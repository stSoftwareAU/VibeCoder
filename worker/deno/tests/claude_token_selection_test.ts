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
 * Issue #1623 then reshaped the rule the join applies: the five-hour window
 * became a gate and the seven-day window sets the rate, so budget that would
 * otherwise lapse is spent first ("use it or lose it"). Three cases below
 * assert the new outcome where they used to assert the old one; each says so
 * at the point it does.
 *
 * These tests pin the join, and each rule is one that would silently degrade
 * rather than fail visibly if it regressed:
 *
 * - a token that has burned over 80% of its five-hour window ranks behind
 *   every token that has not — it cannot spend what its week still holds;
 * - the winner really is the token with the most remaining budget **per hour**
 *   until its own window resets, not the largest share and not a wall-clock
 *   total;
 * - a token under 10% of its seven-day window ranks behind every passing token
 *   above that floor, whatever its rate;
 * - a token whose window has already reset counts as full — scored over the
 *   window's nominal length — not as the stale near-exhausted figure the probe
 *   reported for a window that has gone;
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

Deno.test("ranking returns the token with the most remaining budget per hour of its own window (Issue #1623)", () => {
  // Different windows, different reset days — exactly the case the parent
  // issue exists for. Only the fraction per hour is comparable across them.
  // Rewritten for Issue #1623: until then this ranked on the largest share
  // alone, so provider-2's 81% won although provider-3's 44% over four hours
  // is worth sixteen times as much per hour.
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.10, NOW + 2 * HOUR, "five_hour"),
    known("provider-2", 0.81, NOW + 5 * 24 * HOUR, "seven_day"),
    known("provider-3", 0.44, NOW + 4 * HOUR, "five_hour"),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-3");
  assertEquals(ranking.reason, "highest-remaining-per-hour");
  assertEquals(
    ranking.ranked.map((r) => r.label),
    // provider is last: 10% of its five-hour window is under the guard.
    ["provider-3", "provider-2", "provider"],
  );
});

Deno.test("ranking prefers 20% that expires in six hours over 90% that lasts six and a half days (Issue #1623)", () => {
  // The user's own example. provider-2 holds four and a half times the share,
  // but provider's expires in hours: 20%/6h is 3.33%/h against 0.58%/h, so
  // the budget that would otherwise lapse is spent first.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.95, NOW + 3 * HOUR),
      sevenDay(0.20, NOW + 6 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.95, NOW + 4 * HOUR),
      sevenDay(0.90, NOW + 156 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider");
  assertEquals(ranking.reason, "highest-remaining-per-hour");
  assertEquals(ranking.winner?.ratePerHour, 0.20 / 6);
});

Deno.test("ranking guards on the five-hour window before it looks at the rate (Issue #1623)", () => {
  // provider has by far the best seven-day rate, but 19% of its five-hour
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
  assertEquals(ranking.winner?.meetsFiveHourGuard, true);
  assertEquals(ranking.ranked[1]?.label, "provider");
  assertEquals(ranking.ranked[1]?.meetsFiveHourGuard, false);
});

Deno.test("ranking puts a token at 81% of its five-hour window behind one at 79% (Issue #1623, boundary moved by #1685)", () => {
  // The guard boundary, stated as the shares themselves rather than as
  // `1 - 0.81`: at 19% left the token has used 81% and falls under the guard,
  // at 21% left it has used 79% and meets it. The two are otherwise
  // identical, so nothing but the guard can decide the order — and no
  // floating-point artefact can make the test pass for the wrong reason.
  //
  // Issue #1685 moved the boundary itself: 20% remaining used to fail here
  // and is now usable, so this test states the case either side of 20%.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.19, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 24 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.21, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 24 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.ranked[0]?.meetsFiveHourGuard, true);
  assertEquals(ranking.ranked[1]?.label, "provider");
  assertEquals(ranking.ranked[1]?.meetsFiveHourGuard, false);
});

Deno.test("the guard reads the utilisation the probe actually reports (Issue #1623, boundary moved by #1685)", () => {
  // The probe reports remaining as `1 - utilisation`, which is not exact:
  // 80% used arrives as 0.19999999999999996, which is exactly 20% remaining
  // and therefore usable, while 81% used arrives as 0.18999999999999995 and
  // is not. Both sides of the boundary must land where they belong on the
  // figures the probe really produces.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [fiveHour(1 - 0.81, NOW + 2 * HOUR)]),
    dual("provider-2", [fiveHour(1 - 0.80, NOW + 2 * HOUR)]),
  ], NOW);

  assertEquals(ranking.ranked[0]?.label, "provider-2");
  assertEquals(ranking.ranked[0]?.meetsFiveHourGuard, true);
  assertEquals(ranking.ranked[1]?.meetsFiveHourGuard, false);
});

