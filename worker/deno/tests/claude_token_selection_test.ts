/**
 * Tests for budget-based Claude token selection at worker start (Issue #919,
 * parent #902).
 *
 * What was broken: a host holding two Claude subscriptions always started on
 * whichever token discovery listed first (#917's `selectFirstProviderToken`),
 * so one subscription was burned to exhaustion while the other sat idle and an
 * operator had to swap files between runs by hand. #918 can measure one
 * token's remaining budget; nothing joined the two.
 *
 * Issue #1623 then made the five-hour window a gate and ranked on the
 * seven-day remaining share per hour until reset. The owner replaced that
 * per-hour rate (Issue #4504): the token with the most seven-day quota left
 * wins. Cases below that assert the new outcome where they used to assert the
 * old one say so at the point they do.
 *
 * These tests pin the join, and each rule is one that would silently degrade
 * rather than fail visibly if it regressed:
 *
 * - a token that has burned over 80% of its five-hour window ranks behind
 *   every token that has not — it cannot spend what its week still holds;
 * - the winner really is the passing token with the largest remaining share
 *   of its seven-day window, not the one whose window resets soonest;
 * - a zero-share weekly window with a future reset is exhausted and ranks
 *   after other gate-passing tokens, without changing five-hour failure order;
 * - a token whose window has already reset counts as full, not as the stale
 *   near-exhausted figure the probe reported for a window that has gone;
 * - a token that could not be probed ranks last but never disappears, and a
 *   pool where every probe failed still starts the worker on the primary
 *   token — a network fault must never refuse to start a run;
 * - a host with fewer than two pool candidates makes no request at all, so
 *   every single-token host today pays nothing;
 * - the probes run concurrently, so startup is one round trip, not N;
 * - selection happens once per process start and nothing re-selects after it;
 * - no token value reaches the decision log.
 *
 * Every test injects `fetchFn` and the clock, so nothing here touches the
 * network, sleeps, or spawns a process, and nothing mutates process-wide state
 * — the file stays out of `parallel_safety_cap_test.ts`'s list (Issue #880).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  ClaudeBudgetWindowName,
  ClaudeTokenBudget,
  ClaudeTokenBudgetUnknownReason,
  ClaudeTokenBudgetWindow,
} from "../lib/claude_token_budget.ts";
import {
  createClaudeBudgetTokenSelector,
  formatClaudeTokenSelectionLog,
  rankClaudeTokenBudgets,
} from "../lib/claude_token_selection.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";
import {
  type AgentProviderDescriptor,
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

/** A fixed "now" for every ranking test — 2026-09-04T00:00:00Z. */
const NOW = Date.UTC(2026, 8, 4, 0, 0, 0);

/** One hour, in milliseconds. */
const HOUR = 3_600_000;

const CLAUDE: AgentProviderDescriptor = resolveAgentProvider(
  CLAUDE_PROVIDER_ID,
);

/** A probe result for a token that reported exactly one window. */
function known(
  label: string,
  remainingFraction: number,
  resetAt: number,
  window: ClaudeBudgetWindowName = "five_hour",
): ClaudeTokenBudget {
  return dual(label, [{ window, remainingFraction, resetAt }]);
}

/**
 * A probe result for a token that reported both windows, as the live endpoint
 * does — the shape Issue #1623 ranks on.
 */
function dual(
  label: string,
  windows: readonly ClaudeTokenBudgetWindow[],
): ClaudeTokenBudget {
  // The headline stays what #918 reports: the most constrained window.
  const headline = windows.reduce((best, candidate) =>
    candidate.remainingFraction < best.remainingFraction ? candidate : best
  );
  return {
    known: true,
    label,
    remainingFraction: headline.remainingFraction,
    resetAt: headline.resetAt,
    window: headline.window,
    windows,
  };
}

/** A five-hour window, spelled out at the call site. */
function fiveHour(
  remainingFraction: number,
  resetAt: number,
): ClaudeTokenBudgetWindow {
  return { window: "five_hour", remainingFraction, resetAt };
}

/** A seven-day window, spelled out at the call site. */
function sevenDay(
  remainingFraction: number,
  resetAt: number,
): ClaudeTokenBudgetWindow {
  return { window: "seven_day", remainingFraction, resetAt };
}

/** A probe result for a token whose budget could not be determined. */
function unknown(
  label: string,
  reason: ClaudeTokenBudgetUnknownReason = "network-error",
): ClaudeTokenBudget {
  return { known: false, label, reason };
}

/** A discovered pool token file, as #917 would have returned it. */
function tokenFile(
  label: string,
  value: string,
  options: { poolMember?: boolean; name?: string } = {},
): ProviderTokenFile {
  const name = options.name ?? "CLAUDE_CODE_OAUTH_TOKEN";
  return {
    label,
    path: `/creds/claude/${label}.env`,
    name,
    value,
    primary: label === "provider",
    poolMember: options.poolMember ?? true,
    entries: [{ name, value }],
  };
}

/** A `200` carrying one well-formed five-hour window. */
function budgetResponse(utilisation: number, resetEpochSeconds: number) {
  return new Response(JSON.stringify({ content: [] }), {
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": String(utilisation),
      "anthropic-ratelimit-unified-5h-reset": String(resetEpochSeconds),
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
    },
  });
}

