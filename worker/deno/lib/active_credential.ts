/**
 * Which credential this run is actually holding (Issue #2002).
 *
 * A usage signal belongs to **one subscription**, not to the host: on
 * GRQ-25 a spent token's 80-hour signal paused 25 consecutive restarts that
 * had each selected a *different* subscription with a full window. The signal
 * could not say which credential ran out, because nothing recorded which one
 * the run was holding.
 *
 * This module is that record: the label — `provider`, `provider-2`, never a
 * token value — of the credential exported into the run environment, per
 * provider. `applyProviderCredentialEnv` sets it at start-up and
 * `ClaudeCredentialPool.applySelection` replaces it on a mid-run switch, so
 * every usage-signal writer can name the credential that ran out.
 *
 * Process-level state, deliberately: the exported environment is
 * process-level too, and the readers (the signal writers) live in the same
 * worker process as the writers. A label that was never recorded reads as
 * `undefined`, which every consumer treats as the legacy host-wide signal —
 * so a run whose credential came from the environment rather than from a
 * selected file behaves exactly as it always has.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/** Label of the exported credential, keyed by provider id. */
const labels = new Map<string, string>();

/**
 * Record the credential label this run exported for a provider.
 *
 * @param providerId - The provider the credential belongs to.
 * @param label - The token file's stem (`provider-2`), never its value.
 */
export function recordActiveCredentialLabel(
  providerId: string,
  label: string,
): void {
  const provider = providerId.trim();
  const trimmed = label.trim();
  if (provider.length === 0 || trimmed.length === 0) return;
  labels.set(provider, trimmed);
}

/**
 * The credential label this run is holding for a provider, if one is known.
 *
 * @param providerId - The provider to ask about.
 * @returns The label, or undefined when no selection was recorded.
 */
export function activeCredentialLabel(
  providerId: string,
): string | undefined {
  return labels.get(providerId.trim());
}

/** Forget every recorded label. For tests; production never calls it. */
export function clearActiveCredentialLabels(): void {
  labels.clear();
}

/**
 * The scope a usage signal is written with: the provider that ran out, and
 * the credential of it that did, when the run knows which one it holds.
 *
 * One spelling shared by every usage-signal writer so they cannot drift on
 * what a signal says about itself.
 *
 * @param providerId - The provider whose quota ran out.
 * @returns The scope to hand {@link writeRateLimitSignal}.
 */
export function usageSignalScope(
  providerId: string,
): { provider: string; credentialLabel?: string } {
  const label = activeCredentialLabel(providerId);
  return {
    provider: providerId,
    ...(label ? { credentialLabel: label } : {}),
  };
}
