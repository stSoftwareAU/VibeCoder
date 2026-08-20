/**
 * Shell helper utilities migrated to Deno TypeScript (Issue #964).
 *
 * Contains functions previously implemented as shell helpers in
 * issue_worker.sh: sleep with jitter (anti-thundering herd),
 * and default branch fetching via GitHub API.
 */

import type { Result } from "../types.ts";
import {
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  runWithTimeout,
} from "./subprocess_timeout.ts";
import {
  getCachedDefaultBranch,
  invalidateCachedDefaultBranch,
  setCachedDefaultBranch,
} from "./default_branch_cache.ts";

// =============================================================================
// Jitter / sleep helpers
// =============================================================================

/**
 * Calculate a sleep duration with random jitter.
 *
 * Produces a value between 50% and 150% of the base interval,
 * preventing thundering herd when multiple workers wake simultaneously.
 *
 * @param baseInterval - Base interval in seconds
 * @returns Jittered interval in seconds (integer)
 */
export function calculateJitter(baseInterval: number): number {
  if (baseInterval <= 0) return 0;
  const min = Math.floor(baseInterval * 0.5);
  const max = Math.floor(baseInterval * 1.5);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for a jittered duration based on the given base interval.
 *
 * Anti-thundering herd pattern: adds random jitter so multiple workers
 * don't all wake and poll at the same instant.
 *
 * @param baseInterval - Base interval in seconds
 */
export async function sleepWithJitter(baseInterval: number): Promise<void> {
  const seconds = calculateJitter(baseInterval);
  if (seconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
}

// =============================================================================
// GitHub helpers
// =============================================================================

/** In-process cache for default branch lookups. Backed by a persistent file
 *  so the value survives across run_core cycles (Issue #1509). */
const defaultBranchCache = new Map<string, string>();

/**
 * Clear the in-process memory cache. Exposed for tests — production code
 * should use `invalidateDefaultBranch` instead to also drop the persistent entry.
 */
export function clearDefaultBranchMemoryCache(): void {
  defaultBranchCache.clear();
}

/**
 * Invalidate a cached default-branch entry in both the in-process and
 * persistent caches (Issue #1509).
 *
 * Callers should invoke this when they detect a stale cache — e.g., a
 * `git fetch origin/<cached-branch>` failure after a remote rename.
 *
 * @param repo - Repository in "owner/repo" format
 */
export async function invalidateDefaultBranch(repo: string): Promise<void> {
  if (!repo) return;
  defaultBranchCache.delete(repo);
  try {
    await invalidateCachedDefaultBranch(repo);
  } catch {
    // Persistent cache removal is best-effort.
  }
}

/**
 * Get the default branch for a repository via GitHub API (Issue #140).
 *
 * Lookup order (Issue #1509):
 *   1. In-process memory cache (fastest, cleared on process restart).
 *   2. Persistent disk cache with 7-day TTL — only when `WORK_DIR` is set
 *      (`${WORK_DIR}/.vibe-cache/default-branch-cache.json`, Issue #4318).
 *      With `WORK_DIR` unset (any host-side process — setup, launcher,
 *      housekeeping) there is no cache directory and this layer is a
 *      complete no-op (Issue #132): nothing is read or written on disk.
 *   3. GitHub REST API via `gh api repos/<repo>`.
 *
 * Successful API lookups are written back to both layers so subsequent
 * run_core cycles can answer the next several days' worth of lookups
 * without touching the quota-bounded REST API. Host-side callers simply
 * re-query the API on every call (per process, thanks to layer 1).
 *
 * @param repo - Repository in "owner/repo" format
 * @param ghCommandFn - Optional gh command function for testing
 *   (Issue #1805). When provided, supersedes the default
 *   `runWithTimeout`-based REST call so the API layer can be exercised
 *   from unit tests without invoking a real subprocess.
 * @returns Result with the default branch name
 */
export async function getRepoDefaultBranch(
  repo: string,
  ghCommandFn?: (args: string[]) => Promise<string>,
): Promise<Result<string>> {
  if (!repo) {
    return { ok: false, error: new Error("Repository name is required") };
  }

  // Layer 1: in-process memory cache.
  const memory = defaultBranchCache.get(repo);
  if (memory) {
    return { ok: true, value: memory };
  }

  // Layer 2: persistent disk cache (7-day TTL).
  try {
    const persisted = await getCachedDefaultBranch(repo);
    if (persisted) {
      defaultBranchCache.set(repo, persisted);
      return { ok: true, value: persisted };
    }
  } catch {
    // Persistent cache read is best-effort — fall through to API.
  }

  // Layer 3: GitHub REST API.
  let branch: string;
  if (ghCommandFn) {
    try {
      branch = (await ghCommandFn([
        "api",
        `repos/${repo}`,
        "--jq",
        ".default_branch",
      ])).trim();
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error
          ? new Error(
            `Failed to fetch default branch for ${repo}: ${err.message}`,
          )
          : new Error(`Failed to fetch default branch for ${repo}`),
      };
    }
  } else {
    const result = await runWithTimeout(
      "gh",
      ["api", `repos/${repo}`, "--jq", ".default_branch"],
      { timeoutMs: DEFAULT_SUBPROCESS_TIMEOUT_MS },
    );

    if (!result.ok) {
      return {
        ok: false,
        error: new Error(
          `Failed to fetch default branch for ${repo}: ${result.error.message}`,
        ),
      };
    }

    if (result.value.timedOut) {
      return {
        ok: false,
        error: new Error(
          `Timed out fetching default branch for ${repo}`,
        ),
      };
    }

    if (!result.value.success) {
      return {
        ok: false,
        error: new Error(
          `Could not determine default branch for ${repo}: ${result.value.stderr}`,
        ),
      };
    }

    branch = result.value.stdout;
  }

  if (!branch || branch === "null") {
    return {
      ok: false,
      error: new Error(
        `Could not determine default branch for ${repo}`,
      ),
    };
  }

  defaultBranchCache.set(repo, branch);
  try {
    await setCachedDefaultBranch(repo, branch);
  } catch {
    // Persistent cache write is best-effort.
  }
  return { ok: true, value: branch };
}
