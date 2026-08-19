/**
 * Persistent issue retry cooldown tracking (Issue #633, #908).
 *
 * After a failure, an issue is skipped for a cooldown period so the worker can
 * process other issues instead of immediately re-picking the same one. State
 * is stored as JSON in WORK_DIR so it survives worker crashes and EXIT trap
 * cleanup.
 *
 * Expired entries are cleaned up on load to avoid permanently blocking issues.
 *
 * Migrated from worker/shared/cooldown_state.sh (Issue #908).
 */

import type { Result } from "../types.ts";
import { reportStateLoadFailure } from "./state_load_failure.ts";
import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";

/** Configuration for cooldown state. */
export interface CooldownConfig {
  /** Directory for persistent state file. */
  workDir: string;
  /** Cooldown period in seconds (default: 600). */
  issueRetryCooldown: number;
}

/** A single cooldown entry. */
export interface CooldownEntry {
  /** Repository identifier (e.g., "example-org/private-repo-13"). */
  repo: string;
  /** Issue number. */
  issueNumber: number;
  /** Unix timestamp when the cooldown was recorded. */
  timestamp: number;
  /**
   * Failure class (Issue #4304). "timeout" marks a timeout-class failure
   * (the run burned its whole budget and produced nothing); such entries
   * carry an escalating cooldown and are retained for the escalation
   * history window. Absent (legacy entries, ordinary failures): the flat
   * base cooldown applies, exactly as before.
   */
  kind?: "timeout";
}

/**
 * How long timeout-class entries are retained for escalation counting
 * (Issue #4304). Consecutive timeout failures within this window step the
 * issue up the cooldown ladder; entries older than this expire.
 */
export const ESCALATION_HISTORY_SECONDS = 48 * 60 * 60;

/**
 * Escalating cooldown ladder for timeout-class failures (Issue #4304):
 * first timeout → 2 h (one full cycle plus margin, instead of the 600 s
 * base that let VibeCoder#4281 burn four consecutive hourly cycles);
 * second → 6 h; third and later → 24 h, at which point the caller also
 * escalates to a human.
 */
export const TIMEOUT_COOLDOWN_LADDER_SECONDS: readonly number[] = [
  2 * 60 * 60,
  6 * 60 * 60,
  24 * 60 * 60,
];

/** Cooldown seconds for the Nth consecutive timeout (1-based). */
export function timeoutCooldownSeconds(consecutiveTimeouts: number): number {
  const index = Math.min(
    Math.max(1, consecutiveTimeouts),
    TIMEOUT_COOLDOWN_LADDER_SECONDS.length,
  ) - 1;
  return TIMEOUT_COOLDOWN_LADDER_SECONDS[index]!;
}

/** Persisted cooldown state (JSON). */
export interface CooldownState {
  /** Active cooldown entries. */
  entries: CooldownEntry[];
}

/** Default cooldown configuration values. */
export const COOLDOWN_DEFAULTS: Readonly<Omit<CooldownConfig, "workDir">> = {
  issueRetryCooldown: 600,
} as const;

const STATE_FILENAME = ".cooldown_state.json";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function statePath(workDir: string): string {
  return `${workDir}/${STATE_FILENAME}`;
}

/**
 * Write state to disk atomically (write-to-tmp then rename).
 */
async function persistState(
  workDir: string,
  state: CooldownState,
): Promise<Result<void>> {
  if (!workDir) return { ok: true, value: undefined };
  const result = await atomicWrite({
    targetFile: statePath(workDir),
    content: JSON.stringify(state, null, 2),
  });
  if (result.ok) return result;
  return {
    ok: false,
    error: new Error(
      `Failed to persist cooldown state: ${result.error.message}`,
    ),
  };
}

/**
 * Load state from disk, cleaning up expired entries.
 *
 * Issue #3649 (SEC-6b03e9d5127f): a missing file is the ordinary first run
 * and entry expiry is a designed cleanup, so both stay quiet. A read, parse,
 * or structural failure silently cleared every per-issue cooldown, so it is
 * now reported through `warn`.
 *
 * @param warn - Sink for load-failure notices (defaults to `console.error`)
 */
