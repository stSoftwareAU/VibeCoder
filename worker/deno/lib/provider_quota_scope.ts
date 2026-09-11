/**
 * Scope a quota / rate-limit cooldown to the provider (and credential)
 * that actually ran out (Issue #1696, parent #1694).
 *
 * A Claude usage limit must not pause Codex, and a Codex throttle must not
 * stop healthy Claude work. Only a GitHub (shared infrastructure) block is
 * host-wide. A usage signal that predates the `provider` field is treated
 * as Claude, which is what every historical writer meant.
 *
 * Since Issue #1926 this host-level gate is also the refresh point for the
 * opt-in automatic provider router. It runs before another claim is made, so a
 * provider that exhausted its subscription on the previous work item is never
 * hammered again while another fixed-price provider can serve.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  isRateLimitActive,
  type RateLimitBlockKind,
  type RateLimitSignalData,
  readRateLimitSignal,
} from "./rate_limit_signal.ts";
import { refreshAutomaticProviderRouting } from "./provider_auto_runtime.ts";

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
 * Host-loop pause: honour a shared GitHub block, otherwise refresh the
 * automatic provider router (when opted in) before deciding whether another
 * item of work may be claimed. Pinned configurations keep the exact historical
 * signal-only behaviour.
 */
export async function isHostRateLimitPauseActive(
  workDir: string,
  enabledProviderIds: readonly string[],
  nowFn?: () => number,
): Promise<boolean> {
  const active = await isRateLimitActive(workDir, nowFn);
  let signal: RateLimitSignalData | undefined;
  if (active.ok && active.value.active) {
    const read = await readRateLimitSignal(workDir);
    if (read.ok) signal = read.value;
  }

  // GitHub is shared infrastructure, not a provider choice. No coding-agent
  // selection can route around it.
  if (signal && (signal.kind ?? "github") === "github") return true;

  try {
    const automatic = await refreshAutomaticProviderRouting({
      workDir,
      enabledProviderIds,
      ...(signal ? { signal } : {}),
      ...(nowFn ? { now: nowFn() * 1000 } : {}),
    });
    if (automatic.automatic) return automatic.shouldPause;
  } catch (error) {
    // Fail closed. A malformed/unreadable auto-mode declaration must never
    // fall through to a spawn that could select a metered credential.
    console.error(
      `[quota] automatic provider routing failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }

  if (!signal) return false;
  return usageSignalPausesHost(signal, enabledProviderIds);
}
