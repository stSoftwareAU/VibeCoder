/**
 * The run's timeline: target, finish, and the hard kill the launcher publishes
 * (Issue #4242).
 *
 * Every fixture uses fixed epoch numbers and injected environment and warning
 * collectors, so each assertion is about the resolution alone. Candidate hard
 * kills and supervisor deadlines are given different values, so a resolver
 * that picks the wrong source fails the assertion rather than passing by
 * coincidence.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  DEFAULT_RUN_FINISH_SECONDS,
  DEFAULT_RUN_TARGET_SECONDS,
  describeRunTimeline,
  getRunTimeline,
  pastRunTarget,
  resetRunTimelineForTests,
  resolveRunTimeline,
  type RunTimeline,
  setRunTimeline,
} from "../lib/run_timeline.ts";

const STARTED_EPOCH_SECONDS = 1_700_000_000;
const STARTED_MS = STARTED_EPOCH_SECONDS * 1000;

/** The watchdog's kill: 10 000 s after start, well past the finish. */
const WATCHDOG_KILL_SECONDS = STARTED_EPOCH_SECONDS + 10_000;

/** The supervisor's deadline via the pair: 9 000 s after start. */
const PAIR_MAX_SECONDS = "9000";

/** An env reader over a fixed map, as the launcher would supply. */
function env(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

/** A warning sink that records every message. */
function collector(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return {
    warn: (message: string) => {
      messages.push(message);
    },
    messages,
  };
}

/** The ISO-8601 string for an epoch-ms, as the log line shows it. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A timeline from the default durations, with the given env and sink. */
function timelineFor(
  values: Record<string, string>,
  warn: (message: string) => void,
  killAfterSeconds = 30,
): RunTimeline {
  return resolveRunTimeline({
    startedMs: STARTED_MS,
    runDurationSeconds: DEFAULT_RUN_TARGET_SECONDS,
    runFinishSeconds: DEFAULT_RUN_FINISH_SECONDS,
    env: env(values),
    killAfterSeconds,
    warn,
  });
}

Deno.test("resolveRunTimeline - defaults put the target at start+1h and the finish at start+2h", () => {
  const warnings = collector();
  const t = timelineFor({}, warnings.warn);
  assertEquals(DEFAULT_RUN_TARGET_SECONDS, 3600);
  assertEquals(DEFAULT_RUN_FINISH_SECONDS, 7200);
  assertEquals(t.targetMs, STARTED_MS + 3_600_000);
  assertEquals(t.finishMs, STARTED_MS + 7_200_000);
  assertEquals(warnings.messages, []);
});

Deno.test("resolveRunTimeline - the hard kill comes from VIBE_HARD_KILL_AT_EPOCH in epoch-seconds", () => {
  const warnings = collector();
  const t = timelineFor(
    { VIBE_HARD_KILL_AT_EPOCH: String(WATCHDOG_KILL_SECONDS) },
    warnings.warn,
  );
  assertEquals(t.hardKillMs, WATCHDOG_KILL_SECONDS * 1000);
  assertEquals(t.hardKillReason, undefined);
  assertEquals(t.finishMs, STARTED_MS + 7_200_000);
  assertEquals(warnings.messages, []);
});

Deno.test("resolveRunTimeline - the watchdog variable wins over the supervisor pair when both are set", () => {
  const warnings = collector();
  const t = timelineFor(
    {
      VIBE_HARD_KILL_AT_EPOCH: String(WATCHDOG_KILL_SECONDS),
      VIBE_RUN_MAX_SECONDS: PAIR_MAX_SECONDS,
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    },
    warnings.warn,
  );
  assertEquals(t.hardKillMs, WATCHDOG_KILL_SECONDS * 1000);
  assert(
    t.hardKillMs !== (STARTED_EPOCH_SECONDS + 9000) * 1000,
    "the supervisor deadline must not override the watchdog kill",
  );
});

Deno.test("resolveRunTimeline - without the watchdog variable the hard kill falls back to the supervisor pair", () => {
  const warnings = collector();
  const t = timelineFor(
    {
      VIBE_RUN_MAX_SECONDS: PAIR_MAX_SECONDS,
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    },
    warnings.warn,
  );
  assertEquals(t.hardKillMs, STARTED_MS + 9_000_000);
  assertEquals(t.hardKillReason, undefined);
  assertEquals(warnings.messages, []);
});

Deno.test("resolveRunTimeline - with neither source the hard kill is null and the reason names both", () => {
  const warnings = collector();
  const t = timelineFor({}, warnings.warn);
  assertEquals(t.hardKillMs, null);
  assert(t.hardKillReason !== undefined, "a null kill must carry a reason");
  assert(
    t.hardKillReason.includes("VIBE_HARD_KILL_AT_EPOCH is not set"),
    `the reason must name the watchdog variable: ${t.hardKillReason}`,
  );
  assert(
    t.hardKillReason.includes("VIBE_RUN_MAX_SECONDS is not set"),
    `the reason must carry the cap's own resolution: ${t.hardKillReason}`,
  );
  assertEquals(warnings.messages, []);
});

Deno.test("resolveRunTimeline - a disabled supervisor cap gives a null kill whose reason says so", () => {
  const t = timelineFor(
    {
      VIBE_RUN_MAX_SECONDS: "0",
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    },
    collector().warn,
  );
  assertEquals(t.hardKillMs, null);
  assert(
    t.hardKillReason?.includes("disables the supervisor cap"),
    `the reason must say the cap is disabled: ${t.hardKillReason}`,
  );
});

Deno.test("resolveRunTimeline - a malformed watchdog value is warned, quoted, and falls back to the pair", () => {
  const warnings = collector();
  const t = timelineFor(
    {
      VIBE_HARD_KILL_AT_EPOCH: "soon",
      VIBE_RUN_MAX_SECONDS: PAIR_MAX_SECONDS,
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    },
    warnings.warn,
  );
  assertEquals(t.hardKillMs, STARTED_MS + 9_000_000);
  assertEquals(warnings.messages.length, 1);
  assert(
    warnings.messages[0]!.includes('"soon"'),
    `the warning must quote the value: ${warnings.messages[0]}`,
  );
  assert(
    warnings.messages[0]!.includes("VIBE_HARD_KILL_AT_EPOCH"),
    `the warning must name the variable: ${warnings.messages[0]}`,
  );
});

Deno.test("resolveRunTimeline - an epoch-milliseconds watchdog value is warned, quoted, and falls back to the pair", () => {
  const warnings = collector();
  const millisValue = String(WATCHDOG_KILL_SECONDS * 1000);
  const t = timelineFor(
    {
      VIBE_HARD_KILL_AT_EPOCH: millisValue,
      VIBE_RUN_MAX_SECONDS: PAIR_MAX_SECONDS,
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    },
    warnings.warn,
  );
  // Read as seconds it would be ~50 000 years out; the pair's deadline wins.
  assertEquals(t.hardKillMs, STARTED_MS + 9_000_000);
  assertEquals(warnings.messages.length, 1);
  assert(
    warnings.messages[0]!.includes(`"${millisValue}"`),
    `the warning must quote the millisecond value: ${warnings.messages[0]}`,
  );
});

Deno.test("resolveRunTimeline - a malformed watchdog value with no fallback is null, the reason naming the value", () => {
  const warnings = collector();
  const t = timelineFor({ VIBE_HARD_KILL_AT_EPOCH: "soon" }, warnings.warn);
  assertEquals(t.hardKillMs, null);
  assert(
    t.hardKillReason?.includes('"soon"'),
    `the reason must name the malformed value: ${t.hardKillReason}`,
  );
  assertEquals(warnings.messages.length, 1);
});

Deno.test("resolveRunTimeline - a finish inside the kill-grace and WIP reserve is clamped, and the clamp is warned", () => {
  const warnings = collector();
  // 30 s grace + 120 s WIP reserve = 150 s, so the latest finish is 7 150 s.
  const hardKillSeconds = STARTED_EPOCH_SECONDS + 7_300;
  const t = timelineFor(
    { VIBE_HARD_KILL_AT_EPOCH: String(hardKillSeconds) },
    warnings.warn,
  );
  assertEquals(t.finishMs, STARTED_MS + 7_150_000);
  assertEquals(warnings.messages.length, 1);
  const message = warnings.messages[0]!;
  assert(
    message.includes(iso(STARTED_MS + 7_200_000)),
    `the warning must name the configured finish: ${message}`,
  );
  assert(
    message.includes(iso(STARTED_MS + 7_150_000)),
    `the warning must name the clamped finish: ${message}`,
  );
  assert(
    message.includes(iso(hardKillSeconds * 1000)),
    `the warning must name the hard-kill ISO: ${message}`,
  );
});

Deno.test("resolveRunTimeline - a finish comfortably inside the hard kill is not clamped and not warned", () => {
  const warnings = collector();
  const t = timelineFor(
    { VIBE_HARD_KILL_AT_EPOCH: String(WATCHDOG_KILL_SECONDS) },
    warnings.warn,
  );
  assertEquals(t.finishMs, STARTED_MS + 7_200_000);
  assertEquals(warnings.messages, []);
});

Deno.test("resolveRunTimeline - a finish just outside the reserve is not clamped", () => {
  const warnings = collector();
  // The latest finish is 7 201 s, one second beyond the configured 7 200 s.
  const t = timelineFor(
    { VIBE_HARD_KILL_AT_EPOCH: String(STARTED_EPOCH_SECONDS + 7_351) },
    warnings.warn,
  );
  assertEquals(t.finishMs, STARTED_MS + 7_200_000);
  assertEquals(warnings.messages, []);
});

Deno.test("pastTarget - false just before the target and true at it", () => {
  const t = timelineFor({}, collector().warn);
  assertEquals(t.pastTarget(t.targetMs - 1), false);
  assertEquals(t.pastTarget(t.targetMs), true);
});

Deno.test("pastFinish - false just before the finish and true at it", () => {
  const t = timelineFor({}, collector().warn);
  assertEquals(t.pastFinish(t.finishMs - 1), false);
  assertEquals(t.pastFinish(t.finishMs), true);
});

Deno.test("remainingToFinishMs - counts down to the finish and floors at zero", () => {
  const t = timelineFor({}, collector().warn);
  assertEquals(t.remainingToFinishMs(t.finishMs - 500), 500);
  assertEquals(t.remainingToFinishMs(t.finishMs), 0);
  assertEquals(t.remainingToFinishMs(t.finishMs + 10_000), 0);
});

Deno.test("clampToFinishMs - grants the request when it fits, and caps it at the finish less the reserve", () => {
  const t = timelineFor({}, collector().warn);
  const now = t.finishMs - 10_000;
  // 10 s remain; a 3 s reserve leaves 7 s to grant.
  assertEquals(t.clampToFinishMs(5_000, now, 3_000), 5_000);
  assertEquals(t.clampToFinishMs(60_000, now, 3_000), 7_000);
  assertEquals(t.clampToFinishMs(60_000, now, 20_000), 0);
  assertEquals(t.clampToFinishMs(60_000, t.finishMs + 1, 0), 0);
});

Deno.test("describeRunTimeline - with a hard kill, names target, finish and the kill as ISO", () => {
  const t = timelineFor(
    { VIBE_HARD_KILL_AT_EPOCH: String(WATCHDOG_KILL_SECONDS) },
    collector().warn,
  );
  assertEquals(
    describeRunTimeline(t),
    `target=${iso(STARTED_MS + 3_600_000)} finish=${
      iso(STARTED_MS + 7_200_000)
    } hard-kill=${iso(WATCHDOG_KILL_SECONDS * 1000)}`,
  );
});

Deno.test("describeRunTimeline - with no hard kill, says none and gives the reason", () => {
  const t = timelineFor({}, collector().warn);
  assert(t.hardKillReason !== undefined);
  assertEquals(
    describeRunTimeline(t),
    `target=${iso(STARTED_MS + 3_600_000)} finish=${
      iso(STARTED_MS + 7_200_000)
    } hard-kill=none (${t.hardKillReason})`,
  );
});

Deno.test("set/get/reset - the process-wide timeline round-trips and resets", () => {
  resetRunTimelineForTests();
  try {
    assertEquals(getRunTimeline(), undefined);
    const t = timelineFor({}, collector().warn);
    setRunTimeline(t);
    assertStrictEquals(getRunTimeline(), t);
    resetRunTimelineForTests();
    assertEquals(getRunTimeline(), undefined);
  } finally {
    resetRunTimelineForTests();
  }
});

Deno.test("pastRunTarget - with no timeline set, nothing has passed the target for any clock reading", () => {
  resetRunTimelineForTests();
  try {
    assertEquals(pastRunTarget(0), false);
    assertEquals(pastRunTarget(STARTED_MS + 3_600_000), false);
    assertEquals(pastRunTarget(Number.MAX_SAFE_INTEGER), false);
  } finally {
    resetRunTimelineForTests();
  }
});

Deno.test("pastRunTarget - false just before the target, true at it and just after", () => {
  resetRunTimelineForTests();
  try {
    const t = resolveRunTimeline({
      startedMs: STARTED_MS,
      runDurationSeconds: DEFAULT_RUN_TARGET_SECONDS,
      runFinishSeconds: DEFAULT_RUN_FINISH_SECONDS,
      env: () => undefined,
      killAfterSeconds: 30,
      warn: () => {},
    });
    const targetMs = STARTED_MS + 3_600_000;
    assertEquals(t.targetMs, targetMs);
    setRunTimeline(t);
    assertEquals(pastRunTarget(targetMs - 1), false);
    assertEquals(pastRunTarget(targetMs), true);
    assertEquals(pastRunTarget(targetMs + 1), true);
  } finally {
    resetRunTimelineForTests();
  }
});
