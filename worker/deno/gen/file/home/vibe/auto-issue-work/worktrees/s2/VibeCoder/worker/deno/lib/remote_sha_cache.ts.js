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
 */ import { runGitCommand } from "./git_timeout.ts";
/** Default time-to-live for the in-memory ls-remote cache (60 seconds). */ export const REMOTE_SHA_CACHE_TTL_MS = 60_000;
/**
 * Module-level cache. Keyed by `${repoPath}::${defaultBranch}` so that
 * different repos and different branches do not collide.
 */ const cache = new Map();
/** Build the cache key for a repo path + default branch. */ function cacheKey(repoPath, defaultBranch) {
  return `${repoPath}::${defaultBranch}`;
}
/** Clock function — overridable for tests. */ let clockNow = ()=>Date.now();
/**
 * Override the clock used to evaluate cache TTL. Test-only; production
 * callers should never set this. Returns a restore function so tests can
 * leave the global state untouched.
 */ export function setRemoteShaCacheClockForTesting(fn) {
  const previous = clockNow;
  clockNow = fn;
  return ()=>{
    clockNow = previous;
  };
}
/** Drop every cached entry — primarily for tests. */ export function clearRemoteShaCache() {
  cache.clear();
}
/**
 * Drop the cache entry for a single `(repoPath, defaultBranch)` pair.
 * Call this when the default branch is detected to have moved (e.g.,
 * the repo was renamed) so the next check refetches.
 */ export function invalidateRemoteShaCache(repoPath, defaultBranch) {
  cache.delete(cacheKey(repoPath, defaultBranch));
}
/**
 * Look up the remote tip SHA for `refs/heads/<defaultBranch>` on `origin`,
 * caching the answer for `ttlMs` (default 60 s).
 *
 * On `ls-remote` failure the function returns `{ sha: null, ... }` so the
 * caller can fall back to a full fetch.
 */ export async function getRemoteHeadSha(repoPath, defaultBranch, options = {}) {
  const ttlMs = options.ttlMs ?? REMOTE_SHA_CACHE_TTL_MS;
  const key = cacheKey(repoPath, defaultBranch);
  const now = clockNow();
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < ttlMs) {
    return {
      sha: hit.sha,
      source: "cache"
    };
  }
  const gitOptions = {
    cwd: repoPath
  };
  const result = await runGitCommand([
    "ls-remote",
    "origin",
    `refs/heads/${defaultBranch}`
  ], gitOptions);
  if (!result.ok) {
    return {
      sha: null,
      source: "fresh",
      detail: result.error.message
    };
  }
  const { code, stdout, stderr } = result.value;
  if (code !== 0) {
    return {
      sha: null,
      source: "fresh",
      detail: stderr.trim() || `ls-remote exit ${code}`
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
      detail: `ls-remote returned no SHA for refs/heads/${defaultBranch}`
    };
  }
  cache.set(key, {
    sha,
    fetchedAt: now
  });
  return {
    sha,
    source: "fresh"
  };
}
/**
 * Read the local cached remote-tracking SHA for `origin/<defaultBranch>`
 * via `git rev-parse`. Returns `null` if the ref does not exist locally
 * (e.g., the clone has not seen this branch yet).
 */ export async function getLocalRemoteTrackingSha(repoPath, defaultBranch) {
  const result = await runGitCommand([
    "rev-parse",
    "--verify",
    "--quiet",
    `origin/${defaultBranch}`
  ], {
    cwd: repoPath
  });
  if (!result.ok) return null;
  if (result.value.code !== 0) return null;
  const sha = result.value.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}
