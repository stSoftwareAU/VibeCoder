/**
 * Tests for the pool-wide weekly pace verdict (Issue #2647).
 *
 * The guard still drops `low-priority` and `idle-task` pickup when the week
 * will not last, but "will not last" is judged across every Claude credential
 * in the pool, counting windows that reopen soon. Every test here is a pure
 * function call or an injected gate: no clock, no probe, no subprocess.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CLAUDE_WEEK_PACE_LOG_PREFIX,
  claudePoolWeekPaceVerdict,
  claudeWeekPaceVerdict,
  createClaudeWeekPaceGate,
  formatPoolWeekPaceEngagedLine,
  SEVEN_DAY_WINDOW_HOURS,
} from "../lib/claude_week_pace.ts";
import type { ClaudeTokenBudget } from "../lib/claude_token_budget.ts";
import {
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

const CLAUDE = resolveAgentProvider(CLAUDE_PROVIDER_ID);
const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-09-10T00:00:00.000Z");

/**
 * A credential with `usedShare` of its week spent and its window reopening
 * `resetInHours` from {@link NOW}. A five-hour window rides along, spent, to
 * prove the weekly verdict never reads it.
 */
function credential(
  label: string,
  usedShare: number,
  resetInHours: number,
  now = NOW,
): ClaudeTokenBudget {
  const resetAt = now + resetInHours * HOUR_MS;
  return {
    known: true,
    label,
    remainingFraction: 0,
    resetAt: now + HOUR_MS,
    window: "five_hour",
    windows: [
      { window: "five_hour", remainingFraction: 0, resetAt: now + HOUR_MS },
      { window: "seven_day", remainingFraction: 1 - usedShare, resetAt },
    ],
  };
}

const unknown = (label: string): ClaudeTokenBudget => ({
  known: false,
  label,
  reason: "timeout",
});

// --- The issue's cases, both directions ------------------------------------

Deno.test("pool pace - 95% and 20% used, both resetting in 4 days, beside a fresh third: off", () => {
  // The 95% token alone projects to 222% and would engage the old guard;
  // the pool has 185% of a window left for four days at 1.60%/h (154%).
  const pool = [
    credential("provider", 0.95, 96),
    credential("provider-2", 0.2, 96),
    credential("provider-3", 0, 96),
  ];
  assertEquals(claudeWeekPaceVerdict(pool[0]!, NOW).state, "engaged");
  const verdict = claudePoolWeekPaceVerdict(pool, NOW);
  assertEquals(verdict.state, "off");
  assert(verdict.state === "off");
  assertEquals(verdict.reason, "on-pace");
  assertEquals(verdict.reading.counted, 3);
  assertEquals(verdict.reading.rated, 3);
  assertEquals(verdict.reading.runsOutAt, null);
});

Deno.test("pool pace - 95% and 20% used, both resetting in 4 days, with nothing else: engaged at this rate", () => {
  // Fail direction of the case above: 115% of a window spent in three days
  // is 1.60%/h, so the 85% left runs out ~53 h in, 43 h before either reopens.
  const verdict = claudePoolWeekPaceVerdict([
    credential("provider", 0.95, 96),
    credential("provider-2", 0.2, 96),
  ], NOW);
  assertEquals(verdict.state, "engaged");
  assert(verdict.state === "engaged");
  assertEquals(verdict.reading.nextReopenAt, NOW + 96 * HOUR_MS);
  assert(verdict.reading.runsOutAt !== null);
  assert(verdict.reading.runsOutAt < NOW + 60 * HOUR_MS);
});

Deno.test("pool pace - 95% and 20% used at a slow rate: off", () => {
  // The same shares spent over a longer window (reset in 1 and 2 days) are a
  // slow burn: 0.83%/h against 85% left, and a full window back in 24 h.
  const verdict = claudePoolWeekPaceVerdict([
    credential("provider", 0.95, 24),
    credential("provider-2", 0.2, 48),
  ], NOW);
  assertEquals(verdict.state, "off");
});

