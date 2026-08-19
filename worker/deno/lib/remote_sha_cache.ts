/**
 * Remote-SHA fast-path cache for `setupRepo` (Issue #1810, parent #1804).
 *
 * `setupRepo` runs `git fetch origin` on every priority cycle, even when the
 * local clone is already at the remote tip. Most repos are quiet most of the
 * time, so the fetch is a no-op that still costs a network round-trip and
 * counts toward the gh-authenticated-git rate-limit.
 *
 * The fast path:
 *   1. `git ls-remote origin refs/heads/<defaultBranch>` returns ~1 KB and
 *      the remote tip SHA in a single round-trip.
 *   2. `git rev-parse origin/<defaultBranch>` returns the cached
 *      remote-tracking SHA from the previous fetch — purely local.
 *   3. If they match, the working tree can be reset to the cached ref
 *      without re-fetching.
 *
 * We cache the ls-remote result per `(repoPath, defaultBranch)` for 60 s by
 * default — matching the priority-loop cadence so back-to-back checks of the
 * same repo within one iteration share a single network call.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";

/** Default time-to-live for the in-memory ls-remote cache (60 seconds). */
export const REMOTE_SHA_CACHE_TTL_MS = 60_000;

/** One entry in the in-memory cache. */
interface CacheEntry {
  sha: string;
  fetchedAt: number;
}

/**
 * Module-level cache. Keyed by `${repoPath}::${defaultBranch}` so that
 * different repos and different branches do not collide.
 */
const cache = new Map<string, CacheEntry>();

/** Build the cache key for a repo path + default branch. */
function cacheKey(repoPath: string, defaultBranch: string): string {
  return `${repoPath}::${defaultBranch}`;
}

/** Clock function — overridable for tests. */
let clockNow: () => number = () => Date.now();

/**
 * Override the clock used to evaluate cache TTL. Test-only; production
 * callers should never set this. Returns a restore function so tests can
 * leave the global state untouched.
 */
export function setRemoteShaCacheClockForTesting(
  fn: () => number,
): () => void {
  const previous = clockNow;
  clockNow = fn;
  return () => {
    clockNow = previous;
  };
}

/** Drop every cached entry — primarily for tests. */
export function clearRemoteShaCache(): void {
  cache.clear();
}

/**
 * Drop the cache entry for a single `(repoPath, defaultBranch)` pair.
 * Call this when the default branch is detected to have moved (e.g.,
 * the repo was renamed) so the next check refetches.
 */
export function invalidateRemoteShaCache(
  repoPath: string,
  defaultBranch: string,
): void {
  cache.delete(cacheKey(repoPath, defaultBranch));
}

/** Result of a single ls-remote lookup. */
export interface RemoteShaLookup {
  /** The remote tip SHA, or `null` if `ls-remote` failed. */
  sha: string | null;
  /** `cache` if served from memory, `fresh` if a network call ran. */
  source: "cache" | "fresh";
  /** Human-readable detail for telemetry on failure. */
  detail?: string;
}

/**
 * Look up the remote tip SHA for `refs/heads/<defaultBranch>` on `origin`,
 * caching the answer for `ttlMs` (default 60 s).
 *
 * On `ls-remote` failure the function returns `{ sha: null, ... }` so the
 * caller can fall back to a full fetch.
 */
export async function getRemoteHeadSha(
  repoPath: string,
  defaultBranch: string,
  options: { ttlMs?: number } = {},
): Promise<RemoteShaLookup> {
  const ttlMs = options.ttlMs ?? REMOTE_SHA_CACHE_TTL_MS;
  const key = cacheKey(repoPath, defaultBranch);
  const now = clockNow();

  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < ttlMs) {
    return { sha: hit.sha, source: "cache" };
  }

  const gitOptions: GitCommandOptions = { cwd: repoPath };
  const result = await runGitCommand(
    ["ls-remote", "origin", `refs/heads/${defaultBranch}`],
    gitOptions,
  );

  if (!result.ok) {
    return { sha: null, source: "fresh", detail: result.error.message };
  }
  const { code, stdout, stderr } = result.value;
  if (code !== 0) {
    return {
      sha: null,
      source: "fresh",
      detail: stderr.trim() || `ls-remote exit ${code}`,
    };
  }

  // Output format: "<sha>\trefs/heads/<branch>\n". An empty stdout means
  // the branch does not exist on the remote — treat as "not up to date" so
  // the caller falls back to fetch and surfaces a sensible error.
  const firstLine = stdout.split("\n")[0]?.trim() ?? "";
  const sha = firstLine.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    return {
      sha: null,
      source: "fresh",
      detail: `ls-remote returned no SHA for refs/heads/${defaultBranch}`,
    };
  }

  cache.set(key, { sha, fetchedAt: now });
  return { sha, source: "fresh" };
}

/**
 * Read the local cached remote-tracking SHA for `origin/<defaultBranch>`
 * via `git rev-parse`. Returns `null` if the ref does not exist locally
 * (e.g., the clone has not seen this branch yet).
 */
export async function getLocalRemoteTrackingSha(
  repoPath: string,
  defaultBranch: string,
): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `origin/${defaultBranch}`],
    { cwd: repoPath },
  );
  if (!result.ok) return null;
  if (result.value.code !== 0) return null;
  const sha = result.value.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/** Outcome of a fast-path freshness check. */
export interface UpToDateCheck {
  /** True when the local remote-tracking ref already matches the remote tip. */
  upToDate: boolean;
  /** Remote SHA, or `null` if `ls-remote` failed. */
  remoteSha: string | null;
  /** Local cached SHA from `origin/<defaultBranch>`, or `null` if missing. */
  localSha: string | null;
  /** `cache` if the remote SHA came from the in-memory cache, `fresh` otherwise. */
  remoteShaSource: "cache" | "fresh";
  /** Telemetry message describing the outcome. */
  reason: string;
}

/**
 * Compare local `origin/<defaultBranch>` with the remote tip and decide
 * whether `setupRepo` can skip `git fetch origin`.
 *
 * The function never throws. On any failure it returns `upToDate: false`
 * with a populated `reason` so the caller can fall back to a full fetch
 * and emit useful telemetry.
 */
export async function isLocalDefaultBranchUpToDate(
  repoPath: string,
  defaultBranch: string,
  options: { ttlMs?: number } = {},
): Promise<UpToDateCheck> {
  const remote = await getRemoteHeadSha(repoPath, defaultBranch, options);
  if (remote.sha === null) {
    return {
      upToDate: false,
      remoteSha: null,
      localSha: null,
      remoteShaSource: remote.source,
      reason: `ls-remote unavailable: ${remote.detail ?? "unknown"}`,
    };
  }

  const localSha = await getLocalRemoteTrackingSha(repoPath, defaultBranch);
  if (localSha === null) {
    return {
      upToDate: false,
      remoteSha: remote.sha,
      localSha: null,
      remoteShaSource: remote.source,
      reason: `no local origin/${defaultBranch} ref`,
    };
  }

  if (localSha === remote.sha) {
    return {
      upToDate: true,
      remoteSha: remote.sha,
      localSha,
      remoteShaSource: remote.source,
      reason: `local matches remote @ ${remote.sha.slice(0, 7)}`,
    };
  }

  return {
    upToDate: false,
    remoteSha: remote.sha,
    localSha,
    remoteShaSource: remote.source,
    reason: `local ${localSha.slice(0, 7)} != remote ${remote.sha.slice(0, 7)}`,
  };
}
