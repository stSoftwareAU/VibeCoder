/**
 * Tests for lib/claude_week_pace.ts — skip the backlog tiers while the weekly
 * Claude quota will not last (Issue #1885).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CLAUDE_WEEK_PACE_LOG_PREFIX,
  claudeWeekPaceVerdict,
  createClaudeWeekPaceGate,
  SEVEN_DAY_WINDOW_HOURS,
} from "../lib/claude_week_pace.ts";
import {
  CLAUDE_WEEK_PACE_GRACE_HOURS,
  CLAUDE_WEEK_PACE_THRESHOLD,
} from "../lib/claude_token_selection.ts";
import type { ClaudeTokenBudget } from "../lib/claude_token_budget.ts";
import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

/** The gate is only applicable to a Claude run; tests say which. */
const CLAUDE = resolveAgentProvider(CLAUDE_PROVIDER_ID);

const HOUR_MS = 3_600_000;
const WINDOW_MS = SEVEN_DAY_WINDOW_HOURS * HOUR_MS;
const NOW = Date.parse("2026-09-10T00:00:00.000Z");

/**
 * A known budget whose seven-day window has `elapsedHours` behind it and
 * `usedShare` of the quota spent.
 */
function weekBudget(
  usedShare: number,
  elapsedHours: number,
): ClaudeTokenBudget {
  const resetAt = NOW + WINDOW_MS - elapsedHours * HOUR_MS;
  return {
    known: true,
    label: "week-pace",
    remainingFraction: 1 - usedShare,
    resetAt,
    window: "seven_day",
    windows: [
      // The five-hour window rides along exactly as the probe reports it, to
      // prove the verdict reads the seven-day one and only that one.
      { window: "five_hour", remainingFraction: 0.9, resetAt: NOW + HOUR_MS },
      { window: "seven_day", remainingFraction: 1 - usedShare, resetAt },
    ],
  };
}

Deno.test("claudeWeekPaceVerdict - on pace leaves the gate off", () => {
  // Half the week elapsed, 40% spent: projected 80% at reset.
  const verdict = claudeWeekPaceVerdict(weekBudget(0.4, 84), NOW);
  assertEquals(verdict.state, "off");
  assert(verdict.state === "off");
  assertEquals(verdict.reason, "on-pace");
  assertEquals(verdict.reading.usedShare, 0.4);
  assertEquals(verdict.reading.elapsedShare, 0.5);
  assertEquals(verdict.reading.projectedShare, 0.8);
});

Deno.test("claudeWeekPaceVerdict - over pace engages the gate", () => {
  // Half the week elapsed, 62% spent: projected 124% at reset.
  const verdict = claudeWeekPaceVerdict(weekBudget(0.62, 84), NOW);
  assertEquals(verdict.state, "engaged");
  assert(verdict.state === "engaged");
  assertEquals(verdict.reading.usedShare, 0.62);
  assertEquals(verdict.reading.elapsedShare, 0.5);
  assertEquals(verdict.reading.projectedShare, 1.24);
  assertEquals(verdict.reading.resetAt, NOW + WINDOW_MS - 84 * HOUR_MS);
});

Deno.test("claudeWeekPaceVerdict - exactly on the threshold engages", () => {
  // Projected share lands exactly on the threshold; the target is full use at
  // the reset, so the gate engages at 1.0 rather than above it.
  const elapsedHours = 84;
  const usedShare = CLAUDE_WEEK_PACE_THRESHOLD *
    (elapsedHours / SEVEN_DAY_WINDOW_HOURS);
  const verdict = claudeWeekPaceVerdict(
    weekBudget(usedShare, elapsedHours),
    NOW,
  );
  assertEquals(verdict.state, "engaged");
  assert(verdict.state === "engaged");
  assertEquals(verdict.reading.projectedShare, CLAUDE_WEEK_PACE_THRESHOLD);
});

Deno.test("claudeWeekPaceVerdict - within the first 24h the gate stays off", () => {
  // 20% of the week spent in its first hour projects to 3360%, and is still
  // not judged: one heavy run must not skip the backlog for the whole week.
  const verdict = claudeWeekPaceVerdict(weekBudget(0.2, 1), NOW);
  assertEquals(verdict.state, "off");
  assert(verdict.state === "off");
  assertEquals(verdict.reason, "within-grace");
  // Nothing computed a projection here, so none is reported.
  assertEquals(verdict.reading.projectedShare, null);
});

