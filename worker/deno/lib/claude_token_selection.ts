/**
 * Pick the Claude token with the most remaining budget per hour at worker
 * start (Issue #1623; originally #919, parent #902).
 *
 * An operator with two or more Claude subscriptions wants them consumed
 * evenly without touching the host between runs. #917 finds every configured
 * token file and leaves a {@link ProviderTokenSelector} seam; #918 turns one
 * token into a remaining-budget figure. This module is the join: probe every
 * pool candidate, rank the answers, export the winner, and say why it won.
 *
 * ## Ranking
 *
 * The rule is "use it or lose it" (Issue #1623): the token worth the most
 * **per hour** is spent first, because budget that resets before it is used
 * is budget thrown away. A token holding 20% of a week that resets in six
 * hours is worth far more right now than one holding 90% that resets in six
 * and a half days.
 *
 * {@link rankClaudeTokenBudgets} is **pure** — no I/O, and the current time is
 * a parameter rather than a clock of its own — so every rule below is a plain
 * unit test:
 *
 * - **Exhaustion is the only hard condition** (Issue #1685). A token whose
 *   reported window has nothing left — 0% remaining, or a usage-limit result
 *   recorded as spent — cannot serve a call at all, so it ranks behind every
 *   token that can, until that window resets.
 * - **The five-hour window is a soft guard, not a score.** A token holding at
 *   least {@link CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING} of it can carry an
 *   approximately hour-long Vibe Coder run, so while any usable token clears
 *   the guard the choice is restricted to those. When **no** usable token
 *   clears it the guard steps aside rather than idling the pool: the same
 *   weekly ranking picks between what is left. Exactly 20% remaining is
 *   usable — the guard bites below it.
 * - **Candidates are ordered by remaining budget per hour** on the seven-day
 *   window: its remaining share divided by the hours until it resets. Nothing
 *   overrides that rate for a usable token — in particular there is no weekly
 *   floor, because a nearly spent week that resets within the hour is exactly
 *   the budget that would otherwise lapse.
 * - **A response that reported no seven-day window ranks behind every
 *   candidate in its band that did report one** (Issue #1731). Its five-hour
 *   remaining-per-hour is a figure on a different scale, so comparing the two
 *   made a missing weekly header look artificially urgent — 60% of five hours
 *   resetting in four is 15%/h against a genuine week's 0.35%/h — and
 *   repeatedly picked the least-measured subscription. Missing weekly
 *   telemetry is probe data quality, not evidence of a spent week: such a
 *   token is degraded-but-usable, never excluded, and nothing about the gap
 *   is remembered, so the next snapshot that carries a week ranks normally
 *   again. When a whole band lacks the window, those candidates are ranked
 *   against each other on the same-scale window they did report, so the pool
 *   keeps working rather than idling on absent telemetry.
 * - A token whose `resetAt` has already passed is treated as a fresh, FULL
 *   window, in both the guard and the rate. The probe reports the window that
 *   was current when the figure was produced; once that instant is behind us
 *   the window has rolled over and the old utilisation describes a window that
 *   no longer exists. Its hours-until-reset is the window's nominal length (5
 *   or 168), so a rolled-over window scores a rate rather than dividing by a
 *   negative number.
 * - A tie on rate goes to the **soonest** reset, then to discovery order.
 * - **Exhausted tokens are ordered by when they become usable again** — the
 *   last of their spent windows to reset — so when nothing can be spent now
 *   the token that recovers first is the one used.
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
 * and its seven-day rate in percent per hour, and the winner with the reason
 * it won, through {@link formatClaudeTokenSelectionLog}.
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

/** One hour, in milliseconds — the denominator of every rate here. */
const HOUR_MS = 3_600_000;

/**
 * Five-hour **remaining** share that carries an approximately hour-long Vibe
 * Coder run: 20%, at and above which the guard is met.
 *
 * A *preference* boundary, not an eligibility condition (Issue #1685). While
 * any usable token holds this much, selection is restricted to those tokens;
 * when none does, the guard steps aside and the weekly ranking chooses from
 * what is left, because a pool holding usable quota must never idle.
 *
 * A fixed constant, deliberately not an environment variable (Issue #1623):
 * the figure describes how Anthropic's windows behave, not how one host is
 * configured, so a per-host override would only let a fleet drift apart.
 */
export const CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING = 0.2;

