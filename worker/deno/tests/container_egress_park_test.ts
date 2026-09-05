/**
 * A host whose containers cannot reach the network is parked, not rebuilt
 * (Issue #997).
 *
 * The incident on GRQ-23 (#991) was reported as `image_build`, which sent the
 * reader to the image while the fault was the host's own routing. These tests
 * hold the three things that must be true of the attribution: the phase is the
 * host-networking one, the report says so instead of blaming the build, and the
 * host backs off hard rather than re-attempting a doomed multi-minute build
 * every cycle.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildContainerEscalationParams,
  CONTAINER_RESTART_DEFAULTS,
  describeFailurePhase,
  emptyContainerRestartState,
  escalationThresholdFor,
  nextContainerRestartDecision,
  recordContainerRestartOutcome,
  resolveContainerRestartConfig,
  resolveFailurePhase,
} from "../lib/container_restart_backoff.ts";
import { HOST_EGRESS_BLOCKED_EXIT_STATUS } from "../lib/container_egress_probe.ts";
import type { CrashNotificationParams } from "../lib/crash_notification.ts";

const CONFIG = resolveContainerRestartConfig();

Deno.test("resolveFailurePhase - the egress marker is its own phase, not image_build", () => {
  assertEquals(
    resolveFailurePhase("container_egress", HOST_EGRESS_BLOCKED_EXIT_STATUS),
    "container_egress",
  );
  assertStringIncludes(
    describeFailurePhase("container_egress"),
    "egress",
  );
});

Deno.test("escalationThresholdFor - a host-networking fault escalates on the first failure", () => {
  assertEquals(escalationThresholdFor("container_egress", CONFIG), 1);
  // The other phases keep the thresholds they had.
  assertEquals(
    escalationThresholdFor("image_build", CONFIG),
    CONTAINER_RESTART_DEFAULTS.imageBuildEscalationThreshold,
  );
  assertEquals(
    escalationThresholdFor("worker_run", CONFIG),
    CONTAINER_RESTART_DEFAULTS.escalationThreshold,
  );
});

Deno.test("nextContainerRestartDecision - the first blocked launch parks at the ceiling", () => {
  const decision = nextContainerRestartDecision(
    emptyContainerRestartState(() => 1000),
    HOST_EGRESS_BLOCKED_EXIT_STATUS,
    "container_egress",
    CONFIG,
    () => 1000,
  );

  assertEquals(decision.phase, "container_egress");
  assertEquals(decision.escalate, true);
  // Not the 60s base sleep: retrying a doomed build every minute is what this
  // ends. A plain first failure would have waited `baseSleepSeconds`.
  assertEquals(decision.backoffSeconds, CONFIG.maxBackoffSeconds);
  assert(decision.backoffSeconds > CONFIG.baseSleepSeconds);
});

Deno.test("nextContainerRestartDecision - other phases still climb the ladder", () => {
  const decision = nextContainerRestartDecision(
    emptyContainerRestartState(() => 1000),
    1,
    "image_build",
    CONFIG,
    () => 1000,
  );
  assertEquals(decision.backoffSeconds, CONFIG.baseSleepSeconds);
});

Deno.test("buildContainerEscalationParams - names the host-networking fault, not the image", () => {
  const params = buildContainerEscalationParams({
    phase: "container_egress",
    exitStatus: HOST_EGRESS_BLOCKED_EXIT_STATUS,
    consecutiveFailures: 1,
    backoffSeconds: 1800,
    threshold: 1,
    hostId: "GRQ-23",
    logTail: [
      "Container egress probe: egress_blocked",
      "| container → 1.1.1.1:443 | FAIL |",
      "| host → 1.1.1.1:443 | OK |",
      "- reject route(s): default link#22 UCSIg bridge100 !",
      "- tunnel interface holding a default route: default 100.100.100.100 UGScIg utun8",
    ].join("\n"),
  });

  // The phase, in the field that renders in the summary table.
  assertStringIncludes(params.workStage, "egress");
  assert(!params.workStage.includes("image build"));

  const body = params.logTail;
  assertStringIncludes(body, "Failure phase: container_egress");
  assertStringIncludes(body, "GRQ-23");
  // The wrong cause is ruled out explicitly — that is the whole complaint.
  assertStringIncludes(body, "not the image build");
  // A retry cannot fix it, and the worker cannot repair host routing itself.
  assertStringIncludes(body, "parked");
  assertStringIncludes(body, "cannot repair");
  // The evidence that makes it diagnosable in a minute.
  assertStringIncludes(body, "bridge100");
  assertStringIncludes(body, "utun8");
  // Fleet-wide, per host: this host is unavailable capacity with a reason.
  assertStringIncludes(body, "Fleet capacity");
  assertStringIncludes(body, "unavailable");
  assertStringIncludes(body, "container_egress_blocked");
});

Deno.test("buildContainerEscalationParams - the image-build wording is untouched", () => {
  const params = buildContainerEscalationParams({
    phase: "image_build",
    exitStatus: 1,
    consecutiveFailures: 2,
    backoffSeconds: 120,
    threshold: 2,
  });
  assertStringIncludes(params.logTail, "cannot be reconstructed on this host");
  assert(!params.logTail.includes("Fleet capacity"));
});

Deno.test("buildContainerEscalationParams - the park exit status is not blamed on the runtime", () => {
  const params = buildContainerEscalationParams({
    phase: "container_egress",
    exitStatus: HOST_EGRESS_BLOCKED_EXIT_STATUS,
    consecutiveFailures: 1,
    backoffSeconds: 1800,
    threshold: 1,
  });
  assertStringIncludes(
    params.logTail,
    `Exit status ${HOST_EGRESS_BLOCKED_EXIT_STATUS} is one the worker produces deliberately`,
  );
});

Deno.test("recordContainerRestartOutcome - a parked host escalates once and says it is parked", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "vibe_egress_park_" });
  try {
    const sent: CrashNotificationParams[] = [];
    const outcome = await recordContainerRestartOutcome({
      workDir,
      exitStatus: HOST_EGRESS_BLOCKED_EXIT_STATUS,
      phaseMarker: "container_egress",
      crashConfig: {
        workerName: "test-worker",
        cooldownSeconds: 600,
        logTailMaxBytes: 50_000,
        stateDir: `${workDir}/state`,
      },
      hostId: "GRQ-23",
      logTail:
        "Container egress probe: egress_blocked\n| host → 1.1.1.1:443 | OK |",
      now: () => 5_000,
      send: (_config, params) => {
        sent.push(params);
        return Promise.resolve({ ok: true, value: { notified: true } });
      },
    });

    assertEquals(outcome.phase, "container_egress");
    assertEquals(outcome.escalated, true);
    assertEquals(outcome.consecutiveFailures, 1);
    assertEquals(outcome.backoffSeconds, CONFIG.maxBackoffSeconds);
    assertEquals(sent.length, 1);

    // The self-heal record names the host as unavailable capacity, with the
    // reason, so a fleet reading the events sees why it is not claiming.
    const events = await Deno.readTextFile(`${workDir}/logs/self-heal.jsonl`);
    assertStringIncludes(events, "host_parked");
    assertStringIncludes(events, "container_egress_blocked");
    assertStringIncludes(events, "unavailable");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
