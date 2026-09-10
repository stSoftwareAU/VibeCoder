/**
 * Shared quota ranking for every coding-agent provider (Issue #1696,
 * parent #1694).
 *
 * Claude's five-hour gate and seven-day remaining-per-hour rule live in
 * `claude_token_selection.ts` and stay Claude's. This module is the
 * extracted comparison: a provider **declares** which windows it has and
 * whether a soft gate applies; the ranker never invents a five-hour window
 * for a vendor that does not have one, and an unknown budget stays unknown
 * rather than becoming zero.
 *
 * Tokens are identified by **provider id + credential label** only. No
 * secret value is an input to anything this module formats.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

/** One reported (or rolled-over) window on a credential. */
export interface QuotaWindow {
  /** Provider-declared window name (`five_hour`, `primary`, …). */
  readonly name: string;
  /** Remaining share in `[0, 1]`. */
  readonly remainingFraction: number;
  /** Rollover in epoch milliseconds, when known. */
  readonly resetAt?: number;
  /**
   * Nominal length in hours, used when `resetAt` is already in the past.
   * A window that omits this and has no reset cannot score a rate.
   */
  readonly nominalHours?: number;
}

/** A budget that was determined from a real source. */
export interface QuotaBudgetKnown {
  readonly known: true;
  readonly windows: readonly QuotaWindow[];
}

/** A budget that could not be determined — never represented as zero. */
export interface QuotaBudgetUnknown {
  readonly known: false;
  /** Stable, log-safe reason (`api-key-account`, `probe-failed`, …). */
  readonly reason: string;
}

export type QuotaBudget = QuotaBudgetKnown | QuotaBudgetUnknown;

/** One credential offered to the ranker. */
export interface QuotaCandidate {
  readonly providerId: string;
  readonly credentialLabel: string;
  readonly budget: QuotaBudget;
}

/**
 * How one provider's windows are compared.
 *
 * A policy that names no `softGateWindow` has no five-hour-style filter.
 * A policy that names no `rankWindow` ranks on the first reported window.
 */
export interface QuotaPolicy {
  /** Window that must stay below {@link softGateMaxUsed} to be eligible. */
  readonly softGateWindow?: string;
  /** Usage share at or above which the soft gate fails (Claude: 0.8). */
  readonly softGateMaxUsed?: number;
  /** Window whose remaining/hour sets the score (Claude: `seven_day`). */
  readonly rankWindow?: string;
  /** Rank-window remaining below which a passing token is demoted. */
  readonly lowRemainingFloor?: number;
  /** Nominal hours for named windows when a reset has already passed. */
  readonly nominalHours: Readonly<Record<string, number>>;
  /**
   * Remaining share at or below which a known window is treated as
   * exhausted (ineligible), not merely low. Codex uses `0`; Claude leaves
   * this unset so the existing soft gate owns refusal.
   */
  readonly exhaustedAtOrBelow?: number;
}

/** Claude's declared windows — the #1623 / #1685 rule. */
export const CLAUDE_QUOTA_POLICY: QuotaPolicy = {
  softGateWindow: "five_hour",
  softGateMaxUsed: 0.8,
  rankWindow: "seven_day",
  lowRemainingFloor: 0.1,
  nominalHours: { five_hour: 5, seven_day: 168 },
};

/**
 * Codex ChatGPT subscription windows. The pinned CLI reports `primary` /
 * `secondary` with their own `window_minutes`; there is no five-hour gate
 * unless a window happens to be five hours long. API-key accounts never
 * reach this policy — they stay `{ known: false, reason: "api-key-account" }`.
 */
export const CODEX_QUOTA_POLICY: QuotaPolicy = {
  rankWindow: "primary",
  lowRemainingFloor: 0.1,
  exhaustedAtOrBelow: 0,
  nominalHours: { primary: 168, secondary: 168 },
};

const HOUR_MS = 3_600_000;

