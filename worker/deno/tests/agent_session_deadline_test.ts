/**
 * Tests for lib/agent_session_deadline.ts (Issue #4244, part of #4224).
 *
 * The timeline is built with the real `resolveRunTimeline` (a one-hour target,
 * a two-hour finish, no hard kill in the environment) and the clock is
 * injected, so every branch of the budget is exercised without wall time.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */
import { assert, assertEquals } from "@std/assert";
import {
  finishDeadlinePromptLine,
  MIN_AGENT_SESSION_SECONDS,
  planAgentSessionBudget,
} from "../lib/agent_session_deadline.ts";
import { WIP_CHECKPOINT_RESERVE_SECONDS } from "../lib/run_hard_cap.ts";
import { resolveRunTimeline } from "../lib/run_timeline.ts";

const START_MS = Date.UTC(2026, 9, 24, 0, 0, 0);
const KILL_AFTER_SECONDS = 30;
const RESERVE_SECONDS = KILL_AFTER_SECONDS + WIP_CHECKPOINT_RESERVE_SECONDS;

/** A timeline started at `startedMs`, with no hard kill in the environment. */
function timelineFrom(startedMs: number) {
  return resolveRunTimeline({
    startedMs,
    runDurationSeconds: 3600,
    runFinishSeconds: 7200,
    env: () => undefined,
    killAfterSeconds: KILL_AFTER_SECONDS,
    warn: () => {},
  });
}

Deno.test("late session is clamped to what the finish leaves less the reserve", () => {
  const timeline = timelineFrom(START_MS);
  // 600 s before the finish at 1h50m; the reserve takes 150 s of that.
  const nowMs = START_MS + 6600_000;
  const budget = planAgentSessionBudget({
    timeline,
    nowMs,
    requestedSeconds: 3000,
    killAfterSeconds: KILL_AFTER_SECONDS,
  });
  assert(budget.kind === "run");
  assertEquals(budget.clamped, true);
  assertEquals(budget.timeoutSeconds, 600 - RESERVE_SECONDS);
  assertEquals(budget.timeoutSeconds, 450);
  assertEquals(budget.limitMs, timeline.finishMs - RESERVE_SECONDS * 1000);
  assertEquals(budget.finishIso, new Date(timeline.finishMs).toISOString());
  assertEquals(budget.remainingToFinishSeconds, 600);
});

Deno.test("early session keeps its requested timeout when the finish is far off", () => {
  const timeline = timelineFrom(START_MS);
  // Ten minutes into the run: plenty of time before the finish.
  const nowMs = START_MS + 600_000;
  const budget = planAgentSessionBudget({
    timeline,
    nowMs,
    requestedSeconds: 600,
    killAfterSeconds: KILL_AFTER_SECONDS,
  });
  assert(budget.kind === "run");
  assertEquals(budget.clamped, false);
  assertEquals(budget.timeoutSeconds, 600);
  assertEquals(budget.remainingToFinishSeconds, 6600);
});

Deno.test("exactly the minimum session time left still runs", () => {
  const timeline = timelineFrom(START_MS);
  // Finish less now is 270 s; less the 150 s reserve that leaves exactly 120 s.
  const nowMs = timeline.finishMs -
    (MIN_AGENT_SESSION_SECONDS + RESERVE_SECONDS) *
      1000;
  const budget = planAgentSessionBudget({
    timeline,
    nowMs,
    requestedSeconds: 3000,
    killAfterSeconds: KILL_AFTER_SECONDS,
  });
  assert(budget.kind === "run");
  assertEquals(MIN_AGENT_SESSION_SECONDS, 120);
  assertEquals(budget.timeoutSeconds, 120);
  assertEquals(budget.clamped, true);
});

Deno.test("one second under the minimum session time is refused", () => {
  const timeline = timelineFrom(START_MS);
  // One second less than the boundary above: 119 s available.
  const nowMs = timeline.finishMs -
    ((MIN_AGENT_SESSION_SECONDS + RESERVE_SECONDS) * 1000 - 1000);
  const budget = planAgentSessionBudget({
    timeline,
    nowMs,
    requestedSeconds: 3000,
    killAfterSeconds: KILL_AFTER_SECONDS,
  });
  assertEquals(budget, {
    kind: "refuse",
    availableSeconds: MIN_AGENT_SESSION_SECONDS - 1,
    finishIso: new Date(timeline.finishMs).toISOString(),
  });
});

Deno.test("a session started past the finish is refused with no time", () => {
  const timeline = timelineFrom(START_MS);
  const nowMs = timeline.finishMs + 1000;
  const budget = planAgentSessionBudget({
    timeline,
    nowMs,
    requestedSeconds: 600,
    killAfterSeconds: KILL_AFTER_SECONDS,
  });
  assertEquals(budget, {
    kind: "refuse",
    availableSeconds: 0,
    finishIso: new Date(timeline.finishMs).toISOString(),
  });
});

Deno.test("the floor applies to the time left, not to a short requested timeout", () => {
  const timeline = timelineFrom(START_MS);
  // 1000 s available once the reserve is taken from the time to the finish.
  const nowMs = timeline.finishMs - (1000 + RESERVE_SECONDS) * 1000;
  const budget = planAgentSessionBudget({
    timeline,
    nowMs,
    requestedSeconds: 30,
    killAfterSeconds: KILL_AFTER_SECONDS,
  });
  assert(budget.kind === "run");
  assertEquals(budget.clamped, false);
  assertEquals(budget.timeoutSeconds, 30);
});

Deno.test("the prompt line carries the finish, the time left and the commit instruction", () => {
  const timeline = timelineFrom(START_MS);
  const budget = planAgentSessionBudget({
    timeline,
    nowMs: START_MS + 6600_000,
    requestedSeconds: 600,
    killAfterSeconds: KILL_AFTER_SECONDS,
  });
  assert(budget.kind === "run");
  const line = finishDeadlinePromptLine(budget);
  assert(line.startsWith("\n\n"));
  assert(line.includes(budget.finishIso));
  assert(line.includes(`${budget.remainingToFinishSeconds}s remaining`));
  assert(line.includes("commit and push"));
});