/** A fetch stub that counts calls and answers per bearer token. */
function fetchByToken(answer: (token: string) => Response) {
  const bearers: string[] = [];
  return {
    calls: () => bearers.length,
    bearers: () => bearers,
    fetchFn: (_url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const bearer = (headers["authorization"] ?? "").replace("Bearer ", "");
      bearers.push(bearer);
      return Promise.resolve(answer(bearer));
    },
  };
}

// ---------------------------------------------------------------------------
// The pure ranking function
// ---------------------------------------------------------------------------

Deno.test("ranking returns the passing token with the largest remaining share of its own window (Issue #4504)", () => {
  // Different reset days between two weekly tokens. Under #1623's per-hour
  // rule provider-3's 44% over four hours beat provider-2's 81% over five
  // days; now the larger share wins whatever its reset.
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.10, NOW + 2 * HOUR, "five_hour"),
    known("provider-2", 0.81, NOW + 5 * 24 * HOUR, "seven_day"),
    known("provider-3", 0.44, NOW + 4 * HOUR, "seven_day"),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "most-seven-day-remaining");
  assertEquals(
    ranking.ranked.map((r) => r.label),
    // provider is last: 10% of its five-hour window fails the gate.
    ["provider-2", "provider-3", "provider"],
  );
});

Deno.test("ranking prefers 90% of a week resetting in six days over 20% resetting in six hours (Issue #4504)", () => {
  // The case that tells the two rules apart. Under #1623's per-hour rule
  // provider won: 20%/6h is 3.33%/h against 90%/144h at 0.63%/h. Issue #4504
  // specifies the most weekly quota left, so provider-2 wins.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.95, NOW + 3 * HOUR),
      sevenDay(0.20, NOW + 6 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.95, NOW + 4 * HOUR),
      sevenDay(0.90, NOW + 6 * 24 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "most-seven-day-remaining");
  assertEquals(ranking.winner?.remainingFraction, 0.90);
  assertEquals(ranking.ranked.map((r) => r.label), ["provider-2", "provider"]);
});

Deno.test("ranking keeps weekly telemetry ahead of the non-weekly fallback (Issue #4503)", () => {
  const ranking = rankClaudeTokenBudgets([
    known("weekless", 0.95, NOW + 5 * HOUR, "five_hour"),
    known("weekly", 0.05, NOW + 100 * HOUR, "seven_day"),
  ], NOW);

  assertEquals(ranking.ranked.map((candidate) => candidate.label), [
    "weekly",
    "weekless",
  ]);
  assertEquals(ranking.ranked[0]?.hasSevenDayTelemetry, true);
  assertEquals(ranking.ranked[1]?.hasSevenDayTelemetry, false);
});