Deno.test("pool pace - every credential spent a day before any reset: engaged", () => {
  const pool = [
    credential("provider", 0.7, 72),
    credential("provider-2", 0.7, 72),
    credential("provider-3", 0.7, 80),
  ];
  const verdict = claudePoolWeekPaceVerdict(pool, NOW);
  assertEquals(verdict.state, "engaged");
  assert(verdict.state === "engaged");
  assertEquals(verdict.reading.nextReopenAt, NOW + 72 * HOUR_MS);
  assert(verdict.reading.runsOutAt !== null);
  assert(
    verdict.reading.runsOutAt <= NOW + (72 - 24) * HOUR_MS,
    "capacity runs out at least a day before the first reopening",
  );
});

Deno.test("pool pace - one credential spent, another reopening in 2 h with enough to cover: off", () => {
  // provider is spent until 40 h out; provider-2 has half its window left
  // and reopens in 2 h with a full one, which covers the 38 h that follow.
  const verdict = claudePoolWeekPaceVerdict([
    credential("provider", 1, 40),
    credential("provider-2", 0.5, 2),
  ], NOW);
  assertEquals(verdict.state, "off");
  assert(verdict.state === "off");
  assertEquals(verdict.reason, "on-pace");
  assertEquals(verdict.reading.nextReopenAt, NOW + 2 * HOUR_MS);
});

Deno.test("pool pace - one credential spent, the other not reopening for 100 h: engaged", () => {
  // Fail direction: the same half-window with no reopening in reach runs
  // out ~33 h in, before the spent credential reopens at 40 h.
  const verdict = claudePoolWeekPaceVerdict([
    credential("provider", 1, 40),
    credential("provider-2", 0.5, 100),
  ], NOW);
  assertEquals(verdict.state, "engaged");
  assert(verdict.state === "engaged");
  assertEquals(verdict.reading.nextReopenAt, NOW + 40 * HOUR_MS);
});

Deno.test("pool pace - a single credential behaves exactly as the single-token verdict", () => {
  // Every state and reason, across the grace, the threshold and a rolled-over
  // window, matches the pre-#2647 verdict.
  for (const used of [0, 0.1, 0.25, 0.4, 0.5, 0.62, 0.9, 1]) {
    for (const elapsed of [0, 12, 23.999, 24, 48, 84, 120, 167, 170]) {
      const resetIn = SEVEN_DAY_WINDOW_HOURS - elapsed;
      const budget = credential("provider", used, resetIn);
      for (const drain of [false, true]) {
        const single = claudeWeekPaceVerdict(budget, NOW, { drain });
        const pool = claudePoolWeekPaceVerdict([budget], NOW, { drain });
        const label = `used=${used} elapsed=${elapsed}h drain=${drain}`;
        assertEquals(pool.state, single.state, label);
        if (pool.state === "off" && single.state === "off") {
          assertEquals(pool.reason, single.reason, label);
        }
      }
    }
  }
  // Unknown stays unknown.
  assertEquals(
    claudePoolWeekPaceVerdict([unknown("provider")], NOW).state,
    "unknown",
  );
});

Deno.test("pool pace - unknown readings leave the gate off", () => {
  const verdict = claudePoolWeekPaceVerdict(
    [unknown("provider"), unknown("provider-2")],
    NOW,
  );
  assertEquals(verdict.state, "unknown");
  assert(verdict.state === "unknown");
  assertStringIncludes(verdict.reason, "provider-2: timeout");
});

Deno.test("pool pace - an unknown credential is left out, not counted as headroom", () => {
  // The known credential alone is over pace; an unmeasured one beside it is
  // no evidence of budget, so the verdict still engages.
  const verdict = claudePoolWeekPaceVerdict([
    credential("provider", 0.62, 84),
    unknown("provider-2"),
  ], NOW);
  assertEquals(verdict.state, "engaged");
  assert(verdict.state === "engaged");
  assertEquals(verdict.reading.counted, 1);
  assertEquals(verdict.reading.total, 2);
});

