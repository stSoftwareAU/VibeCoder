/**
 * Pick the Claude token with the most remaining budget at worker start
 * (Issue #919, parent #902).
 *
 * An operator with two or more Claude subscriptions wants them consumed
 * evenly without touching the host between runs. #917 finds every configured
 * token file and leaves a {@link ProviderTokenSelector} seam; #918 turns one
 * token into a remaining-budget figure. This module is the join: probe every
 * pool candidate, rank the answers, export the winner, and say why it won.
 *
 * ## Ranking
 *
 * {@link rankClaudeTokenBudgets} is **pure** — no I/O, and the current time is
 * a parameter rather than a clock of its own — so every rule below is a plain
 * unit test:
 *
 * - Most remaining budget first, each token measured against **its own**
 *   window. Comparing fractions rather than wall-clock totals is what makes
 *   subscriptions whose reset sessions end on different days and at different
 *   times comparable at all.
 * - A token whose `resetAt` has already passed is treated as a fresh, FULL
 *   window. The probe reports the window that was current when the figure was
 *   produced; once that instant is behind us the window has rolled over and
 *   the old utilisation describes a window that no longer exists. Ranking it
 *   on a stale, near-exhausted figure would skip a token that is in fact
 *   completely unused.
 * - A tie on remaining budget goes to the **soonest** reset, so budget is
 *   spent before it expires rather than left to lapse.
 * - A token whose budget is unknown (`{ known: false }`) ranks **last**,
 *   behind every token with a known budget. It is never dropped: a probe
 *   failure must not make a configured subscription disappear, and with every
 *   budget unknown the discovery order from #917 decides — so the run still
 *   starts on today's primary `provider.env` and a host whose network cannot
 *   reach the endpoint at all starts exactly as it does now. Refusing to
 *   start because a probe failed is never an option.
 *
 * ## Cost, and when nothing is probed
 *
 * Selection happens **once per worker-process start** and the chosen token
 * serves the whole run: {@link createClaudeBudgetTokenSelector} remembers the
 * decision per provider, so a second call issues no further requests and
 * re-decides nothing. Mid-run exhaustion keeps today's failure behaviour; the
 * next process start reselects.
 *
 * With fewer than two pool candidates there is nothing to choose between, so
 * **no request is made at all** and selection falls straight through to
 * #917's discovery-order default: a single-token host — which is every host
 * today — pays nothing and behaves byte-for-byte as it did. Providers with no
 * token pool (Codex, Gemini, DeepSeek) take that same path.
 *
 * The N probes run **concurrently**. Worker start must not be delayed by N
 * sequential round trips, and each probe is independently bounded by #918.
 *
 * ## Logging
 *
 * Every candidate is named with its remaining budget and reset time, and the
 * winner with the reason it won, through {@link formatClaudeTokenSelectionLog}.
 * Tokens are identified by **label** (`provider`, `provider-2`) and discovery
 * position only — no token value, nor any prefix or suffix of one, can reach
 * a log line, a GitHub comment or an error message, because nothing this
 * module formats is derived from the token value in the first place. Reset
 * instants are rendered as ISO-8601 UTC, the same way the existing
 * `resetEpochMs` surfaces render theirs (`run_core_production_deps.ts`), so
 * the two read alike.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  type ClaudeBudgetFetch,
  type ClaudeTokenBudget,
  probeClaudeTokenBudget,
} from "./claude_token_budget.ts";
import {
  type ProviderTokenFile,
  type ProviderTokenSelector,
  selectFirstProviderToken,
} from "./credential_preflight.ts";

/** Prefix shared by every line this module logs. */
const LOG_PREFIX = "[SECURITY] claude token";

/** Why the winning token won — stable, greppable, and safe to log. */
export type ClaudeTokenSelectionReason =
  /** Strictly more remaining budget than every other candidate. */
  | "most-remaining-budget"
  /** Level on remaining budget; won on the sooner reset. */
  | "equal-remaining-budget-soonest-reset"
  /** Level on budget and reset; won on #917's discovery order. */
  | "tied-discovery-order"
  /** No candidate had a known budget; #917's discovery order decided. */
  | "budget-unknown-discovery-order";

/** One candidate's probe result, with the figures ranking actually used. */
export interface RankedClaudeToken {
  /** Loggable identity — the file stem, never the token value. */
  readonly label: string;
  /** Discovery position from #917, zero-based. The final tie-break. */
  readonly index: number;
  /** The probe outcome this ranking was computed from. */
  readonly budget: ClaudeTokenBudget;
  /**
   * Remaining share used for ranking, in `[0, 1]`, or null when the budget is
   * unknown. 1 for a token whose window had already reset.
   */
  readonly remainingFraction: number | null;
  /** The reported reset in epoch ms, or null when the budget is unknown. */
  readonly resetAt: number | null;
  /** True when {@link resetAt} had already passed, so the window is full. */
  readonly windowElapsed: boolean;
}

