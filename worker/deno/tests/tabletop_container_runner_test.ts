/**
 * Tests for the tabletop harness's container runner (Issue #4194).
 *
 * The runner starts a real container, which no unit test may do, so what is
 * tested here is everything the run hinges on either side of that call: the
 * argument list is the launcher's own plan with only the process replaced, an
 * attempt that says nothing is an error rather than a pass, and the outbox is
 * parsed into the sinks the canary scan then reads.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  attemptRunArgs,
  DEFAULT_EGRESS_PROBE_URL,
  parseAttemptOutcome,
  parseOutboxArtefacts,
  TabletopContainerUnavailableError,
} from "../lib/tabletop_container_runner.ts";
import type { ContainerLaunchPlan } from "../lib/container_launch.ts";
import {
  parseWeakenedControls,
  tabletopReportPath,
} from "../commands/security_tabletop.ts";

/** A launch plan shaped exactly as `buildContainerLaunchPlan` returns one. */
function plan(): ContainerLaunchPlan {
  return {
    runtime: "docker",
    image: "vibe-coder:abc123",
    containerName: "vibe-tabletop-1234",
    watchdogSeconds: 11_400,
    mounts: [],
    ensureDirectories: [],
    volumes: ["vibe-tabletop-work-1234"],
    initArgs: ["run", "--rm", "vibe-coder:abc123"],
    imageInspectArgs: ["image", "inspect", "vibe-coder:abc123"],
    buildArgs: ["build"],
    // The runtime's own removal verb rides in the plan (Issue #731).
    volumeRemoveArgs: ["volume", "rm"],
    // The claiming floor rides the plan too (Issue #732).
    claimFloorGb: 20,
    claimFloorPercent: 10,
    claimFloorOrigin: "gb=default,percent=default",
    builderStopArgs: [],
    builderAbsentPatterns: [],
    runArgs: [
      "run",
      "--rm",
      "--name",
      "vibe-tabletop-1234",
      "--memory",
      "8g",
      "--cap-drop",
      "ALL",
      "--volume",
      "/tmp/checkout:/workspace",
      "vibe-coder:abc123",
    ],
  };
}

Deno.test("attemptRunArgs keeps every containment flag the plan produced", () => {
  const args = attemptRunArgs(plan(), "vibe-tabletop-1234-0", [], ["/x.sh"]);
  for (const flag of ["--rm", "--memory", "--cap-drop", "--volume"]) {
    assert(args.includes(flag), `${flag} was dropped from the run`);
  }
  assert(
    args.includes("/tmp/checkout:/workspace"),
    "the mount set must survive verbatim",
  );
});

Deno.test("attemptRunArgs replaces only the process and the container name", () => {
  const args = attemptRunArgs(
    plan(),
    "vibe-tabletop-1234-2",
    ["VIBE_TABLETOP_CANARY=/creds/x"],
    ["/workspace/tabletop/a.sh"],
  );
  assertEquals(args[args.indexOf("--name") + 1], "vibe-tabletop-1234-2");
  assertEquals(args.at(-1), "/workspace/tabletop/a.sh");
  assertEquals(args.at(-2), "vibe-coder:abc123");
  assertEquals(args.at(-3), "bash");
  assertEquals(args.at(-4), "--entrypoint");
  assertEquals(
    args[args.indexOf("--env") + 1],
    "VIBE_TABLETOP_CANARY=/creds/x",
  );
});

Deno.test("attemptRunArgs refuses a plan whose shape it does not recognise", () => {
  const noImage = plan();
  noImage.runArgs = ["run", "--name", "x", "some-other-image"];
  assertThrows(() => attemptRunArgs(noImage, "n", [], ["/x"]), Error, "image");

  const unnamed = plan();
  unnamed.runArgs = ["run", "--rm", "vibe-coder:abc123"];
  assertThrows(
    () => attemptRunArgs(unnamed, "n", [], ["/x"]),
    Error,
    "does not name the container",
  );
});

Deno.test("parseAttemptOutcome reads the status and detail the attempt reported", () => {
  assertEquals(
    parseAttemptOutcome("noise\noutcome\trefused\t/etc is not writable\n"),
    { status: "refused", detail: "/etc is not writable" },
  );
  assertEquals(
    parseAttemptOutcome("outcome\tachieved\treached https://example.com"),
    { status: "achieved", detail: "reached https://example.com" },
  );
});

Deno.test("an attempt that reports nothing usable is an error, never a pass", () => {
  assertEquals(parseAttemptOutcome("").status, "error");
  assertEquals(parseAttemptOutcome("all fine here").status, "error");
  assertEquals(parseAttemptOutcome("outcome\tcontained\tx").status, "error");
});

Deno.test("parseOutboxArtefacts groups the queued bodies by sink", () => {
  const artefacts = parseOutboxArtefacts(
    "pr-comment\tfirst body\nrun-log\ttelemetry line\npr-comment\tsecond body\n",
  );
  assertEquals(artefacts.length, 2);
  assertEquals(artefacts[0], {
    sink: "pr-comment",
    body: "first body\nsecond body",
  });
  assertEquals(artefacts[1], { sink: "run-log", body: "telemetry line" });
});

Deno.test("an untagged outbox line still becomes an artefact", () => {
  assertEquals(parseOutboxArtefacts("bare leak\n"), [{
    sink: "outbox",
    body: "bare leak",
  }]);
  assertEquals(parseOutboxArtefacts(""), []);
});

Deno.test("the unavailable-container error names the refusal, not a fallback", () => {
  const error = new TabletopContainerUnavailableError("no runtime on PATH");
  assert(error.message.includes("no runtime on PATH"));
  assert(
    error.message.includes("refuses"),
    "the message must say the run was refused rather than downgraded",
  );
});

Deno.test("the egress fixture probes a documentation host by default", () => {
  assertEquals(DEFAULT_EGRESS_PROBE_URL, "https://example.com");
});

// ---------------------------------------------------------------------------
// Command arguments
// ---------------------------------------------------------------------------

Deno.test("--weaken accepts the controls the harness can switch off", () => {
  assertEquals(parseWeakenedControls(undefined), []);
  assertEquals(parseWeakenedControls("sink-redaction"), ["sink-redaction"]);
  assertEquals(
    parseWeakenedControls("sink-redaction, canary-encoding-scan"),
    ["sink-redaction", "canary-encoding-scan"],
  );
});

Deno.test("--weaken refuses a control it does not know", () => {
  assertThrows(
    () => parseWeakenedControls("containment"),
    Error,
    "Unknown control",
  );
  assertThrows(() => parseWeakenedControls(""), Error, "--weaken");
});

Deno.test("a negative-control run writes to its own evidence file", () => {
  const day = new Date("2026-08-18T04:05:06Z");
  assertEquals(
    tabletopReportPath(day, false),
    "docs/evidence/tabletop-2026-08-18.md",
  );
  assertEquals(
    tabletopReportPath(day, true),
    "docs/evidence/tabletop-negative-control-2026-08-18.md",
  );
});