/** Why the winner won — stable and safe to log. */
export type QuotaSelectionReason =
  | "highest-remaining-per-hour"
  | "equal-remaining-per-hour-soonest-reset"
  | "tied-discovery-order"
  | "low-rank-window-remaining-highest-rate"
  | "soft-gate-failed-soonest-reset"
  | "budget-unknown-discovery-order";

interface RankedWindow {
  readonly name: string;
  readonly remainingFraction: number;
  readonly resetAt?: number;
  readonly elapsed: boolean;
  readonly hoursUntilReset: number | null;
}

/** One candidate after the policy is applied. */
export interface RankedQuotaCandidate {
  readonly providerId: string;
  readonly credentialLabel: string;
  readonly index: number;
  readonly budget: QuotaBudget;
  readonly eligible: boolean;
  readonly remainingFraction: number | null;
  readonly ratePerHour: number | null;
  readonly resetAt: number | null;
  readonly softGatePassed: boolean;
}

export interface QuotaRanking {
  readonly ranked: readonly RankedQuotaCandidate[];
  readonly winner: RankedQuotaCandidate | null;
  readonly reason: QuotaSelectionReason | null;
}

function nominalHours(
  window: QuotaWindow,
  policy: QuotaPolicy,
): number | undefined {
  return window.nominalHours ?? policy.nominalHours[window.name];
}

function resolveWindow(
  reported: QuotaWindow,
  now: number,
  policy: QuotaPolicy,
): RankedWindow {
  const hours = nominalHours(reported, policy);
  const resetAt = reported.resetAt;
  const elapsed = resetAt !== undefined && resetAt <= now;
  const hoursUntilReset = elapsed
    ? hours ?? null
    : resetAt !== undefined
    ? (resetAt - now) / HOUR_MS
    : hours ?? null;
  return {
    name: reported.name,
    remainingFraction: elapsed ? 1 : reported.remainingFraction,
    resetAt,
    elapsed,
    hoursUntilReset,
  };
}

function view(
  candidate: QuotaCandidate,
  index: number,
  now: number,
  policy: QuotaPolicy,
): RankedQuotaCandidate {
  if (!candidate.budget.known) {
    return {
      providerId: candidate.providerId,
      credentialLabel: candidate.credentialLabel,
      index,
      budget: candidate.budget,
      eligible: false,
      remainingFraction: null,
      ratePerHour: null,
      resetAt: null,
      softGatePassed: false,
    };
  }
  const windows = candidate.budget.windows.map((w) =>
    resolveWindow(w, now, policy)
  );
  const gateName = policy.softGateWindow;
  const gate = gateName === undefined
    ? null
    : windows.find((w) => w.name === gateName) ?? null;
  const maxUsed = policy.softGateMaxUsed ?? 1;
  const softGatePassed = gate === null ||
    1 - gate.remainingFraction < maxUsed;
  const rankName = policy.rankWindow;
  const rateWindow =
    (rankName === undefined
      ? undefined
      : windows.find((w) => w.name === rankName)) ?? windows[0] ?? null;
  const hours = rateWindow?.hoursUntilReset ?? null;
  const ratePerHour = rateWindow === null || hours === null || hours <= 0
    ? null
    : rateWindow.remainingFraction / hours;
  const remaining = rateWindow?.remainingFraction ?? null;
  const exhaustedFloor = policy.exhaustedAtOrBelow;
  const exhausted = exhaustedFloor !== undefined && remaining !== null &&
    remaining <= exhaustedFloor && !(rateWindow?.elapsed ?? false);
  return {
    providerId: candidate.providerId,
    credentialLabel: candidate.credentialLabel,
    index,
    budget: candidate.budget,
    eligible: softGatePassed && !exhausted && ratePerHour !== null,
    remainingFraction: remaining,
    ratePerHour,
    resetAt: rateWindow?.resetAt ?? null,
    softGatePassed,
  };
}

