/**
 * The progress-extension policy is bounded by the supervisor hard cap
 * (Issue #421, parent #397).
 *
 * Extensions used to be uncapped: each grant moved the deadline
 * `grantSeconds` from now for as long as both progress signals held, and
 * nothing in the policy knew the supervisor's wall-clock cap
 * (`VIBE_RUN_MAX_SECONDS`, applied by `timeout` in `loop.sh`). With the
 * deadline-bound refusal retired by Issue #420, a genuinely progressing run
 * would have run until the supervisor SIGTERMed it — no worker-side warning,
 * no orderly WIP commit window, and a launcher failure recorded against the
 * host.
 *
 * These tests pin the bound itself: grants stop at the ceiling however long
 * progress continues, the last grant is clamped to the exact runway left, and
 * an undefined ceiling reproduces the unbounded sequence exactly.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  decideProgressExtension,
  type ProgressExtensionPolicy,
} from "../lib/progress_extension.ts";

const POLICY: ProgressExtensionPolicy = {
  enabled: true,
  grantSeconds: 900,
  activityStallSeconds: 300,
};

const START_MS = 1_700_000_000_000;

/**
 * Run the policy forward as a progressing agent would drive it: every check
 * has fresh tool activity and an advanced tree, and each grant becomes the
 * next check's deadline.
 *
 * @param ceilingMs - The hard ceiling, or undefined for no ceiling.
 * @param checks - How many deadline checks to simulate.
 * @returns The deadline armed after each check; a kill ends the sequence.
 */
function runSequence(
  ceilingMs: number | undefined,
  checks: number,
): { deadlines: number[]; killReason?: string; reasons: string[] } {
  const deadlines: number[] = [];
  const reasons: string[] = [];
  let deadlineMs = START_MS + 3600 * 1000;
  let extensionsGranted = 0;

  for (let i = 0; i < checks; i++) {
    // The watchdog wakes at the deadline, so "now" is the deadline itself.
    const nowMs = deadlineMs;
    const decision = decideProgressExtension({
      nowMs,
      startMs: START_MS,
      deadlineMs,
      lastToolCallAtMs: nowMs - 10_000,
      treeState: "advanced",
      extensionsGranted,
      ...(ceilingMs !== undefined ? { ceilingMs } : {}),
    }, POLICY);
    reasons.push(decision.reason);
    if (decision.action === "kill") {
      return { deadlines, killReason: decision.reason, reasons };
    }
    extensionsGranted++;
    deadlineMs = decision.newDeadlineMs;
    deadlines.push(deadlineMs);
  }
  return { deadlines, reasons };
}

Deno.test("progress extension #421 - grants stop at the ceiling however long progress continues", () => {
  // A 3 h cap from the run start, less the shutdown reserve.
  const ceilingMs = START_MS + (10800 - 150) * 1000;
  const { deadlines, killReason } = runSequence(ceilingMs, 20);

  assert(
    killReason !== undefined,
    "a progressing run must eventually be refused at the hard cap",
  );
  assert(deadlines.length > 0, "grants before the cap must still be issued");
  for (const deadline of deadlines) {
    assert(
      deadline <= ceilingMs,
      `no grant may arm a deadline past the ceiling (got ${deadline}, ` +
        `ceiling ${ceilingMs})`,
    );
  }
  assertEquals(
    deadlines[deadlines.length - 1],
    ceilingMs,
    "the run should be extended right up to the ceiling, not short of it",
  );
});

Deno.test("progress extension #421 - the last grant is clamped to the exact runway left", () => {
  // 200 s of runway: the issue's worked example — not a full 900 s grant,
  // and not zero.
  const nowMs = START_MS + 3600 * 1000;
  const ceilingMs = nowMs + 200_000;
  const decision = decideProgressExtension({
    nowMs,
    startMs: START_MS,
    deadlineMs: nowMs,
    lastToolCallAtMs: nowMs - 5_000,
    treeState: "advanced",
    extensionsGranted: 3,
    ceilingMs,
  }, POLICY);

  assertEquals(decision.action, "extend");
  if (decision.action !== "extend") return;
  assertEquals(
    decision.newDeadlineMs,
    ceilingMs,
    "the grant must land exactly on the ceiling",
  );
  assert(
    decision.reason.includes("clamped"),
    `the clamp must be named in the reason: ${decision.reason}`,
  );
  assert(
    decision.reason.includes("200s"),
    `the reason must name the remaining runway: ${decision.reason}`,
  );
});

