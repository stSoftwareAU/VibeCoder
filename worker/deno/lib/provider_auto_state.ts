/**
 * Process-local outage memory for automatic provider routing (Issue #1926).
 *
 * The normalised agent-output adapters are the first place a provider's own
 * structured failure has an unambiguous category. They record only the fact
 * that a provider is unusable here; quota/status probing and ranking remain in
 * `provider_auto_runtime.ts` / `provider_auto_selection.ts`.
 *
 * This state is intentionally process-local. A quota exhaustion also has the
 * existing durable `.rate_limit_signal`, while authentication is re-checked on
 * the next fresh worker process. No credential value or provider output is
 * retained — only provider id, category and observation time.
 */

export type AutomaticProviderOutageCategory =
  | "authentication"
  | "quota-exhausted";

export interface AutomaticProviderOutage {
  readonly provider: string;
  readonly category: AutomaticProviderOutageCategory;
  readonly observedAt: number;
}

let automaticRoutingActive = false;
const outages = new Map<string, AutomaticProviderOutage>();

/** Enable/disable outage recording for this process. */
export function setAutomaticProviderRoutingActive(active: boolean): void {
  automaticRoutingActive = active;
  if (!active) outages.clear();
}

/** Whether the automatic router is active for the current worker process. */
export function isAutomaticProviderRoutingActive(): boolean {
  return automaticRoutingActive;
}

/** Record a provider outage only while automatic routing is active. */
export function recordAutomaticProviderOutage(
  provider: string,
  category: AutomaticProviderOutageCategory,
  observedAt: number = Date.now(),
): void {
  if (!automaticRoutingActive) return;
  const id = provider.trim();
  if (!id) return;
  outages.set(id, { provider: id, category, observedAt });
}

/** Current process-local outage for one provider, if any. */
export function automaticProviderOutage(
  provider: string,
): AutomaticProviderOutage | undefined {
  return outages.get(provider.trim());
}

/** Clear an outage once fresh evidence proves the provider is usable again. */
export function clearAutomaticProviderOutage(provider: string): void {
  outages.delete(provider.trim());
}

/** Test/support seam: clear every automatic-routing state bit. */
export function resetAutomaticProviderState(): void {
  automaticRoutingActive = false;
  outages.clear();
}
