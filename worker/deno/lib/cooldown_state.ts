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
  /** Repository identifier (e.g., "stSoftwareAU/private-repo-1"). */
  repo: string;
  /** Issue number. */
  issueNumber: number;
  /** Unix timestamp when the cooldown was recorded. */
  timestamp: number;
  /**
   * Failure kind (Issue #4304, broadened by Issue #1949). A kinded entry
   * carries the escalating cooldown and is retained for the escalation
   * history window. Absent (legacy entries, skips, transient
   * infrastructure): the flat base cooldown applies, exactly as before.
   */
  kind?: CooldownFailureKind;
}

/**
 * Failure kinds that step the escalating re-claim cooldown.
 *
 * - `timeout` (Issue #4304) — the run burned its whole configured budget and
 *   produced nothing.
 * - `non_transient` (Issue #1949) — any other terminal failure that is not
 *   transient infrastructure. A run that fails in 40 seconds is *stronger*
 *   evidence of a stuck issue than one that fails slowly, not weaker, so it
 *   climbs the same ladder rather than earning a flat 600 s retry.
 */
export type CooldownFailureKind = "timeout" | "non_transient";

const COOLDOWN_FAILURE_KINDS: ReadonlySet<string> = new Set<
  CooldownFailureKind
>(["timeout", "non_transient"]);

/** Whether `value` is a recognised {@link CooldownFailureKind}. */
export function isCooldownFailureKind(
  value: unknown,
): value is CooldownFailureKind {
  return typeof value === "string" && COOLDOWN_FAILURE_KINDS.has(value);
}

/**
 * How long ladder entries are retained for escalation counting
 * (Issue #4304). Consecutive ladder failures within this window step the
 * issue up the cooldown ladder; entries older than this expire.
 */
export const ESCALATION_HISTORY_SECONDS = 48 * 60 * 60;

/**
 * Escalating cooldown ladder for ladder-class failures (Issue #4304,
 * broadened to every non-transient failure by Issue #1949): first failure
 * → 2 h (one full cycle plus margin, instead of the 600 s base that let
 * VibeCoder#4281 burn four consecutive hourly cycles); second → 6 h; third
 * and later → 24 h, at which point the caller also escalates to a human.
 */
export const ESCALATING_COOLDOWN_LADDER_SECONDS: readonly number[] = [
  2 * 60 * 60,
  6 * 60 * 60,
  24 * 60 * 60,
];

/** Cooldown seconds for the Nth consecutive ladder failure (1-based). */
export function escalatingCooldownSeconds(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(1, consecutiveFailures),
    ESCALATING_COOLDOWN_LADDER_SECONDS.length,
  ) - 1;
  return ESCALATING_COOLDOWN_LADDER_SECONDS[index]!;
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
      // An unrecognised `kind` must never earn a 24 h cooldown by accident
      // (Issue #1949): drop it so the entry reverts to the flat base.
      if (entry.kind !== undefined && !isCooldownFailureKind(entry.kind)) {
        delete entry.kind;
      }
      // Ladder entries persist for the escalation window (Issue #4304,
      // #1949); everything else expires on the base cooldown.
      const retention = entry.kind
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

/**
 * Count this issue's ladder entries inside the escalation window.
 *
 * Both kinds count towards the same ladder (Issue #1949): two attempts that
 * failed for different non-transient reasons are still two attempts.
 */
export function countRecentEscalatingFailures(
  state: CooldownState,
  repo: string,
  issueNumber: number,
  now: number = nowSeconds(),
): number {
  return state.entries.filter((e) =>
    e.repo === repo && e.issueNumber === issueNumber &&
    isCooldownFailureKind(e.kind) &&
    (now - e.timestamp) < ESCALATION_HISTORY_SECONDS
  ).length;
}

/** Outcome of recording a cooldown (Issue #4304). */
export interface RecordCooldownOutcome {
  /** The persisted state after recording. */
  state: CooldownState;
  /**
   * Consecutive ladder-class failures for this issue inside the escalation
   * window, INCLUDING the one just recorded. 0 for transient failures and
   * skips, which carry no kind.
   */
  consecutiveFailures: number;
}

/**
 * Record that an issue failed (skip for cooldown period).
 *
 * Ladder-class failures (Issue #4304, #1949) step an escalating ladder —
 * the returned `consecutiveFailures` lets the caller escalate to a human
 * once retrying stops being credible.
 */
export async function recordIssueCooldown(
  config: CooldownConfig,
  repo: string,
  issueNumber: number,
  kind?: CooldownFailureKind,
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
        consecutiveFailures: isCooldownFailureKind(kind)
          ? countRecentEscalatingFailures(state, repo, issueNumber)
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
  // Escalating window for ladder-class failures (Issue #4304, #1949): the
  // more consecutive failures, the longer the issue stays off the menu.
  const duration = isCooldownFailureKind(latest.kind)
    ? Math.max(
      config.issueRetryCooldown,
      escalatingCooldownSeconds(
        countRecentEscalatingFailures(state, repo, issueNumber, now),
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
