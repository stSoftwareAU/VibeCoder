/**
 * Per-repository timeout tracking (Issue #1168).
 *
 * Tracks timeout events per repository so that repositories with chronic
 * timeouts can be identified and given escalating cooldowns. This prevents
 * repositories that consistently time out from wasting compute resources.
 *
 * Uses file-based storage for persistence across worker cycles.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { atomicWrite } from "./file_utils.ts";

/** Configuration for the timeout tracker. */
export interface TimeoutTrackerConfig {
  /** Path to the timeout state file. */
  stateFile: string;
  /** Base cooldown in seconds after the first timeout (default: 300 = 5 minutes). */
  baseCooldownSeconds: number;
  /** Maximum cooldown in seconds (default: 3600 = 1 hour). */
  maxCooldownSeconds: number;
}

/** Persisted timeout state for a single repository. */
export interface RepoTimeoutState {
  /** Count of consecutive timeouts. */
  consecutiveTimeouts: number;
  /** Epoch timestamp of the last timeout. */
  lastTimeoutEpoch: number;
  /** Cooldown expiry epoch (repo should not be processed before this time). */
  cooldownUntilEpoch: number;
}

/** Default base cooldown: 5 minutes. */
export const DEFAULT_BASE_COOLDOWN_SECONDS = 300;

/** Default maximum cooldown: 1 hour. */
export const DEFAULT_MAX_COOLDOWN_SECONDS = 3600;

/**
 * Read the timeout state file and return a map of repo → timeout state.
 */
async function readTimeoutMap(
  stateFile: string,
): Promise<Map<string, RepoTimeoutState>> {
  const map = new Map<string, RepoTimeoutState>();
  try {
    const content = await Deno.readTextFile(stateFile);
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      for (const [repo, state] of Object.entries(parsed)) {
        const s = state as RepoTimeoutState;
        if (
          typeof s.consecutiveTimeouts === "number" &&
          typeof s.lastTimeoutEpoch === "number" &&
          typeof s.cooldownUntilEpoch === "number"
        ) {
          map.set(repo, s);
        }
      }
    }
  } catch {
    // File doesn't exist or unreadable — empty map
  }
  return map;
}

/**
 * Write the timeout map to the state file atomically.
 */
async function writeTimeoutMap(
  stateFile: string,
  map: Map<string, RepoTimeoutState>,
): Promise<Result<void>> {
  const obj: Record<string, RepoTimeoutState> = {};
  for (const [repo, state] of map) {
    obj[repo] = state;
  }
  const result = await atomicWrite({
    targetFile: stateFile,
    content: JSON.stringify(obj, null, 2),
  });
  if (result.ok) return result;
  return {
    ok: false,
    error: new Error(`Failed to write timeout state: ${result.error.message}`),
  };
}

/**
 * Calculate escalating cooldown using exponential backoff.
 *
 * cooldown = min(baseCooldown * 2^(consecutiveTimeouts - 1), maxCooldown)
 */
export function calculateCooldown(
  consecutiveTimeouts: number,
  baseCooldownSeconds: number,
  maxCooldownSeconds: number,
): number {
  if (consecutiveTimeouts <= 0) return 0;
  const cooldown = baseCooldownSeconds * Math.pow(2, consecutiveTimeouts - 1);
  return Math.min(cooldown, maxCooldownSeconds);
}

/**
 * Record a timeout event for a repository.
 *
 * Increments the consecutive timeout counter and applies an escalating
 * cooldown period before the repository will be processed again.
 */
export async function recordRepoTimeout(
  config: TimeoutTrackerConfig,
  repo: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Result<RepoTimeoutState>> {
  if (!config.stateFile) {
    return { ok: false, error: new Error("No state file configured") };
  }

  const map = await readTimeoutMap(config.stateFile);
  const existing = map.get(repo);
  const consecutiveTimeouts = (existing?.consecutiveTimeouts ?? 0) + 1;
  const now = nowFn();
  const cooldownSeconds = calculateCooldown(
    consecutiveTimeouts,
    config.baseCooldownSeconds,
    config.maxCooldownSeconds,
  );

  const state: RepoTimeoutState = {
    consecutiveTimeouts,
    lastTimeoutEpoch: now,
    cooldownUntilEpoch: now + cooldownSeconds,
  };

  map.set(repo, state);
  recordFaultEvent(
    "timeout",
    `${repo} (consecutive: ${consecutiveTimeouts}, cooldown: ${cooldownSeconds}s)`,
  );

  const writeResult = await writeTimeoutMap(config.stateFile, map);
  if (!writeResult.ok) return writeResult as Result<RepoTimeoutState>;

  console.warn(
    `[timeout-tracker] ${repo} timed out (${consecutiveTimeouts} consecutive). Cooldown: ${cooldownSeconds}s`,
  );

  return { ok: true, value: state };
}

/**
 * Record a successful completion for a repository, resetting its timeout counter.
 */
export async function recordRepoTimeoutSuccess(
  config: TimeoutTrackerConfig,
  repo: string,
): Promise<Result<void>> {
  if (!config.stateFile) return { ok: true, value: undefined };
  const map = await readTimeoutMap(config.stateFile);
  if (!map.has(repo)) return { ok: true, value: undefined };
  map.delete(repo);
  return await writeTimeoutMap(config.stateFile, map);
}

/**
 * Check whether a repository is currently in a timeout cooldown period.
 */
export async function isRepoInTimeoutCooldown(
  config: TimeoutTrackerConfig,
  repo: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!config.stateFile) return false;
  const map = await readTimeoutMap(config.stateFile);
  const state = map.get(repo);
  if (!state) return false;
  return nowFn() < state.cooldownUntilEpoch;
}

/**
 * Get the timeout state for a repository, or null if no timeouts recorded.
 */
export async function getRepoTimeoutState(
  config: TimeoutTrackerConfig,
  repo: string,
): Promise<RepoTimeoutState | null> {
  if (!config.stateFile) return null;
  const map = await readTimeoutMap(config.stateFile);
  return map.get(repo) ?? null;
}

/**
 * Clean up expired cooldown entries from the state file.
 */
export async function cleanupExpiredTimeouts(
  config: TimeoutTrackerConfig,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Result<number>> {
  if (!config.stateFile) return { ok: true, value: 0 };
  const map = await readTimeoutMap(config.stateFile);
  const now = nowFn();
  let removed = 0;
  for (const [repo, state] of map) {
    if (now >= state.cooldownUntilEpoch) {
      map.delete(repo);
      removed++;
    }
  }
  if (removed > 0) {
    const writeResult = await writeTimeoutMap(config.stateFile, map);
    if (!writeResult.ok) return writeResult as Result<number>;
  }
  return { ok: true, value: removed };
}
