/**
 * Label cache for the Vibe Coder worker (Issue #333).
 *
 * Caches GitHub label lists per-repository on disk to avoid repeated
 * `gh label list` calls. The cache is file-backed with a first-line
 * timestamp for TTL validation.
 *
 * Issue #1242 (SEC-1215-06): the default directory used to be the fixed
 * `${TMPDIR}/vibe-label-cache` — the same path for every account on the host,
 * so any local user could create it first and drop in a `owner_repo.cache`
 * naming labels that do not exist. `ensureLabelExists` then skipped the real
 * `gh label create`. The directory is now per-account
 * ({@link defaultLabelCacheDir}), created `0700`, and a directory another
 * account could have written to disables the cache entirely rather than
 * being read back.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";
import { defaultLogger } from "./logger.ts";
import { ensureStateDir, sharedTmpStateDir } from "./private_cache_dir.ts";

/**
 * Default per-account directory holding the label caches.
 *
 * @param lookup - Environment reader, injectable for tests.
 */
export function defaultLabelCacheDir(
  lookup?: (key: string) => string | undefined,
): string {
  return lookup === undefined
    ? sharedTmpStateDir("vibe-label-cache")
    : sharedTmpStateDir("vibe-label-cache", lookup);
}

/**
 * Create the cache directory and report whether it may be used.
 *
 * A shared-tmp directory another account owns (or left group/other
 * writable) is refused: the cache is skipped for the rest of the call and
 * the labels come from `gh` instead. The refusal is logged, never swallowed.
 */
async function cacheDirUsable(cacheDir: string): Promise<boolean> {
  const trust = await ensureStateDir(cacheDir);
  if (!trust.trusted) {
    defaultLogger.warn(
      "Label cache directory is not worker-private — cache disabled " +
        "(Issue #1242)",
      { cacheDir, reason: trust.reason ?? "unknown" },
    );
  }
  return trust.trusted;
}

/**
 * Generate the cache file path for a given repo.
 */
export function labelCacheFilePath(cacheDir: string, repo: string): string {
  const repoKey = repo.replace("/", "_");
  return `${cacheDir}/${repoKey}.cache`;
}

/**
 * Check whether the label cache for a repo is still valid.
 */
export async function labelCacheIsValid(
  cacheDir: string,
  repo: string,
  ttlSeconds: number,
): Promise<boolean> {
  const cachePath = labelCacheFilePath(cacheDir, repo);
  try {
    const content = await Deno.readTextFile(cachePath);
    const firstLine = content.split("\n")[0] ?? "";
    const cachedTime = parseInt(firstLine, 10);
    if (isNaN(cachedTime)) return false;
    const now = Math.floor(Date.now() / 1000);
    return (now - cachedTime) <= ttlSeconds;
  } catch {
    return false;
  }
}

/**
 * Refresh the label cache by fetching from GitHub.
 *
 * @param writeCache - False when the directory is not worker-private: the
 *   labels are still fetched, but nothing is written to (or read from) a
 *   directory another account could control.
 */
async function labelCacheRefresh(
  cacheDir: string,
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  writeCache: boolean,
): Promise<Result<string[]>> {
  let labels: string;
  try {
    labels = await ghCommandFn([
      "label",
      "list",
      "--repo",
      repo,
      // gh's default page is 30 (Issue #4337): a repo with more labels made
      // every label past the first page invisible to the cache, so
      // ensureLabelExists tried to create labels that already existed and
      // reported failure. Per-repo label counts are small; 500 is ample.
      "--limit",
      "500",
      "--json",
      "name",
      "--jq",
      ".[].name",
    ]);
  } catch {
    return {
      ok: false,
      error: new Error(`Failed to fetch labels from GitHub for ${repo}`),
    };
  }

  const labelList = labels.trim().split("\n").filter((l) => l.length > 0);
  if (!writeCache) return { ok: true, value: labelList };

  const now = Math.floor(Date.now() / 1000);
  const cacheContent = `${now}\n${labelList.join("\n")}`;
  const cachePath = labelCacheFilePath(cacheDir, repo);

  const writeResult = await atomicWrite({
    targetFile: cachePath,
    content: cacheContent,
  });
  if (!writeResult.ok) {
    // Non-fatal — the labels were fetched, only the cache write failed. Say
    // so rather than swallowing it (never fail silently).
    console.warn(
      `[label-cache] Failed to cache labels for ${repo}: ${writeResult.error.message}`,
    );
  }

  return { ok: true, value: labelList };
}

/**
 * Invalidate the label cache for a repo.
 */
export async function labelCacheInvalidate(
  cacheDir: string,
  repo: string,
): Promise<void> {
  const cachePath = labelCacheFilePath(cacheDir, repo);
  try {
    await Deno.remove(cachePath);
  } catch {
    // File may not exist
  }
}

/**
 * Get cached labels, refreshing if needed.
 *
 * The directory is created and ownership-checked first (Issue #1242). A
 * directory another account could have written to is never read from and
 * never written to — the labels come straight from `gh` instead, so a
 * planted cache file cannot make `ensureLabelExists` skip a real
 * `gh label create`.
 */
export async function getCachedLabels(
  cacheDir: string,
  repo: string,
  ttlSeconds: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Result<string[]>> {
  const usable = await cacheDirUsable(cacheDir);
  if (!usable) {
    return await labelCacheRefresh(cacheDir, repo, ghCommandFn, false);
  }

  if (await labelCacheIsValid(cacheDir, repo, ttlSeconds)) {
    const cachePath = labelCacheFilePath(cacheDir, repo);
    try {
      const content = await Deno.readTextFile(cachePath);
      const lines = content.split("\n").slice(1).filter((l) => l.length > 0);
      return { ok: true, value: lines };
    } catch {
      // Fall through to refresh
    }
  }

  return await labelCacheRefresh(cacheDir, repo, ghCommandFn, true);
}