/** The outcome of ranking one provider's candidates. */
export interface ClaudeTokenRanking {
  /** Every candidate, best first. Nothing is ever dropped. */
  readonly ranked: readonly RankedClaudeToken[];
  /** The winner, or null when there was nothing to rank. */
  readonly winner: RankedClaudeToken | null;
  /** Why the winner won, or null when there was nothing to rank. */
  readonly reason: ClaudeTokenSelectionReason | null;
}

/**
 * Reduce one probe result to the figures ranking compares.
 *
 * @param budget - The probe outcome for one token.
 * @param index - Its discovery position.
 * @param now - Current time in epoch milliseconds.
 * @returns The ranking view of that candidate.
 */
function rankingView(
  budget: ClaudeTokenBudget,
  index: number,
  now: number,
): RankedClaudeToken {
  if (!budget.known) {
    return {
      label: budget.label,
      index,
      budget,
      remainingFraction: null,
      resetAt: null,
      windowElapsed: false,
    };
  }
  // A reset in the past means the window rolled over after the figure was
  // produced: the token is fresh, not nearly spent.
  const windowElapsed = budget.resetAt <= now;
  return {
    label: budget.label,
    index,
    budget,
    remainingFraction: windowElapsed ? 1 : budget.remainingFraction,
    resetAt: budget.resetAt,
    windowElapsed,
  };
}

/**
 * Order two candidates: known before unknown, then most remaining budget,
 * then soonest reset, then discovery order.
 */
function compareCandidates(
  a: RankedClaudeToken,
  b: RankedClaudeToken,
): number {
  const left = a.remainingFraction;
  const right = b.remainingFraction;
  if (left === null || right === null) {
    // An unknown budget ranks behind every known one, and never vanishes.
    if (left !== right) return left === null ? 1 : -1;
    return a.index - b.index;
  }
  if (left !== right) return right - left;
  const leftReset = a.resetAt ?? Number.MAX_SAFE_INTEGER;
  const rightReset = b.resetAt ?? Number.MAX_SAFE_INTEGER;
  // Level pegging: spend the budget that expires first.
  if (leftReset !== rightReset) return leftReset - rightReset;
  return a.index - b.index;
}

/** Name why the head of a ranked list beat the rest. */
function winningReason(
  ranked: readonly RankedClaudeToken[],
): ClaudeTokenSelectionReason | null {
  const winner = ranked[0];
  if (winner === undefined) return null;
  if (winner.remainingFraction === null) {
    return "budget-unknown-discovery-order";
  }
  const runnerUp = ranked[1];
  if (runnerUp === undefined) return "most-remaining-budget";
  if (runnerUp.remainingFraction !== winner.remainingFraction) {
    return "most-remaining-budget";
  }
  return runnerUp.resetAt === winner.resetAt
    ? "tied-discovery-order"
    : "equal-remaining-budget-soonest-reset";
}

/**
 * Rank probe results by remaining budget — the pure heart of Issue #919.
 *
 * Input order is the discovery order from #917 and is the tie-break of last
 * resort, so with every budget unknown the primary `provider.env` wins.
 *
 * @param budgets - One probe result per candidate, in discovery order.
 * @param now - Current time in epoch milliseconds (a parameter, never a clock
 *   of this function's own, so every rule is deterministically testable).
 * @returns Every candidate ranked best first, plus the winner and its reason.
 */
export function rankClaudeTokenBudgets(
  budgets: readonly ClaudeTokenBudget[],
  now: number,
): ClaudeTokenRanking {
  const ranked = budgets
    .map((budget, index) => rankingView(budget, index, now))
    .sort(compareCandidates);
  return {
    ranked,
    winner: ranked[0] ?? null,
    reason: winningReason(ranked),
  };
}