const WEEKLY_TELEMETRY_CASES: readonly {
  name: string;
  budgets: readonly ClaudeTokenBudget[];
  order: readonly string[];
  reason: string;
}[] = [
  {
    name: "weekly telemetry precedes a larger weekless share (Issue #4503)",
    budgets: [
      known("weekless", 0.60, NOW + 4 * HOUR, "five_hour"),
      known("weekly", 0.50, NOW + 144 * HOUR, "seven_day"),
    ],
    order: ["weekly", "weekless"],
    reason: "most-seven-day-remaining",
  },
  {
    name: "weekly telemetry precedes a weekless 95% share (Issue #4503)",
    budgets: [
      known("weekless", 0.95, NOW + 5 * HOUR, "five_hour"),
      known("weekly", 0.90, NOW + 100 * HOUR, "seven_day"),
    ],
    order: ["weekly", "weekless"],
    reason: "most-seven-day-remaining",
  },
  {
    name: "weekly credentials rank by share, not rate (Issue #4503)",
    budgets: [
      known("slow", 0.50, NOW + 144 * HOUR, "seven_day"),
      known("fast", 0.20, NOW + 24 * HOUR, "seven_day"),
    ],
    order: ["slow", "fast"],
    reason: "most-seven-day-remaining",
  },
  {
    name:
      "weekless fallback credentials rank by their reported share (Issue #4503)",
    budgets: [
      known("low", 0.40, NOW + 2 * HOUR, "five_hour"),
      known("high", 0.60, NOW + 4 * HOUR, "five_hour"),
      known("middle", 0.50, NOW + 2 * HOUR, "five_hour"),
    ],
    order: ["high", "middle", "low"],
    reason: "most-seven-day-remaining",
  },
  {
    name: "weekless equal shares use reset then discovery order (Issue #4503)",
    budgets: [
      known("first", 0.40, NOW + 2 * HOUR, "five_hour"),
      known("second", 0.40, NOW + 2 * HOUR, "five_hour"),
    ],
    order: ["first", "second"],
    reason: "tied-discovery-order",
  },
  {
    name:
      "weekly share and reset order precede weekless fallback order (Issue #4503)",
    budgets: [
      known("weekless-low", 0.30, NOW + 5 * HOUR, "five_hour"),
      known("weekly-later", 0.50, NOW + 144 * HOUR, "seven_day"),
      known("weekless-high", 0.60, NOW + 2 * HOUR, "five_hour"),
      known("weekly-sooner", 0.50, NOW + 24 * HOUR, "seven_day"),
    ],
    order: ["weekly-sooner", "weekly-later", "weekless-high", "weekless-low"],
    reason: "equal-seven-day-remaining-soonest-reset",
  },
  {
    name:
      "a passing weekless token outranks a weekly gate failure (Issue #4503)",
    budgets: [
      dual("weekly-failed", [
        fiveHour(0.19, NOW + HOUR),
        sevenDay(0.90, NOW + 100 * HOUR),
      ]),
      known("weekless-passing", 0.21, NOW + 5 * HOUR, "five_hour"),
    ],
    order: ["weekless-passing", "weekly-failed"],
    reason: "most-seven-day-remaining",
  },
  {
    name: "a weekly pass outranks a weekless gate failure (Issue #4503)",
    budgets: [
      known("weekless-failed", 0.19, NOW + 4 * HOUR, "five_hour"),
      dual("weekly-passing", [
        fiveHour(0.21, NOW + HOUR),
        sevenDay(0.90, NOW + 100 * HOUR),
      ]),
    ],
    order: ["weekly-passing", "weekless-failed"],
    reason: "most-seven-day-remaining",
  },
  {
    name:
      "a usable weekly token under 10% stays ahead of weekless fallback (Issue #4503)",
    budgets: [
      known("weekly-low", 0.05, NOW + 2 * HOUR, "seven_day"),
      known("weekless", 0.30, NOW + 5 * HOUR, "five_hour"),
    ],
    order: ["weekly-low", "weekless"],
    reason: "most-seven-day-remaining",
  },
  {
    name: "gate failures keep their five-hour reset order (Issue #4503)",
    budgets: [
      dual("weekly-late", [
        fiveHour(0.10, NOW + 3 * HOUR),
        sevenDay(0.80, NOW + 100 * HOUR),
      ]),
      known("weekless-soon", 0.10, NOW + HOUR, "five_hour"),
    ],
    order: ["weekless-soon", "weekly-late"],
    reason: "five-hour-gate-failed-soonest-reset",
  },
  {
    name:
      "unknown budgets remain last behind weekly and fallback readings (Issue #4503)",
    budgets: [
      unknown("unknown"),
      known("weekless", 0.40, NOW + 2 * HOUR, "five_hour"),
    ],
    order: ["weekless", "unknown"],
    reason: "most-seven-day-remaining",
  },
];

for (const row of WEEKLY_TELEMETRY_CASES) {
  Deno.test(row.name, () => {
    const ranking = rankClaudeTokenBudgets(row.budgets, NOW);
    assertEquals(ranking.ranked.length, row.budgets.length, "nothing dropped");
    assertEquals(ranking.ranked.map((candidate) => candidate.label), row.order);
    assertEquals(ranking.winner?.label, row.order[0]);
    assertEquals(ranking.reason, row.reason);
  });
}

Deno.test("all weekless tokens with an equal share pick the same winner on every call (Issue #4503)", () => {
  const budgets = [
    known("provider", 0.4, NOW + 2 * HOUR, "five_hour"),
    known("provider-2", 0.4, NOW + 2 * HOUR, "five_hour"),
  ];
  for (let call = 0; call < 3; call++) {
    const ranking = rankClaudeTokenBudgets(budgets, NOW);
    assertEquals(ranking.winner?.label, "provider");
    assertEquals(ranking.ranked.length, 2);
  }
});

Deno.test("a later snapshot that reports a seven-day window restores weekly ranking (Issue #4503)", () => {
  const before = rankClaudeTokenBudgets([
    known("provider", 0.9, NOW + 100 * HOUR, "seven_day"),
    known("provider-2", 0.95, NOW + 5 * HOUR, "five_hour"),
  ], NOW);
  assertEquals(before.ranked.map((r) => r.label), ["provider", "provider-2"]);
  assertEquals(before.ranked[1]?.hasSevenDayTelemetry, false);

  // The same label now reports both windows. Nothing is remembered between
  // calls, so provider-2 is ranked on its seven-day 95% and now beats
  // provider's 90%; had the weekless reading been remembered it would stay
  // behind the weekly token.
  const after = rankClaudeTokenBudgets([
    known("provider", 0.9, NOW + 100 * HOUR, "seven_day"),
    dual("provider-2", [
      fiveHour(0.95, NOW + 5 * HOUR),
      sevenDay(0.95, NOW + 24 * HOUR),
    ]),
  ], NOW);
  assertEquals(after.ranked.map((r) => r.label), ["provider-2", "provider"]);
  assertEquals(after.winner?.hasSevenDayTelemetry, true);
  assertEquals(after.winner?.rankWindow?.window, "seven_day");
  assertEquals(after.winner?.remainingFraction, 0.95);
  assertEquals(after.reason, "most-seven-day-remaining");
});