Deno.test("a token under 10% of its seven-day window is ranked on its rate like any other (Issue #1685)", () => {
  // Issue #1623 demoted every token under a 10% weekly floor; Issue #1685
  // removed that floor as the opposite of use-it-or-lose-it. provider's 8%
  // lapses within the hour, so it is worth 8.00%/h against 0.11%/h and
  // 0.59%/h and is spent first.
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
    ["provider", "provider-3", "provider-2"],
  );
  assertEquals(ranking.winner?.label, "provider");
  assertEquals(ranking.reason, "highest-remaining-per-hour");
});

Deno.test("ranking orders two sub-10% tokens by rate and still ahead of a token under the guard (Issue #1623, floor removed by #1685)", () => {
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
  // Under Issue #1685 the winner is simply the highest rate of the tokens
  // that meet the guard; there is no weekly floor left to name.
  assertEquals(ranking.reason, "highest-remaining-per-hour");
});

Deno.test("ranking keeps choosing on the weekly rate when nothing meets the guard (Issue #1623, corrected by #1685)", () => {
  // Both hold a sliver of their five-hour window and neither is exhausted.
  // Until Issue #1685 the pool ranked these on the five-hour reset alone and
  // provider-2 won; now the guard steps aside and the weekly rate decides,
  // so provider's 0.56%/h beats provider-2's 0.13%/h.
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

  assertEquals(ranking.winner?.label, "provider");
  assertEquals(
    ranking.reason,
    "below-five-hour-guard-highest-remaining-per-hour",
  );
  assertEquals(
    ranking.ranked.map((r) => r.label),
    ["provider", "provider-2"],
  );
});

Deno.test("ranking spends equal headroom that expires soonest first (Issue #919)", () => {
  // Equal headroom: spend the one that expires first, or it lapses unused.
  // Under Issue #1623 that is no longer a tie-break but the rule itself —
  // the same share over three hours is a higher rate than over twenty.
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.5, NOW + 20 * HOUR),
    known("provider-2", 0.5, NOW + 3 * HOUR),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "highest-remaining-per-hour");
});

Deno.test("ranking breaks an equal rate towards the soonest reset (Issue #1623)", () => {
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.40, NOW + 20 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.20, NOW + 10 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "equal-remaining-per-hour-soonest-reset");
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

  assertEquals(ranking.winner?.label, "provider", "0.60/12h beats 0.60/120h");
  assertEquals(ranking.winner?.ratePerHour, 0.60 / 12);
  assertEquals(ranking.winner?.meetsFiveHourGuard, true, "no guard to fail");
});

