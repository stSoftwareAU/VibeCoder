/**
 * One answer to "how is this provider billed?" for every routing path
 * (Issue #1923, parent goal of #1924/#1925/#1926/#1927).
 *
 * VibeCoder runs unattended for months on fixed-price subscriptions, and must
 * never quietly turn a spent subscription into per-token API spend. Two
 * routing paths can change provider without a human: quota-aware automatic
 * selection (`provider_auto_runtime.ts`) and the opt-in health-gate fallback
 * (`agent_provider_fallback`). Each needs the same question answered, so the
 * answer is stated once here and read from the provider descriptor's declared
 * {@link AgentProviderBilling} capability — not from a `case "claude"` chain
 * repeated per call site.
 *
 * Fail-closed by construction. A provider that proves nothing is `unknown`,
 * and unknown is never fixed-price: {@link isFixedPriceSubscription} answers
 * true only for a positively proved subscription.
 *
 * **No credential value is ever read into the result.** Presence is inspected
 * and the `reason` carries a variable NAME or a state label, so the evidence
 * is safe to log.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { agentProviderById } from "./agent_provider.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import type { ProviderBillingMode } from "./provider_quota.ts";

/** What a provider's credentials were proved to be, and what proved it. */
export interface ProviderBillingEvidence {
  /** The provider id the question was asked about. */
  readonly provider: string;
  readonly billingMode: ProviderBillingMode;
  /** Log-safe: a variable NAME or a state label, never a credential value. */
  readonly reason: string;
}

/** What {@link classifyProviderBilling} may read. */
export interface ProviderBillingContext {
  /** The worker's work directory, for provider state kept beside it. */
  readonly workDir: string;
  /** Environment lookup; defaults to the process environment. */
  readonly env?: EnvLookup;
}

/** The first declared variable carrying a non-blank value, if any. */
function firstPresent(
  names: readonly string[],
  env: EnvLookup,
): string | undefined {
  return names.find((name) => (env(name) ?? "").trim().length > 0);
}

/**
 * Classify how one provider's currently available credentials are billed.
 *
 * Precedence, most authoritative first:
 *   1. A declared subscription variable with a non-blank value — the run
 *      holds a fixed-price subscription.
 *   2. The provider's own stored-state probe (Codex's persistent ChatGPT
 *      login), which may report either mode. It runs before the declared
 *      metered variables so a provider whose CLI gives an API key precedence
 *      can say so itself.
 *   3. A declared metered variable with a non-blank value — per-token spend.
 *   4. Otherwise `unknown`. Unknown is **not** exhausted and **not**
 *      fixed-price; it simply proves nothing.
 *
 * @param providerId - Provider id to classify.
 * @param context - Work directory and environment lookup.
 * @returns The billing mode and the log-safe label that proved it.
 */
export function classifyProviderBilling(
  providerId: string,
  context: ProviderBillingContext,
): ProviderBillingEvidence {
  const provider = providerId.trim();
  const env = context.env ?? processEnvLookup;
  const descriptor = provider ? agentProviderById(provider) : undefined;
  if (!descriptor) {
    // An id nothing is registered under proves nothing about billing, and a
    // caller must not read that silence as a subscription.
    return {
      provider,
      billingMode: "unknown",
      reason: "provider-not-registered",
    };
  }

  const billing = descriptor.billing;
  const subscription = firstPresent(billing.subscriptionEnvVars, env);
  if (subscription) {
    return {
      provider,
      billingMode: "fixed-subscription",
      reason: subscription,
    };
  }

  const stored = billing.resolveStoredBilling?.({
    workDir: context.workDir,
    env,
  });
  if (stored) {
    return {
      provider,
      billingMode: stored.mode,
      reason: stored.reason,
    };
  }

  const metered = firstPresent(billing.meteredEnvVars, env);
  if (metered) {
    return { provider, billingMode: "metered", reason: metered };
  }

  return {
    provider,
    billingMode: "unknown",
    reason: "subscription-credential-missing",
  };
}

/**
 * Whether this evidence proves a fixed-price subscription.
 *
 * The one predicate an unattended routing decision should use: `metered` and
 * `unknown` both answer false, so a missing or failed probe can never become
 * accidental API spend.
 *
 * @param evidence - A classification from {@link classifyProviderBilling}.
 * @returns true only for a positively proved fixed-price subscription.
 */
export function isFixedPriceSubscription(
  evidence: ProviderBillingEvidence,
): boolean {
  return evidence.billingMode === "fixed-subscription";
}