Deno.test("ranked entries report whether the probe reported a seven-day window (Issue #4503)", () => {
  const ranking = rankClaudeTokenBudgets([
    known("weekless", 0.4, NOW + 2 * HOUR, "five_hour"),
    dual("both", [
      fiveHour(0.9, NOW + 2 * HOUR),
      sevenDay(0.5, NOW + 100 * HOUR),
    ]),
    known("weekly", 0.5, NOW + 100 * HOUR, "seven_day"),
    unknown("unknown"),
  ], NOW);
  assertEquals(
    Object.fromEntries(
      ranking.ranked.map((r) => [r.label, r.hasSevenDayTelemetry]),
    ),
    { weekless: false, both: true, weekly: true, unknown: false },
  );
});

Deno.test("ranking gates on the five-hour window before it looks at the seven-day share (Issue #1623)", () => {
  // provider has twice the seven-day quota left, but 19% of its five-hour
  // window is left — over 80% used — so it cannot spend that budget now.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.19, NOW + 2 * HOUR),
      sevenDay(0.60, NOW + 6 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.40, NOW + 2 * HOUR),
      sevenDay(0.30, NOW + 100 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.winner?.passesFiveHourGate, true);
  assertEquals(ranking.ranked[1]?.label, "provider");
  assertEquals(ranking.ranked[1]?.passesFiveHourGate, false);
});

Deno.test("ranking puts a token at 80% of its five-hour window behind one at 79% (Issue #1623)", () => {
  // The gate boundary, stated as the shares themselves rather than as
  // `1 - 0.80`: at exactly 20% left the token has used exactly 80% and fails,
  // at 21% left it has used 79% and passes. The two are otherwise identical,
  // so nothing but the gate can decide the order — and no floating-point
  // artefact can make the test pass for the wrong reason.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.20, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 24 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.21, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 24 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.ranked[0]?.passesFiveHourGate, true);
  assertEquals(ranking.ranked[1]?.label, "provider");
  assertEquals(ranking.ranked[1]?.passesFiveHourGate, false);
});

Deno.test("the gate reads the utilisation the probe actually reports (Issue #1623)", () => {
  // The probe reports remaining as `1 - utilisation`, which is not exact:
  // 80% used arrives as 0.19999999999999996 and 79% as 0.20999999999999996.
  // Both sides of the boundary must still land where they belong.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [fiveHour(1 - 0.80, NOW + 2 * HOUR)]),
    dual("provider-2", [fiveHour(1 - 0.79, NOW + 2 * HOUR)]),
  ], NOW);

  assertEquals(ranking.ranked[0]?.label, "provider-2");
  assertEquals(ranking.ranked[0]?.passesFiveHourGate, true);
  assertEquals(ranking.ranked[1]?.passesFiveHourGate, false);
});

Deno.test("ranking puts a nearly spent week last among the passing tokens, however soon it resets (Issue #4504)", () => {
  // provider resets in an hour, but 8% of a week is the least left of the
  // three, so it ranks last with no floor band of its own.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.08, NOW + HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.11, NOW + 100 * HOUR),
    ]),
    dual("provider-3", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.95, NOW + 160 * HOUR),
    ]),
  ], NOW);

  assertEquals(
    ranking.ranked.map((r) => r.label),
    ["provider-3", "provider-2", "provider"],
  );
  assertEquals(ranking.winner?.label, "provider-3");
});

Deno.test("ranking demotes an exhausted week with fresh five-hour capacity but keeps it ahead of gate failures", () => {
  const ranking = rankClaudeTokenBudgets([
    dual("spent-week", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0, NOW + 72 * HOUR),
    ]),
    known("weekless", 0.30, NOW + 4 * HOUR, "five_hour"),
    dual("five-hour-failed", [
      fiveHour(0.10, NOW + HOUR),
      sevenDay(0.90, NOW + 100 * HOUR),
    ]),
  ], NOW);

  assertEquals(
    ranking.ranked.map((candidate) => candidate.label),
    ["weekless", "spent-week", "five-hour-failed"],
  );
  assertEquals(ranking.ranked[1]?.sevenDaySpent, true);
  assertEquals(ranking.ranked[1]?.passesFiveHourGate, true);
  assertEquals(ranking.reason, "most-seven-day-remaining");
});

