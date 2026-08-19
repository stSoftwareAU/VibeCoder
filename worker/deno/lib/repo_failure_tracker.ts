/**
 * Per-repo failure tracking within a scan cycle (Issue #586, #909, #1066).
 *
 * When a repo accumulates failures from multiple *different* issues in a
 * single scan cycle, it is deprioritised for the remainder of that cycle
 * so other repos get a chance to make progress.
 *
 * Issue #1066: Tracks unique failed issue numbers per repo. A single
 * failing issue cannot cascade into deprioritising the entire repository.
 * The failure count equals the number of unique issues that failed, not
 * the total number of failure events.
 *
 * Uses file-based storage for persistence across calls.
 *
 * Migrated from worker/shared/repo_failure_tracker.sh (Issue #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";

/** Configuration for the repo failure tracker. */
export interface RepoFailureTrackerConfig {
  /** Path to the failure state file. */
  failureFile: string;
  /** Deprioritise after this many unique failing issues in a single cycle (default: 3). */
  threshold: number;
  /** Timeout-throttle after this many consecutive timeouts (default: 3, Issue #1172). */
  timeoutThreshold?: number;
}

/** Default threshold for deprioritising repos. */
export const DEFAULT_REPO_FAILURE_THRESHOLD = 3;

/**
 * Default threshold for timeout throttling (Issue #1168, #1172).
 * Repos exceeding this many consecutive timeouts are throttled
 * to avoid wasting compute on chronically timing-out repos.
 * Matches config_defaults.ts repoTimeoutThreshold.
 */
export const DEFAULT_REPO_TIMEOUT_THRESHOLD = 3;

/**
 * Internal counter used to generate unique pseudo-issue IDs when
 * recordRepoFailure is called without an issueNumber (legacy callers).
 * Each call gets a distinct negative number so every call counts as
 * a separate failure, preserving backward-compatible behaviour.
 */
let anonymousCounter = 0;

/**
 * Read the failure file and return a map of repo → set of failed issue numbers.
 *
 * File format (Issue #1066): repo|issueNum1,issueNum2,...
 * Legacy format (pre-#1066): repo|count — migrated on read by generating
 * synthetic issue numbers.
 */
