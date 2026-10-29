/**
 * Pick the Claude token with the most seven-day quota left at worker start
 * (owner decision 2026-10-29, replacing Issue #1623's per-hour rule;
 * originally #919, parent #902).
 *
 * An operator with two or more Claude subscriptions wants them consumed
 * evenly without touching the host between runs. #917 finds every configured
 * token file and leaves a {@link ProviderTokenSelector} seam; #918 turns one
 * token into a remaining-budget figure. This module is the join: probe every
 * pool candidate, rank the answers, export the winner, and say why it won.
 *
 * ## Ranking
 *
 * The rule is **most weekly quota left first**: of the tokens that can run
 * now, the one holding the largest remaining share of its seven-day window is
 * used. Issue #1623 used to divide that share by the hours until the window
 * reset, so 20% resetting in six hours beat 90% resetting in six days; the
 * owner replaced that rule on 2026-10-29, and the 90% token now wins.
 *
 * {@link rankClaudeTokenBudgets} is **pure** — no I/O, and the current time is
 * a parameter rather than a clock of its own — so every rule below is a plain
 * unit test:
 *
 * - **The five-hour window is a gate, not a score.** A token that has used
 *   less than {@link CLAUDE_FIVE_HOUR_GATE_MAX_USED} of it passes; one that
 *   has used 80% or more cannot spend whatever its week still holds, so every
 *   passing token ranks ahead of every failing one.
 * - **Passing tokens are ordered by remaining share** of the seven-day window
 *   (100% less its utilisation), largest first. A response that reported no
 *   seven-day window is ranked on the remaining share of the window it did
 *   report. A nearly spent week needs no floor of its own: it holds the least
 *   and so ranks last among the passing tokens.
 * - A token whose `resetAt` has already passed is treated as a fresh, FULL
 *   window, in both the gate and the ranking. The probe reports the window
 *   that was current when the figure was produced; once that instant is behind
 *   us the window has rolled over and the old utilisation describes a window
 *   that no longer exists.
 * - A tie on remaining share goes to the **soonest** reset, then to discovery
 *   order.
 * - **Gate failures are ordered by the soonest five-hour reset**, so the
 *   token that refills first is the one used when nothing can be spent now.
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
 * re-decides nothing.
 *
 * Worker start now reaches these rules through `claude_credential_pool.ts`
 * (Issue #1668), which keeps the probe results as snapshots so a later
 * selection re-measures only what has gone stale.
 * {@link rankClaudeTokenBudgets} and {@link formatClaudeTokenSelectionLog} are
 * the rule both surfaces share; {@link createClaudeBudgetTokenSelector} stays
 * as the standalone once-per-start selector for a caller that wants nothing
 * more than that.
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
 * Every candidate is named with both windows' remaining budget and reset time
 * and the remaining share it was ranked on, and the winner with the reason it
 * won, through {@link formatClaudeTokenSelectionLog}.
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
  type ClaudeBudgetWindowName,
  type ClaudeTokenBudget,
  type ClaudeTokenBudgetWindow,
  probeClaudeTokenBudget,
} from "./claude_token_budget.ts";
import {
  providerPoolCandidates,
  type ProviderTokenFile,
  type ProviderTokenSelector,
  selectFirstProviderToken,
} from "./credential_preflight.ts";

/** Prefix shared by every line this module logs. */
const LOG_PREFIX = "[SECURITY] claude token";

/**
 * Five-hour **remaining** share a token must hold to be worth running
 * against: 20%, above which the gate passes and at or below which it fails.
 *
 * The one figure behind both spellings of the gate (Issue #1668). It is also
 * `POOL_BUDGET_FLOOR` in `claude_pool_budget.ts` — "worth restarting for" and
 * "worth switching to" are the same question, and two floors that drifted
 * would let a host restart for a token the gate then refuses to select.
 *
 * A fixed constant, deliberately not an environment variable (Issue #1623):
 * the figure describes how Anthropic's windows behave, not how one host is
 * configured, so a per-host override would only let a fleet drift apart.
 */