Deno.test("ranking scores an elapsed seven-day window over its nominal 168 hours (Issue #1623)", () => {
  // The reset is behind us, so the window is full again and there is no
  // positive number of hours to divide by. Its nominal length is the divisor:
  // a rolled-over week is 100% over 168 hours, not a division by a negative.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.90, NOW + 2 * HOUR),
      sevenDay(0.01, NOW - 2 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.remainingFraction, 1);
  assertEquals(ranking.winner?.windowElapsed, true);
  assertEquals(ranking.winner?.ratePerHour, 1 / 168);
  assertEquals(ranking.winner?.rateWindow?.hoursUntilReset, 168);
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
    "[SECURITY] claude token candidate provider-2 (#2): five_hour=75.0% " +
      "resets=2026-09-04T02:00:00.000Z seven_day=absent rate=37.50%/h " +
      "guard=pass",
  );
  assertEquals(
    lines[1],
    "[SECURITY] claude token candidate provider (#1): five_hour=absent " +
      "seven_day=25.0% resets=2026-09-04T05:00:00.000Z rate=5.00%/h " +
      "guard=pass",
  );
  assertEquals(
    lines[2],
    "[SECURITY] claude token candidate provider-3 (#3): remaining=unknown " +
      "reason=http-401",
  );
  assertEquals(
    lines[3],
    "[SECURITY] claude token selected provider-2 (#2) of 3: " +
      "highest-remaining-per-hour rate=37.50%/h remaining=75.0% " +
      "resets=2026-09-04T02:00:00.000Z",
  );
});