Deno.test("claudeWeekPaceVerdict - the grace boundary is judged, not skipped", () => {
  const justInside = claudeWeekPaceVerdict(
    weekBudget(0.9, CLAUDE_WEEK_PACE_GRACE_HOURS - 0.001),
    NOW,
  );
  assertEquals(justInside.state, "off");
  const atTheBoundary = claudeWeekPaceVerdict(
    weekBudget(0.9, CLAUDE_WEEK_PACE_GRACE_HOURS),
    NOW,
  );
  assertEquals(atTheBoundary.state, "engaged");
});

Deno.test("claudeWeekPaceVerdict - a reset already in the past leaves it off", () => {
  // The window rolled over after the figure was produced, so its utilisation
  // describes a week that no longer exists.
  const budget: ClaudeTokenBudget = {
    known: true,
    label: "week-pace",
    remainingFraction: 0.01,
    resetAt: NOW - HOUR_MS,
    window: "seven_day",
    windows: [{
      window: "seven_day",
      remainingFraction: 0.01,
      resetAt: NOW - HOUR_MS,
    }],
  };
  const verdict = claudeWeekPaceVerdict(budget, NOW);
  assertEquals(verdict.state, "off");
  assert(verdict.state === "off");
  assertEquals(verdict.reason, "window-elapsed");
  assertEquals(verdict.reading.projectedShare, null);
});

Deno.test("claudeWeekPaceVerdict - an unknown budget is unknown, never engaged", () => {
  const verdict = claudeWeekPaceVerdict(
    { known: false, label: "week-pace", reason: "timeout" },
    NOW,
  );
  assertEquals(verdict.state, "unknown");
  assert(verdict.state === "unknown");
  assertStringIncludes(verdict.reason, "timeout");
});

Deno.test("claudeWeekPaceVerdict - no seven-day window is unknown", () => {
  const budget: ClaudeTokenBudget = {
    known: true,
    label: "week-pace",
    remainingFraction: 0.05,
    resetAt: NOW + HOUR_MS,
    window: "five_hour",
    windows: [{
      window: "five_hour",
      remainingFraction: 0.05,
      resetAt: NOW + HOUR_MS,
    }],
  };
  const verdict = claudeWeekPaceVerdict(budget, NOW);
  assertEquals(verdict.state, "unknown");
});

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

Deno.test("week pace gate - engaged skips the backlog and logs once per reading", async () => {
  const log = sinks();
  let probes = 0;
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => "oauth-token",
    readBudget: () => {
      probes++;
      return Promise.resolve(weekBudget(0.62, 84));
    },
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });

  assertEquals(await gate.isEngaged(NOW), true);
  // A second cycle a minute later reuses the ten-minute snapshot.
  assertEquals(await gate.isEngaged(NOW + 60_000), true);

  assertEquals(probes, 1);
  // One line, not two: the second cycle read the same snapshot, so the same
  // sentence is not repeated once per slot per 30-second cycle.
  assertEquals(log.info.length, 1);
  assertEquals(log.warn.length, 0);
  assertStringIncludes(log.info[0] ?? "", CLAUDE_WEEK_PACE_LOG_PREFIX);
  assertStringIncludes(log.info[0] ?? "", "engaged");
  assertStringIncludes(log.info[0] ?? "", "used=62.0%");
  assertStringIncludes(log.info[0] ?? "", "elapsed=50.0%");
  assertStringIncludes(log.info[0] ?? "", "projected=124.0%");
  assertStringIncludes(log.info[0] ?? "", "at reset 2026-09-13T12:00:00.000Z");
});

Deno.test("week pace gate - re-probes once the snapshot has gone stale", async () => {
  const log = sinks();
  const readings: ClaudeTokenBudget[] = [
    weekBudget(0.62, 84),
    weekBudget(0.4, 84),
  ];
  let probes = 0;
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => "oauth-token",
    readBudget: () => Promise.resolve(readings[probes++] ?? readings[1]!),
    snapshotMaxAgeMs: 10 * 60_000,
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });

  assertEquals(await gate.isEngaged(NOW), true);
  // Eleven minutes on the snapshot is stale, so the fresher reading lifts it.
  assertEquals(await gate.isEngaged(NOW + 11 * 60_000), false);
  assertEquals(probes, 2);
  assertEquals(log.info.length, 2);
  assertEquals(gate.lastEngaged(), false);
  assertStringIncludes(log.info[1] ?? "", "lifted");
  assertStringIncludes(log.info[1] ?? "", "pickup resumed");

  // Once lifted, a further on-pace cycle says nothing more.
  assertEquals(await gate.isEngaged(NOW + 12 * 60_000), false);
  assertEquals(log.info.length, 2);
});