export const CLAUDE_FIVE_HOUR_GATE_MIN_REMAINING = 0.2;

/**
 * Five-hour usage share a token must stay **below** to pass the gate: a token
 * that has used 80% or more of its five-hour window fails it. Past it the
 * token cannot spend whatever its seven-day window still holds, so no remaining
 * share it reports is worth acting on.
 *
 * The complement of {@link CLAUDE_FIVE_HOUR_GATE_MIN_REMAINING}, and derived
 * from it rather than restated, so the two cannot drift. Derived in this
 * direction because only this one is exact: `1 - 0.2` is exactly `0.8`, while
 * `1 - 0.8` is `0.19999999999999996`.
 *
 * The gate compares usage rather than the remaining share, because that is
 * the comparison it makes: at exactly 20% remaining the token has used
 * exactly 80% and fails, which no `remaining >= 0.2` spelling gets right on
 * both sides of the boundary.
 */
export const CLAUDE_FIVE_HOUR_GATE_MAX_USED = 1 -
  CLAUDE_FIVE_HOUR_GATE_MIN_REMAINING;

/**
 * Ratio of used share to elapsed share at or above which the weekly quota
 * "will not last" and the backlog tiers are skipped (Issue #1885).
 *
 * A linear projection: a token that has spent 62% of its week with 42% of the
 * week elapsed is on course for 149% by reset, so the quota runs out before
 * the window does. At exactly 1.0 the projection lands on the quota at the
 * instant it resets — the target — so the gate engages there and the
 * remaining budget goes to `top-priority` and `work-on` work.
 *
 * A fixed constant beside {@link CLAUDE_FIVE_HOUR_GATE_MIN_REMAINING} and
 * deliberately not a `.config.json` key, for the same reason that one is: the
 * figure describes how Anthropic's weekly window behaves, not how one host is
 * configured, so a per-host override would only let a fleet drift apart.
 */
export const CLAUDE_WEEK_PACE_THRESHOLD = 1;

/**
 * Hours of the seven-day window that must have elapsed before the pace
 * projection is trusted (Issue #1885).
 *
 * Early in a window the divisor is tiny, so one heavy run reads as a
 * catastrophic burn rate: 2% used in the first hour of 168 projects to 336%.
 * A day in, the projection describes the week rather than the last few
 * minutes. Below the grace the gate is always off, so the backlog runs.
 */
export const CLAUDE_WEEK_PACE_GRACE_HOURS = 24;

/** Why the winning token won — stable, greppable, and safe to log. */
export type ClaudeTokenSelectionReason =
  /**
   * Strictly the largest remaining share of the seven-day window (or of the
   * only window reported) of every candidate that passed the five-hour gate.
   */
  | "most-seven-day-remaining"
  /** Level on remaining share; won on the sooner reset. */
  | "equal-seven-day-remaining-soonest-reset"
  /** Level on remaining share and reset; won on #917's discovery order. */
  | "tied-discovery-order"
  /**
   * No candidate passed the five-hour gate; the winner is the one whose
   * five-hour window refills first.
   */
  | "five-hour-gate-failed-soonest-reset"
  /** No candidate had a known budget; #917's discovery order decided. */
  | "budget-unknown-discovery-order";

/** One window as ranking sees it, with its reset resolved against `now`. */
export interface RankedClaudeWindow {
  /** Which window this is. */
  readonly window: ClaudeBudgetWindowName;
  /** Remaining share in `[0, 1]`; 1 when the window had already reset. */
  readonly remainingFraction: number;
  /** The reported reset, in epoch milliseconds. */
  readonly resetAt: number;
  /** True when {@link resetAt} had already passed, so the window is full. */
  readonly elapsed: boolean;
}