function band(
  candidate: RankedQuotaCandidate,
  policy: QuotaPolicy,
): 0 | 1 | 2 | 3 {
  if (candidate.ratePerHour === null) return 3;
  if (!candidate.softGatePassed) return 2;
  const floor = policy.lowRemainingFloor;
  if (floor !== undefined && (candidate.remainingFraction ?? 0) < floor) {
    return 1;
  }
  return 0;
}

function compare(
  a: RankedQuotaCandidate,
  b: RankedQuotaCandidate,
  policy: QuotaPolicy,
): number {
  const bandA = band(a, policy);
  const bandB = band(b, policy);
  if (bandA !== bandB) return bandA - bandB;
  if (bandA === 3) return a.index - b.index;
  if (bandA === 2) {
    const left = a.resetAt ?? Number.MAX_SAFE_INTEGER;
    const right = b.resetAt ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return a.index - b.index;
  }
  const rateA = a.ratePerHour ?? 0;
  const rateB = b.ratePerHour ?? 0;
  if (rateA !== rateB) return rateB - rateA;
  const left = a.resetAt ?? Number.MAX_SAFE_INTEGER;
  const right = b.resetAt ?? Number.MAX_SAFE_INTEGER;
  if (left !== right) return left - right;
  return a.index - b.index;
}

function winningReason(
  ranked: readonly RankedQuotaCandidate[],
  policy: QuotaPolicy,
): QuotaSelectionReason | null {
  const winner = ranked[0];
  if (winner === undefined) return null;
  const winnerBand = band(winner, policy);
  if (winnerBand === 3) return "budget-unknown-discovery-order";
  if (winnerBand === 2) return "soft-gate-failed-soonest-reset";
  if (winnerBand === 1) return "low-rank-window-remaining-highest-rate";
  const runnerUp = ranked[1];
  if (runnerUp === undefined || band(runnerUp, policy) !== 0) {
    return "highest-remaining-per-hour";
  }
  if (runnerUp.ratePerHour !== winner.ratePerHour) {
    return "highest-remaining-per-hour";
  }
  return runnerUp.resetAt === winner.resetAt
    ? "tied-discovery-order"
    : "equal-remaining-per-hour-soonest-reset";
}

/**
 * Rank credentials by remaining budget per hour under `policy`.
 *
 * Input order is the discovery order and the last tie-break. Nothing is
 * dropped: an unknown budget ranks last so a probe failure cannot hide a
 * configured credential.
 *
 * @param candidates - One entry per credential, in discovery order.
 * @param now - Epoch milliseconds (a parameter, never this module's clock).
 * @param policy - The provider's declared windows and gates.
 */
export function rankQuotaCandidates(
  candidates: readonly QuotaCandidate[],
  now: number,
  policy: QuotaPolicy,
): QuotaRanking {
  const ranked = candidates
    .map((candidate, index) => view(candidate, index, now, policy))
    .sort((a, b) => compare(a, b, policy));
  return {
    ranked,
    winner: ranked[0] ?? null,
    reason: winningReason(ranked, policy),
  };
}

/** Log every candidate's windows, rate, eligibility and the winner reason. */
export function formatQuotaSelectionLog(ranking: QuotaRanking): string {
  const lines = ranking.ranked.map((candidate) => {
    const budget = candidate.budget.known
      ? `remaining=${
        candidate.remainingFraction === null
          ? "unknown"
          : `${(candidate.remainingFraction * 100).toFixed(1)}%`
      } rate=${
        candidate.ratePerHour === null
          ? "unknown"
          : `${(candidate.ratePerHour * 100).toFixed(2)}%/h`
      }`
      : `unknown:${candidate.budget.reason}`;
    return `${candidate.providerId}/${candidate.credentialLabel} ` +
      `${budget} eligible=${candidate.eligible}`;
  });
  const winner = ranking.winner === null
    ? "none"
    : `${ranking.winner.providerId}/${ranking.winner.credentialLabel} ` +
      `(${ranking.reason ?? "unknown"})`;
  return `[quota] selected ${winner}; candidates: ${lines.join("; ")}`;
}
