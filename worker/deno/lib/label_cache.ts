/**
 * Label cache for the Vibe Coder worker (Issue #333).
 *
 * Caches GitHub label lists per-repository on disk to avoid repeated
 * `gh label list` calls. The cache is file-backed with a first-line
 * timestamp for TTL validation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";

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
 */
async function labelCacheRefresh(
  cacheDir: string,
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Result<string[]>> {
  try {
    await Deno.mkdir(cacheDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

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
 */
export async function getCachedLabels(
  cacheDir: string,
  repo: string,
  ttlSeconds: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Result<string[]>> {
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

  return await labelCacheRefresh(cacheDir, repo, ghCommandFn);
}
