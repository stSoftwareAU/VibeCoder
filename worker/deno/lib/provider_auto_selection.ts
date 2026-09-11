/**
 * Quota-aware automatic coding-agent provider selection (Issue #1926).
 *
 * This module is deliberately provider-agnostic. Claude and Codex own how
 * their subscription state is discovered and translated into the shared
 * {@link ProviderSubscriptionStatus} contract; this file only decides which
 * already-normalised fixed-price subscription is the best place for the next
 * invocation.
 *
 * Automatic routing is fail-closed on billing mode: a provider is eligible
 * only when it is explicitly known to be a `fixed-subscription`. Metered and
 * unknown billing modes can never win, so a missing subscription probe cannot
 * accidentally turn into API spend.
 *
 * Selection is not "largest remaining percentage wins". For every fresh,
 * known window we calculate remaining percentage per hour until reset, then
 * use the most constrained (lowest) rate as the provider's score. This favours
 * capacity that will replenish soon while preserving a healthier long-lived
 * allowance elsewhere. Configured provider order is the final deterministic
 * tie-breaker.
 *
 * Unknown quota is not exhaustion. A provider whose fixed-price status is
 * known but whose quota is unknown remains a last-resort candidate after every
 * provider with fresh known capacity; stale observations are treated the same
 * way until refreshed. That keeps telemetry failure from becoming a fabricated
 * zero while still preferring evidence we can trust.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import type { ProviderSubscriptionStatus } from "./provider_quota.ts";

/** Maximum age of status evidence accepted as fresh by the default policy. */
export const DEFAULT_AUTO_PROVIDER_STATUS_MAX_AGE_MS = 10 * 60_000;

/** Why one provider cannot participate in automatic selection. */
export type AutomaticProviderExclusionReason =
  | "metered-billing"
  | "billing-unknown"
  | "unavailable"
  | "exhausted";

/** Confidence band used before the numeric score. Lower is better. */
export type AutomaticProviderBand =
  | "fresh-known"
  | "fresh-unknown-quota"
  | "stale";

/** One normalised candidate as seen by the ranking policy. */
export interface AutomaticProviderCandidate {
  readonly provider: string;
  readonly credentialLabel: string;
  readonly preferenceIndex: number;
  readonly band: AutomaticProviderBand | null;
  readonly score: number | null;
  readonly earliestResetAt: number | null;
  readonly excluded: AutomaticProviderExclusionReason | null;
  readonly status: ProviderSubscriptionStatus;
}

/** Result of ranking every supplied provider status. */
export interface AutomaticProviderSelection {
  /** The selected provider, or null when automatic work must defer. */
  readonly winner: AutomaticProviderCandidate | null;
  /** Every input in rank order, including excluded entries for observability. */
  readonly ranked: readonly AutomaticProviderCandidate[];
  /** Earliest known future reset among exhausted providers, when there is one. */
  readonly retryAt: number | null;
  /** Stable, log-safe explanation of the decision. */
  readonly reason:
    | "fresh-known-capacity"
    | "fixed-subscription-quota-unknown"
    | "stale-fixed-subscription-status"
    | "no-eligible-fixed-subscription";
}

/** Options for {@link selectAutomaticProvider}. */
export interface AutomaticProviderSelectionOptions {
  /** Current epoch milliseconds. Required so the policy itself has no clock. */
  readonly now: number;
  /** Maximum accepted evidence age. */
  readonly maxAgeMs?: number;
  /** Provider ids in operator preference order. */
  readonly preference?: readonly string[];
}

function preferenceIndex(
  provider: string,
  preference: readonly string[],
  fallbackIndex: number,
): number {
  const configured = preference.indexOf(provider);
  return configured === -1 ? preference.length + fallbackIndex : configured;
}

function futureResets(
  status: ProviderSubscriptionStatus,
  now: number,
): number[] {
  return status.windows
    .map((window) => window.resetsAt)
    .filter((value): value is number =>
      value !== undefined && Number.isFinite(value) && value > now
    );
}

/**
 * Score a fresh known status by its most constrained remaining/hour window.
 *
 * A missing reset cannot produce a defensible rate and is ignored. If every
 * window lacks a usable reset the status falls into the unknown-quota band;
 * no reset time is invented.
 */
function constrainedRatePerHour(
  status: ProviderSubscriptionStatus,
  now: number,
): number | null {
  const rates: number[] = [];
  for (const window of status.windows) {
    const remaining = window.remainingPercent;
    const reset = window.resetsAt;
    if (
      remaining === undefined || !Number.isFinite(remaining) ||
      reset === undefined || !Number.isFinite(reset) || reset <= now
    ) continue;
    const hours = (reset - now) / 3_600_000;
    if (hours <= 0) continue;
    rates.push(Math.max(0, remaining) / hours);
  }
  return rates.length === 0 ? null : Math.min(...rates);
}