Deno.test("pool pace - the five-hour window never drives the weekly verdict", () => {
  // Five-hour-only readings (a recorded five-hour exhaustion) say nothing
  // about the week: unknown, never engaged.
  const fiveHourOnly: ClaudeTokenBudget = {
    known: true,
    label: "provider",
    remainingFraction: 0,
    resetAt: NOW + HOUR_MS,
    window: "five_hour",
    windows: [{
      window: "five_hour",
      remainingFraction: 0,
      resetAt: NOW + HOUR_MS,
    }],
  };
  assertEquals(
    claudePoolWeekPaceVerdict(
      [fiveHourOnly, { ...fiveHourOnly, label: "provider-2" }],
      NOW,
    ).state,
    "unknown",
  );
  // And a spent five-hour window on every credential of an on-pace week is
  // off: the fixture's five-hour windows are all at zero.
  assertEquals(
    claudePoolWeekPaceVerdict([
      credential("provider", 0.3, 84),
      credential("provider-2", 0.3, 84),
    ], NOW).state,
    "off",
  );
});

Deno.test("pool pace - credentials inside the grace are left out of the rate", () => {
  // 30% spent in a window's first hour would read as a catastrophic burn.
  const verdict = claudePoolWeekPaceVerdict([
    credential("provider", 0.3, 167),
    credential("provider-2", 0.3, 84),
  ], NOW);
  assertEquals(verdict.state, "off");
  assert(verdict.state === "off");
  assertEquals(verdict.reading.rated, 1);
  const young = claudePoolWeekPaceVerdict([
    credential("provider", 0.9, 167),
    credential("provider-2", 0.9, 160),
  ], NOW);
  assertEquals(young.state, "off");
  assert(young.state === "off");
  assertEquals(young.reason, "within-grace");
});

Deno.test("pool pace - drain mode keeps a pool that will not last off", () => {
  const pool = [
    credential("provider", 0.7, 72),
    credential("provider-2", 0.7, 72),
  ];
  assertEquals(claudePoolWeekPaceVerdict(pool, NOW).state, "engaged");
  const drained = claudePoolWeekPaceVerdict(pool, NOW, { drain: true });
  assertEquals(drained.state, "off");
  assert(drained.state === "off");
  assertEquals(drained.reason, "drain");
});

Deno.test("pool pace - GRQ-23 at 2026-09-25 06:54Z: the pool itself would not last", () => {
  // The readings the host logged ten minutes earlier: provider-2 at 68% used
  // (the held token the old guard judged), provider-3 at 99% reopening at
  // 09:00Z, provider at 90% reopening 2026-09-29 01:00Z.
  const now = Date.parse("2026-09-25T06:54:56.000Z");
  const at = (iso: string) => (Date.parse(iso) - now) / HOUR_MS;
  const verdict = claudePoolWeekPaceVerdict([
    credential("provider", 0.9, at("2026-09-29T01:00:00.000Z"), now),
    credential("provider-2", 0.68, at("2026-09-29T22:00:00.000Z"), now),
    credential("provider-3", 0.99, at("2026-09-25T09:00:00.000Z"), now),
  ], now);
  assertEquals(verdict.state, "engaged");
  assert(verdict.state === "engaged");
  assertEquals(verdict.reading.counted, 3);
  assertEquals(verdict.reading.nextReopenAt, Date.parse("2026-09-29T01:00Z"));
  // 2.95%/h against 43% now plus provider-3's fresh window at 09:00Z.
  assertEquals(verdict.reading.burnPerHour.toFixed(4), "0.0295");
  assert(verdict.reading.runsOutAt !== null);
  assertEquals(
    new Date(verdict.reading.runsOutAt).toISOString().slice(0, 13),
    "2026-09-27T07",
  );
});

// --- The log line -----------------------------------------------------------