Deno.test("progress extension #421 - a grant inside the ceiling is not clamped", () => {
  const nowMs = START_MS + 3600 * 1000;
  const ceilingMs = nowMs + 5_000_000;
  const decision = decideProgressExtension({
    nowMs,
    startMs: START_MS,
    deadlineMs: nowMs,
    lastToolCallAtMs: nowMs - 5_000,
    treeState: "advanced",
    extensionsGranted: 0,
    ceilingMs,
  }, POLICY);

  assertEquals(decision.action, "extend");
  if (decision.action !== "extend") return;
  assertEquals(decision.newDeadlineMs, nowMs + POLICY.grantSeconds * 1000);
  assert(
    !decision.reason.includes("clamped"),
    `a full grant must not claim to be clamped: ${decision.reason}`,
  );
});

Deno.test("progress extension #421 - no runway left refuses, naming the cap", () => {
  const nowMs = START_MS + 3600 * 1000;
  const decision = decideProgressExtension({
    nowMs,
    startMs: START_MS,
    deadlineMs: nowMs,
    lastToolCallAtMs: nowMs - 5_000,
    treeState: "advanced",
    extensionsGranted: 7,
    // The ceiling is already behind us.
    ceilingMs: nowMs - 1,
  }, POLICY);

  assertEquals(decision.action, "kill");
  assert(
    decision.reason.includes("hard cap"),
    `the refusal must name the hard cap: ${decision.reason}`,
  );
  // Issue #424: the kill must declare itself a scheduled release, so the
  // issue comment says "hard cap reached — WIP preserved" instead of
  // blaming the issue for running out of time.
  if (decision.action !== "kill") return;
  assertEquals(decision.cause, "hard-cap");
});

Deno.test("progress extension #424 - a stalled run's kill carries no scheduled-release cause", () => {
  const nowMs = START_MS + 3600 * 1000;
  const decision = decideProgressExtension({
    nowMs,
    startMs: START_MS,
    deadlineMs: nowMs,
    // Tool activity well outside the stall window: a genuine timeout.
    lastToolCallAtMs: nowMs - 900_000,
    treeState: "advanced",
    extensionsGranted: 2,
    ceilingMs: nowMs + 5_000_000,
  }, POLICY);

  assertEquals(decision.action, "kill");
  if (decision.action !== "kill") return;
  assertEquals(decision.cause, undefined);
});

Deno.test("progress extension #421 - an undefined ceiling reproduces the unbounded sequence", () => {
  const { deadlines, killReason } = runSequence(undefined, 20);
  assertEquals(
    killReason,
    undefined,
    "with no ceiling a progressing run is never refused",
  );
  assertEquals(deadlines.length, 20);
  for (let i = 1; i < deadlines.length; i++) {
    const [previous, current] = [deadlines[i - 1] ?? 0, deadlines[i] ?? 0];
    assertEquals(
      current - previous,
      POLICY.grantSeconds * 1000,
      "each unbounded grant adds the full increment",
    );
  }
});

Deno.test("progress extension #421 - the ceiling never rescues a stalled run", () => {
  // A ceiling with plenty of runway must not turn a stall into an extension:
  // the two progress signals still decide, and only then does the cap clamp.
  const nowMs = START_MS + 3600 * 1000;
  const decision = decideProgressExtension({
    nowMs,
    startMs: START_MS,
    deadlineMs: nowMs,
    lastToolCallAtMs: nowMs - 5_000,
    treeState: "unchanged",
    extensionsGranted: 0,
    ceilingMs: nowMs + 5_000_000,
  }, POLICY);
  assertEquals(decision.action, "kill");
  assert(
    decision.reason.includes("working tree unchanged"),
    `the stalled signal must still be the reason: ${decision.reason}`,
  );
});