async function readFailureMap(
  failureFile: string,
): Promise<Map<string, Set<number>>> {
  const map = new Map<string, Set<number>>();
  try {
    const content = await Deno.readTextFile(failureFile);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const sepIdx = line.indexOf("|");
      if (sepIdx < 0) continue;
      const repo = line.substring(0, sepIdx);
      const valuePart = line.substring(sepIdx + 1).trim();
      if (!repo || !valuePart) continue;

      // Detect format: if valuePart is a single integer with no commas,
      // it could be legacy (plain count) or a single issue number.
      // We use the new format: comma-separated issue numbers.
      const issues = new Set<number>();
      for (const token of valuePart.split(",")) {
        const num = parseInt(token.trim(), 10);
        if (!isNaN(num)) {
          issues.add(num);
        }
      }
      if (issues.size > 0) {
        map.set(repo, issues);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.warn(
        `[repo-failure-tracker] Failed to read failure state from ${failureFile}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return map;
}

/**
 * Write the failure map to the state file atomically.
 *
 * Format: repo|issueNum1,issueNum2,...
 */
async function writeFailureMap(
  failureFile: string,
  map: Map<string, Set<number>>,
): Promise<Result<void>> {
  const lines: string[] = [];
  for (const [repo, issues] of map) {
    if (issues.size > 0) {
      lines.push(`${repo}|${[...issues].join(",")}`);
    }
  }
  const result = await atomicWrite({
    targetFile: failureFile,
    content: lines.length > 0 ? lines.join("\n") + "\n" : "",
  });
  if (result.ok) return result;
  return {
    ok: false,
    error: new Error(
      `Failed to write repo failure state: ${result.error.message}`,
    ),
  };
}

/**
 * Record a failure for a given repository and issue.
 *
 * Issue #1066: When issueNumber is provided, the same issue failing
 * multiple times only counts once toward the deprioritisation threshold.
 * When issueNumber is omitted (legacy callers), each call is treated
 * as a distinct failure to preserve backward-compatible behaviour.
 *
 * Returns the count of unique failed issues for this repo.
 */
export async function recordRepoFailure(
  config: RepoFailureTrackerConfig,
  repo: string,
  issueNumber?: number,
): Promise<Result<number>> {
  if (!config.failureFile) {
    return { ok: false, error: new Error("No failure file configured") };
  }
  const map = await readFailureMap(config.failureFile);
  const issues = map.get(repo) ?? new Set<number>();

  // Use the provided issue number, or generate a unique anonymous one
  const id = issueNumber ?? --anonymousCounter;
  issues.add(id);
  map.set(repo, issues);

  // Log when repo becomes deprioritised (Issue #1066)
  if (issues.size >= config.threshold) {
    const issueList = [...issues].filter((n) => n > 0).map((n) => `#${n}`).join(
      ", ",
    );
    console.error(
      `[repo-failure-tracker] Repo ${repo} deprioritised after ${issues.size} unique failing issues` +
        (issueList ? `: ${issueList}` : ""),
    );
  }

  const writeResult = await writeFailureMap(config.failureFile, map);
  if (!writeResult.ok) return writeResult as Result<number>;
  return { ok: true, value: issues.size };
}

/**
 * Reset failure count for a repo after a success.
 *
 * A successful issue processing clears the failure counter for that repo,
 * indicating it can produce results and should not be deprioritised.
 */
export async function recordRepoSuccess(
  config: RepoFailureTrackerConfig,
  repo: string,
): Promise<Result<void>> {
  if (!config.failureFile) {
    return { ok: true, value: undefined };
  }
  const map = await readFailureMap(config.failureFile);
  if (map.has(repo)) {
    map.delete(repo);
    const writeResult = await writeFailureMap(config.failureFile, map);
    if (!writeResult.ok) return writeResult;
  }

  // Also clear timeout state for this repo (Issue #1168)
  const timeoutFile = `${config.failureFile}.timeouts`;
  try {
    const timeoutMap = await readTimeoutMap(timeoutFile);
    if (timeoutMap.has(repo)) {
      timeoutMap.delete(repo);
      await writeTimeoutMap(timeoutFile, timeoutMap);
    }
  } catch (err) {
    console.warn(
      `[repo-failure-tracker] Failed to clear timeout state for ${repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { ok: true, value: undefined };
}

/**
 * Get the current failure count for a repo (count of unique failed issues).
 */
export async function getRepoFailureCount(
  config: RepoFailureTrackerConfig,
  repo: string,
): Promise<number> {
  if (!config.failureFile) return 0;
  const map = await readFailureMap(config.failureFile);
  return map.get(repo)?.size ?? 0;
}

/**
 * Get the list of unique failed issue numbers for a repo (Issue #1066).
 *
 * Returns only real issue numbers (positive), not anonymous/synthetic ones.
 */
export async function getRepoFailedIssues(
  config: RepoFailureTrackerConfig,
  repo: string,
): Promise<number[]> {
  if (!config.failureFile) return [];
  const map = await readFailureMap(config.failureFile);
  const issues = map.get(repo);
  if (!issues) return [];
  return [...issues].filter((n) => n > 0);
}

/**
 * Check if a repo should be skipped this cycle.
 *
 * Returns true if the repo's unique failure count >= threshold.
 */
export async function isRepoDeprioritised(
  config: RepoFailureTrackerConfig,
  repo: string,
): Promise<boolean> {
  const count = await getRepoFailureCount(config, repo);
  return count >= config.threshold;
}

/**
 * Reset all repo failure counts (and timeout counts).
 *
 * Call this at the start of each new scan cycle to give all repos a
 * fresh chance.
 */
export async function resetRepoFailures(
  config: RepoFailureTrackerConfig,
): Promise<Result<void>> {
  if (!config.failureFile) {
    return { ok: true, value: undefined };
  }
  const writeResult = await writeFailureMap(config.failureFile, new Map());
  if (!writeResult.ok) return writeResult;
  // Also clear timeout state
  const timeoutFile = `${config.failureFile}.timeouts`;
  try {
    await Deno.remove(timeoutFile);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.warn(
        `[repo-failure-tracker] Failed to remove timeout state file: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { ok: true, value: undefined };
}

// ============================================================================
// Per-repo timeout tracking (Issue #1168)
// ============================================================================

/**
 * Read the timeout state file. Returns a map of repo → timeout count.
 *
 * File format: repo|count (one per line).
 */
async function readTimeoutMap(
  timeoutFile: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const content = await Deno.readTextFile(timeoutFile);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const sepIdx = line.indexOf("|");
      if (sepIdx < 0) continue;
      const repo = line.substring(0, sepIdx);
      const count = parseInt(line.substring(sepIdx + 1).trim(), 10);
      if (repo && !isNaN(count)) {
        map.set(repo, count);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Expected on first run — no state file yet
    } else {
      console.warn(
        `[repo-failure-tracker] Failed to read timeout state from ${timeoutFile}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return map;
}

/**
 * Write the timeout map to the state file atomically.
 */
async function writeTimeoutMap(
  timeoutFile: string,
  map: Map<string, number>,
): Promise<Result<void>> {
  const lines: string[] = [];
  for (const [repo, count] of map) {
    if (count > 0) {
      lines.push(`${repo}|${count}`);
    }
  }
  const result = await atomicWrite({
    targetFile: timeoutFile,
    content: lines.length > 0 ? lines.join("\n") + "\n" : "",
  });
  if (result.ok) return result;
  return {
    ok: false,
    error: new Error(`Failed to write timeout state: ${result.error.message}`),
  };
}

/**
 * Record a timeout for a given repository (Issue #1168).
 *
 * Tracks timeouts separately from general failures so that repos with
 * chronic timeouts can be throttled with escalating cooldowns, avoiding
 * wasted compute.
 *
 * @returns The updated timeout count for this repo.
 */
export async function recordRepoTimeout(
  config: RepoFailureTrackerConfig,
  repo: string,
): Promise<Result<number>> {
  if (!config.failureFile) {
    return { ok: false, error: new Error("No failure file configured") };
  }
  const timeoutFile = `${config.failureFile}.timeouts`;
  const map = await readTimeoutMap(timeoutFile);
  const count = (map.get(repo) ?? 0) + 1;
  map.set(repo, count);

  const threshold = config.timeoutThreshold ?? DEFAULT_REPO_TIMEOUT_THRESHOLD;
  if (count >= threshold) {
    console.warn(
      `[repo-failure-tracker] Repo ${repo} timeout-throttled after ${count} timeouts ` +
        `(threshold: ${threshold})`,
    );
  }

  const writeResult = await writeTimeoutMap(timeoutFile, map);
  if (!writeResult.ok) return writeResult as Result<number>;
  return { ok: true, value: count };
}

/**
 * Get the current timeout count for a repo.
 */
export async function getRepoTimeoutCount(
  config: RepoFailureTrackerConfig,
  repo: string,
): Promise<number> {
  if (!config.failureFile) return 0;
  const timeoutFile = `${config.failureFile}.timeouts`;
  const map = await readTimeoutMap(timeoutFile);
  return map.get(repo) ?? 0;
}

/**
 * Check if a repo should be timeout-throttled this cycle (Issue #1168).
 *
 * Returns true if the repo's timeout count >= the timeout threshold.
 */
export async function isRepoTimeoutThrottled(
  config: RepoFailureTrackerConfig,
  repo: string,
): Promise<boolean> {
  const count = await getRepoTimeoutCount(config, repo);
  const threshold = config.timeoutThreshold ?? DEFAULT_REPO_TIMEOUT_THRESHOLD;
  return count >= threshold;
}

/**
 * Get the cooldown multiplier for a repo based on its timeout count (Issue #1172).
 *
 * Returns 1 (no change) when the repo has not exceeded the timeout threshold.
 * After the threshold is reached, the multiplier doubles for each additional
 * threshold-worth of timeouts:
 *   - Below threshold: 1x
 *   - 1× threshold:   2x
 *   - 2× threshold:   4x
 *   - 3× threshold:   8x
 *
 * This escalating cooldown gives chronically timing-out repos progressively
 * longer recovery periods, reducing wasted compute.
 */
export async function getTimeoutCooldownMultiplier(
  config: RepoFailureTrackerConfig,
  repo: string,
): Promise<number> {
  const count = await getRepoTimeoutCount(config, repo);
  const threshold = config.timeoutThreshold ?? DEFAULT_REPO_TIMEOUT_THRESHOLD;
  if (count < threshold) return 1;
  // Each threshold-worth of timeouts doubles the multiplier
  const escalations = Math.floor(count / threshold);
  return Math.pow(2, escalations);
}