Deno.test("ranking uses five-hour reset order when both windows are exhausted", () => {
  const ranking = rankClaudeTokenBudgets([
    dual("later-five-hour", [
      fiveHour(0, NOW + 3 * HOUR),
      sevenDay(0, NOW + 72 * HOUR),
    ]),
    dual("sooner-five-hour", [
      fiveHour(0, NOW + HOUR),
      sevenDay(0, NOW + 100 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "sooner-five-hour");
  assertEquals(ranking.reason, "five-hour-gate-failed-soonest-reset");
});

Deno.test("ranking names weekly exhaustion separately from the removed low-share band", () => {
  const ranking = rankClaudeTokenBudgets([
    dual("spent-week", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0, NOW + 72 * HOUR),
    ]),
  ], NOW);
  assertEquals(ranking.winner?.sevenDaySpent, true);
  assertEquals(ranking.reason, "seven-day-spent-soonest-reset");
});

Deno.test("ranking orders spent weeks by reset, then discovery order", () => {
  const ranking = rankClaudeTokenBudgets([
    known("later", 0, NOW + 72 * HOUR, "seven_day"),
    known("soon-first", 0, NOW + 24 * HOUR, "seven_day"),
    known("soon-second", 0, NOW + 24 * HOUR, "seven_day"),
  ], NOW);
  assertEquals(
    ranking.ranked.map((candidate) => candidate.label),
    ["soon-first", "soon-second", "later"],
  );
  assertEquals(ranking.reason, "seven-day-spent-soonest-reset");
});

Deno.test("ranking distinguishes equal shares across gate bands in the selection reason", () => {
  const reset = NOW + 24 * HOUR;
  const ranking = rankClaudeTokenBudgets([
    dual("failed", [fiveHour(0.1, NOW + HOUR), sevenDay(0.5, reset)]),
    dual("passing", [fiveHour(0.9, NOW + HOUR), sevenDay(0.5, reset)]),
  ], NOW);
  assertEquals(ranking.winner?.label, "passing");
  assertEquals(ranking.reason, "most-seven-day-remaining");
  assertStringIncludes(
    formatClaudeTokenSelectionLog(ranking).at(-1) ?? "",
    "selected passing (#2) of 2: most-seven-day-remaining",
  );
});

Deno.test("ranking distinguishes equal shares across telemetry types in the selection reason", () => {
  const reset = NOW + 24 * HOUR;
  const ranking = rankClaudeTokenBudgets([
    known("weekless", 0.5, reset),
    known("weekly", 0.5, reset, "seven_day"),
  ], NOW);
  assertEquals(ranking.winner?.label, "weekly");
  assertEquals(ranking.reason, "most-seven-day-remaining");
  assertStringIncludes(
    formatClaudeTokenSelectionLog(ranking).at(-1) ?? "",
    "selected weekly (#2) of 2: most-seven-day-remaining",
  );
});

Deno.test("ranking returns an unknown reading without inventing a rank window or weekly exhaustion", () => {
  const budget = unknown("unmeasured", "timeout");
  const ranking = rankClaudeTokenBudgets([budget], NOW);
  assertEquals(ranking.winner, {
    label: "unmeasured",
    index: 0,
    budget,
    fiveHour: null,
    rankWindow: null,
    hasSevenDayTelemetry: false,
    sevenDaySpent: false,
    passesFiveHourGate: false,
    remainingFraction: null,
    resetAt: null,
    windowElapsed: false,
  });
});

Deno.test("ranking orders two nearly spent weeks by share then soonest reset, still ahead of a gate failure (Issue #4504)", () => {
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.05, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 10 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.05, NOW + 100 * HOUR),
    ]),
    dual("provider-3", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.05, NOW + 10 * HOUR),
    ]),
  ], NOW);

  assertEquals(
    ranking.ranked.map((r) => r.label),
    ["provider-3", "provider-2", "provider"],
  );
  // Rewritten for Issue #4504: the 10% floor band and its
  // `low-seven-day-remaining-highest-rate` reason are gone, so two equal 5%
  // shares are split by the sooner reset like any other tie.
  assertEquals(ranking.reason, "equal-seven-day-remaining-soonest-reset");
});

Deno.test("ranking orders gate-failing tokens by the soonest five-hour reset (Issue #1623)", () => {
  // Nothing passes the gate, so the winner is whichever refills first.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.02, NOW + 4 * HOUR),
      sevenDay(0.90, NOW + 160 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.01, NOW + HOUR),
      sevenDay(0.20, NOW + 160 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "five-hour-gate-failed-soonest-reset");
  assertEquals(
    ranking.ranked.map((r) => r.label),
    ["provider-2", "provider"],
  );
});

Deno.test("ranking spends equal headroom that expires soonest first (Issue #919)", () => {
  // Equal headroom: spend the one that expires first, or it lapses unused.
  // Rewritten for Issue #4504: under #1623 the sooner
  // reset was a higher rate; now it is the tie-break on an equal share.
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.5, NOW + 20 * HOUR),
    known("provider-2", 0.5, NOW + 3 * HOUR),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "equal-seven-day-remaining-soonest-reset");
});

Deno.test("ranking breaks an equal seven-day share towards the soonest reset (Issue #4504)", () => {
  // Rewritten for Issue #4504: this used to pin 40%/20h
  // against 20%/10h as an equal rate; equal shares are the tie now.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.40, NOW + 20 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.40, NOW + 10 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "equal-seven-day-remaining-soonest-reset");
});

Deno.test("ranking puts an unknown budget behind every known one without dropping it (Issue #919)", () => {
  // The unknown token is last, but it is still a candidate: a probe failure
  // must not make a configured subscription disappear.
  const ranking = rankClaudeTokenBudgets([
    unknown("provider", "http-401"),
    known("provider-2", 0.02, NOW + HOUR),
    known("provider-3", 0.90, NOW + HOUR),
  ], NOW);

  assertEquals(
    ranking.ranked.map((r) => r.label),
    ["provider-3", "provider-2", "provider"],
  );
  assertEquals(ranking.winner?.label, "provider-3");
  assertEquals(ranking.ranked.length, 3, "no candidate is discarded");
  assertEquals(ranking.ranked.at(-1)?.remainingFraction, null);
});