/**
 * Five-hour usage share a token may reach and still meet the guard: a token
 * that has used **more** than 80% of its five-hour window falls under it.
 *
 * The complement of {@link CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING}, and derived
 * from it rather than restated, so the two cannot drift. Derived in this
 * direction because only this one is exact: `1 - 0.2` is exactly `0.8`, while
 * `1 - 0.8` is `0.19999999999999996`.
 *
 * The guard compares usage rather than the remaining share, because that is
 * the comparison it makes: at exactly 20% remaining the token has used
 * exactly 80% and is usable, which a `remaining >= 0.2` spelling gets wrong
 * on figures the probe actually produces.
 */
export const CLAUDE_FIVE_HOUR_GUARD_MAX_USED = 1 -
  CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING;

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

/** Nominal length of each window, used when its reset has already passed. */
const WINDOW_HOURS: Record<ClaudeBudgetWindowName, number> = {
  five_hour: 5,
  seven_day: 168,
};

/** Why the winning token won — stable, greppable, and safe to log. */
export type ClaudeTokenSelectionReason =
  /**
   * Strictly the most remaining budget per hour of every usable candidate
   * that meets the five-hour guard.
   */
  | "highest-remaining-per-hour"
  /**
   * Won because it carries seven-day telemetry and the runner-up in its band
   * does not; a five-hour rate is never compared with a weekly one
   * (Issue #1731).
   */
  | "seven-day-telemetry-preferred"
  /**
   * No candidate in the winner's band reported a seven-day window, so they
   * were ranked against each other on the window they did report
   * (Issue #1731). Degraded, deliberately still a selection.
   */
  | "no-seven-day-telemetry-degraded-fallback"
  /** Level on budget per hour; won on the sooner reset. */
  | "equal-remaining-per-hour-soonest-reset"
  /** Level on rate and reset; won on #917's discovery order. */
  | "tied-discovery-order"
  /**
   * No usable candidate meets the five-hour guard, so the guard stepped
   * aside; the winner is the highest weekly remaining-per-hour of them
   * (Issue #1685).
   */
  | "below-five-hour-guard-highest-remaining-per-hour"
  /**
   * Every candidate is exhausted; the winner is the one whose spent windows
   * reset first.
   */
  | "exhausted-soonest-reset"
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
  /** Hours until the reset; the window's nominal length when elapsed. */
  readonly hoursUntilReset: number;
}

