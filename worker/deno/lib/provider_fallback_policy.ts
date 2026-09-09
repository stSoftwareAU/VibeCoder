/**
 * Explicit, opt-in provider routing (Issue #1700, parent #1694).
 *
 * `agent_provider` stays the default and `agent_providers` the enabled set.
 * A fallback list is **off** until the operator writes one. A pinned
 * provider (`fallback: []` or omitted) must not be substituted. Ordinary
 * task failure, auth/config errors and ambiguous failures never trigger a
 * switch — only a classified provider/credential outage listed in
 * {@link PROVIDER_OUTAGE_CLASSES}.
 *
 * Automatic mixed-provider failover is not enabled for the production
 * fleet by this module: an empty policy is the shipped default.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

/** Failure classes that may justify a permitted fallback. */
export const PROVIDER_OUTAGE_CLASSES = [
  "subscription-exhausted",
  "transient-rate-limit",
  "model-unavailable",
] as const;

export type ProviderOutageClass = typeof PROVIDER_OUTAGE_CLASSES[number];

/** Classes that must stay on the current provider (human action). */
export const PINNED_FAILURE_CLASSES = [
  "authentication",
  "configuration",
  "ordinary-task-failure",
  "ambiguous",
] as const;

export type ProviderFallbackMode = "pinned" | "ordered";

export interface ProviderFallbackPolicy {
  readonly mode: ProviderFallbackMode;
  /** Preferred provider — the configured `agent_provider`. */
  readonly preferred: string;
  /** Ordered alternatives; empty when pinned. */
  readonly alternatives: readonly string[];
  /** Hard cap on provider switches for one issue run. */
  readonly maxSwitches: number;
}

export const DEFAULT_PROVIDER_FALLBACK_MAX_SWITCHES = 1;

/**
 * Build the policy from config.
 *
 * `fallback` omitted or empty → pinned (no substitution).
 * `fallback` a list → ordered, preferring `preferred` first, then the
 * listed ids that are in `enabled` and installed.
 */
export function resolveProviderFallbackPolicy(input: {
  readonly preferred: string;
  readonly enabled: readonly string[];
  readonly fallback?: readonly string[];
  readonly maxSwitches?: number;
}): ProviderFallbackPolicy {
  const preferred = input.preferred.trim();
  if (preferred.length === 0) {
    throw new Error("provider fallback: preferred provider id is blank");
  }
  const enabled = new Set(input.enabled.map((id) => id.trim()).filter(Boolean));
  if (!enabled.has(preferred)) {
    throw new Error(
      `provider fallback: preferred "${preferred}" is not in the enabled set`,
    );
  }
  const raw = input.fallback ?? [];
  const alternatives = raw
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id !== preferred && enabled.has(id));
  const unknown = raw
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && !enabled.has(id) && id !== preferred);
  if (unknown.length > 0) {
    throw new Error(
      `provider fallback: ${unknown.join(", ")} is not enabled — ` +
        `no automatic fallback to an unconfigured provider`,
    );
  }
  const maxSwitches = input.maxSwitches ??
    DEFAULT_PROVIDER_FALLBACK_MAX_SWITCHES;
  if (!Number.isInteger(maxSwitches) || maxSwitches < 0) {
    throw new Error(
      `provider fallback: maxSwitches must be a non-negative integer, got ${maxSwitches}`,
    );
  }
  return {
    mode: alternatives.length === 0 ? "pinned" : "ordered",
    preferred,
    alternatives,
    maxSwitches,
  };
}

/** True when this classified failure may change provider under the policy. */
export function mayFallbackOn(
  policy: ProviderFallbackPolicy,
  failureClass: string,
  switchesSoFar: number,
): boolean {
  if (policy.mode === "pinned") return false;
  if (switchesSoFar >= policy.maxSwitches) return false;
  return (PROVIDER_OUTAGE_CLASSES as readonly string[]).includes(failureClass);
}

/**
 * Next provider to try, or null when the run must park.
 *
 * Never returns the provider that just failed, and never ping-pongs: each
 * id is offered at most once per walk of `preferred + alternatives`.
 */
export function nextFallbackProvider(
  policy: ProviderFallbackPolicy,
  current: string,
  alreadyTried: readonly string[],
): string | null {
  if (policy.mode === "pinned") return null;
  const tried = new Set(alreadyTried.map((id) => id.trim()));
  tried.add(current.trim());
  for (const id of [policy.preferred, ...policy.alternatives]) {
    if (!tried.has(id)) return id;
  }
  return null;
}
