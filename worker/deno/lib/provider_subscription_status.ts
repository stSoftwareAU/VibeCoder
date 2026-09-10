/**
 * Provider-agnostic fixed-price subscription status (Issue #1925).
 *
 * Vendor adapters translate their own quota evidence into this contract. The
 * scheduler therefore never needs to understand Anthropic headers, Codex
 * rollout JSON, OAuth tokens, or any other provider-specific shape.
 *
 * Unknown is deliberately different from exhausted. Metered credentials are
 * deliberately different again: they are never eligible for subscription-only
 * routing, even when their quota is otherwise unknown.
 */

import type { QuotaCandidate } from "./provider_quota.ts";

export type ProviderBillingMode =
  | "fixed-subscription"
  | "metered"
  | "unknown";

export type ProviderSubscriptionAvailability =
  | "available"
  | "exhausted"
  | "unavailable"
  | "unknown";

export type ProviderSubscriptionConfidence =
  | "authoritative"
  | "inferred"
  | "unknown";

export interface ProviderSubscriptionQuotaWindow {
  readonly id: string;
  /** Remaining percentage in [0, 100], when the provider reported one. */
  readonly remainingPercent?: number;
  /** Epoch milliseconds, when the provider reported a reset. */
  readonly resetsAt?: number;
}

export interface ProviderSubscriptionStatus {
  readonly provider: string;
  /** Log-safe account/file label; never a token or token fragment. */
  readonly credentialLabel: string;
  readonly billingMode: ProviderBillingMode;
  readonly availability: ProviderSubscriptionAvailability;
  readonly windows: readonly ProviderSubscriptionQuotaWindow[];
  /** Epoch milliseconds at which this status was observed. */
  readonly observedAt: number;
  readonly confidence: ProviderSubscriptionConfidence;
  /** Stable, log-safe reason code only. */
  readonly reason?: string;
}

/** A provider-specific probe. Shared callers know only this signature. */
export type ProviderSubscriptionProbe = () =>
  | ProviderSubscriptionStatus
  | Promise<ProviderSubscriptionStatus>;

export interface SubscriptionStatusOptions {
  readonly billingMode?: ProviderBillingMode;
  readonly confidence?: ProviderSubscriptionConfidence;
  readonly reason?: string;
}

/**
 * Normalise the existing shared quota candidate without knowing its vendor.
 */
export function subscriptionStatusFromQuotaCandidate(
  candidate: QuotaCandidate,
  observedAt: number,
  options: SubscriptionStatusOptions = {},
): ProviderSubscriptionStatus {
  const billingMode = options.billingMode ?? "fixed-subscription";
  const confidence = options.confidence ?? "inferred";

  if (billingMode === "metered") {
    return {
      provider: candidate.providerId,
      credentialLabel: candidate.credentialLabel,
      billingMode,
      availability: "unavailable",
      windows: [],
      observedAt,
      confidence,
      reason: options.reason ?? "metered-billing-not-eligible",
    };
  }

  if (!candidate.budget.known) {
    return {
      provider: candidate.providerId,
      credentialLabel: candidate.credentialLabel,
      billingMode,
      availability: "unknown",
      windows: [],
      observedAt,
      confidence: confidence === "authoritative" ? "inferred" : confidence,
      reason: options.reason ?? candidate.budget.reason,
    };
  }

  const windows = candidate.budget.windows.map((window) => ({
    id: window.name,
    remainingPercent: window.remainingFraction * 100,
    ...(window.resetAt === undefined ? {} : { resetsAt: window.resetAt }),
  }));
  const exhausted = windows.some((window) => window.remainingPercent === 0);

  return {
    provider: candidate.providerId,
    credentialLabel: candidate.credentialLabel,
    billingMode,
    availability: exhausted ? "exhausted" : "available",
    windows,
    observedAt,
    confidence,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };
}

export const DEFAULT_SUBSCRIPTION_STATUS_CACHE_MS = 5 * 60_000;

export interface ProviderSubscriptionStatusCacheOptions {
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

/**
 * Short-lived, deduplicating cache for provider status probes.
 *
 * Probe failure is data, not a worker failure. Error text is intentionally not
 * copied into the result because it may contain credential material.
 */
export class ProviderSubscriptionStatusCache {
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #values = new Map<string, ProviderSubscriptionStatus>();
  readonly #inFlight = new Map<string, Promise<ProviderSubscriptionStatus>>();

  constructor(options: ProviderSubscriptionStatusCacheOptions = {}) {
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_SUBSCRIPTION_STATUS_CACHE_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  #key(provider: string, credentialLabel: string): string {
    return `${provider}\u0000${credentialLabel}`;
  }

  latest(
    provider: string,
    credentialLabel: string,
  ): ProviderSubscriptionStatus | undefined {
    return this.#values.get(this.#key(provider, credentialLabel));
  }

  record(status: ProviderSubscriptionStatus): void {
    this.#values.set(
      this.#key(status.provider, status.credentialLabel),
      status,
    );
  }

  /** Immediately replace cached evidence after a real quota-exhausted result. */
  recordExhaustion(
    provider: string,
    credentialLabel: string,
    resetsAt?: number,
  ): ProviderSubscriptionStatus {
    const previous = this.latest(provider, credentialLabel);
    const status: ProviderSubscriptionStatus = {
      provider,
      credentialLabel,
      billingMode: previous?.billingMode ?? "fixed-subscription",
      availability: "exhausted",
      windows: resetsAt === undefined
        ? []
        : [{ id: "observed-exhaustion", remainingPercent: 0, resetsAt }],
      observedAt: this.#now(),
      confidence: "authoritative",
      reason: "observed-quota-exhaustion",
    };
    this.record(status);
    return status;
  }

  async get(
    provider: string,
    credentialLabel: string,
    probe: ProviderSubscriptionProbe,
  ): Promise<ProviderSubscriptionStatus> {
    const key = this.#key(provider, credentialLabel);
    const cached = this.#values.get(key);
    const now = this.#now();
    if (cached && now - cached.observedAt < this.#maxAgeMs) return cached;

    const running = this.#inFlight.get(key);
    if (running) return running;

    const pending = Promise.resolve()
      .then(probe)
      .then((status) => {
        this.record(status);
        return status;
      })
      .catch(() => {
        const unknown: ProviderSubscriptionStatus = {
          provider,
          credentialLabel,
          billingMode: cached?.billingMode ?? "unknown",
          availability: "unknown",
          windows: [],
          observedAt: this.#now(),
          confidence: "unknown",
          reason: "probe-failed",
        };
        this.record(unknown);
        return unknown;
      })
      .finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, pending);
    return pending;
  }
}
