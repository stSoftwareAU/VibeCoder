/**
 * Unattended restart/soak observability for subscription providers (Issue #1927).
 *
 * The subscription path was delivered in stages — Codex persistent ChatGPT
 * authentication (#1924), the shared quota/status probe (#1925) and quota-aware
 * automatic selection/failover (#1926). This module is the *qualification*
 * surface on top of them: it joins each provider's subscription status with its
 * authentication evidence and the automatic-routing decision into one
 * operator-facing snapshot that an unattended deployment — and the automated
 * restart-cycle tests — can assert on without ever reading a credential.
 *
 * Three properties are load-bearing:
 *
 * - **Restart determinism.** The snapshot is a pure function of `(statuses,
 *   auth, now, selection)`. Nothing is read from disk or the process
 *   environment, so two identical worker/container generations produce an
 *   identical snapshot and a Claude-only baseline cannot drift.
 * - **Token refresh, not reuse.** {@link refreshInstant} names the earliest
 *   instant a credential must be refreshed — expiry when known, otherwise a
 *   configured horizon after the last refresh — so a long-lived run refreshes
 *   before expiry rather than reusing an unexpired access token forever.
 * - **Fail-closed billing.** {@link SubscriptionBillingGuardVerdict} cross-checks
 *   the automatic selection: a metered or unknown-billing winner is reported as
 *   a guard failure, never silently accepted.
 *
 * No credential value is an input to, or an output of, anything here. Labels
 * and reason codes only.
 *
 * Australian English spelling throughout (behaviour, organisation, utilise).
 */

import type { AutomaticProviderSelection } from "./provider_auto_selection.ts";
import type {
  ProviderBillingMode,
  ProviderSubscriptionAvailability,
  ProviderSubscriptionConfidence,
  ProviderSubscriptionQuotaWindow,
  ProviderSubscriptionStatus,
} from "./provider_quota.ts";

/**
 * Default horizon after a refresh before a token must be refreshed again
 * (12 hours). A token with a known expiry always uses the earlier of the two.
 */
export const DEFAULT_SUBSCRIPTION_TOKEN_REFRESH_HORIZON_MS = 12 * 3_600_000;

/** How a provider authenticates, as far as soak qualification is concerned. */
export type SubscriptionAuthKind =
  /** A fixed-price subscription login (Claude OAuth / ChatGPT). */
  | "subscription-login"
  /** A metered API-key credential — never eligible for automatic routing. */
  | "metered"
  /** No credential could be established. */
  | "none";

/** Authentication evidence, stripped of any credential value. */
export interface SubscriptionAuthEvidence {
  readonly kind: SubscriptionAuthKind;
  /** When the credential was last minted/refreshed, epoch ms. */
  readonly refreshedAt?: number;
  /** When the credential is known to expire, epoch ms. */
  readonly expiresAt?: number;
  /** Whether the refreshed state lives outside the disposable container. */
  readonly persistedDurably: boolean;
  /** Stable, log-safe reason; never a credential value. */
  readonly reason?: string;
}

/** The earliest instant a credential must be refreshed, or null when unknown. */
export interface SubscriptionSoakEntry {
  readonly provider: string;
  readonly credentialLabel: string;
  readonly billingMode: ProviderBillingMode;
  readonly availability: ProviderSubscriptionAvailability;
  readonly windows: readonly ProviderSubscriptionQuotaWindow[];
  readonly observedAt: number;
  readonly confidence: ProviderSubscriptionConfidence;
  readonly reason?: string;
  readonly auth: SubscriptionAuthEvidence;
  readonly refreshBy: number | null;
}

/** The billing guard verdict cross-checked against the automatic selection. */
export interface SubscriptionBillingGuardVerdict {
  /** False only when the selection handed a metered or unknown-billing winner. */
  readonly holds: boolean;
  readonly meteredCandidateWon: boolean;
  readonly unknownBillingCandidateWon: boolean;
  /** Stable reason; safe to log. */
  readonly reason: string;
}

/** The operator-facing soak snapshot for one routing decision. */
export interface SubscriptionSoakStatus {
  readonly providersEnabled: readonly string[];
  readonly entries: readonly SubscriptionSoakEntry[];
  /** True when every eligible fixed-price subscription is exhausted/unavailable. */
  readonly allExhaustedOrUnavailable: boolean;
  /** Providers needing initial/re-authentication before they can be used. */
  readonly authRequiredProviders: readonly string[];
  /** Earliest known future reset among exhausted providers, epoch ms or null. */
  readonly retryAt: number | null;
  readonly selection: AutomaticProviderSelection;
  readonly billingGuard: SubscriptionBillingGuardVerdict;
  /** Stable, log-safe one-line summary; never a credential value. */
  readonly summary: string;
}

/** Inputs to {@link buildSubscriptionSoakStatus}. */
export interface BuildSubscriptionSoakStatusOptions {
  /** Providers the running image installed, in operator order. */
  readonly enabledProviderIds: readonly string[];
  /** One normalised status per credential in play. */
  readonly statuses: readonly ProviderSubscriptionStatus[];
  /** Authentication evidence per provider id. */
  readonly auths: Readonly<Record<string, SubscriptionAuthEvidence>>;
  /** Current epoch milliseconds. */
  readonly now: number;
  /** The automatic-routing decision this snapshot qualifies. */
  readonly selection: AutomaticProviderSelection;
  /** Refresh horizon; defaults to {@link DEFAULT_SUBSCRIPTION_TOKEN_REFRESH_HORIZON_MS}. */
  readonly horizonMs?: number;
}