/** One candidate's probe result, with the figures ranking actually used. */
export interface RankedClaudeToken {
  /** Loggable identity — the file stem, never the token value. */
  readonly label: string;
  /** Discovery position from #917, zero-based. The final tie-break. */
  readonly index: number;
  /** The probe outcome this ranking was computed from. */
  readonly budget: ClaudeTokenBudget;
  /** The five-hour window the gate was applied to, or null when absent. */
  readonly fiveHour: RankedClaudeWindow | null;
  /** The window the token is ranked on — seven-day when reported. */
  readonly rankWindow: RankedClaudeWindow | null;
  /** True when the five-hour window still holds the gate's minimum share. */
  readonly passesFiveHourGate: boolean;
  /**
   * Remaining share of {@link rankWindow}, in `[0, 1]`, or null when the
   * budget is unknown. 1 for a token whose window had already reset.
   *
   * This and the two fields below flatten {@link rankWindow} — the same three
   * figures, without the null check at every call site. `rankWindow` stays the
   * source of truth; these are derived from it in one place
   * ({@link rankingView}) and never set independently.
   */
  readonly remainingFraction: number | null;
  /** {@link rankWindow}'s reset in epoch ms, or null when unknown. */
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
 * Resolve one reported window against the current time.
 *
 * A reset in the past means the window rolled over after the figure was
 * produced: the token is fresh, not nearly spent.
 */
function resolveWindow(
  reported: ClaudeTokenBudgetWindow,
  now: number,
): RankedClaudeWindow {
  const elapsed = reported.resetAt <= now;
  return {
    window: reported.window,
    remainingFraction: elapsed ? 1 : reported.remainingFraction,
    resetAt: reported.resetAt,
    elapsed,
  };
}

/**
 * Every window the probe reported, falling back to the headline figure for a
 * budget carrying no window array of its own.
 */
function reportedWindows(
  budget: Extract<ClaudeTokenBudget, { known: true }>,
): readonly ClaudeTokenBudgetWindow[] {
  if (budget.windows.length > 0) return budget.windows;
  return [{
    window: budget.window,
    remainingFraction: budget.remainingFraction,
    resetAt: budget.resetAt,
  }];
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
      fiveHour: null,
      rankWindow: null,
      passesFiveHourGate: false,
      remainingFraction: null,
      resetAt: null,
      windowElapsed: false,
    };
  }
  const windows = reportedWindows(budget).map((window) =>
    resolveWindow(window, now)
  );
  const fiveHour = windows.find((w) => w.window === "five_hour") ?? null;
  // The ranking is on the seven-day window; a response that did not report
  // one is ranked on the window it did report rather than dropped.
  const rankWindow = windows.find((w) => w.window === "seven_day") ??
    windows[0] ?? null;
  return {
    label: budget.label,
    index,
    budget,
    fiveHour,
    rankWindow,
    // A response carrying no five-hour window has no gate to fail.
    passesFiveHourGate: fiveHour === null ||
      1 - fiveHour.remainingFraction < CLAUDE_FIVE_HOUR_GATE_MAX_USED,
    remainingFraction: rankWindow?.remainingFraction ?? null,
    resetAt: rankWindow?.resetAt ?? null,
    windowElapsed: rankWindow?.elapsed ?? false,
  };
}

/**
 * Which band a candidate falls in. Bands are compared before anything else,
 * so every candidate in a lower band beats every candidate above it.
 *
 * 0. passed the five-hour gate;
 * 1. failed the five-hour gate — it cannot spend what it holds right now;
 * 2. budget unknown, which never drops a candidate, only ranks it last.
 */
function band(candidate: RankedClaudeToken): 0 | 1 | 2 {
  if (candidate.remainingFraction === null) return 2;
  return candidate.passesFiveHourGate ? 0 : 1;
}

/**
 * Order two candidates: by band, then — inside the passing band — by the most
 * remaining share, soonest reset, and finally discovery order. Gate failures
 * are ordered by which five-hour window refills first.
 */
