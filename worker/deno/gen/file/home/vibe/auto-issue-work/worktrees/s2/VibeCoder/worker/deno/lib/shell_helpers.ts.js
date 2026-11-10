/**
 * Shell helper utilities migrated to Deno TypeScript (Issue #964).
 *
 * Contains functions previously implemented as shell helpers in
 * issue_worker.sh: sleep with jitter (anti-thundering herd),
 * and default branch fetching via GitHub API.
 */ import { spawnGh } from "./gh_spawn.ts";
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./subprocess_timeout.ts";
import { defaultBranchCachePath, getCachedDefaultBranch, invalidateCachedDefaultBranch, setCachedDefaultBranch } from "./default_branch_cache.ts";
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
 */ export function calculateJitter(baseInterval) {
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
 */ export async function sleepWithJitter(baseInterval) {
  const seconds = calculateJitter(baseInterval);
  if (seconds <= 0) return;
  await new Promise((resolve)=>setTimeout(resolve, seconds * 1000));
}
// =============================================================================
// GitHub helpers
// =============================================================================
/** In-process cache for default branch lookups. Backed by a persistent file
 *  so the value survives across run_core cycles (Issue #1509). */ const defaultBranchCache = new Map();
/**
 * Clear the in-process memory cache. Exposed for tests — production code
 * should use `invalidateDefaultBranch` instead to also drop the persistent entry.
 */ export function clearDefaultBranchMemoryCache() {
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
 * @param cachePath - Where the persistent cache lives (Issue #964).
 *   Defaults to {@link defaultBranchCachePath}, so production callers pass
 *   nothing; a test names a throwaway path instead of pointing the whole
 *   process at one with `Deno.env.set`.
 */ export async function invalidateDefaultBranch(repo, cachePath = defaultBranchCachePath()) {
  if (!repo) return;
  defaultBranchCache.delete(repo);
  try {
    await invalidateCachedDefaultBranch(repo, cachePath);
  } catch  {
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
 *   (Issue #1805). When provided, supersedes the default `spawnGh`-based
 *   REST call so the API layer can be exercised from unit tests without
 *   invoking a real subprocess.
 * @param cachePath - Where the persistent (layer 2) cache lives
 *   (Issue #964). Defaults to {@link defaultBranchCachePath}, so production
 *   callers pass nothing; a test names a throwaway path instead of pointing
 *   the whole process at one with `Deno.env.set`.
 * @returns Result with the default branch name
 */ export async function getRepoDefaultBranch(repo, ghCommandFn, cachePath = defaultBranchCachePath()) {
  if (!repo) {
    return {
      ok: false,
      error: new Error("Repository name is required")
    };
  }
  // Layer 1: in-process memory cache.
  const memory = defaultBranchCache.get(repo);
  if (memory) {
    return {
      ok: true,
      value: memory
    };
  }
  // Layer 2: persistent disk cache (7-day TTL).
  try {
    const persisted = await getCachedDefaultBranch(repo, cachePath);
    if (persisted) {
      defaultBranchCache.set(repo, persisted);
      return {
        ok: true,
        value: persisted
      };
    }
  } catch  {
  // Persistent cache read is best-effort — fall through to API.
  }
  // Layer 3: GitHub REST API.
  let branch;
  if (ghCommandFn) {
    try {
      branch = (await ghCommandFn([
        "api",
        `repos/${repo}`,
        "--jq",
        ".default_branch"
      ])).trim();
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? new Error(`Failed to fetch default branch for ${repo}: ${err.message}`) : new Error(`Failed to fetch default branch for ${repo}`)
      };
    }
  } else {
    // Issue #1378: the shared `gh` chokepoint, not the generic subprocess
    // wrapper. `runWithTimeout("gh", …)` reached the binary outside the
    // write-repo allowlist and the audit journal — and outside the quality
    // gate, whose scan only saw a literal `Deno.Command("gh", …)`.
    let result;
    try {
      result = await spawnGh([
        "api",
        `repos/${repo}`,
        "--jq",
        ".default_branch"
      ], {
        signal: AbortSignal.timeout(DEFAULT_SUBPROCESS_TIMEOUT_MS)
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
      return {
        ok: false,
        error: new Error(timedOut ? `Timed out fetching default branch for ${repo}` : `Failed to fetch default branch for ${repo}: ${err instanceof Error ? err.message : String(err)}`)
      };
    }
    if (!result.success) {
      return {
        ok: false,
        error: new Error(`Could not determine default branch for ${repo}: ${result.stderr}`)
      };
    }
    branch = result.stdout.trim();
  }
  if (!branch || branch === "null") {
    return {
      ok: false,
      error: new Error(`Could not determine default branch for ${repo}`)
    };
  }
  defaultBranchCache.set(repo, branch);
  try {
    await setCachedDefaultBranch(repo, branch, cachePath);
  } catch  {
  // Persistent cache write is best-effort.
  }
  return {
    ok: true,
    value: branch
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zaGVsbF9oZWxwZXJzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2hlbGwgaGVscGVyIHV0aWxpdGllcyBtaWdyYXRlZCB0byBEZW5vIFR5cGVTY3JpcHQgKElzc3VlICM5NjQpLlxuICpcbiAqIENvbnRhaW5zIGZ1bmN0aW9ucyBwcmV2aW91c2x5IGltcGxlbWVudGVkIGFzIHNoZWxsIGhlbHBlcnMgaW5cbiAqIGlzc3VlX3dvcmtlci5zaDogc2xlZXAgd2l0aCBqaXR0ZXIgKGFudGktdGh1bmRlcmluZyBoZXJkKSxcbiAqIGFuZCBkZWZhdWx0IGJyYW5jaCBmZXRjaGluZyB2aWEgR2l0SHViIEFQSS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgdHlwZSBHaFNwYXduUmVzdWx0LCBzcGF3bkdoIH0gZnJvbSBcIi4vZ2hfc3Bhd24udHNcIjtcbmltcG9ydCB7IERFRkFVTFRfU1VCUFJPQ0VTU19USU1FT1VUX01TIH0gZnJvbSBcIi4vc3VicHJvY2Vzc190aW1lb3V0LnRzXCI7XG5pbXBvcnQge1xuICBkZWZhdWx0QnJhbmNoQ2FjaGVQYXRoLFxuICBnZXRDYWNoZWREZWZhdWx0QnJhbmNoLFxuICBpbnZhbGlkYXRlQ2FjaGVkRGVmYXVsdEJyYW5jaCxcbiAgc2V0Q2FjaGVkRGVmYXVsdEJyYW5jaCxcbn0gZnJvbSBcIi4vZGVmYXVsdF9icmFuY2hfY2FjaGUudHNcIjtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEppdHRlciAvIHNsZWVwIGhlbHBlcnNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogQ2FsY3VsYXRlIGEgc2xlZXAgZHVyYXRpb24gd2l0aCByYW5kb20gaml0dGVyLlxuICpcbiAqIFByb2R1Y2VzIGEgdmFsdWUgYmV0d2VlbiA1MCUgYW5kIDE1MCUgb2YgdGhlIGJhc2UgaW50ZXJ2YWwsXG4gKiBwcmV2ZW50aW5nIHRodW5kZXJpbmcgaGVyZCB3aGVuIG11bHRpcGxlIHdvcmtlcnMgd2FrZSBzaW11bHRhbmVvdXNseS5cbiAqXG4gKiBAcGFyYW0gYmFzZUludGVydmFsIC0gQmFzZSBpbnRlcnZhbCBpbiBzZWNvbmRzXG4gKiBAcmV0dXJucyBKaXR0ZXJlZCBpbnRlcnZhbCBpbiBzZWNvbmRzIChpbnRlZ2VyKVxuICovXG5leHBvcnQgZnVuY3Rpb24gY2FsY3VsYXRlSml0dGVyKGJhc2VJbnRlcnZhbDogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKGJhc2VJbnRlcnZhbCA8PSAwKSByZXR1cm4gMDtcbiAgY29uc3QgbWluID0gTWF0aC5mbG9vcihiYXNlSW50ZXJ2YWwgKiAwLjUpO1xuICBjb25zdCBtYXggPSBNYXRoLmZsb29yKGJhc2VJbnRlcnZhbCAqIDEuNSk7XG4gIHJldHVybiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAobWF4IC0gbWluICsgMSkpICsgbWluO1xufVxuXG4vKipcbiAqIFNsZWVwIGZvciBhIGppdHRlcmVkIGR1cmF0aW9uIGJhc2VkIG9uIHRoZSBnaXZlbiBiYXNlIGludGVydmFsLlxuICpcbiAqIEFudGktdGh1bmRlcmluZyBoZXJkIHBhdHRlcm46IGFkZHMgcmFuZG9tIGppdHRlciBzbyBtdWx0aXBsZSB3b3JrZXJzXG4gKiBkb24ndCBhbGwgd2FrZSBhbmQgcG9sbCBhdCB0aGUgc2FtZSBpbnN0YW50LlxuICpcbiAqIEBwYXJhbSBiYXNlSW50ZXJ2YWwgLSBCYXNlIGludGVydmFsIGluIHNlY29uZHNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNsZWVwV2l0aEppdHRlcihiYXNlSW50ZXJ2YWw6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzZWNvbmRzID0gY2FsY3VsYXRlSml0dGVyKGJhc2VJbnRlcnZhbCk7XG4gIGlmIChzZWNvbmRzIDw9IDApIHJldHVybjtcbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgc2Vjb25kcyAqIDEwMDApKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEdpdEh1YiBoZWxwZXJzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKiogSW4tcHJvY2VzcyBjYWNoZSBmb3IgZGVmYXVsdCBicmFuY2ggbG9va3Vwcy4gQmFja2VkIGJ5IGEgcGVyc2lzdGVudCBmaWxlXG4gKiAgc28gdGhlIHZhbHVlIHN1cnZpdmVzIGFjcm9zcyBydW5fY29yZSBjeWNsZXMgKElzc3VlICMxNTA5KS4gKi9cbmNvbnN0IGRlZmF1bHRCcmFuY2hDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cbi8qKlxuICogQ2xlYXIgdGhlIGluLXByb2Nlc3MgbWVtb3J5IGNhY2hlLiBFeHBvc2VkIGZvciB0ZXN0cyDigJQgcHJvZHVjdGlvbiBjb2RlXG4gKiBzaG91bGQgdXNlIGBpbnZhbGlkYXRlRGVmYXVsdEJyYW5jaGAgaW5zdGVhZCB0byBhbHNvIGRyb3AgdGhlIHBlcnNpc3RlbnQgZW50cnkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGVhckRlZmF1bHRCcmFuY2hNZW1vcnlDYWNoZSgpOiB2b2lkIHtcbiAgZGVmYXVsdEJyYW5jaENhY2hlLmNsZWFyKCk7XG59XG5cbi8qKlxuICogSW52YWxpZGF0ZSBhIGNhY2hlZCBkZWZhdWx0LWJyYW5jaCBlbnRyeSBpbiBib3RoIHRoZSBpbi1wcm9jZXNzIGFuZFxuICogcGVyc2lzdGVudCBjYWNoZXMgKElzc3VlICMxNTA5KS5cbiAqXG4gKiBDYWxsZXJzIHNob3VsZCBpbnZva2UgdGhpcyB3aGVuIHRoZXkgZGV0ZWN0IGEgc3RhbGUgY2FjaGUg4oCUIGUuZy4sIGFcbiAqIGBnaXQgZmV0Y2ggb3JpZ2luLzxjYWNoZWQtYnJhbmNoPmAgZmFpbHVyZSBhZnRlciBhIHJlbW90ZSByZW5hbWUuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHBhcmFtIGNhY2hlUGF0aCAtIFdoZXJlIHRoZSBwZXJzaXN0ZW50IGNhY2hlIGxpdmVzIChJc3N1ZSAjOTY0KS5cbiAqICAgRGVmYXVsdHMgdG8ge0BsaW5rIGRlZmF1bHRCcmFuY2hDYWNoZVBhdGh9LCBzbyBwcm9kdWN0aW9uIGNhbGxlcnMgcGFzc1xuICogICBub3RoaW5nOyBhIHRlc3QgbmFtZXMgYSB0aHJvd2F3YXkgcGF0aCBpbnN0ZWFkIG9mIHBvaW50aW5nIHRoZSB3aG9sZVxuICogICBwcm9jZXNzIGF0IG9uZSB3aXRoIGBEZW5vLmVudi5zZXRgLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW52YWxpZGF0ZURlZmF1bHRCcmFuY2goXG4gIHJlcG86IHN0cmluZyxcbiAgY2FjaGVQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQgPSBkZWZhdWx0QnJhbmNoQ2FjaGVQYXRoKCksXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFyZXBvKSByZXR1cm47XG4gIGRlZmF1bHRCcmFuY2hDYWNoZS5kZWxldGUocmVwbyk7XG4gIHRyeSB7XG4gICAgYXdhaXQgaW52YWxpZGF0ZUNhY2hlZERlZmF1bHRCcmFuY2gocmVwbywgY2FjaGVQYXRoKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGVyc2lzdGVudCBjYWNoZSByZW1vdmFsIGlzIGJlc3QtZWZmb3J0LlxuICB9XG59XG5cbi8qKlxuICogR2V0IHRoZSBkZWZhdWx0IGJyYW5jaCBmb3IgYSByZXBvc2l0b3J5IHZpYSBHaXRIdWIgQVBJIChJc3N1ZSAjMTQwKS5cbiAqXG4gKiBMb29rdXAgb3JkZXIgKElzc3VlICMxNTA5KTpcbiAqICAgMS4gSW4tcHJvY2VzcyBtZW1vcnkgY2FjaGUgKGZhc3Rlc3QsIGNsZWFyZWQgb24gcHJvY2VzcyByZXN0YXJ0KS5cbiAqICAgMi4gUGVyc2lzdGVudCBkaXNrIGNhY2hlIHdpdGggNy1kYXkgVFRMIOKAlCBvbmx5IHdoZW4gYFdPUktfRElSYCBpcyBzZXRcbiAqICAgICAgKGAke1dPUktfRElSfS8udmliZS1jYWNoZS9kZWZhdWx0LWJyYW5jaC1jYWNoZS5qc29uYCwgSXNzdWUgIzQzMTgpLlxuICogICAgICBXaXRoIGBXT1JLX0RJUmAgdW5zZXQgKGFueSBob3N0LXNpZGUgcHJvY2VzcyDigJQgc2V0dXAsIGxhdW5jaGVyLFxuICogICAgICBob3VzZWtlZXBpbmcpIHRoZXJlIGlzIG5vIGNhY2hlIGRpcmVjdG9yeSBhbmQgdGhpcyBsYXllciBpcyBhXG4gKiAgICAgIGNvbXBsZXRlIG5vLW9wIChJc3N1ZSAjMTMyKTogbm90aGluZyBpcyByZWFkIG9yIHdyaXR0ZW4gb24gZGlzay5cbiAqICAgMy4gR2l0SHViIFJFU1QgQVBJIHZpYSBgZ2ggYXBpIHJlcG9zLzxyZXBvPmAuXG4gKlxuICogU3VjY2Vzc2Z1bCBBUEkgbG9va3VwcyBhcmUgd3JpdHRlbiBiYWNrIHRvIGJvdGggbGF5ZXJzIHNvIHN1YnNlcXVlbnRcbiAqIHJ1bl9jb3JlIGN5Y2xlcyBjYW4gYW5zd2VyIHRoZSBuZXh0IHNldmVyYWwgZGF5cycgd29ydGggb2YgbG9va3Vwc1xuICogd2l0aG91dCB0b3VjaGluZyB0aGUgcXVvdGEtYm91bmRlZCBSRVNUIEFQSS4gSG9zdC1zaWRlIGNhbGxlcnMgc2ltcGx5XG4gKiByZS1xdWVyeSB0aGUgQVBJIG9uIGV2ZXJ5IGNhbGwgKHBlciBwcm9jZXNzLCB0aGFua3MgdG8gbGF5ZXIgMSkuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHBhcmFtIGdoQ29tbWFuZEZuIC0gT3B0aW9uYWwgZ2ggY29tbWFuZCBmdW5jdGlvbiBmb3IgdGVzdGluZ1xuICogICAoSXNzdWUgIzE4MDUpLiBXaGVuIHByb3ZpZGVkLCBzdXBlcnNlZGVzIHRoZSBkZWZhdWx0IGBzcGF3bkdoYC1iYXNlZFxuICogICBSRVNUIGNhbGwgc28gdGhlIEFQSSBsYXllciBjYW4gYmUgZXhlcmNpc2VkIGZyb20gdW5pdCB0ZXN0cyB3aXRob3V0XG4gKiAgIGludm9raW5nIGEgcmVhbCBzdWJwcm9jZXNzLlxuICogQHBhcmFtIGNhY2hlUGF0aCAtIFdoZXJlIHRoZSBwZXJzaXN0ZW50IChsYXllciAyKSBjYWNoZSBsaXZlc1xuICogICAoSXNzdWUgIzk2NCkuIERlZmF1bHRzIHRvIHtAbGluayBkZWZhdWx0QnJhbmNoQ2FjaGVQYXRofSwgc28gcHJvZHVjdGlvblxuICogICBjYWxsZXJzIHBhc3Mgbm90aGluZzsgYSB0ZXN0IG5hbWVzIGEgdGhyb3dhd2F5IHBhdGggaW5zdGVhZCBvZiBwb2ludGluZ1xuICogICB0aGUgd2hvbGUgcHJvY2VzcyBhdCBvbmUgd2l0aCBgRGVuby5lbnYuc2V0YC5cbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIHRoZSBkZWZhdWx0IGJyYW5jaCBuYW1lXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRSZXBvRGVmYXVsdEJyYW5jaChcbiAgcmVwbzogc3RyaW5nLFxuICBnaENvbW1hbmRGbj86IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICBjYWNoZVBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZCA9IGRlZmF1bHRCcmFuY2hDYWNoZVBhdGgoKSxcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZz4+IHtcbiAgaWYgKCFyZXBvKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogbmV3IEVycm9yKFwiUmVwb3NpdG9yeSBuYW1lIGlzIHJlcXVpcmVkXCIpIH07XG4gIH1cblxuICAvLyBMYXllciAxOiBpbi1wcm9jZXNzIG1lbW9yeSBjYWNoZS5cbiAgY29uc3QgbWVtb3J5ID0gZGVmYXVsdEJyYW5jaENhY2hlLmdldChyZXBvKTtcbiAgaWYgKG1lbW9yeSkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogbWVtb3J5IH07XG4gIH1cblxuICAvLyBMYXllciAyOiBwZXJzaXN0ZW50IGRpc2sgY2FjaGUgKDctZGF5IFRUTCkuXG4gIHRyeSB7XG4gICAgY29uc3QgcGVyc2lzdGVkID0gYXdhaXQgZ2V0Q2FjaGVkRGVmYXVsdEJyYW5jaChyZXBvLCBjYWNoZVBhdGgpO1xuICAgIGlmIChwZXJzaXN0ZWQpIHtcbiAgICAgIGRlZmF1bHRCcmFuY2hDYWNoZS5zZXQocmVwbywgcGVyc2lzdGVkKTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcGVyc2lzdGVkIH07XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBQZXJzaXN0ZW50IGNhY2hlIHJlYWQgaXMgYmVzdC1lZmZvcnQg4oCUIGZhbGwgdGhyb3VnaCB0byBBUEkuXG4gIH1cblxuICAvLyBMYXllciAzOiBHaXRIdWIgUkVTVCBBUEkuXG4gIGxldCBicmFuY2g6IHN0cmluZztcbiAgaWYgKGdoQ29tbWFuZEZuKSB7XG4gICAgdHJ5IHtcbiAgICAgIGJyYW5jaCA9IChhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICAgIFwiYXBpXCIsXG4gICAgICAgIGByZXBvcy8ke3JlcG99YCxcbiAgICAgICAgXCItLWpxXCIsXG4gICAgICAgIFwiLmRlZmF1bHRfYnJhbmNoXCIsXG4gICAgICBdKSkudHJpbSgpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3JcbiAgICAgICAgICA/IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBGYWlsZWQgdG8gZmV0Y2ggZGVmYXVsdCBicmFuY2ggZm9yICR7cmVwb306ICR7ZXJyLm1lc3NhZ2V9YCxcbiAgICAgICAgICApXG4gICAgICAgICAgOiBuZXcgRXJyb3IoYEZhaWxlZCB0byBmZXRjaCBkZWZhdWx0IGJyYW5jaCBmb3IgJHtyZXBvfWApLFxuICAgICAgfTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgLy8gSXNzdWUgIzEzNzg6IHRoZSBzaGFyZWQgYGdoYCBjaG9rZXBvaW50LCBub3QgdGhlIGdlbmVyaWMgc3VicHJvY2Vzc1xuICAgIC8vIHdyYXBwZXIuIGBydW5XaXRoVGltZW91dChcImdoXCIsIOKApilgIHJlYWNoZWQgdGhlIGJpbmFyeSBvdXRzaWRlIHRoZVxuICAgIC8vIHdyaXRlLXJlcG8gYWxsb3dsaXN0IGFuZCB0aGUgYXVkaXQgam91cm5hbCDigJQgYW5kIG91dHNpZGUgdGhlIHF1YWxpdHlcbiAgICAvLyBnYXRlLCB3aG9zZSBzY2FuIG9ubHkgc2F3IGEgbGl0ZXJhbCBgRGVuby5Db21tYW5kKFwiZ2hcIiwg4oCmKWAuXG4gICAgbGV0IHJlc3VsdDogR2hTcGF3blJlc3VsdDtcbiAgICB0cnkge1xuICAgICAgcmVzdWx0ID0gYXdhaXQgc3Bhd25HaChcbiAgICAgICAgW1wiYXBpXCIsIGByZXBvcy8ke3JlcG99YCwgXCItLWpxXCIsIFwiLmRlZmF1bHRfYnJhbmNoXCJdLFxuICAgICAgICB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dChERUZBVUxUX1NVQlBST0NFU1NfVElNRU9VVF9NUykgfSxcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCB0aW1lZE91dCA9IGVyciBpbnN0YW5jZW9mIERPTUV4Y2VwdGlvbiAmJlxuICAgICAgICAoZXJyLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiIHx8IGVyci5uYW1lID09PSBcIlRpbWVvdXRFcnJvclwiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICB0aW1lZE91dFxuICAgICAgICAgICAgPyBgVGltZWQgb3V0IGZldGNoaW5nIGRlZmF1bHQgYnJhbmNoIGZvciAke3JlcG99YFxuICAgICAgICAgICAgOiBgRmFpbGVkIHRvIGZldGNoIGRlZmF1bHQgYnJhbmNoIGZvciAke3JlcG99OiAke1xuICAgICAgICAgICAgICBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICAgICAgICAgIH1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYENvdWxkIG5vdCBkZXRlcm1pbmUgZGVmYXVsdCBicmFuY2ggZm9yICR7cmVwb306ICR7cmVzdWx0LnN0ZGVycn1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBicmFuY2ggPSByZXN1bHQuc3Rkb3V0LnRyaW0oKTtcbiAgfVxuXG4gIGlmICghYnJhbmNoIHx8IGJyYW5jaCA9PT0gXCJudWxsXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCBkZXRlcm1pbmUgZGVmYXVsdCBicmFuY2ggZm9yICR7cmVwb31gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgZGVmYXVsdEJyYW5jaENhY2hlLnNldChyZXBvLCBicmFuY2gpO1xuICB0cnkge1xuICAgIGF3YWl0IHNldENhY2hlZERlZmF1bHRCcmFuY2gocmVwbywgYnJhbmNoLCBjYWNoZVBhdGgpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBQZXJzaXN0ZW50IGNhY2hlIHdyaXRlIGlzIGJlc3QtZWZmb3J0LlxuICB9XG4gIHJldHVybiB7IG9rOiB0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
// denoCacheMetadata=6197040831558354715,16204160837304273658