/** One candidate's probe result, with the figures ranking actually used. */
export interface RankedClaudeToken {
  /** Loggable identity — the file stem, never the token value. */
  readonly label: string;
  /** Discovery position from #917, zero-based. The final tie-break. */
  readonly index: number;
  /** The probe outcome this ranking was computed from. */
  readonly budget: ClaudeTokenBudget;
  /** The five-hour window the guard was applied to, or null when absent. */
  readonly fiveHour: RankedClaudeWindow | null;
  /** The window the rate was computed on — seven-day when reported. */
  readonly rateWindow: RankedClaudeWindow | null;
  /** Remaining share per hour until {@link rateWindow} resets, or null. */
  readonly ratePerHour: number | null;
  /** True when the five-hour window still holds the guard's minimum share. */
  readonly meetsFiveHourGuard: boolean;
  /**
   * True when the probe reported a seven-day window, so {@link ratePerHour}
   * is a weekly rate and comparable with the other weekly rates.
   *
   * False is **degraded-but-usable**, never exhausted and never unknown: the
   * rate is then the reported five-hour window's, on a different scale, so
   * such a candidate ranks behind every candidate in its band that carries a
   * week and is compared only with the others that do not (Issue #1731).
   */
  readonly hasSevenDayTelemetry: boolean;
  /**
   * True when a reported window has nothing left and has not yet reset, so
   * the token cannot serve a call at all until it does.
   */
  readonly exhausted: boolean;
  /**
   * When an {@link exhausted} token becomes usable again — the last of its
   * spent windows to reset — or null when it is not exhausted.
   */
  readonly availableAt: number | null;
  /**
   * Remaining share of {@link rateWindow}, in `[0, 1]`, or null when the
   * budget is unknown. 1 for a token whose window had already reset.
   *
   * This and the two fields below flatten {@link rateWindow} — the same three
   * figures, without the null check at every call site. `rateWindow` stays the
   * source of truth; these are derived from it in one place
   * ({@link rankingView}) and never set independently.
   */
  readonly remainingFraction: number | null;
  /** {@link rateWindow}'s reset in epoch ms, or null when unknown. */
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
 * produced: the token is fresh, not nearly spent, and the hours it has left
 * are the window's full nominal length rather than a negative number.
 */
function rankWindow(
  reported: ClaudeTokenBudgetWindow,
  now: number,
): RankedClaudeWindow {
  const elapsed = reported.resetAt <= now;
  return {
    window: reported.window,
    remainingFraction: elapsed ? 1 : reported.remainingFraction,
    resetAt: reported.resetAt,
    elapsed,
    hoursUntilReset: elapsed
      ? WINDOW_HOURS[reported.window]
      : (reported.resetAt - now) / HOUR_MS,
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
      rateWindow: null,
      ratePerHour: null,
      meetsFiveHourGuard: false,
      hasSevenDayTelemetry: false,
      exhausted: false,
      availableAt: null,
      remainingFraction: null,
      resetAt: null,
      windowElapsed: false,
    };
  }
  const windows = reportedWindows(budget).map((window) =>
    rankWindow(window, now)
  );
  const fiveHour = windows.find((w) => w.window === "five_hour") ?? null;
  const sevenDay = windows.find((w) => w.window === "seven_day") ?? null;
  // The rate is the seven-day window's; a response that did not report one is
  // ranked on the window it did report rather than dropped — but on that
  // scale only, against the others that also lack a week (Issue #1731).
  const rateWindow = sevenDay ?? windows[0] ?? null;
  // A window with nothing left and a reset still ahead of us is spent: the
  // token cannot serve a call against it, whatever its other window holds.
  // `rankWindow` has already counted a rolled-over window as full, so an
  // exhaustion lapses of its own accord at the reset.
  const spent = windows.filter((w) => w.remainingFraction <= 0);
  return {
    label: budget.label,
    index,
    budget,
    fiveHour,
    rateWindow,
    ratePerHour: rateWindow === null
      ? null
      : rateWindow.remainingFraction / rateWindow.hoursUntilReset,
    // A response carrying no five-hour window has no guard to fall under.
    meetsFiveHourGuard: fiveHour === null ||
      1 - fiveHour.remainingFraction <= CLAUDE_FIVE_HOUR_GUARD_MAX_USED,
    hasSevenDayTelemetry: sevenDay !== null,
    exhausted: spent.length > 0,
    // Usable again only once every spent window has reset, so the latest of
    // them is the instant that matters.
    availableAt: spent.length === 0
      ? null
      : spent.reduce((latest, w) => Math.max(latest, w.resetAt), -Infinity),
    remainingFraction: rateWindow?.remainingFraction ?? null,
    resetAt: rateWindow?.resetAt ?? null,
    windowElapsed: rateWindow?.elapsed ?? false,
  };
}

/**
 * Which band a candidate falls in. Bands are compared before anything else,
 * so every candidate in a lower band beats every candidate above it.
 *
 * 0. usable and meets the five-hour guard;
 * 1. usable but under the guard — chosen only when band 0 is empty, which is
 *    the guard stepping aside rather than idling a pool that has quota;
 * 2. exhausted: nothing can be spent against it until its window resets;
 * 3. budget unknown, which never drops a candidate, only ranks it last.
 */
function band(candidate: RankedClaudeToken): 0 | 1 | 2 | 3 {
  if (candidate.ratePerHour === null) return 3;
  if (candidate.exhausted) return 2;
  return candidate.meetsFiveHourGuard ? 0 : 1;
}

/**
 * Order two candidates: by band, then — inside a usable band — by remaining
 * budget per hour, soonest reset, and finally discovery order. Exhausted
 * candidates are ordered by which becomes usable again first.
 */
function compareCandidates(
  a: RankedClaudeToken,
  b: RankedClaudeToken,
): number {
  const bandA = band(a);
  const bandB = band(b);
  if (bandA !== bandB) return bandA - bandB;
  if (bandA === 3) return a.index - b.index;
  if (bandA === 2) {
    // Nothing here can be spent now, so the first to recover is used first.
    const leftReset = a.availableAt ?? Number.MAX_SAFE_INTEGER;
    const rightReset = b.availableAt ?? Number.MAX_SAFE_INTEGER;
    if (leftReset !== rightReset) return leftReset - rightReset;
    return a.index - b.index;
  }
  // Known weekly data first: a five-hour rate and a weekly rate are numbers
  // on different scales, so the candidate that actually reported a week is
  // preferred rather than compared with one that did not (Issue #1731). This
  // sits INSIDE the band, so the exhaustion exclusion and the five-hour soft
  // guard are both still decided ahead of it.
  if (a.hasSevenDayTelemetry !== b.hasSevenDayTelemetry) {
    return a.hasSevenDayTelemetry ? -1 : 1;
  }
  // Use it or lose it: the budget worth most per hour is spent first. Both
  // candidates now describe the same window, so the rates are comparable.
  const rateA = a.ratePerHour ?? 0;
  const rateB = b.ratePerHour ?? 0;
  if (rateA !== rateB) return rateB - rateA;
  const leftReset = a.resetAt ?? Number.MAX_SAFE_INTEGER;
  const rightReset = b.resetAt ?? Number.MAX_SAFE_INTEGER;
  if (leftReset !== rightReset) return leftReset - rightReset;
  return a.index - b.index;
}

