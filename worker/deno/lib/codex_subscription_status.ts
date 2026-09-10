/** Codex adapter for the generic subscription status contract (Issue #1925). */

import type { CodexBudgetSnapshot } from "./codex_budget.ts";
import { quotaCandidateFromCodexSnapshot } from "./codex_quota.ts";
import {
  type ProviderSubscriptionStatus,
  subscriptionStatusFromQuotaCandidate,
} from "./provider_subscription_status.ts";

/**
 * Translate one cached/read-only Codex budget snapshot. API-key auth is
 * explicitly metered and therefore unavailable to subscription-only routing.
 */
export function subscriptionStatusFromCodexSnapshot(
  credentialLabel: string,
  snapshot: CodexBudgetSnapshot,
): ProviderSubscriptionStatus {
  const candidate = quotaCandidateFromCodexSnapshot(credentialLabel, snapshot);

  if (snapshot.authMode === "api-key") {
    return subscriptionStatusFromQuotaCandidate(candidate, snapshot.readAt, {
      billingMode: "metered",
      confidence: "authoritative",
      reason: "api-key-account",
    });
  }

  const billingMode = snapshot.authMode === "chatgpt"
    ? "fixed-subscription" as const
    : "unknown" as const;
  const confidence = snapshot.source === "exhaustion-event" ||
      snapshot.source === "rollout-token-count"
    ? "authoritative" as const
    : "inferred" as const;

  return subscriptionStatusFromQuotaCandidate(candidate, snapshot.readAt, {
    billingMode,
    confidence,
    ...(snapshot.budget.known ? {} : { reason: snapshot.budget.reason }),
  });
}