function compareCandidates(
  a: RankedClaudeToken,
  b: RankedClaudeToken,
): number {
  const bandA = band(a);
  const bandB = band(b);
  if (bandA !== bandB) return bandA - bandB;
  if (bandA === 2) return a.index - b.index;
  if (bandA === 1) {
    // Nothing here can be spent now, so the first to refill is used first.
    const leftReset = a.fiveHour?.resetAt ?? Number.MAX_SAFE_INTEGER;
    const rightReset = b.fiveHour?.resetAt ?? Number.MAX_SAFE_INTEGER;
    if (leftReset !== rightReset) return leftReset - rightReset;
    return a.index - b.index;
  }
  // The most weekly quota left is spent first.
  const remainingA = a.remainingFraction ?? 0;
  const remainingB = b.remainingFraction ?? 0;
  if (remainingA !== remainingB) return remainingB - remainingA;
  const leftReset = a.resetAt ?? Number.MAX_SAFE_INTEGER;
  const rightReset = b.resetAt ?? Number.MAX_SAFE_INTEGER;
  if (leftReset !== rightReset) return leftReset - rightReset;
  return a.index - b.index;
}

/** Name why the head of a ranked list beat the rest. */
function winningReason(
  ranked: readonly RankedClaudeToken[],
): ClaudeTokenSelectionReason | null {
  const winner = ranked[0];
  if (winner === undefined) return null;
  const winnerBand = band(winner);
  if (winnerBand === 2) return "budget-unknown-discovery-order";
  if (winnerBand === 1) return "five-hour-gate-failed-soonest-reset";
  const runnerUp = ranked[1];
  if (
    runnerUp === undefined || band(runnerUp) !== 0 ||
    runnerUp.remainingFraction !== winner.remainingFraction
  ) {
    return "most-seven-day-remaining";
  }
  return runnerUp.resetAt === winner.resetAt
    ? "tied-discovery-order"
    : "equal-seven-day-remaining-soonest-reset";
}

/**
 * Rank probe results by the most seven-day quota left — the pure heart of the
 * selection (Issue #919, reshaped by Issue #1623 and by the owner's
 * 2026-10-29 decision).
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

/** Describe one window for the log, or say it was not reported. */
function describeWindow(
  name: ClaudeBudgetWindowName,
  window: RankedClaudeWindow | null,
): string {
  if (window === null) return `${name}=absent`;
  const described = `${name}=${formatShare(window.remainingFraction)} ` +
    `resets=${formatReset(window.resetAt)}`;
  return window.elapsed
    ? `${described} (window already elapsed, counted as full)`
    : described;
}

/** Describe one candidate's budget for the log — labels and figures only. */
function describeCandidate(candidate: RankedClaudeToken): string {
  const { budget } = candidate;
  if (!budget.known) {
    const detail = budget.detail === undefined
      ? ""
      : ` detail=${JSON.stringify(budget.detail)}`;
    return `remaining=unknown reason=${budget.reason}${detail}`;
  }
  const sevenDay = candidate.rankWindow?.window === "seven_day"
    ? candidate.rankWindow
    : null;
  const remaining = candidate.remainingFraction === null
    ? "remaining=unknown"
    : `remaining=${formatShare(candidate.remainingFraction)}`;
  const gate = candidate.passesFiveHourGate ? "gate=pass" : "gate=fail";
  return `${describeWindow("five_hour", candidate.fiveHour)} ` +
    `${describeWindow("seven_day", sevenDay)} ${remaining} ${gate}`;
}

/**
 * The startup decision log: one line per candidate, then the winner.
 *
 * Pure, so a test can assert the exact text. Candidates are listed best-first
 * with their discovery position, both windows and the remaining share that
 * ranked them,
 * and identified by label alone — the token value is not an input to this
 * function, so it cannot reach the output.
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
  // A gate failure was decided on the five-hour reset, so the line that
  // records the decision has to carry it.
  const gateDetail = winner.passesFiveHourGate || winner.fiveHour === null
    ? ""
    : `${describeWindow("five_hour", winner.fiveHour)} `;
  const detail = winner.remainingFraction === null
    ? `remaining=unknown`
    : `${gateDetail}remaining=${formatShare(winner.remainingFraction)} ` +
      `resets=${
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

    const pool = providerPoolCandidates(tokens);
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