Deno.test("week pace gate - an on-pace week never logs a lift it did not make", async () => {
  const log = sinks();
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => "oauth-token",
    readBudget: () => Promise.resolve(weekBudget(0.4, 84)),
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(await gate.isEngaged(NOW), false);
  assertEquals(log.info.length, 0);
  assertEquals(log.warn.length, 0);
});

Deno.test("week pace gate - an unknown reading warns and never refuses work", async () => {
  const log = sinks();
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => "oauth-token",
    readBudget: () =>
      Promise.resolve({
        known: false as const,
        label: "week-pace",
        reason: "network-error" as const,
      }),
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(await gate.isEngaged(NOW), false);
  assertEquals(await gate.isEngaged(NOW + 60_000), false);
  assertEquals(log.warn.length, 1);
  assertEquals(log.info.length, 0);
  assertStringIncludes(log.warn[0] ?? "", CLAUDE_WEEK_PACE_LOG_PREFIX);
  assertStringIncludes(log.warn[0] ?? "", "unknown");
});

Deno.test("week pace gate - no Claude token means no probe and no line", async () => {
  const log = sinks();
  let probes = 0;
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => null,
    readBudget: () => {
      probes++;
      return Promise.resolve(weekBudget(0.99, 84));
    },
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(await gate.isEngaged(NOW), false);
  assertEquals(probes, 0);
  assertEquals(log.info.length, 0);
  assertEquals(log.warn.length, 0);
});

Deno.test("claudeWeekPaceVerdict - a garbled reset cannot engage the gate", () => {
  // Fail direction: every comparison against NaN is false, so the projection
  // must land on `off`. A reading nothing could compute must never skip a
  // tier.
  const budget: ClaudeTokenBudget = {
    known: true,
    label: "week-pace",
    remainingFraction: 0.01,
    resetAt: Number.NaN,
    window: "seven_day",
    windows: [{
      window: "seven_day",
      remainingFraction: 0.01,
      resetAt: Number.NaN,
    }],
  };
  assertEquals(claudeWeekPaceVerdict(budget, NOW).state, "off");
});

Deno.test("week pace gate - a non-Claude run is never paced by a Claude window", async () => {
  // A stale CLAUDE_CODE_OAUTH_TOKEN in a shared environment must not gate a
  // Codex run's pickup on a quota it is not spending.
  const log = sinks();
  let probes = 0;
  const gate = createClaudeWeekPaceGate({
    provider: resolveAgentProvider(CODEX_PROVIDER_ID),
    token: () => "oauth-token",
    readBudget: () => {
      probes++;
      return Promise.resolve(weekBudget(0.99, 84));
    },
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(await gate.isEngaged(NOW), false);
  assertEquals(probes, 0);
  assertEquals(log.info.length, 0);
  assertEquals(log.warn.length, 0);
});

Deno.test("week pace gate - a mid-run token switch discards the old token's reading", async () => {
  // The credential pool replaces the run's token in place; the snapshot it
  // leaves behind describes a different subscription's week.
  const log = sinks();
  let current = "token-a";
  const budgets: Record<string, ClaudeTokenBudget> = {
    "token-a": weekBudget(0.62, 84),
    "token-b": weekBudget(0.1, 84),
  };
  let probes = 0;
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => current,
    readBudget: () => {
      probes++;
      return Promise.resolve(budgets[current]!);
    },
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });

  assertEquals(await gate.isEngaged(NOW), true);
  current = "token-b";
  // One second later — well inside the ten-minute snapshot — but a different
  // subscription, so the reading is taken again rather than reused.
  assertEquals(await gate.isEngaged(NOW + 1_000), false);
  assertEquals(probes, 2);
  assertEquals(gate.lastEngaged(), false);
});

Deno.test("week pace gate - lastEngaged reports the last verdict without probing", async () => {
  const log = sinks();
  let probes = 0;
  const gate = createClaudeWeekPaceGate({
    provider: CLAUDE,
    token: () => "oauth-token",
    readBudget: () => {
      probes++;
      return Promise.resolve(weekBudget(0.62, 84));
    },
    logInfo: log.logInfo,
    logWarn: log.logWarn,
  });
  assertEquals(gate.lastEngaged(), false);
  assertEquals(await gate.isEngaged(NOW), true);
  assertEquals(gate.lastEngaged(), true);
  assertEquals(gate.lastEngaged(), true);
  assertEquals(probes, 1);
});