Deno.test("ranking falls back to discovery order when every budget is unknown (Issue #919)", () => {
  // #917 lists the primary provider.env first, so the run still starts on
  // today's token rather than refusing to start.
  const ranking = rankClaudeTokenBudgets([
    unknown("provider", "timeout"),
    unknown("provider-2", "network-error"),
    unknown("provider-3", "http-500"),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider");
  assertEquals(ranking.reason, "budget-unknown-discovery-order");
  assertEquals(
    ranking.ranked.map((r) => r.label),
    ["provider", "provider-2", "provider-3"],
  );
});

Deno.test("ranking treats a reset that has already passed as a full window (Issue #919)", () => {
  // provider's window rolled over an hour ago: the 3% figure describes a
  // window that no longer exists, so it is a fresh token, not a spent one.
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.03, NOW - HOUR),
    known("provider-2", 0.55, NOW + 4 * HOUR),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider");
  assertEquals(ranking.winner?.remainingFraction, 1);
  assertEquals(ranking.winner?.windowElapsed, true);
});

Deno.test("ranking falls back to the headline figure for a budget carrying no window list (Issue #1623)", () => {
  // `probeClaudeTokenBudget` always fills `windows`, but the type permits an
  // empty list and a budget that reached ranking with one must still be
  // ranked rather than silently treated as unmeasured.
  const ranking = rankClaudeTokenBudgets([
    {
      known: true,
      label: "provider",
      remainingFraction: 0.60,
      resetAt: NOW + 12 * HOUR,
      window: "seven_day",
      windows: [],
    },
    dual("provider-2", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.60, NOW + 120 * HOUR),
    ]),
  ], NOW);

  assertEquals(
    ranking.winner?.label,
    "provider",
    "an equal 60% share goes to the sooner reset",
  );
  assertEquals(ranking.winner?.remainingFraction, 0.60);
  assertEquals(ranking.winner?.resetAt, NOW + 12 * HOUR);
  assertEquals(ranking.reason, "equal-seven-day-remaining-soonest-reset");
  assertEquals(ranking.winner?.passesFiveHourGate, true, "no gate to fail");
});

Deno.test("ranking counts an elapsed seven-day window as 100% left (Issue #4504)", () => {
  // The reset is behind us, so the week is full again: the stale 1% loses to
  // nothing, and beats a current 95%.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.95, NOW + 100 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.01, NOW - 2 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.winner?.remainingFraction, 1);
  assertEquals(ranking.winner?.windowElapsed, true);
  assertEquals(ranking.reason, "most-seven-day-remaining");
});

Deno.test("ranking breaks a complete tie on discovery order (Issue #919)", () => {
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.4, NOW + HOUR),
    known("provider-2", 0.4, NOW + HOUR),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider");
  assertEquals(ranking.reason, "tied-discovery-order");
});

Deno.test("ranking nothing yields no winner and no reason (Issue #919)", () => {
  const ranking = rankClaudeTokenBudgets([], NOW);
  assertEquals(ranking.winner, null);
  assertEquals(ranking.reason, null);
  assertEquals(formatClaudeTokenSelectionLog(ranking), []);
});

// ---------------------------------------------------------------------------
// The decision log
// ---------------------------------------------------------------------------

Deno.test("the decision log names every candidate then the winner and its reason (Issue #1623)", () => {
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.25, Date.UTC(2026, 8, 4, 5, 0, 0), "seven_day"),
    known("provider-2", 0.75, Date.UTC(2026, 8, 4, 2, 0, 0), "five_hour"),
    unknown("provider-3", "http-401"),
  ], NOW);
  const lines = formatClaudeTokenSelectionLog(ranking);

  assertEquals(lines.length, 4, "one line per candidate, plus the winner");
  assertEquals(
    lines[0],
    "[SECURITY] claude token candidate provider (#1): five_hour=absent " +
      "seven_day=25.0% resets=2026-09-04T05:00:00.000Z remaining=25.0% " +
      "gate=pass",
  );
  assertEquals(
    lines[1],
    "[SECURITY] claude token candidate provider-2 (#2): five_hour=75.0% " +
      "resets=2026-09-04T02:00:00.000Z seven_day=absent remaining=75.0% " +
      "gate=pass",
  );
  assertEquals(
    lines[2],
    "[SECURITY] claude token candidate provider-3 (#3): remaining=unknown " +
      "reason=http-401",
  );
  assertEquals(
    lines[3],
    "[SECURITY] claude token selected provider (#1) of 3: " +
      "most-seven-day-remaining remaining=25.0% " +
      "resets=2026-09-04T05:00:00.000Z",
  );
});

Deno.test("an unknown candidate's line carries the probe's detail", () => {
  const lines = formatClaudeTokenSelectionLog(
    rankClaudeTokenBudgets([
      {
        known: false,
        label: "provider",
        reason: "http-429",
        detail: "rate_limit_error: Error",
      },
    ], NOW),
  );

  assertEquals(
    lines[0],
    "[SECURITY] claude token candidate provider (#1): remaining=unknown " +
      'reason=http-429 detail="rate_limit_error: Error"',
  );
});