Deno.test("the decision log prints both windows and the rate for a token reporting both (Issue #1623)", () => {
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
      "resets=2026-09-06T00:00:00.000Z rate=1.25%/h guard=below",
  );
  assertEquals(
    lines[1],
    "[SECURITY] claude token selected provider (#1) of 1: " +
      "below-five-hour-guard-highest-remaining-per-hour five_hour=10.0% " +
      "resets=2026-09-04T02:00:00.000Z rate=1.25%/h remaining=60.0% " +
      "resets=2026-09-06T00:00:00.000Z",
    "the line records the five-hour window the decision was made despite",
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
    "selected provider-2 (#2) of 3: highest-remaining-per-hour",
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

// ---------------------------------------------------------------------------
// The weekly quota-per-hour rule, with the five-hour window as a soft guard
// (Issue #1685)
// ---------------------------------------------------------------------------

Deno.test("the weekly rate decides while both credentials clear the five-hour guard (Issue #1685)", () => {
  // A holds the better weekly rate, B the roomier five hours. The guard is a
  // boundary, never a score, so a passing candidate's five-hour share adds
  // nothing to its ranking.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.70, NOW + 4 * HOUR),
      sevenDay(0.30, NOW + 10 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.90, NOW + 4 * HOUR),
      sevenDay(0.80, NOW + 150 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider", "3.00%/h beats 0.53%/h");
  assertEquals(ranking.reason, "highest-remaining-per-hour");
});

Deno.test("a credential under the five-hour guard loses to one above it, whatever its weekly rate (Issue #1685)", () => {
  // 19% of five hours is too little to run an approximately hour-long Vibe
  // Coder run against while a healthier subscription is there.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.19, NOW + 2 * HOUR),
      sevenDay(0.60, NOW + 6 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.60, NOW + 2 * HOUR),
      sevenDay(0.30, NOW + 100 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.winner?.meetsFiveHourGuard, true);
  assertEquals(ranking.ranked[1]?.label, "provider");
  assertEquals(ranking.ranked[1]?.meetsFiveHourGuard, false);
  assertEquals(ranking.ranked[1]?.exhausted, false, "low is not exhausted");
});

Deno.test("with every credential under the guard the weekly rate still decides and nothing is refused (Issue #1685)", () => {
  // The correction this issue exists for: 19% and 18% are both under the
  // guard, so the guard steps aside and the weekly quota-per-hour ranking
  // picks the winner rather than the pool going idle.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.19, NOW + 2 * HOUR),
      sevenDay(0.40, NOW + 8 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.18, NOW + 2 * HOUR),
      sevenDay(0.90, NOW + 160 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider", "5.00%/h beats 0.56%/h");
  assertEquals(
    ranking.reason,
    "below-five-hour-guard-highest-remaining-per-hour",
  );
  assertEquals(ranking.ranked.map((r) => r.exhausted), [false, false]);
});

Deno.test("an exhausted credential loses to a usable one under the guard (Issue #1685)", () => {
  // Exhaustion is the hard condition: 0% cannot serve a call at all, while
  // 15% can, so the weekly rate never gets to rescue the spent one.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0, NOW + 2 * HOUR),
      sevenDay(0.90, NOW + 3 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.15, NOW + 2 * HOUR),
      sevenDay(0.20, NOW + 160 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.ranked[1]?.label, "provider");
  assertEquals(ranking.ranked[1]?.exhausted, true);
});

Deno.test("21% of the five-hour window beats 19% even on a worse weekly rate (Issue #1685)", () => {
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.19, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 5 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.21, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 150 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.winner?.meetsFiveHourGuard, true);
});

Deno.test("exactly 20% of the five-hour window is usable, not excluded (Issue #1685)", () => {
  // The boundary belongs to the usable side: at 20% left the credential joins
  // the weekly ranking and wins it on rate.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.20, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 5 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.21, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 150 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider", "10.00%/h beats 0.33%/h");
  assertEquals(ranking.winner?.meetsFiveHourGuard, true);
  assertEquals(ranking.reason, "highest-remaining-per-hour");
});

Deno.test("an imminent weekly reset beats a far larger weekly balance days away (Issue #1685)", () => {
  // No 10% weekly floor: 8% that lapses in two hours is worth more per hour
  // than 80% that lasts six days, which is the use-it-or-lose-it objective.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0.90, NOW + 4 * HOUR),
      sevenDay(0.08, NOW + 2 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.90, NOW + 4 * HOUR),
      sevenDay(0.80, NOW + 144 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider", "4.00%/h beats 0.56%/h");
  assertEquals(ranking.reason, "highest-remaining-per-hour");
});

Deno.test("with every credential exhausted the soonest reset wins and a winner is still named (Issue #1685)", () => {
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0, NOW + 4 * HOUR),
      sevenDay(0.90, NOW + 160 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0, NOW + HOUR),
      sevenDay(0.20, NOW + 160 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "exhausted-soonest-reset");
  assertEquals(
    ranking.ranked.map((r) => r.label),
    ["provider-2", "provider"],
  );
});

Deno.test("an exhausted token becomes usable again only when its LAST spent window resets (Issue #1685)", () => {
  // provider's five hours reopen within the hour but its week is spent for
  // another thirty, so it cannot serve a call until then. provider-2 is spent
  // on one window alone and recovers in two hours, which is sooner.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0, NOW + HOUR),
      sevenDay(0, NOW + 30 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0, NOW + 2 * HOUR),
      sevenDay(0.50, NOW + 100 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.winner?.availableAt, NOW + 2 * HOUR);
  assertEquals(ranking.ranked[1]?.availableAt, NOW + 30 * HOUR);
  assertEquals(ranking.reason, "exhausted-soonest-reset");
});

Deno.test("an exhausted window whose reset has passed is usable again (Issue #1685)", () => {
  // The figures describe the window that was current when they were taken;
  // once its reset is behind us the window has rolled over and is full.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(0, NOW - HOUR),
      sevenDay(0.50, NOW + 10 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.90, NOW + 4 * HOUR),
      sevenDay(0.50, NOW + 100 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider");
  assertEquals(ranking.winner?.exhausted, false);
  assertEquals(ranking.winner?.meetsFiveHourGuard, true);
});

Deno.test("a seven-day exhaustion is exhaustion too, whatever the five hours hold (Issue #1685)", () => {
  // A spent week cannot be spent from, so a fresh five-hour window does not
  // make the credential usable.
  const ranking = rankClaudeTokenBudgets([
    dual("provider", [
      fiveHour(1, NOW + 4 * HOUR),
      sevenDay(0, NOW + 48 * HOUR),
    ]),
    dual("provider-2", [
      fiveHour(0.10, NOW + 4 * HOUR),
      sevenDay(0.10, NOW + 100 * HOUR),
    ]),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.ranked[1]?.exhausted, true);
});
