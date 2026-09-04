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
 * These tests pin the join, and each rule is one that would silently degrade
 * rather than fail visibly if it regressed:
 *
 * - the winner really is the token with the most remaining budget, measured
 *   against **its own** window, not a wall-clock total;
 * - a tie goes to the sooner reset, so budget is spent before it lapses;
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

/** A probe result for a token whose budget was determined. */
function known(
  label: string,
  remainingFraction: number,
  resetAt: number,
  window: ClaudeBudgetWindowName = "five_hour",
): ClaudeTokenBudget {
  return {
    known: true,
    label,
    remainingFraction,
    resetAt,
    window,
    windows: [{ window, remainingFraction, resetAt }],
  };
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

Deno.test("ranking returns the token with the most remaining budget of its own window (Issue #919)", () => {
  // Different windows, different reset days — exactly the case the parent
  // issue exists for. Only the fraction is comparable across them.
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.10, NOW + 2 * HOUR, "five_hour"),
    known("provider-2", 0.81, NOW + 5 * 24 * HOUR, "seven_day"),
    known("provider-3", 0.44, NOW + 4 * HOUR, "five_hour"),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "most-remaining-budget");
  assertEquals(
    ranking.ranked.map((r) => r.label),
    ["provider-2", "provider-3", "provider"],
  );
});

Deno.test("ranking breaks a tie on remaining budget towards the soonest reset (Issue #919)", () => {
  // Equal headroom: spend the one that expires first, or it lapses unused.
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.5, NOW + 20 * HOUR),
    known("provider-2", 0.5, NOW + 3 * HOUR),
  ], NOW);

  assertEquals(ranking.winner?.label, "provider-2");
  assertEquals(ranking.reason, "equal-remaining-budget-soonest-reset");
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

Deno.test("the decision log names every candidate then the winner and its reason (Issue #919)", () => {
  const ranking = rankClaudeTokenBudgets([
    known("provider", 0.25, Date.UTC(2026, 8, 4, 5, 0, 0), "seven_day"),
    known("provider-2", 0.75, Date.UTC(2026, 8, 4, 2, 0, 0), "five_hour"),
    unknown("provider-3", "http-401"),
  ], NOW);
  const lines = formatClaudeTokenSelectionLog(ranking);

  assertEquals(lines.length, 4, "one line per candidate, plus the winner");
  assertEquals(
    lines[0],
    "[SECURITY] claude token candidate provider-2 (#2): remaining=75.0% " +
      "window=five_hour resets=2026-09-04T02:00:00.000Z",
  );
  assertEquals(
    lines[1],
    "[SECURITY] claude token candidate provider (#1): remaining=25.0% " +
      "window=seven_day resets=2026-09-04T05:00:00.000Z",
  );
  assertEquals(
    lines[2],
    "[SECURITY] claude token candidate provider-3 (#3): remaining=unknown " +
      "reason=http-401",
  );
  assertEquals(
    lines[3],
    "[SECURITY] claude token selected provider-2 (#2) of 3: " +
      "most-remaining-budget remaining=75.0% resets=2026-09-04T02:00:00.000Z",
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
  assertStringIncludes(lines[0] ?? "", "remaining=100.0%");
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
    "selected provider-2 (#2) of 3: most-remaining-budget",
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