Deno.test("pool pace - the engaged line reports the pool figures", () => {
  const verdict = claudePoolWeekPaceVerdict([
    credential("provider", 1, 40),
    credential("provider-2", 0.5, 100),
    unknown("provider-3"),
  ], NOW);
  assert(verdict.state === "engaged");
  const line = formatPoolWeekPaceEngagedLine(verdict.reading);
  assertStringIncludes(line, CLAUDE_WEEK_PACE_LOG_PREFIX);
  assertStringIncludes(line, "counted=2/3");
  assertStringIncludes(line, "remaining=50.0%");
  assertStringIncludes(line, "burn=1.52%/h");
  assertStringIncludes(line, "runs-out=2026-09-11T08:");
  assertStringIncludes(line, "next-reopen=2026-09-11T16:00:00.000Z");
});

// --- The gate ---------------------------------------------------------------

/** Collect the lines a gate logs, by level. */
function sinks() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    logInfo: (m: string) => info.push(m),
    logWarn: (m: string) => warn.push(m),
  };
}

const TOKEN = "sk-ant-oat01-pool-pace-fixture"; // gitleaks:allow fake fixture, not a real key

Deno.test("pool pace gate - a pooled host is judged across the pool, not the held token", async () => {
  const log = sinks();
  let singleProbes = 0;
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => TOKEN,
    // The held token alone is over pace …
    readBudget: () => {
      singleProbes++;
      return Promise.resolve(credential("provider", 0.95, 96));
    },
    // … but the pool has a fresh credential beside it.
    readPoolBudgets: () =>
      Promise.resolve([
        credential("provider", 0.95, 96),
        credential("provider-2", 0.2, 96),
        credential("provider-3", 0, 96),
      ]),
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(await gate.isEngaged(NOW), false);
  assertEquals(gate.lastEngaged(), false);
  assertEquals(singleProbes, 0);
  assertEquals(log.info, []);
  assertEquals(log.warn, []);
});

Deno.test("pool pace gate - engages and lifts on the pool verdict, logging each once", async () => {
  const log = sinks();
  let pool = [
    credential("provider", 0.7, 72),
    credential("provider-2", 0.7, 72),
  ];
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => TOKEN,
    readPoolBudgets: () => Promise.resolve(pool),
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(await gate.isEngaged(NOW), true);
  assertEquals(await gate.isEngaged(NOW), true);
  assertEquals(gate.lastEngaged(), true);
  pool = [...pool, credential("provider-3", 0, 100)];
  assertEquals(await gate.isEngaged(NOW), false);
  assertEquals(log.info.length, 2);
  assertStringIncludes(log.info[0] ?? "", "engaged — pool counted=2/2");
  assertStringIncludes(log.info[1] ?? "", "lifted — pool counted=3/3");
  for (const line of [...log.info, ...log.warn]) {
    assert(!line.includes(TOKEN), "a token value never reaches a log line");
  }
});

Deno.test("pool pace gate - a single-token host keeps the single-token path", async () => {
  const log = sinks();
  let singleProbes = 0;
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => TOKEN,
    readBudget: () => {
      singleProbes++;
      return Promise.resolve(credential("provider", 0.62, 84));
    },
    readPoolBudgets: () => Promise.resolve(null),
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(await gate.isEngaged(NOW), true);
  assertEquals(singleProbes, 1);
  assertStringIncludes(log.info[0] ?? "", "used=62.0%");
});

Deno.test("pool pace gate - unknown pool readings warn and never refuse work", async () => {
  const log = sinks();
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => TOKEN,
    readPoolBudgets: () =>
      Promise.resolve([unknown("provider"), unknown("provider-2")]),
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(await gate.isEngaged(NOW), false);
  assertEquals(log.warn.length, 1);
  assertStringIncludes(log.warn[0] ?? "", "unknown");
});

Deno.test("pool pace gate - a pool read that throws warns and never refuses work", async () => {
  const log = sinks();
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => TOKEN,
    readPoolBudgets: () => Promise.reject(new TypeError(TOKEN)),
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(await gate.isEngaged(NOW), false);
  assertEquals(log.warn.length, 1);
  assertStringIncludes(log.warn[0] ?? "", "could not be read (TypeError)");
  assert(!log.warn[0]!.includes(TOKEN));
});
