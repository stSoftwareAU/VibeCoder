/**
 * Tests for conflict_stage_timer.ts (Issue #2308).
 *
 * The timings are what shows where a twenty-minute conflict attempt went, so
 * the two properties that matter are exactness under a known clock and the
 * refusal to drop a stage that never finished.
 *
 * Every test drives an injected clock — no wall-clock reading and no absolute
 * duration assertion, so a loaded CI runner cannot change a verdict.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ConflictStage,
  createConflictStageTimer,
  currentHost,
  formatStageTimings,
} from "../lib/conflict_stage_timer.ts";

/** A clock the test advances by hand. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let ms = 1_000_000;
  return {
    now: () => ms,
    advance: (delta: number) => {
      ms += delta;
    },
  };
}

Deno.test("conflict stage timer - reports the seconds each stage took", () => {
  const clock = fakeClock();
  const timer = createConflictStageTimer(clock.now);

  timer.start("deepen");
  clock.advance(3_000);
  timer.stop();

  timer.start("rules");
  clock.advance(1_000);
  timer.stop();

  timer.start("agent");
  clock.advance(212_000);
  timer.stop();

  assertEquals(timer.report(), [
    { stage: "deepen", seconds: 3 },
    { stage: "rules", seconds: 1 },
    { stage: "agent", seconds: 212 },
  ]);
});

Deno.test("conflict stage timer - an empty timer reports no stages", () => {
  assertEquals(createConflictStageTimer(fakeClock().now).report(), []);
});

Deno.test("conflict stage timer - a stage never stopped reports unfinished, never disappears", () => {
  const clock = fakeClock();
  const timer = createConflictStageTimer(clock.now);

  timer.start("deepen");
  clock.advance(2_000);
  timer.stop();

  // The attempt died inside the agent: started, never stopped.
  timer.start("agent");
  clock.advance(900_000);

  const report = timer.report();
  assertEquals(report, [
    { stage: "deepen", seconds: 2 },
    { stage: "agent", seconds: null },
  ]);
  assertStringIncludes(
    formatStageTimings(report, "mel-01"),
    "agent unfinished",
  );
});

Deno.test("conflict stage timer - starting the next stage marks an unstopped one unfinished", () => {
  const clock = fakeClock();
  const timer = createConflictStageTimer(clock.now);

  timer.start("rules");
  clock.advance(5_000);
  // No stop(): the caller forgot, so no duration may be invented for it.
  timer.start("push");
  clock.advance(4_000);
  timer.stop();

  assertEquals(timer.report(), [
    { stage: "rules", seconds: null },
    { stage: "push", seconds: 4 },
  ]);
});

Deno.test("conflict stage timer - a stage run twice accumulates under one entry", () => {
  const clock = fakeClock();
  const timer = createConflictStageTimer(clock.now);

  timer.start("gate");
  clock.advance(30_000);
  timer.stop();

  timer.start("agent");
  clock.advance(60_000);
  timer.stop();

  // The milestone path re-runs its gate after a repair round.
  timer.start("gate");
  clock.advance(20_000);
  timer.stop();

  assertEquals(timer.report(), [
    { stage: "gate", seconds: 50 },
    { stage: "agent", seconds: 60 },
  ]);
});

Deno.test("conflict stage timer - a running stage still reports, and settles once stopped", () => {
  const clock = fakeClock();
  const timer = createConflictStageTimer(clock.now);

  timer.start("push");
  clock.advance(7_000);
  // Reading the report mid-stage must not end the stage.
  assertEquals(timer.report(), [{ stage: "push", seconds: null }]);

  timer.stop();
  assertEquals(timer.report(), [{ stage: "push", seconds: 7 }]);
});

Deno.test("conflict stage timer - stop without start records nothing", () => {
  const timer = createConflictStageTimer(fakeClock().now);
  timer.stop();
  assertEquals(timer.report(), []);
});

Deno.test("formatStageTimings - renders one line naming the host and every stage", () => {
  const line = formatStageTimings(
    [
      { stage: "deepen", seconds: 3 },
      { stage: "rules", seconds: 1 },
      { stage: "agent", seconds: 212 },
      { stage: "push", seconds: null },
    ],
    "mel-01",
  );
  assertEquals(
    line,
    "Timings (host `mel-01`): deepen 3s · rules 1s · agent 212s · " +
      "push unfinished",
  );
});

Deno.test("formatStageTimings - an empty report says so rather than trailing off", () => {
  assertEquals(
    formatStageTimings([], "mel-01"),
    "Timings (host `mel-01`): no stage was timed",
  );
});

Deno.test("formatStageTimings - every stage of the union renders", () => {
  const stages: ConflictStage[] = [
    "deepen",
    "rules",
    "issue-context",
    "agent",
    "gate",
    "push",
  ];
  const line = formatStageTimings(
    stages.map((stage, index) => ({ stage, seconds: index })),
    "host-a",
  );
  for (const stage of stages) assertStringIncludes(line, stage);
});

Deno.test("currentHost - resolves a non-empty host name", () => {
  const host = currentHost();
  assertEquals(typeof host, "string");
  assertEquals(host.length > 0, true);
});
