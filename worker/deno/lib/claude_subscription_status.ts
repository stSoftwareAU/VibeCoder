/** Claude adapter for the generic subscription status contract (Issue #1925).
 *
 * This is intentionally only an adapter. It does not replace Claude's mature
 * probe, token pool, snapshot cache, or selection rules.
 */

import type { ClaudeTokenBudget } from "./claude_token_budget.ts";
import type { QuotaCandidate } from "./provider_quota.ts";
import {
  type ProviderSubscriptionStatus,
  subscriptionStatusFromQuotaCandidate,
} from "./provider_subscription_status.ts";

/** Translate an existing Claude budget result into the shared status shape. */
export function subscriptionStatusFromClaudeBudget(
  budget: ClaudeTokenBudget,
  observedAt: number,
): ProviderSubscriptionStatus {
  const candidate: QuotaCandidate = budget.known
    ? {
      providerId: "claude",
      credentialLabel: budget.label,
      budget: {
        known: true,
        windows: budget.windows.map((window) => ({
          name: window.window,
          remainingFraction: window.remainingFraction,
          resetAt: window.resetAt,
        })),
      },
    }
    : {
      providerId: "claude",
      credentialLabel: budget.label,
      budget: { known: false, reason: budget.reason },
    };

  return subscriptionStatusFromQuotaCandidate(candidate, observedAt, {
    billingMode: "fixed-subscription",
    confidence: budget.known ? "authoritative" : "unknown",
    ...(budget.known ? {} : { reason: budget.reason }),
  });
}
