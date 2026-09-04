/**
 * Issue #949: an unreachable GitHub must not climb the failure ladder.
 *
 * The backoff escalates 60 → 120 → 240 → 480 → 960s so a host that is
 * genuinely broken stops hammering its runtime. That is right for a broken
 * host and wrong for a broken link. Observed on a laptop tethered to a
 * mobile hotspot on a train: five launches in a row died on
 *
 * ```text
 * dial tcp 4.237.22.34:443: i/o timeout
 * ```
 *
 * and the ladder walked itself up to `Sleeping 960s...`, so half an hour of
 * flaky signal cost an hour of fleet time. Nothing was wrong with the host —
 * it resolved `api.github.com` in 0.17s throughout — and no amount of extra
 * waiting makes a link come back sooner.
 *
 * So this failure is treated the way a quota pause already is (Issue #342):
 * the streak resets, nothing escalates, and the wait is the base cadence, so
 * the fleet is ready the moment the link is. Nothing escalates because there
 * is nothing a human could fix.
 *
 * The classification travels from the run to the supervisor through the
 * launch log, which is the only channel between them — the work directory
 * rides a named volume the host cannot read. These tests pin both ends of
 * that contract, because the two modules could otherwise drift apart
 * silently and the symptom would be a slow fleet nobody can explain.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  classifyLauncherOutcome,
  CONTAINER_RESTART_DEFAULTS,
  emptyContainerRestartState,
  isNetworkUnavailableLaunch,
  nextContainerRestartDecision,
  resolveContainerRestartConfig,
} from "../lib/container_restart_backoff.ts";
import { NETWORK_UNAVAILABLE_MARKER } from "../lib/github_user_resolution.ts";

const CONFIG = resolveContainerRestartConfig(CONTAINER_RESTART_DEFAULTS);
const CLOCK = () => 1_000;

/** A launch log ending the way an unreachable-GitHub run ends. */
const NETWORK_LOG = [
  "[02:09:50Z] INFO: [run-worker] run mode: container",
  "[02:10:59Z] ERROR: [run-worker] gh could not resolve the authenticated " +
  'user (network, 4 attempt(s)): Get "https://api.github.com/user": ' +
  "dial tcp 4.237.22.34:443: i/o timeout",
  `[02:10:59Z] ERROR: [run-worker] ${NETWORK_UNAVAILABLE_MARKER} — GitHub ` +
  "was unreachable for every attempt; not a host fault",
].join("\n");

/** A launch log from a run that failed for a reason a human must fix. */
const FATAL_LOG = [
  "[02:09:50Z] INFO: [run-worker] run mode: container",
  "[02:09:51Z] ERROR: [run-worker] gh could not resolve the authenticated " +
  "user (fatal, 1 attempt(s)): HTTP 401: Bad credentials",
].join("\n");

Deno.test("network backoff - the marker is what the run actually prints (Issue #949)", () => {
  // The contract between the two modules. If the run's wording changes and
  // the matcher does not, the fleet quietly goes back to 960s sleeps and
  // nothing says why.
  assertEquals(isNetworkUnavailableLaunch(NETWORK_LOG), true);
  assertEquals(isNetworkUnavailableLaunch(FATAL_LOG), false);
  assertEquals(isNetworkUnavailableLaunch(""), false);
  assertEquals(isNetworkUnavailableLaunch(null), false);
  assertEquals(isNetworkUnavailableLaunch(undefined), false);
});

Deno.test("network backoff - an unreachable GitHub waits the base cadence (Issue #949)", () => {
  const decision = nextContainerRestartDecision(
    emptyContainerRestartState(CLOCK),
    1,
    null,
    CONFIG,
    CLOCK,
    null,
    true,
  );
  assertEquals(decision.kind, "network_unavailable");
  assertEquals(decision.backoffSeconds, CONFIG.baseSleepSeconds);
  assertEquals(decision.escalate, false);
});

Deno.test("network backoff - repeated blips do not climb the ladder (Issue #949)", () => {
  // The measured failure: five in a row took the sleep from 60s to 960s.
  let state = emptyContainerRestartState(CLOCK);
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    const decision = nextContainerRestartDecision(
      state,
      1,
      null,
      CONFIG,
      CLOCK,
      null,
      true,
    );
    waits.push(decision.backoffSeconds);
    state = decision.state;
    assertEquals(state.consecutiveFailures, 0);
  }
  assertEquals(waits, [60, 60, 60, 60, 60]);
});

Deno.test("network backoff - a real failure still escalates (Issue #949)", () => {
  // The guard on the fix: a host that is genuinely broken must still back
  // off, or this trades one fault for a restart storm.
  let state = emptyContainerRestartState(CLOCK);
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    const decision = nextContainerRestartDecision(
      state,
      1,
      null,
      CONFIG,
      CLOCK,
      null,
      false,
    );
    waits.push(decision.backoffSeconds);
    state = decision.state;
  }
  assertEquals(state.consecutiveFailures, 5);
  assertEquals(
    waits.some((seconds) => seconds > CONFIG.baseSleepSeconds),
    true,
    `a genuine failure streak must escalate, got ${waits.join(", ")}`,
  );
});

Deno.test("network backoff - a clean run is never reclassified by the marker (Issue #949)", () => {
  // A log can carry the marker from earlier in the same file. Exit status 0
  // means the run reached the end, and that wins.
  assertEquals(classifyLauncherOutcome(0, null, true), "success");
  const decision = nextContainerRestartDecision(
    emptyContainerRestartState(CLOCK),
    0,
    null,
    CONFIG,
    CLOCK,
    null,
    true,
  );
  assertEquals(decision.kind, "success");
});

Deno.test("network backoff - a quota pause still outranks it (Issue #949)", () => {
  // Both are "not a host fault", but a quota pause knows when it ends and
  // has its own cadence; it must not be relabelled.
  assertEquals(
    classifyLauncherOutcome(
      1,
      { resetEpochMs: 2_000_000, declaredAtMs: 1_000_000, reason: "usage" },
      true,
    ),
    "quota_pause",
  );
});

Deno.test("network backoff - without the marker a failure stays a failure (Issue #949)", () => {
  assertEquals(classifyLauncherOutcome(1, null, false), "failure");
  assertEquals(classifyLauncherOutcome(1, null, undefined), "failure");
});