/** Render a remaining share as a percentage. */
function formatShare(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Render a reset instant the way the existing `resetEpochMs` surfaces do.
 *
 * @param epochMs - The instant, in epoch milliseconds.
 * @returns ISO-8601 UTC, or `unparseable` for a value `Date` rejects.
 */
function formatReset(epochMs: number): string {
  const at = new Date(epochMs);
  return Number.isFinite(at.getTime()) ? at.toISOString() : "unparseable";
}

/** Describe one candidate's budget for the log — labels and figures only. */
function describeCandidate(candidate: RankedClaudeToken): string {
  const { budget } = candidate;
  if (!budget.known) {
    return `remaining=unknown reason=${budget.reason}`;
  }
  const reset = formatReset(budget.resetAt);
  if (candidate.windowElapsed) {
    return `remaining=${formatShare(1)} window=${budget.window} ` +
      `resets=${reset} (window already elapsed, counted as full)`;
  }
  return `remaining=${formatShare(budget.remainingFraction)} ` +
    `window=${budget.window} resets=${reset}`;
}

/**
 * The startup decision log: one line per candidate, then the winner.
 *
 * Pure, so a test can assert the exact text. Candidates are listed best-first
 * with their discovery position, and identified by label alone — the token
 * value is not an input to this function, so it cannot reach the output.
 *
 * @param ranking - The ranking to describe.
 * @returns The lines to log, in order. Empty when nothing was ranked.
 */
export function formatClaudeTokenSelectionLog(
  ranking: ClaudeTokenRanking,
): string[] {
  const { ranked, winner, reason } = ranking;
  if (winner === null || reason === null) return [];
  const lines = ranked.map((candidate) =>
    `${LOG_PREFIX} candidate ${candidate.label} (#${candidate.index + 1}): ` +
    describeCandidate(candidate)
  );
  const detail = winner.remainingFraction === null
    ? `remaining=unknown`
    : `remaining=${formatShare(winner.remainingFraction)} resets=${
      winner.resetAt === null ? "unknown" : formatReset(winner.resetAt)
    }`;
  lines.push(
    `${LOG_PREFIX} selected ${winner.label} (#${winner.index + 1}) of ` +
      `${ranked.length}: ${reason} ${detail}`,
  );
  return lines;
}

/** Bounds and injection points for the selector (tests inject every one). */
export interface ClaudeBudgetSelectorOptions {
  /** Injected `fetch`; production passes nothing and gets the global. */
  fetchFn?: ClaudeBudgetFetch;
  /** Per-probe timeout, forwarded to {@link probeClaudeTokenBudget}. */
  timeoutMs?: number;
  /** Endpoint override, for tests that assert what was called. */
  url?: string;
  /** Current time source; defaults to the wall clock. */
  now?: () => number;
  /** Where the decision log goes; defaults to discarding it. */
  log?: (message: string) => void;
  /** Selector used when there is nothing to choose between. */
  fallback?: ProviderTokenSelector;
}

/**
 * Build the {@link ProviderTokenSelector} that worker start hands to
 * `applyProviderCredentialEnv` — the wiring half of Issue #919.
 *
 * The returned selector:
 *
 * - probes every pool candidate **concurrently**, one request each;
 * - returns the winner of {@link rankClaudeTokenBudgets};
 * - logs each candidate and the winning reason by label;
 * - makes **no** request and defers to {@link selectFirstProviderToken} when
 *   the provider has fewer than two pool candidates;
 * - decides **once per provider** for the life of the selector, so a second
 *   call costs nothing and cannot change the token the run is using.
 *
 * It never throws and never refuses: a pool whose every probe failed still
 * selects, on discovery order.
 *
 * @param options - Injected bounds, clock, log sink and fallback.
 * @returns A selector suitable for `applyProviderCredentialEnv`.
 */
export function createClaudeBudgetTokenSelector(
  options: ClaudeBudgetSelectorOptions = {},
): ProviderTokenSelector {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const fallback = options.fallback ?? selectFirstProviderToken;
  // One decision per provider, held for the life of this selector — which is
  // the life of the worker process (Issue #919: the chosen token serves the
  // whole run, and nothing re-selects mid-run).
  const decided = new Map<string, ProviderTokenFile | null>();

  return async (tokens, provider) => {
    const remembered = decided.get(provider.id);
    if (remembered !== undefined) return remembered;

    const pool = tokens.filter(
      (token) => token.poolMember && (token.value ?? "").length > 0,
    );
    // Nothing to choose between: no probe, no log, no change from today.
    const selected = pool.length < 2
      ? await fallback(tokens, provider)
      : await selectByBudget(pool);
    decided.set(provider.id, selected);
    return selected;
  };

  /** Probe the pool concurrently, rank it, log it, return the winner. */
  async function selectByBudget(
    pool: readonly ProviderTokenFile[],
  ): Promise<ProviderTokenFile | null> {
    const budgets = await Promise.all(
      pool.map((token) =>
        probeClaudeTokenBudget(token.value ?? "", {
          label: token.label,
          fetchFn: options.fetchFn,
          timeoutMs: options.timeoutMs,
          url: options.url,
        })
      ),
    );
    const ranking = rankClaudeTokenBudgets(budgets, now());
    for (const line of formatClaudeTokenSelectionLog(ranking)) log(line);
    // Ranking drops nothing, so a pool of two or more always has a winner.
    return ranking.winner === null ? null : pool[ranking.winner.index] ?? null;
  }
}