Deno.test("the decision log prints both windows and the ranked share for a token reporting both (Issue #1623)", () => {
  const lines = formatClaudeTokenSelectionLog(
    rankClaudeTokenBudgets([
      dual("provider", [
        fiveHour(0.10, Date.UTC(2026, 8, 4, 2, 0, 0)),
        sevenDay(0.60, Date.UTC(2026, 8, 6, 0, 0, 0)),
      ]),
    ], NOW),
  );

  assertEquals(
    lines[0],
    "[SECURITY] claude token candidate provider (#1): five_hour=10.0% " +
      "resets=2026-09-04T02:00:00.000Z seven_day=60.0% " +
      "resets=2026-09-06T00:00:00.000Z remaining=60.0% gate=fail",
  );
  assertEquals(
    lines[1],
    "[SECURITY] claude token selected provider (#1) of 1: " +
      "five-hour-gate-failed-soonest-reset five_hour=10.0% " +
      "resets=2026-09-04T02:00:00.000Z remaining=60.0% " +
      "resets=2026-09-06T00:00:00.000Z",
    "the line records the five-hour reset the decision was made on",
  );
});

Deno.test("the decision log says an elapsed window was counted as full (Issue #919)", () => {
  const lines = formatClaudeTokenSelectionLog(
    rankClaudeTokenBudgets([
      known("provider", 0.03, NOW - HOUR),
      known("provider-2", 0.55, NOW + 4 * HOUR),
    ], NOW),
  );
  assertStringIncludes(
    lines[0] ?? "",
    "window already elapsed, counted as full",
  );
  assertStringIncludes(lines[0] ?? "", "five_hour=100.0%");
});

// ---------------------------------------------------------------------------
// The selector wired into applyProviderCredentialEnv
// ---------------------------------------------------------------------------

Deno.test("the selector makes no request at all with a single pool candidate (Issue #919)", async () => {
  const fetcher = fetchByToken(() => budgetResponse(0.5, 1_788_483_600));
  const logs: string[] = [];
  const select = createClaudeBudgetTokenSelector({
    fetchFn: fetcher.fetchFn,
    now: () => NOW,
    log: (line) => logs.push(line),
  });

  const chosen = await select([tokenFile("provider", "tok-1")], CLAUDE);

  assertEquals(chosen?.label, "provider");
  assertEquals(fetcher.calls(), 0, "one token is not a choice — do not probe");
  assertEquals(logs, [], "startup is byte-for-byte what it was");
});

Deno.test("the selector makes no request with no pool candidate at all (Issue #919)", async () => {
  // An API-key-only host, and every provider without a token pool: nothing
  // here has a budget to compare, so nothing is probed.
  const fetcher = fetchByToken(() => budgetResponse(0.5, 1_788_483_600));
  const select = createClaudeBudgetTokenSelector({
    fetchFn: fetcher.fetchFn,
    now: () => NOW,
  });

  const chosen = await select([
    tokenFile("provider", "sk-ant-key", {
      poolMember: false,
      name: "ANTHROPIC_API_KEY",
    }),
    tokenFile("provider-2", "sk-ant-key-2", {
      poolMember: false,
      name: "ANTHROPIC_API_KEY",
    }),
  ], CLAUDE);

  assertEquals(chosen?.label, "provider");
  assertEquals(fetcher.calls(), 0);
});

Deno.test("the selector probes each candidate once and exports the one with the most budget (Issue #919)", async () => {
  const utilisation: Record<string, number> = {
    "tok-1": 0.91,
    "tok-2": 0.12,
    "tok-3": 0.60,
  };
  const fetcher = fetchByToken((token) =>
    budgetResponse(utilisation[token] ?? 1, 1_788_483_600)
  );
  const logs: string[] = [];
  const select = createClaudeBudgetTokenSelector({
    fetchFn: fetcher.fetchFn,
    now: () => NOW,
    log: (line) => logs.push(line),
  });

  const chosen = await select([
    tokenFile("provider", "tok-1"),
    tokenFile("provider-2", "tok-2"),
    tokenFile("provider-3", "tok-3"),
  ], CLAUDE);

  assertEquals(chosen?.label, "provider-2", "88% remaining beats 40% and 9%");
  assertEquals(chosen?.value, "tok-2");
  assertEquals(fetcher.calls(), 3, "exactly one request per candidate");
  assertEquals(
    new Set(fetcher.bearers()).size,
    3,
    "each candidate's own token was probed",
  );
  assertStringIncludes(
    logs.at(-1) ?? "",
    "selected provider-2 (#2) of 3: most-seven-day-remaining",
  );
});

Deno.test("the selector probes every candidate concurrently, not in series (Issue #919)", async () => {
  // Worker start must cost one round trip, not N. Every probe must be in
  // flight before any of them is answered.
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const select = createClaudeBudgetTokenSelector({
    now: () => NOW,
    fetchFn: () => {
      started += 1;
      return gate.then(() => budgetResponse(0.5, 1_788_483_600));
    },
  });

  const pending = select([
    tokenFile("provider", "tok-1"),
    tokenFile("provider-2", "tok-2"),
    tokenFile("provider-3", "tok-3"),
  ], CLAUDE);

  assertEquals(started, 3, "all three probes are in flight before any answers");
  release();
  assert(await pending);
});