/**
 * Why a usable winner won on its rate, when nothing in its band contested it
 * on telemetry quality: the degradation first, then the guard, then the rate.
 *
 * The degradation is named ahead of the guard because it is the more unusual
 * signal — a pool running on five-hour figures alone is a probe data-quality
 * problem an operator wants to see, while the guard stepping aside is already
 * visible in every candidate line (Issue #1731).
 */
function rateReason(
  winner: RankedClaudeToken,
  winnerBand: 0 | 1,
): ClaudeTokenSelectionReason {
  if (!winner.hasSevenDayTelemetry) {
    return "no-seven-day-telemetry-degraded-fallback";
  }
  return winnerBand === 1
    ? "below-five-hour-guard-highest-remaining-per-hour"
    : "highest-remaining-per-hour";
}

/**
 * Name why the head of a ranked list beat the rest — the last discriminator
 * {@link compareCandidates} actually applied, in its order: band, then
 * telemetry quality, then the rate, then the reset, then discovery order.
 */
function winningReason(
  ranked: readonly RankedClaudeToken[],
): ClaudeTokenSelectionReason | null {
  const winner = ranked[0];
  if (winner === undefined) return null;
  const winnerBand = band(winner);
  if (winnerBand === 3) return "budget-unknown-discovery-order";
  if (winnerBand === 2) return "exhausted-soonest-reset";
  const runnerUp = ranked[1];
  // Nothing in the winner's band to be compared with, so the band it reached
  // is the whole reason.
  if (runnerUp === undefined || band(runnerUp) !== winnerBand) {
    return rateReason(winner, winnerBand);
  }
  // Telemetry quality is compared before the rate, so when the two differ on
  // it the rates were never compared at all (Issue #1731).
  if (winner.hasSevenDayTelemetry !== runnerUp.hasSevenDayTelemetry) {
    return "seven-day-telemetry-preferred";
  }
  if (runnerUp.ratePerHour !== winner.ratePerHour) {
    return rateReason(winner, winnerBand);
  }
  return runnerUp.resetAt === winner.resetAt
    ? "tied-discovery-order"
    : "equal-remaining-per-hour-soonest-reset";
}

/**
 * Rank probe results by remaining budget per hour — the pure heart of the
 * selection (Issue #919, reshaped by Issue #1623).
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

/** Render a remaining-budget-per-hour rate as a percentage per hour. */
function formatRate(ratePerHour: number): string {
  return `${(ratePerHour * 100).toFixed(2)}%/h`;
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
    return `remaining=unknown reason=${budget.reason}`;
  }
  const sevenDay = candidate.rateWindow?.window === "seven_day"
    ? candidate.rateWindow
    : null;
  const rate = candidate.ratePerHour === null
    ? "rate=unknown"
    : `rate=${formatRate(candidate.ratePerHour)}`;
  // One field with three values, so a reader never has to combine two:
  // exhausted is the hard condition, below the soft guard, pass neither.
  const guard = candidate.exhausted
    ? "guard=exhausted"
    : candidate.meetsFiveHourGuard
    ? "guard=pass"
    : "guard=below";
  return `${describeWindow("five_hour", candidate.fiveHour)} ` +
    `${describeWindow("seven_day", sevenDay)} ${rate} ${guard}`;
}

/**
 * The startup decision log: one line per candidate, then the winner.
 *
 * Pure, so a test can assert the exact text. Candidates are listed best-first
 * with their discovery position, both windows and the rate that ranked them,
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
  // A winner that did not meet the guard was chosen despite its five-hour
  // window, so the line that records the decision has to carry it.
  const guardDetail = winner.meetsFiveHourGuard || winner.fiveHour === null
    ? ""
    : `${describeWindow("five_hour", winner.fiveHour)} `;
  const detail =
    winner.remainingFraction === null || winner.ratePerHour === null
      ? `remaining=unknown`
      : `${guardDetail}rate=${formatRate(winner.ratePerHour)} ` +
        `remaining=${formatShare(winner.remainingFraction)} resets=${
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
