/**
 * Scope a quota / rate-limit cooldown to the provider (and credential)
 * that actually ran out (Issue #1696, parent #1694).
 *
 * A Claude usage limit must not pause Codex, and a Codex throttle must not
 * stop healthy Claude work. Only a GitHub (shared infrastructure) block is
 * host-wide. A usage signal that predates the `provider` field is treated
 * as Claude, which is what every historical writer meant.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  isRateLimitActive,
  type RateLimitBlockKind,
  type RateLimitSignalData,
  readRateLimitSignal,
} from "./rate_limit_signal.ts";

/** Default vendor for a usage signal that never named one. */
export const LEGACY_USAGE_SIGNAL_PROVIDER = "claude";

/**
 * Whether a signal should stop **this** provider's next spawn.
 *
 * GitHub blocks everyone. Usage blocks only the named provider.
 */
export function usageSignalBlocksProvider(
  signal: RateLimitSignalData,
  providerId: string,
): boolean {
  const kind: RateLimitBlockKind = signal.kind === "usage" ||
      signal.kind === "github"
    ? signal.kind
    : "github";
  if (kind === "github") return true;
  const blocked = signal.provider?.trim() || LEGACY_USAGE_SIGNAL_PROVIDER;
  return blocked === providerId;
}

/**
 * Whether the host loop should drain every slot because of this signal.
 *
 * GitHub: yes. Usage: only when every enabled provider is the blocked
 * one — a mixed Claude/Codex host keeps the other vendor working.
 */
export function usageSignalPausesHost(
  signal: RateLimitSignalData,
  enabledProviderIds: readonly string[],
): boolean {
  const kind: RateLimitBlockKind = signal.kind === "usage" ||
      signal.kind === "github"
    ? signal.kind
    : "github";
  if (kind === "github") return true;
  const blocked = signal.provider?.trim() || LEGACY_USAGE_SIGNAL_PROVIDER;
  const enabled = enabledProviderIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (enabled.length === 0) return true;
  return enabled.every((id) => id === blocked);
}

/**
 * Host-loop pause: the signal is still inside its wait window **and**
 * {@link usageSignalPausesHost} says every enabled provider is blocked.
 */
export async function isHostRateLimitPauseActive(
  workDir: string,
  enabledProviderIds: readonly string[],
  nowFn?: () => number,
): Promise<boolean> {
  const active = await isRateLimitActive(workDir, nowFn);
  if (!active.ok || !active.value.active) return false;
  const signal = await readRateLimitSignal(workDir);
  if (!signal.ok) return false;
  return usageSignalPausesHost(signal.value, enabledProviderIds);
}