export async function loadState(
  workDir: string,
  issueRetryCooldown: number = COOLDOWN_DEFAULTS.issueRetryCooldown,
  warn?: (message: string) => void,
): Promise<CooldownState> {
  if (!workDir) return { entries: [] };
  const path = statePath(workDir);
  try {
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content) as CooldownState;

    // Validate structure
    if (!Array.isArray(parsed.entries)) {
      reportStateLoadFailure(
        "cooldown state",
        path,
        new Error("malformed state: entries is not an array"),
        warn,
      );
      return { entries: [] };
    }

    // Clean expired entries
    const now = nowSeconds();
    parsed.entries = parsed.entries.filter((entry) => {
      if (
        typeof entry.repo !== "string" ||
        typeof entry.issueNumber !== "number" ||
        typeof entry.timestamp !== "number"
      ) {
        return false;
      }
      // Timeout-class entries persist for the escalation window
      // (Issue #4304); everything else expires on the base cooldown.
      const retention = entry.kind === "timeout"
        ? ESCALATION_HISTORY_SECONDS
        : issueRetryCooldown;
      return (now - entry.timestamp) < retention;
    });

    return parsed;
  } catch (err) {
    reportStateLoadFailure("cooldown state", path, err, warn);
    return { entries: [] };
  }
}

/** Count this issue's timeout entries inside the escalation window. */
export function countRecentTimeouts(
  state: CooldownState,
  repo: string,
  issueNumber: number,
  now: number = nowSeconds(),
): number {
  return state.entries.filter((e) =>
    e.repo === repo && e.issueNumber === issueNumber &&
    e.kind === "timeout" &&
    (now - e.timestamp) < ESCALATION_HISTORY_SECONDS
  ).length;
}

/** Outcome of recording a cooldown (Issue #4304). */
export interface RecordCooldownOutcome {
  /** The persisted state after recording. */
  state: CooldownState;
  /**
   * Consecutive timeout-class failures for this issue inside the
   * escalation window, INCLUDING the one just recorded. 0 for
   * non-timeout failures.
   */
  consecutiveTimeouts: number;
}

/**
 * Record that an issue failed (skip for cooldown period).
 *
 * Timeout-class failures (Issue #4304) step an escalating ladder — the
 * returned `consecutiveTimeouts` lets the caller escalate to a human
 * once retrying stops being credible.
 */
export async function recordIssueCooldown(
  config: CooldownConfig,
  repo: string,
  issueNumber: number,
  kind?: "timeout",
): Promise<Result<RecordCooldownOutcome>> {
  return await withStateLock(`cooldown:${config.workDir}`, async () => {
    const state = await loadState(config.workDir, config.issueRetryCooldown);
    state.entries.push({
      repo,
      issueNumber,
      timestamp: nowSeconds(),
      ...(kind ? { kind } : {}),
    });

    const writeResult = await persistState(config.workDir, state);
    if (!writeResult.ok) return writeResult as Result<RecordCooldownOutcome>;

    return {
      ok: true,
      value: {
        state,
        consecutiveTimeouts: kind === "timeout"
          ? countRecentTimeouts(state, repo, issueNumber)
          : 0,
      },
    };
  });
}

/**
 * Check if an issue is currently in cooldown.
 *
 * Returns true if the issue should be skipped.
 */
export async function isIssueInCooldown(
  config: CooldownConfig,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  const state = await loadState(config.workDir, config.issueRetryCooldown);
  const now = nowSeconds();

  // Find the most recent entry for this repo/issue
  const matching = state.entries
    .filter((e) => e.repo === repo && e.issueNumber === issueNumber)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (matching.length === 0) return false;

  const latest = matching[0]!;
  // Escalating window for timeout-class failures (Issue #4304): the
  // more consecutive timeouts, the longer the issue stays off the menu.
  const duration = latest.kind === "timeout"
    ? Math.max(
      config.issueRetryCooldown,
      timeoutCooldownSeconds(
        countRecentTimeouts(state, repo, issueNumber, now),
      ),
    )
    : config.issueRetryCooldown;
  return (now - latest.timestamp) < duration;
}

/**
 * Clean expired cooldown entries and persist.
 */
export async function cleanExpiredCooldowns(
  config: CooldownConfig,
): Promise<Result<CooldownState>> {
  return await withStateLock(`cooldown:${config.workDir}`, async () => {
    const state = await loadState(config.workDir, config.issueRetryCooldown);
    const writeResult = await persistState(config.workDir, state);
    if (!writeResult.ok) return writeResult as Result<CooldownState>;
    return { ok: true, value: state };
  });
}