Deno.test("the selector decides once and issues no second round of probes (Issue #919)", async () => {
  const fetcher = fetchByToken((token) =>
    budgetResponse(token === "tok-2" ? 0.1 : 0.9, 1_788_483_600)
  );
  const logs: string[] = [];
  const select = createClaudeBudgetTokenSelector({
    fetchFn: fetcher.fetchFn,
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  const tokens = [
    tokenFile("provider", "tok-1"),
    tokenFile("provider-2", "tok-2"),
  ];

  const first = await select(tokens, CLAUDE);
  const decisionLines = logs.length;
  const second = await select(tokens, CLAUDE);

  assertEquals(first?.label, "provider-2");
  assertEquals(second?.label, "provider-2", "the run keeps the token it chose");
  assertEquals(fetcher.calls(), 2, "N requests per process start, not 2N");
  assertEquals(logs.length, decisionLines, "selection ran exactly once");
});

Deno.test("a pool whose every probe fails still starts the run on the primary token (Issue #919)", async () => {
  // A host that cannot reach the endpoint must start, not refuse to.
  const fetcher = fetchByToken(() => {
    throw new TypeError("error sending request");
  });
  const logs: string[] = [];
  const select = createClaudeBudgetTokenSelector({
    fetchFn: fetcher.fetchFn,
    now: () => NOW,
    log: (line) => logs.push(line),
  });

  const chosen = await select([
    tokenFile("provider", "tok-1"),
    tokenFile("provider-2", "tok-2"),
  ], CLAUDE);

  assertEquals(chosen?.label, "provider", "#917's discovery order decides");
  assertStringIncludes(
    logs.at(-1) ?? "",
    "budget-unknown-discovery-order",
  );
});

Deno.test("no token value reaches the decision log (Issue #919)", async () => {
  // Distinctive values: any prefix or suffix leaking is unmissable.
  const alpha = "sk-ant-oat01-ALPHA-SELECTION-TOKEN-919";
  const beta = "sk-ant-oat01-BETA-SELECTION-TOKEN-919";
  const fetcher = fetchByToken((token) => {
    // One healthy answer, one transport failure that quotes the token.
    if (token === beta) throw new TypeError(`failed to send ${beta}`);
    return budgetResponse(0.4, 1_788_483_600);
  });
  const logs: string[] = [];
  const select = createClaudeBudgetTokenSelector({
    fetchFn: fetcher.fetchFn,
    now: () => NOW,
    log: (line) => logs.push(line),
  });

  const chosen = await select([
    tokenFile("provider", alpha),
    tokenFile("provider-2", beta),
  ], CLAUDE);

  assertEquals(chosen?.value, alpha);
  const captured = logs.join("\n");
  assert(captured.length > 0, "the decision was logged at all");
  for (const value of [alpha, beta]) {
    assert(
      !captured.includes(value),
      `a token value reached the log: ${captured}`,
    );
    for (const fragment of [value.slice(0, 20), value.slice(-20)]) {
      assert(
        !captured.includes(fragment),
        `a token fragment reached the log: ${captured}`,
      );
    }
  }
  assertStringIncludes(captured, "provider-2");
});

Deno.test("a spent token's candidate line carries its windows, not remaining=unknown (Issue #2040)", async () => {
  // The whole point of #2040 at the operator's end: the token that answered
  // 429 must say 0% and when it comes back, rather than going blank and
  // leaving the pool's weekly picture two-thirds empty.
  const fiveHourReset = Date.UTC(2026, 8, 4, 2, 0, 0) / 1000;
  const sevenDayReset = Date.UTC(2026, 8, 8, 1, 0, 0) / 1000;
  const fetcher = fetchByToken((token) =>
    token === "tok-spent"
      ? new Response(JSON.stringify({ error: { message: "rate limit" } }), {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "1",
          "anthropic-ratelimit-unified-5h-reset": String(fiveHourReset),
          "anthropic-ratelimit-unified-7d-utilization": "1",
          "anthropic-ratelimit-unified-7d-reset": String(sevenDayReset),
        },
      })
      : budgetResponse(0.08, Date.UTC(2026, 8, 4, 3, 0, 0) / 1000)
  );
  const logs: string[] = [];
  const select = createClaudeBudgetTokenSelector({
    fetchFn: fetcher.fetchFn,
    now: () => NOW,
    log: (line) => logs.push(line),
  });

  const chosen = await select([
    tokenFile("provider", "tok-spent"),
    tokenFile("provider-2", "tok-2"),
  ], CLAUDE);

  assertEquals(chosen?.label, "provider-2", "the token with budget is chosen");
  const spentLine = logs.find((line) =>
    line.includes("candidate provider (#1)")
  );
  assertEquals(
    spentLine,
    "[SECURITY] claude token candidate provider (#1): five_hour=0.0% " +
      "resets=2026-09-04T02:00:00.000Z seven_day=0.0% " +
      "resets=2026-09-08T01:00:00.000Z remaining=0.0% gate=fail " +
      "week=spent",
  );
});