/**
 * Compute the earliest instant a credential must be refreshed.
 *
 * Expiry always wins when known; otherwise the horizon after the last refresh
 * bounds reuse. A result in the past is a refresh already due — it is data,
 * never silently advanced.
 *
 * @param expiresAt - Known expiry, epoch ms, when available.
 * @param refreshedAt - Last mint/refresh, epoch ms, when available.
 * @param horizonMs - Refresh horizon after {@link refreshedAt}.
 * @returns The refresh instant, or null when neither bound is known.
 */
export function refreshInstant(
  expiresAt: number | undefined,
  refreshedAt: number | undefined,
  horizonMs: number = DEFAULT_SUBSCRIPTION_TOKEN_REFRESH_HORIZON_MS,
): number | null {
  const candidates: number[] = [];
  if (expiresAt !== undefined && Number.isFinite(expiresAt)) {
    candidates.push(expiresAt);
  }
  if (refreshedAt !== undefined && Number.isFinite(refreshedAt)) {
    candidates.push(refreshedAt + horizonMs);
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/** Whether a refresh instant is due at `now`. */
export function isTokenRefreshDue(
  refreshBy: number | null,
  now: number,
): boolean {
  return refreshBy !== null && refreshBy <= now;
}

const AUTH_REASON_PATTERN = /auth/i;

/** Build the operator-facing soak snapshot for one routing decision. */
export function buildSubscriptionSoakStatus(
  options: BuildSubscriptionSoakStatusOptions,
): SubscriptionSoakStatus {
  const horizonMs = options.horizonMs ??
    DEFAULT_SUBSCRIPTION_TOKEN_REFRESH_HORIZON_MS;
  if (!Number.isFinite(options.now)) {
    throw new Error("subscription soak status requires a finite current time");
  }
  if (!Number.isFinite(horizonMs) || horizonMs <= 0) {
    throw new Error(
      `subscription soak refresh horizon must be positive, got ${horizonMs}`,
    );
  }

  const enabled = options.enabledProviderIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .filter((id, index, all) => all.indexOf(id) === index);

  const entries: SubscriptionSoakEntry[] = options.statuses.map((status) => {
    const auth = options.auths[status.provider] ?? {
      kind: "none" as const,
      persistedDurably: false,
    };
    return {
      provider: status.provider,
      credentialLabel: status.credentialLabel,
      billingMode: status.billingMode,
      availability: status.availability,
      windows: status.windows,
      observedAt: status.observedAt,
      confidence: status.confidence,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      auth,
      refreshBy: refreshInstant(
        auth.expiresAt,
        auth.refreshedAt,
        horizonMs,
      ),
    };
  });

  const enabledEntries = entries.filter((entry) =>
    enabled.includes(entry.provider)
  );
  const eligible = enabledEntries.filter((entry) =>
    entry.billingMode === "fixed-subscription" ||
    entry.billingMode === "unknown"
  );
  const allExhaustedOrUnavailable = eligible.length > 0 &&
    eligible.every((entry) =>
      entry.availability === "exhausted" || entry.availability === "unavailable"
    );
  const authRequiredProviders = enabledEntries
    .filter((entry) =>
      entry.availability === "unavailable" &&
      AUTH_REASON_PATTERN.test(entry.reason ?? "")
    )
    .map((entry) => entry.provider);

  const winner = options.selection.winner;
  const meteredCandidateWon = winner !== null &&
    winner.status.billingMode === "metered";
  const unknownBillingCandidateWon = winner !== null &&
    winner.status.billingMode === "unknown";
  const billingGuard: SubscriptionBillingGuardVerdict = {
    holds: !meteredCandidateWon && !unknownBillingCandidateWon,
    meteredCandidateWon,
    unknownBillingCandidateWon,
    reason: meteredCandidateWon
      ? "metered-candidate-won"
      : unknownBillingCandidateWon
      ? "unknown-billing-candidate-won"
      : "no-metered-or-unknown-winner",
  };

  const chosen = winner === null
    ? "none"
    : `${winner.provider}/${winner.credentialLabel}`;
  const authRequired = authRequiredProviders.length === 0
    ? "none"
    : authRequiredProviders.join(",");
  const probe = enabledEntries
    .map((entry) =>
      `${entry.provider}:${entry.availability}@${entry.observedAt}`
    )
    .join(";");
  const summary =
    `[soak] providers-enabled=${enabled.join(",")} chosen=${chosen} ` +
    `reason=${options.selection.reason} ` +
    `all-eligible-exhausted=${allExhaustedOrUnavailable} ` +
    `auth-required=${authRequired} ` +
    `billing-guard=${billingGuard.holds ? "holds" : "failed"} ` +
    `retryAt=${options.selection.retryAt ?? "none"} ` +
    `last-quota-probe=${probe}`;

  return {
    providersEnabled: enabled,
    entries,
    allExhaustedOrUnavailable,
    authRequiredProviders,
    retryAt: options.selection.retryAt,
    selection: options.selection,
    billingGuard,
    summary,
  };
}
