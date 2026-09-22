/**
 * Pace-aware provider fallback (Issue #2470).
 *
 * The week-pace guard (Issue #1885) drops the `low-priority` and `idle-task`
 * tiers while the preferred provider's weekly quota is projected to run out.
 * That parks the backlog even while an operator-named fallback provider sits
 * idle — the fallback policy (`provider_fallback_policy.ts`) only engages
 * mid-run on an outage-class failure, never at pickup time.
 *
 * This module is the pickup-time half: two pure decisions the wiring,
 * the claim scan, the census and the filer must all share, so none of them
 * can re-derive the verdict differently and manufacture a disagreement.
 *
 * The caller owns the side effects (the provider switch, the billing log):
 * this module decides, it never switches.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { ProviderFallbackPolicy } from "./provider_fallback_policy.ts";

/**
 * The provider the paced backlog runs on, or `null`.
 *
 * The operator's fallback list is the opt-in: an engaged guard plus an
 * `ordered` policy names the first alternative; a pinned policy or an empty
 * list names nothing and today's behaviour (drop the tiers, keep the
 * preferred provider) is unchanged.
 */
export function paceFallbackProviderId(input: {
  /** The guard's verdict for this scan cycle. */
  paceEngaged: boolean;
  /** The resolved fallback policy from the worker config. */
  policy: ProviderFallbackPolicy;
}): string | null {
  if (!input.paceEngaged) return null;
  if (input.policy.mode !== "ordered") return null;
  const [first] = input.policy.alternatives;
  return first ?? null;
}

/**
 * Whether the claim scan drops the `low-priority` and `idle-task` tiers.
 *
 * True only while the guard is engaged AND no fallback provider took the
 * backlog — once a fallback is running the backlog, the drop's whole reason
 * (protect the remaining preferred-provider quota) no longer applies. Every
 * consumer of the guard's verdict — the scan, the census, the filer — must
 * use this flag so they keep agreeing about what is claimable.
 */
export function paceTierDrop(input: {
  /** The guard's verdict for this scan cycle. */
  paceEngaged: boolean;
  /** The provider the paced backlog runs on, or `null`. */
  fallbackProviderId: string | null;
}): boolean {
  return input.paceEngaged && input.fallbackProviderId === null;
}
