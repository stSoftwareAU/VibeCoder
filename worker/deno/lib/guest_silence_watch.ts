/**
 * Early reap of a guest that has gone silent and stopped answering (Issue #5161).
 *
 * A worker container's guest VM can wedge: the worker log stops growing and
 * `container exec` stops answering. The launcher's watchdog otherwise waits for
 * the full deadline before it reaps, so a dead guest holds the host for an hour
 * or more. This module decides whether to reap now: the newest worker log must
 * have been silent for the threshold AND the guest must fail consecutive exec
 * probes. It fails safe: without positive evidence of both, the guest is
 * reported as not wedged and nothing is reaped.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import {
  bounded,
  type EvidenceSeams,
  newestMatching,
  WORKER_LOG_RE,
} from "./hard_kill_evidence.ts";

/** Environment variable holding the silence threshold, in seconds. */
export const GUEST_SILENCE_SECONDS_ENV = "VIBE_GUEST_SILENCE_SECONDS";

/** Default silence threshold, in seconds. Zero disables the early reap. */
export const DEFAULT_GUEST_SILENCE_SECONDS = 900;

/** Consecutive exec probes that must fail before the guest counts as wedged. */
export const GUEST_SILENCE_PROBES = 2;

/** Bound on one exec probe, in milliseconds. */
export const GUEST_SILENCE_PROBE_TIMEOUT_MS = 30_000;

/** Exit status the command reports when it did not reap (the guest answers). */
export const GUEST_ANSWERING_EXIT = 3;

/**
 * Resolve the silence threshold from the environment.
 *
 * @param env - Reads an environment variable
 * @returns Seconds; 0 disables the early reap; unset or invalid gives the default
 */
export function resolveGuestSilenceSeconds(
  env: (name: string) => string | undefined,
): number {
  const raw = env(GUEST_SILENCE_SECONDS_ENV)?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return DEFAULT_GUEST_SILENCE_SECONDS;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : DEFAULT_GUEST_SILENCE_SECONDS;
}

/**
 * The operator-facing reason recorded in the hard-kill evidence.
 *
 * @param silentSeconds - How long the worker log has been silent
 * @returns The fixed-shape reason sentence
 */
export function guestSilenceReason(silentSeconds: number): string {
  return `the launcher's watchdog found the guest silent for ${
    Math.floor(silentSeconds)
  }s and not answering`;
}

/** What {@link checkGuestSilence} found. */
export type GuestSilenceVerdict =
  | { wedged: true; silentSeconds: number; detail: string }
  | { wedged: false; silentSeconds: number | null; detail: string };

/** What to check. */
export interface GuestSilenceOptions {
  containerName: string;
  /** Directory holding the worker log. */
  evidenceDir: string;
  /** Silence threshold in seconds; 0 or less disables the check. */
  silenceSeconds: number;
  /** The current time, in milliseconds since the epoch. */
  nowMs: number;
  /** Consecutive failed probes needed; defaults to {@link GUEST_SILENCE_PROBES}. */
  probes?: number;
  /** Bound on one probe; defaults to {@link GUEST_SILENCE_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
}

/** Bound on listing the evidence directory, in milliseconds. */
const LIST_TIMEOUT_MS = 15_000;

/**
 * Decide whether a guest is wedged: worker log silent past the threshold and
 * every exec probe failing. Never throws; any doubt is "not wedged".
 *
 * @param seams - Injected operations
 * @param options - What to check
 * @returns The verdict
 */
export async function checkGuestSilence(
  seams: EvidenceSeams,
  options: GuestSilenceOptions,
): Promise<GuestSilenceVerdict> {
  if (options.silenceSeconds <= 0) {
    return {
      wedged: false,
      silentSeconds: null,
      detail: "guest silence check is disabled",
    };
  }
  const listed = await bounded(
    seams,
    () => seams.listLogFiles(options.evidenceDir),
    LIST_TIMEOUT_MS,
  );
  if (!listed.ok) {
    return {
      wedged: false,
      silentSeconds: null,
      detail: `could not list ${options.evidenceDir}: ${listed.cause}`,
    };
  }
  const newest = newestMatching(listed.value, WORKER_LOG_RE);
  if (newest === undefined) {
    return {
      wedged: false,
      silentSeconds: null,
      detail: `no worker log in ${options.evidenceDir}`,
    };
  }
  const silentSeconds = (options.nowMs - newest.mtimeMs) / 1000;
  if (silentSeconds < options.silenceSeconds) {
    return {
      wedged: false,
      silentSeconds,
      detail: `worker log written ${
        Math.floor(silentSeconds)
      }s ago, under the ${options.silenceSeconds}s threshold`,
    };
  }

  const probes = Math.max(1, options.probes ?? GUEST_SILENCE_PROBES);
  const timeoutMs = options.probeTimeoutMs ?? GUEST_SILENCE_PROBE_TIMEOUT_MS;
  let lastCause = "no probe was run";
  for (let attempt = 1; attempt <= probes; attempt++) {
    const probe = await bounded(
      seams,
      () =>
        seams.runRuntime(["exec", options.containerName, "true"], timeoutMs),
      timeoutMs,
    );
    if (probe.ok && probe.value.code === 0) {
      return {
        wedged: false,
        silentSeconds,
        detail: `worker log silent for ${
          Math.floor(silentSeconds)
        }s but the guest answered`,
      };
    }
    lastCause = probe.ok ? `exit ${probe.value.code}` : probe.cause;
  }
  return {
    wedged: true,
    silentSeconds,
    detail: `worker log silent for ${
      Math.floor(silentSeconds)
    }s and ${probes} exec probes failed; last: ${lastCause}`,
  };
}
