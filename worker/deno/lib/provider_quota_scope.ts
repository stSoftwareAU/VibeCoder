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
import { activeCredentialLabel } from "./active_credential.ts";

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
 * one — a mixed Claude/Codex host keeps the other vendor working — **and**
 * the run is holding the credential the signal names (Issue #2002).
 *
 * A subscription's exhaustion is that subscription's, not the host's: on
 * GRQ-25 one spent token's 80-hour signal paused 25 consecutive restarts,
 * each of which had selected a different subscription with a full window. A
 * signal that names no credential, or a run that recorded none, keeps the
 * historical host-wide behaviour — the scoping needs both labels to be sure.
 *
 * @param signal - The active signal.
 * @param enabledProviderIds - The providers this host may run.
 * @param heldCredentialLabel - Label of the credential this run holds for
 *   the blocked provider, when it is known.
 */
export function usageSignalPausesHost(
  signal: RateLimitSignalData,
  enabledProviderIds: readonly string[],
  heldCredentialLabel?: string,
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
  if (!enabled.every((id) => id === blocked)) return false;
  const spent = signal.credentialLabel?.trim();
  const held = heldCredentialLabel?.trim();
  if (spent && held && spent !== held) return false;
  return true;
}

/**
 * The credential an active usage signal says ran out, or undefined.
 *
 * The reader half of Issue #2002: the restart question and the start-up
 * ranking both need to exclude the one credential that just failed, and
 * neither could name it while the signal carried no label. Never throws — an
 * unreadable or expired signal names nobody, which is the behaviour both
 * callers had before.
 *
 * @param workDir - Directory holding the signal file.
 * @param providerId - The provider whose pool is being asked about.
 * @param nowFn - Injectable time source, in Unix seconds.
 * @returns The spent credential's label, or undefined when the signal is
 *   absent, expired, a GitHub block, another vendor's, or unlabelled.
 */
export async function activeUsageSignalSpentLabel(
  workDir: string,
  providerId: string,
  nowFn?: () => number,
): Promise<string | undefined> {
  const active = await isRateLimitActive(workDir, nowFn);
  if (!active.ok || !active.value.active) return undefined;
  const read = await readRateLimitSignal(workDir);
  if (!read.ok) return undefined;
  const signal = read.value;
  if ((signal.kind ?? "github") !== "usage") return undefined;
  const blocked = signal.provider?.trim() || LEGACY_USAGE_SIGNAL_PROVIDER;
  if (blocked !== providerId.trim()) return undefined;
  const label = signal.credentialLabel?.trim();
  return label && label.length > 0 ? label : undefined;
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
  heldCredentialLabel: (providerId: string) => string | undefined =
    activeCredentialLabel,
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
  // Issue #2002: the pause belongs to the credential that ran out. A run
  // holding a different subscription of the same provider keeps working.
  const blocked = signal.provider?.trim() || LEGACY_USAGE_SIGNAL_PROVIDER;
  return usageSignalPausesHost(
    signal,
    enabledProviderIds,
    heldCredentialLabel(blocked),
  );
}