function candidateView(
  status: ProviderSubscriptionStatus,
  inputIndex: number,
  options:
    & Required<Pick<AutomaticProviderSelectionOptions, "now" | "maxAgeMs">>
    & Pick<AutomaticProviderSelectionOptions, "preference">,
): AutomaticProviderCandidate {
  const preference = options.preference ?? [];
  const index = preferenceIndex(status.provider, preference, inputIndex);
  const resets = futureResets(status, options.now);
  const earliestResetAt = resets.length === 0 ? null : Math.min(...resets);

  if (status.billingMode === "metered") {
    return {
      provider: status.provider,
      credentialLabel: status.credentialLabel,
      preferenceIndex: index,
      band: null,
      score: null,
      earliestResetAt,
      excluded: "metered-billing",
      status,
    };
  }
  if (status.billingMode !== "fixed-subscription") {
    return {
      provider: status.provider,
      credentialLabel: status.credentialLabel,
      preferenceIndex: index,
      band: null,
      score: null,
      earliestResetAt,
      excluded: "billing-unknown",
      status,
    };
  }
  if (status.availability === "unavailable") {
    return {
      provider: status.provider,
      credentialLabel: status.credentialLabel,
      preferenceIndex: index,
      band: null,
      score: null,
      earliestResetAt,
      excluded: "unavailable",
      status,
    };
  }
  if (status.availability === "exhausted") {
    return {
      provider: status.provider,
      credentialLabel: status.credentialLabel,
      preferenceIndex: index,
      band: null,
      score: null,
      earliestResetAt,
      excluded: "exhausted",
      status,
    };
  }

  const age = Math.max(0, options.now - status.observedAt);
  if (!Number.isFinite(status.observedAt) || age >= options.maxAgeMs) {
    return {
      provider: status.provider,
      credentialLabel: status.credentialLabel,
      preferenceIndex: index,
      band: "stale",
      score: null,
      earliestResetAt,
      excluded: null,
      status,
    };
  }

  const score = status.availability === "available"
    ? constrainedRatePerHour(status, options.now)
    : null;
  return {
    provider: status.provider,
    credentialLabel: status.credentialLabel,
    preferenceIndex: index,
    band: score === null ? "fresh-unknown-quota" : "fresh-known",
    score,
    earliestResetAt,
    excluded: null,
    status,
  };
}

function bandRank(band: AutomaticProviderBand | null): number {
  switch (band) {
    case "fresh-known":
      return 0;
    case "fresh-unknown-quota":
      return 1;
    case "stale":
      return 2;
    default:
      return 3;
  }
}

function compareCandidates(
  left: AutomaticProviderCandidate,
  right: AutomaticProviderCandidate,
): number {
  const leftExcluded = left.excluded === null ? 0 : 1;
  const rightExcluded = right.excluded === null ? 0 : 1;
  if (leftExcluded !== rightExcluded) return leftExcluded - rightExcluded;

  const leftBand = bandRank(left.band);
  const rightBand = bandRank(right.band);
  if (leftBand !== rightBand) return leftBand - rightBand;

  // Higher remaining-per-hour is preferable: it represents capacity that can
  // be spent before it replenishes, while leaving longer-lived allowance on
  // another provider intact.
  if (left.score !== null || right.score !== null) {
    const l = left.score ?? Number.NEGATIVE_INFINITY;
    const r = right.score ?? Number.NEGATIVE_INFINITY;
    if (l !== r) return r - l;
  }

  // If the score is equal, use the capacity that resets sooner, then the
  // operator's stable preference order. Unknown reset sorts after known reset.
  const leftReset = left.earliestResetAt ?? Number.MAX_SAFE_INTEGER;
  const rightReset = right.earliestResetAt ?? Number.MAX_SAFE_INTEGER;
  if (leftReset !== rightReset) return leftReset - rightReset;
  return left.preferenceIndex - right.preferenceIndex;
}

/**
 * Choose the provider for the next automatic invocation.
 *
 * Explicit provider selection is intentionally outside this function. A caller
 * that was given an explicit provider must not call the auto selector at all;
 * this policy therefore cannot silently override an operator or issue-level
 * pin.
 */
export function selectAutomaticProvider(
  statuses: readonly ProviderSubscriptionStatus[],
  options: AutomaticProviderSelectionOptions,
): AutomaticProviderSelection {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_AUTO_PROVIDER_STATUS_MAX_AGE_MS;
  if (!Number.isFinite(options.now)) {
    throw new Error(
      "automatic provider selection requires a finite current time",
    );
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error(
      `automatic provider selection maxAgeMs must be positive, got ${maxAgeMs}`,
    );
  }

  const ranked = statuses
    .map((status, index) =>
      candidateView(status, index, {
        now: options.now,
        maxAgeMs,
        preference: options.preference,
      })
    )
    .sort(compareCandidates);
  const winner = ranked.find((candidate) => candidate.excluded === null) ??
    null;
  const exhaustedResets = ranked
    .filter((candidate) => candidate.excluded === "exhausted")
    .map((candidate) => candidate.earliestResetAt)
    .filter((value): value is number => value !== null && value > options.now);
  const retryAt = exhaustedResets.length === 0
    ? null
    : Math.min(...exhaustedResets);

  let reason: AutomaticProviderSelection["reason"];
  if (winner === null) reason = "no-eligible-fixed-subscription";
  else if (winner.band === "fresh-known") reason = "fresh-known-capacity";
  else if (winner.band === "stale") reason = "stale-fixed-subscription-status";
  else reason = "fixed-subscription-quota-unknown";

  return { winner, ranked, retryAt, reason };
}

/** Render an automatic routing decision without credential values. */
export function formatAutomaticProviderSelection(
  selection: AutomaticProviderSelection,
): string {
  const candidates = selection.ranked.map((candidate) => {
    const state = candidate.excluded ?? candidate.band ?? "unknown";
    const score = candidate.score === null
      ? ""
      : ` score=${candidate.score.toFixed(3)}%/h`;
    return `${candidate.provider}/${candidate.credentialLabel}:${state}${score}`;
  }).join(", ");
  const winner = selection.winner === null
    ? "none"
    : `${selection.winner.provider}/${selection.winner.credentialLabel}`;
  return `[quota] automatic provider selected=${winner} reason=${selection.reason}` +
    (selection.retryAt === null ? "" : ` retryAt=${selection.retryAt}`) +
    ` candidates=[${candidates}]`;
}