/**
 * Compare local `origin/<defaultBranch>` with the remote tip and decide
 * whether `setupRepo` can skip `git fetch origin`.
 *
 * The function never throws. On any failure it returns `upToDate: false`
 * with a populated `reason` so the caller can fall back to a full fetch
 * and emit useful telemetry.
 */ export async function isLocalDefaultBranchUpToDate(repoPath, defaultBranch, options = {}) {
  const remote = await getRemoteHeadSha(repoPath, defaultBranch, options);
  if (remote.sha === null) {
    return {
      upToDate: false,
      remoteSha: null,
      localSha: null,
      remoteShaSource: remote.source,
      reason: `ls-remote unavailable: ${remote.detail ?? "unknown"}`
    };
  }
  const localSha = await getLocalRemoteTrackingSha(repoPath, defaultBranch);
  if (localSha === null) {
    return {
      upToDate: false,
      remoteSha: remote.sha,
      localSha: null,
      remoteShaSource: remote.source,
      reason: `no local origin/${defaultBranch} ref`
    };
  }
  if (localSha === remote.sha) {
    return {
      upToDate: true,
      remoteSha: remote.sha,
      localSha,
      remoteShaSource: remote.source,
      reason: `local matches remote @ ${remote.sha.slice(0, 7)}`
    };
  }
  return {
    upToDate: false,
    remoteSha: remote.sha,
    localSha,
    remoteShaSource: remote.source,
    reason: `local ${localSha.slice(0, 7)} != remote ${remote.sha.slice(0, 7)}`
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZW1vdGVfc2hhX2NhY2hlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUmVtb3RlLVNIQSBmYXN0LXBhdGggY2FjaGUgZm9yIGBzZXR1cFJlcG9gIChJc3N1ZSAjMTgxMCwgcGFyZW50ICMxODA0KS5cbiAqXG4gKiBgc2V0dXBSZXBvYCBydW5zIGBnaXQgZmV0Y2ggb3JpZ2luYCBvbiBldmVyeSBwcmlvcml0eSBjeWNsZSwgZXZlbiB3aGVuIHRoZVxuICogbG9jYWwgY2xvbmUgaXMgYWxyZWFkeSBhdCB0aGUgcmVtb3RlIHRpcC4gTW9zdCByZXBvcyBhcmUgcXVpZXQgbW9zdCBvZiB0aGVcbiAqIHRpbWUsIHNvIHRoZSBmZXRjaCBpcyBhIG5vLW9wIHRoYXQgc3RpbGwgY29zdHMgYSBuZXR3b3JrIHJvdW5kLXRyaXAgYW5kXG4gKiBjb3VudHMgdG93YXJkIHRoZSBnaC1hdXRoZW50aWNhdGVkLWdpdCByYXRlLWxpbWl0LlxuICpcbiAqIFRoZSBmYXN0IHBhdGg6XG4gKiAgIDEuIGBnaXQgbHMtcmVtb3RlIG9yaWdpbiByZWZzL2hlYWRzLzxkZWZhdWx0QnJhbmNoPmAgcmV0dXJucyB+MSBLQiBhbmRcbiAqICAgICAgdGhlIHJlbW90ZSB0aXAgU0hBIGluIGEgc2luZ2xlIHJvdW5kLXRyaXAuXG4gKiAgIDIuIGBnaXQgcmV2LXBhcnNlIG9yaWdpbi88ZGVmYXVsdEJyYW5jaD5gIHJldHVybnMgdGhlIGNhY2hlZFxuICogICAgICByZW1vdGUtdHJhY2tpbmcgU0hBIGZyb20gdGhlIHByZXZpb3VzIGZldGNoIOKAlCBwdXJlbHkgbG9jYWwuXG4gKiAgIDMuIElmIHRoZXkgbWF0Y2gsIHRoZSB3b3JraW5nIHRyZWUgY2FuIGJlIHJlc2V0IHRvIHRoZSBjYWNoZWQgcmVmXG4gKiAgICAgIHdpdGhvdXQgcmUtZmV0Y2hpbmcuXG4gKlxuICogV2UgY2FjaGUgdGhlIGxzLXJlbW90ZSByZXN1bHQgcGVyIGAocmVwb1BhdGgsIGRlZmF1bHRCcmFuY2gpYCBmb3IgNjAgcyBieVxuICogZGVmYXVsdCDigJQgbWF0Y2hpbmcgdGhlIHByaW9yaXR5LWxvb3AgY2FkZW5jZSBzbyBiYWNrLXRvLWJhY2sgY2hlY2tzIG9mIHRoZVxuICogc2FtZSByZXBvIHdpdGhpbiBvbmUgaXRlcmF0aW9uIHNoYXJlIGEgc2luZ2xlIG5ldHdvcmsgY2FsbC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyBydW5HaXRDb21tYW5kIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB0eXBlIHsgR2l0Q29tbWFuZE9wdGlvbnMgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuXG4vKiogRGVmYXVsdCB0aW1lLXRvLWxpdmUgZm9yIHRoZSBpbi1tZW1vcnkgbHMtcmVtb3RlIGNhY2hlICg2MCBzZWNvbmRzKS4gKi9cbmV4cG9ydCBjb25zdCBSRU1PVEVfU0hBX0NBQ0hFX1RUTF9NUyA9IDYwXzAwMDtcblxuLyoqIE9uZSBlbnRyeSBpbiB0aGUgaW4tbWVtb3J5IGNhY2hlLiAqL1xuaW50ZXJmYWNlIENhY2hlRW50cnkge1xuICBzaGE6IHN0cmluZztcbiAgZmV0Y2hlZEF0OiBudW1iZXI7XG59XG5cbi8qKlxuICogTW9kdWxlLWxldmVsIGNhY2hlLiBLZXllZCBieSBgJHtyZXBvUGF0aH06OiR7ZGVmYXVsdEJyYW5jaH1gIHNvIHRoYXRcbiAqIGRpZmZlcmVudCByZXBvcyBhbmQgZGlmZmVyZW50IGJyYW5jaGVzIGRvIG5vdCBjb2xsaWRlLlxuICovXG5jb25zdCBjYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBDYWNoZUVudHJ5PigpO1xuXG4vKiogQnVpbGQgdGhlIGNhY2hlIGtleSBmb3IgYSByZXBvIHBhdGggKyBkZWZhdWx0IGJyYW5jaC4gKi9cbmZ1bmN0aW9uIGNhY2hlS2V5KHJlcG9QYXRoOiBzdHJpbmcsIGRlZmF1bHRCcmFuY2g6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtyZXBvUGF0aH06OiR7ZGVmYXVsdEJyYW5jaH1gO1xufVxuXG4vKiogQ2xvY2sgZnVuY3Rpb24g4oCUIG92ZXJyaWRhYmxlIGZvciB0ZXN0cy4gKi9cbmxldCBjbG9ja05vdzogKCkgPT4gbnVtYmVyID0gKCkgPT4gRGF0ZS5ub3coKTtcblxuLyoqXG4gKiBPdmVycmlkZSB0aGUgY2xvY2sgdXNlZCB0byBldmFsdWF0ZSBjYWNoZSBUVEwuIFRlc3Qtb25seTsgcHJvZHVjdGlvblxuICogY2FsbGVycyBzaG91bGQgbmV2ZXIgc2V0IHRoaXMuIFJldHVybnMgYSByZXN0b3JlIGZ1bmN0aW9uIHNvIHRlc3RzIGNhblxuICogbGVhdmUgdGhlIGdsb2JhbCBzdGF0ZSB1bnRvdWNoZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRSZW1vdGVTaGFDYWNoZUNsb2NrRm9yVGVzdGluZyhcbiAgZm46ICgpID0+IG51bWJlcixcbik6ICgpID0+IHZvaWQge1xuICBjb25zdCBwcmV2aW91cyA9IGNsb2NrTm93O1xuICBjbG9ja05vdyA9IGZuO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGNsb2NrTm93ID0gcHJldmlvdXM7XG4gIH07XG59XG5cbi8qKiBEcm9wIGV2ZXJ5IGNhY2hlZCBlbnRyeSDigJQgcHJpbWFyaWx5IGZvciB0ZXN0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGVhclJlbW90ZVNoYUNhY2hlKCk6IHZvaWQge1xuICBjYWNoZS5jbGVhcigpO1xufVxuXG4vKipcbiAqIERyb3AgdGhlIGNhY2hlIGVudHJ5IGZvciBhIHNpbmdsZSBgKHJlcG9QYXRoLCBkZWZhdWx0QnJhbmNoKWAgcGFpci5cbiAqIENhbGwgdGhpcyB3aGVuIHRoZSBkZWZhdWx0IGJyYW5jaCBpcyBkZXRlY3RlZCB0byBoYXZlIG1vdmVkIChlLmcuLFxuICogdGhlIHJlcG8gd2FzIHJlbmFtZWQpIHNvIHRoZSBuZXh0IGNoZWNrIHJlZmV0Y2hlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGludmFsaWRhdGVSZW1vdGVTaGFDYWNoZShcbiAgcmVwb1BhdGg6IHN0cmluZyxcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGNhY2hlLmRlbGV0ZShjYWNoZUtleShyZXBvUGF0aCwgZGVmYXVsdEJyYW5jaCkpO1xufVxuXG4vKiogUmVzdWx0IG9mIGEgc2luZ2xlIGxzLXJlbW90ZSBsb29rdXAuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlbW90ZVNoYUxvb2t1cCB7XG4gIC8qKiBUaGUgcmVtb3RlIHRpcCBTSEEsIG9yIGBudWxsYCBpZiBgbHMtcmVtb3RlYCBmYWlsZWQuICovXG4gIHNoYTogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIGBjYWNoZWAgaWYgc2VydmVkIGZyb20gbWVtb3J5LCBgZnJlc2hgIGlmIGEgbmV0d29yayBjYWxsIHJhbi4gKi9cbiAgc291cmNlOiBcImNhY2hlXCIgfCBcImZyZXNoXCI7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBkZXRhaWwgZm9yIHRlbGVtZXRyeSBvbiBmYWlsdXJlLiAqL1xuICBkZXRhaWw/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogTG9vayB1cCB0aGUgcmVtb3RlIHRpcCBTSEEgZm9yIGByZWZzL2hlYWRzLzxkZWZhdWx0QnJhbmNoPmAgb24gYG9yaWdpbmAsXG4gKiBjYWNoaW5nIHRoZSBhbnN3ZXIgZm9yIGB0dGxNc2AgKGRlZmF1bHQgNjAgcykuXG4gKlxuICogT24gYGxzLXJlbW90ZWAgZmFpbHVyZSB0aGUgZnVuY3Rpb24gcmV0dXJucyBgeyBzaGE6IG51bGwsIC4uLiB9YCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gZmFsbCBiYWNrIHRvIGEgZnVsbCBmZXRjaC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFJlbW90ZUhlYWRTaGEoXG4gIHJlcG9QYXRoOiBzdHJpbmcsXG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZyxcbiAgb3B0aW9uczogeyB0dGxNcz86IG51bWJlciB9ID0ge30sXG4pOiBQcm9taXNlPFJlbW90ZVNoYUxvb2t1cD4ge1xuICBjb25zdCB0dGxNcyA9IG9wdGlvbnMudHRsTXMgPz8gUkVNT1RFX1NIQV9DQUNIRV9UVExfTVM7XG4gIGNvbnN0IGtleSA9IGNhY2hlS2V5KHJlcG9QYXRoLCBkZWZhdWx0QnJhbmNoKTtcbiAgY29uc3Qgbm93ID0gY2xvY2tOb3coKTtcblxuICBjb25zdCBoaXQgPSBjYWNoZS5nZXQoa2V5KTtcbiAgaWYgKGhpdCAmJiBub3cgLSBoaXQuZmV0Y2hlZEF0IDwgdHRsTXMpIHtcbiAgICByZXR1cm4geyBzaGE6IGhpdC5zaGEsIHNvdXJjZTogXCJjYWNoZVwiIH07XG4gIH1cblxuICBjb25zdCBnaXRPcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHsgY3dkOiByZXBvUGF0aCB9O1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcImxzLXJlbW90ZVwiLCBcIm9yaWdpblwiLCBgcmVmcy9oZWFkcy8ke2RlZmF1bHRCcmFuY2h9YF0sXG4gICAgZ2l0T3B0aW9ucyxcbiAgKTtcblxuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIHJldHVybiB7IHNoYTogbnVsbCwgc291cmNlOiBcImZyZXNoXCIsIGRldGFpbDogcmVzdWx0LmVycm9yLm1lc3NhZ2UgfTtcbiAgfVxuICBjb25zdCB7IGNvZGUsIHN0ZG91dCwgc3RkZXJyIH0gPSByZXN1bHQudmFsdWU7XG4gIGlmIChjb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNoYTogbnVsbCxcbiAgICAgIHNvdXJjZTogXCJmcmVzaFwiLFxuICAgICAgZGV0YWlsOiBzdGRlcnIudHJpbSgpIHx8IGBscy1yZW1vdGUgZXhpdCAke2NvZGV9YCxcbiAgICB9O1xuICB9XG5cbiAgLy8gT3V0cHV0IGZvcm1hdDogXCI8c2hhPlxcdHJlZnMvaGVhZHMvPGJyYW5jaD5cXG5cIi4gQW4gZW1wdHkgc3Rkb3V0IG1lYW5zXG4gIC8vIHRoZSBicmFuY2ggZG9lcyBub3QgZXhpc3Qgb24gdGhlIHJlbW90ZSDigJQgdHJlYXQgYXMgXCJub3QgdXAgdG8gZGF0ZVwiIHNvXG4gIC8vIHRoZSBjYWxsZXIgZmFsbHMgYmFjayB0byBmZXRjaCBhbmQgc3VyZmFjZXMgYSBzZW5zaWJsZSBlcnJvci5cbiAgY29uc3QgZmlyc3RMaW5lID0gc3Rkb3V0LnNwbGl0KFwiXFxuXCIpWzBdPy50cmltKCkgPz8gXCJcIjtcbiAgY29uc3Qgc2hhID0gZmlyc3RMaW5lLnNwbGl0KC9cXHMrLylbMF0gPz8gXCJcIjtcbiAgaWYgKCEvXlswLTlhLWZdezQwfSQvaS50ZXN0KHNoYSkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hhOiBudWxsLFxuICAgICAgc291cmNlOiBcImZyZXNoXCIsXG4gICAgICBkZXRhaWw6IGBscy1yZW1vdGUgcmV0dXJuZWQgbm8gU0hBIGZvciByZWZzL2hlYWRzLyR7ZGVmYXVsdEJyYW5jaH1gLFxuICAgIH07XG4gIH1cblxuICBjYWNoZS5zZXQoa2V5LCB7IHNoYSwgZmV0Y2hlZEF0OiBub3cgfSk7XG4gIHJldHVybiB7IHNoYSwgc291cmNlOiBcImZyZXNoXCIgfTtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBsb2NhbCBjYWNoZWQgcmVtb3RlLXRyYWNraW5nIFNIQSBmb3IgYG9yaWdpbi88ZGVmYXVsdEJyYW5jaD5gXG4gKiB2aWEgYGdpdCByZXYtcGFyc2VgLiBSZXR1cm5zIGBudWxsYCBpZiB0aGUgcmVmIGRvZXMgbm90IGV4aXN0IGxvY2FsbHlcbiAqIChlLmcuLCB0aGUgY2xvbmUgaGFzIG5vdCBzZWVuIHRoaXMgYnJhbmNoIHlldCkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRMb2NhbFJlbW90ZVRyYWNraW5nU2hhKFxuICByZXBvUGF0aDogc3RyaW5nLFxuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLXZlcmlmeVwiLCBcIi0tcXVpZXRcIiwgYG9yaWdpbi8ke2RlZmF1bHRCcmFuY2h9YF0sXG4gICAgeyBjd2Q6IHJlcG9QYXRoIH0sXG4gICk7XG4gIGlmICghcmVzdWx0Lm9rKSByZXR1cm4gbnVsbDtcbiAgaWYgKHJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc2hhID0gcmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCk7XG4gIHJldHVybiAvXlswLTlhLWZdezQwfSQvaS50ZXN0KHNoYSkgPyBzaGEgOiBudWxsO1xufVxuXG4vKiogT3V0Y29tZSBvZiBhIGZhc3QtcGF0aCBmcmVzaG5lc3MgY2hlY2suICovXG5leHBvcnQgaW50ZXJmYWNlIFVwVG9EYXRlQ2hlY2sge1xuICAvKiogVHJ1ZSB3aGVuIHRoZSBsb2NhbCByZW1vdGUtdHJhY2tpbmcgcmVmIGFscmVhZHkgbWF0Y2hlcyB0aGUgcmVtb3RlIHRpcC4gKi9cbiAgdXBUb0RhdGU6IGJvb2xlYW47XG4gIC8qKiBSZW1vdGUgU0hBLCBvciBgbnVsbGAgaWYgYGxzLXJlbW90ZWAgZmFpbGVkLiAqL1xuICByZW1vdGVTaGE6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBMb2NhbCBjYWNoZWQgU0hBIGZyb20gYG9yaWdpbi88ZGVmYXVsdEJyYW5jaD5gLCBvciBgbnVsbGAgaWYgbWlzc2luZy4gKi9cbiAgbG9jYWxTaGE6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBgY2FjaGVgIGlmIHRoZSByZW1vdGUgU0hBIGNhbWUgZnJvbSB0aGUgaW4tbWVtb3J5IGNhY2hlLCBgZnJlc2hgIG90aGVyd2lzZS4gKi9cbiAgcmVtb3RlU2hhU291cmNlOiBcImNhY2hlXCIgfCBcImZyZXNoXCI7XG4gIC8qKiBUZWxlbWV0cnkgbWVzc2FnZSBkZXNjcmliaW5nIHRoZSBvdXRjb21lLiAqL1xuICByZWFzb246IHN0cmluZztcbn1cblxuLyoqXG4gKiBDb21wYXJlIGxvY2FsIGBvcmlnaW4vPGRlZmF1bHRCcmFuY2g+YCB3aXRoIHRoZSByZW1vdGUgdGlwIGFuZCBkZWNpZGVcbiAqIHdoZXRoZXIgYHNldHVwUmVwb2AgY2FuIHNraXAgYGdpdCBmZXRjaCBvcmlnaW5gLlxuICpcbiAqIFRoZSBmdW5jdGlvbiBuZXZlciB0aHJvd3MuIE9uIGFueSBmYWlsdXJlIGl0IHJldHVybnMgYHVwVG9EYXRlOiBmYWxzZWBcbiAqIHdpdGggYSBwb3B1bGF0ZWQgYHJlYXNvbmAgc28gdGhlIGNhbGxlciBjYW4gZmFsbCBiYWNrIHRvIGEgZnVsbCBmZXRjaFxuICogYW5kIGVtaXQgdXNlZnVsIHRlbGVtZXRyeS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGlzTG9jYWxEZWZhdWx0QnJhbmNoVXBUb0RhdGUoXG4gIHJlcG9QYXRoOiBzdHJpbmcsXG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZyxcbiAgb3B0aW9uczogeyB0dGxNcz86IG51bWJlciB9ID0ge30sXG4pOiBQcm9taXNlPFVwVG9EYXRlQ2hlY2s+IHtcbiAgY29uc3QgcmVtb3RlID0gYXdhaXQgZ2V0UmVtb3RlSGVhZFNoYShyZXBvUGF0aCwgZGVmYXVsdEJyYW5jaCwgb3B0aW9ucyk7XG4gIGlmIChyZW1vdGUuc2hhID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHVwVG9EYXRlOiBmYWxzZSxcbiAgICAgIHJlbW90ZVNoYTogbnVsbCxcbiAgICAgIGxvY2FsU2hhOiBudWxsLFxuICAgICAgcmVtb3RlU2hhU291cmNlOiByZW1vdGUuc291cmNlLFxuICAgICAgcmVhc29uOiBgbHMtcmVtb3RlIHVuYXZhaWxhYmxlOiAke3JlbW90ZS5kZXRhaWwgPz8gXCJ1bmtub3duXCJ9YCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgbG9jYWxTaGEgPSBhd2FpdCBnZXRMb2NhbFJlbW90ZVRyYWNraW5nU2hhKHJlcG9QYXRoLCBkZWZhdWx0QnJhbmNoKTtcbiAgaWYgKGxvY2FsU2hhID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHVwVG9EYXRlOiBmYWxzZSxcbiAgICAgIHJlbW90ZVNoYTogcmVtb3RlLnNoYSxcbiAgICAgIGxvY2FsU2hhOiBudWxsLFxuICAgICAgcmVtb3RlU2hhU291cmNlOiByZW1vdGUuc291cmNlLFxuICAgICAgcmVhc29uOiBgbm8gbG9jYWwgb3JpZ2luLyR7ZGVmYXVsdEJyYW5jaH0gcmVmYCxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGxvY2FsU2hhID09PSByZW1vdGUuc2hhKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHVwVG9EYXRlOiB0cnVlLFxuICAgICAgcmVtb3RlU2hhOiByZW1vdGUuc2hhLFxuICAgICAgbG9jYWxTaGEsXG4gICAgICByZW1vdGVTaGFTb3VyY2U6IHJlbW90ZS5zb3VyY2UsXG4gICAgICByZWFzb246IGBsb2NhbCBtYXRjaGVzIHJlbW90ZSBAICR7cmVtb3RlLnNoYS5zbGljZSgwLCA3KX1gLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHVwVG9EYXRlOiBmYWxzZSxcbiAgICByZW1vdGVTaGE6IHJlbW90ZS5zaGEsXG4gICAgbG9jYWxTaGEsXG4gICAgcmVtb3RlU2hhU291cmNlOiByZW1vdGUuc291cmNlLFxuICAgIHJlYXNvbjogYGxvY2FsICR7bG9jYWxTaGEuc2xpY2UoMCwgNyl9ICE9IHJlbW90ZSAke3JlbW90ZS5zaGEuc2xpY2UoMCwgNyl9YCxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBcUJDLEdBRUQsU0FBUyxhQUFhLFFBQVEsbUJBQW1CO0FBR2pELHlFQUF5RSxHQUN6RSxPQUFPLE1BQU0sMEJBQTBCLE9BQU87QUFROUM7OztDQUdDLEdBQ0QsTUFBTSxRQUFRLElBQUk7QUFFbEIsMERBQTBELEdBQzFELFNBQVMsU0FBUyxRQUFnQixFQUFFLGFBQXFCO0VBQ3ZELE9BQU8sR0FBRyxTQUFT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
// denoCacheMetadata=11949166403543245300,11659935630688981544