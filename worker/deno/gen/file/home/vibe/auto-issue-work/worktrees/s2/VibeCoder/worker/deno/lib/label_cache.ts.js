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
 */ import { atomicWrite } from "./file_utils.ts";
import { defaultLogger } from "./logger.ts";
import { ensureStateDir, sharedTmpStateDir } from "./private_cache_dir.ts";
/**
 * Default per-account directory holding the label caches.
 *
 * @param lookup - Environment reader, injectable for tests.
 */ export function defaultLabelCacheDir(lookup) {
  return lookup === undefined ? sharedTmpStateDir("vibe-label-cache") : sharedTmpStateDir("vibe-label-cache", lookup);
}
/**
 * Create the cache directory and report whether it may be used.
 *
 * A shared-tmp directory another account owns (or left group/other
 * writable) is refused: the cache is skipped for the rest of the call and
 * the labels come from `gh` instead. The refusal is logged, never swallowed.
 */ async function cacheDirUsable(cacheDir) {
  const trust = await ensureStateDir(cacheDir);
  if (!trust.trusted) {
    defaultLogger.warn("Label cache directory is not worker-private — cache disabled " + "(Issue #1242)", {
      cacheDir,
      reason: trust.reason ?? "unknown"
    });
  }
  return trust.trusted;
}
/**
 * Generate the cache file path for a given repo.
 */ export function labelCacheFilePath(cacheDir, repo) {
  const repoKey = repo.replace("/", "_");
  return `${cacheDir}/${repoKey}.cache`;
}
/**
 * Check whether the label cache for a repo is still valid.
 */ export async function labelCacheIsValid(cacheDir, repo, ttlSeconds) {
  const cachePath = labelCacheFilePath(cacheDir, repo);
  try {
    const content = await Deno.readTextFile(cachePath);
    const firstLine = content.split("\n")[0] ?? "";
    const cachedTime = parseInt(firstLine, 10);
    if (isNaN(cachedTime)) return false;
    const now = Math.floor(Date.now() / 1000);
    return now - cachedTime <= ttlSeconds;
  } catch  {
    return false;
  }
}
/**
 * Refresh the label cache by fetching from GitHub.
 *
 * @param writeCache - False when the directory is not worker-private: the
 *   labels are still fetched, but nothing is written to (or read from) a
 *   directory another account could control.
 */ async function labelCacheRefresh(cacheDir, repo, ghCommandFn, writeCache) {
  let labels;
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
      ".[].name"
    ]);
  } catch  {
    return {
      ok: false,
      error: new Error(`Failed to fetch labels from GitHub for ${repo}`)
    };
  }
  const labelList = labels.trim().split("\n").filter((l)=>l.length > 0);
  if (!writeCache) return {
    ok: true,
    value: labelList
  };
  const now = Math.floor(Date.now() / 1000);
  const cacheContent = `${now}\n${labelList.join("\n")}`;
  const cachePath = labelCacheFilePath(cacheDir, repo);
  const writeResult = await atomicWrite({
    targetFile: cachePath,
    content: cacheContent
  });
  if (!writeResult.ok) {
    // Non-fatal — the labels were fetched, only the cache write failed. Say
    // so rather than swallowing it (never fail silently).
    console.warn(`[label-cache] Failed to cache labels for ${repo}: ${writeResult.error.message}`);
  }
  return {
    ok: true,
    value: labelList
  };
}
/**
 * Invalidate the label cache for a repo.
 */ export async function labelCacheInvalidate(cacheDir, repo) {
  const cachePath = labelCacheFilePath(cacheDir, repo);
  try {
    await Deno.remove(cachePath);
  } catch  {
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
 */ export async function getCachedLabels(cacheDir, repo, ttlSeconds, ghCommandFn) {
  const usable = await cacheDirUsable(cacheDir);
  if (!usable) {
    return await labelCacheRefresh(cacheDir, repo, ghCommandFn, false);
  }
  if (await labelCacheIsValid(cacheDir, repo, ttlSeconds)) {
    const cachePath = labelCacheFilePath(cacheDir, repo);
    try {
      const content = await Deno.readTextFile(cachePath);
      const lines = content.split("\n").slice(1).filter((l)=>l.length > 0);
      return {
        ok: true,
        value: lines
      };
    } catch  {
    // Fall through to refresh
    }
  }
  return await labelCacheRefresh(cacheDir, repo, ghCommandFn, true);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9sYWJlbF9jYWNoZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIExhYmVsIGNhY2hlIGZvciB0aGUgVmliZSBDb2RlciB3b3JrZXIgKElzc3VlICMzMzMpLlxuICpcbiAqIENhY2hlcyBHaXRIdWIgbGFiZWwgbGlzdHMgcGVyLXJlcG9zaXRvcnkgb24gZGlzayB0byBhdm9pZCByZXBlYXRlZFxuICogYGdoIGxhYmVsIGxpc3RgIGNhbGxzLiBUaGUgY2FjaGUgaXMgZmlsZS1iYWNrZWQgd2l0aCBhIGZpcnN0LWxpbmVcbiAqIHRpbWVzdGFtcCBmb3IgVFRMIHZhbGlkYXRpb24uXG4gKlxuICogSXNzdWUgIzEyNDIgKFNFQy0xMjE1LTA2KTogdGhlIGRlZmF1bHQgZGlyZWN0b3J5IHVzZWQgdG8gYmUgdGhlIGZpeGVkXG4gKiBgJHtUTVBESVJ9L3ZpYmUtbGFiZWwtY2FjaGVgIOKAlCB0aGUgc2FtZSBwYXRoIGZvciBldmVyeSBhY2NvdW50IG9uIHRoZSBob3N0LFxuICogc28gYW55IGxvY2FsIHVzZXIgY291bGQgY3JlYXRlIGl0IGZpcnN0IGFuZCBkcm9wIGluIGEgYG93bmVyX3JlcG8uY2FjaGVgXG4gKiBuYW1pbmcgbGFiZWxzIHRoYXQgZG8gbm90IGV4aXN0LiBgZW5zdXJlTGFiZWxFeGlzdHNgIHRoZW4gc2tpcHBlZCB0aGUgcmVhbFxuICogYGdoIGxhYmVsIGNyZWF0ZWAuIFRoZSBkaXJlY3RvcnkgaXMgbm93IHBlci1hY2NvdW50XG4gKiAoe0BsaW5rIGRlZmF1bHRMYWJlbENhY2hlRGlyfSksIGNyZWF0ZWQgYDA3MDBgLCBhbmQgYSBkaXJlY3RvcnkgYW5vdGhlclxuICogYWNjb3VudCBjb3VsZCBoYXZlIHdyaXR0ZW4gdG8gZGlzYWJsZXMgdGhlIGNhY2hlIGVudGlyZWx5IHJhdGhlciB0aGFuXG4gKiBiZWluZyByZWFkIGJhY2suXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IGF0b21pY1dyaXRlIH0gZnJvbSBcIi4vZmlsZV91dGlscy50c1wiO1xuaW1wb3J0IHsgZGVmYXVsdExvZ2dlciB9IGZyb20gXCIuL2xvZ2dlci50c1wiO1xuaW1wb3J0IHsgZW5zdXJlU3RhdGVEaXIsIHNoYXJlZFRtcFN0YXRlRGlyIH0gZnJvbSBcIi4vcHJpdmF0ZV9jYWNoZV9kaXIudHNcIjtcblxuLyoqXG4gKiBEZWZhdWx0IHBlci1hY2NvdW50IGRpcmVjdG9yeSBob2xkaW5nIHRoZSBsYWJlbCBjYWNoZXMuXG4gKlxuICogQHBhcmFtIGxvb2t1cCAtIEVudmlyb25tZW50IHJlYWRlciwgaW5qZWN0YWJsZSBmb3IgdGVzdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0TGFiZWxDYWNoZURpcihcbiAgbG9va3VwPzogKGtleTogc3RyaW5nKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gbG9va3VwID09PSB1bmRlZmluZWRcbiAgICA/IHNoYXJlZFRtcFN0YXRlRGlyKFwidmliZS1sYWJlbC1jYWNoZVwiKVxuICAgIDogc2hhcmVkVG1wU3RhdGVEaXIoXCJ2aWJlLWxhYmVsLWNhY2hlXCIsIGxvb2t1cCk7XG59XG5cbi8qKlxuICogQ3JlYXRlIHRoZSBjYWNoZSBkaXJlY3RvcnkgYW5kIHJlcG9ydCB3aGV0aGVyIGl0IG1heSBiZSB1c2VkLlxuICpcbiAqIEEgc2hhcmVkLXRtcCBkaXJlY3RvcnkgYW5vdGhlciBhY2NvdW50IG93bnMgKG9yIGxlZnQgZ3JvdXAvb3RoZXJcbiAqIHdyaXRhYmxlKSBpcyByZWZ1c2VkOiB0aGUgY2FjaGUgaXMgc2tpcHBlZCBmb3IgdGhlIHJlc3Qgb2YgdGhlIGNhbGwgYW5kXG4gKiB0aGUgbGFiZWxzIGNvbWUgZnJvbSBgZ2hgIGluc3RlYWQuIFRoZSByZWZ1c2FsIGlzIGxvZ2dlZCwgbmV2ZXIgc3dhbGxvd2VkLlxuICovXG5hc3luYyBmdW5jdGlvbiBjYWNoZURpclVzYWJsZShjYWNoZURpcjogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHRydXN0ID0gYXdhaXQgZW5zdXJlU3RhdGVEaXIoY2FjaGVEaXIpO1xuICBpZiAoIXRydXN0LnRydXN0ZWQpIHtcbiAgICBkZWZhdWx0TG9nZ2VyLndhcm4oXG4gICAgICBcIkxhYmVsIGNhY2hlIGRpcmVjdG9yeSBpcyBub3Qgd29ya2VyLXByaXZhdGUg4oCUIGNhY2hlIGRpc2FibGVkIFwiICtcbiAgICAgICAgXCIoSXNzdWUgIzEyNDIpXCIsXG4gICAgICB7IGNhY2hlRGlyLCByZWFzb246IHRydXN0LnJlYXNvbiA/PyBcInVua25vd25cIiB9LFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHRydXN0LnRydXN0ZWQ7XG59XG5cbi8qKlxuICogR2VuZXJhdGUgdGhlIGNhY2hlIGZpbGUgcGF0aCBmb3IgYSBnaXZlbiByZXBvLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGFiZWxDYWNoZUZpbGVQYXRoKGNhY2hlRGlyOiBzdHJpbmcsIHJlcG86IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJlcG9LZXkgPSByZXBvLnJlcGxhY2UoXCIvXCIsIFwiX1wiKTtcbiAgcmV0dXJuIGAke2NhY2hlRGlyfS8ke3JlcG9LZXl9LmNhY2hlYDtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIHRoZSBsYWJlbCBjYWNoZSBmb3IgYSByZXBvIGlzIHN0aWxsIHZhbGlkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGFiZWxDYWNoZUlzVmFsaWQoXG4gIGNhY2hlRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgdHRsU2Vjb25kczogbnVtYmVyLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGNhY2hlUGF0aCA9IGxhYmVsQ2FjaGVGaWxlUGF0aChjYWNoZURpciwgcmVwbyk7XG4gIHRyeSB7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKGNhY2hlUGF0aCk7XG4gICAgY29uc3QgZmlyc3RMaW5lID0gY29udGVudC5zcGxpdChcIlxcblwiKVswXSA/PyBcIlwiO1xuICAgIGNvbnN0IGNhY2hlZFRpbWUgPSBwYXJzZUludChmaXJzdExpbmUsIDEwKTtcbiAgICBpZiAoaXNOYU4oY2FjaGVkVGltZSkpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBub3cgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKTtcbiAgICByZXR1cm4gKG5vdyAtIGNhY2hlZFRpbWUpIDw9IHR0bFNlY29uZHM7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZnJlc2ggdGhlIGxhYmVsIGNhY2hlIGJ5IGZldGNoaW5nIGZyb20gR2l0SHViLlxuICpcbiAqIEBwYXJhbSB3cml0ZUNhY2hlIC0gRmFsc2Ugd2hlbiB0aGUgZGlyZWN0b3J5IGlzIG5vdCB3b3JrZXItcHJpdmF0ZTogdGhlXG4gKiAgIGxhYmVscyBhcmUgc3RpbGwgZmV0Y2hlZCwgYnV0IG5vdGhpbmcgaXMgd3JpdHRlbiB0byAob3IgcmVhZCBmcm9tKSBhXG4gKiAgIGRpcmVjdG9yeSBhbm90aGVyIGFjY291bnQgY291bGQgY29udHJvbC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbGFiZWxDYWNoZVJlZnJlc2goXG4gIGNhY2hlRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICB3cml0ZUNhY2hlOiBib29sZWFuLFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nW10+PiB7XG4gIGxldCBsYWJlbHM6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBsYWJlbHMgPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcImxhYmVsXCIsXG4gICAgICBcImxpc3RcIixcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgLy8gZ2gncyBkZWZhdWx0IHBhZ2UgaXMgMzAgKElzc3VlICM0MzM3KTogYSByZXBvIHdpdGggbW9yZSBsYWJlbHMgbWFkZVxuICAgICAgLy8gZXZlcnkgbGFiZWwgcGFzdCB0aGUgZmlyc3QgcGFnZSBpbnZpc2libGUgdG8gdGhlIGNhY2hlLCBzb1xuICAgICAgLy8gZW5zdXJlTGFiZWxFeGlzdHMgdHJpZWQgdG8gY3JlYXRlIGxhYmVscyB0aGF0IGFscmVhZHkgZXhpc3RlZCBhbmRcbiAgICAgIC8vIHJlcG9ydGVkIGZhaWx1cmUuIFBlci1yZXBvIGxhYmVsIGNvdW50cyBhcmUgc21hbGw7IDUwMCBpcyBhbXBsZS5cbiAgICAgIFwiLS1saW1pdFwiLFxuICAgICAgXCI1MDBcIixcbiAgICAgIFwiLS1qc29uXCIsXG4gICAgICBcIm5hbWVcIixcbiAgICAgIFwiLS1qcVwiLFxuICAgICAgXCIuW10ubmFtZVwiLFxuICAgIF0pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihgRmFpbGVkIHRvIGZldGNoIGxhYmVscyBmcm9tIEdpdEh1YiBmb3IgJHtyZXBvfWApLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBsYWJlbExpc3QgPSBsYWJlbHMudHJpbSgpLnNwbGl0KFwiXFxuXCIpLmZpbHRlcigobCkgPT4gbC5sZW5ndGggPiAwKTtcbiAgaWYgKCF3cml0ZUNhY2hlKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGxhYmVsTGlzdCB9O1xuXG4gIGNvbnN0IG5vdyA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApO1xuICBjb25zdCBjYWNoZUNvbnRlbnQgPSBgJHtub3d9XFxuJHtsYWJlbExpc3Quam9pbihcIlxcblwiKX1gO1xuICBjb25zdCBjYWNoZVBhdGggPSBsYWJlbENhY2hlRmlsZVBhdGgoY2FjaGVEaXIsIHJlcG8pO1xuXG4gIGNvbnN0IHdyaXRlUmVzdWx0ID0gYXdhaXQgYXRvbWljV3JpdGUoe1xuICAgIHRhcmdldEZpbGU6IGNhY2hlUGF0aCxcbiAgICBjb250ZW50OiBjYWNoZUNvbnRlbnQsXG4gIH0pO1xuICBpZiAoIXdyaXRlUmVzdWx0Lm9rKSB7XG4gICAgLy8gTm9uLWZhdGFsIOKAlCB0aGUgbGFiZWxzIHdlcmUgZmV0Y2hlZCwgb25seSB0aGUgY2FjaGUgd3JpdGUgZmFpbGVkLiBTYXlcbiAgICAvLyBzbyByYXRoZXIgdGhhbiBzd2FsbG93aW5nIGl0IChuZXZlciBmYWlsIHNpbGVudGx5KS5cbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW2xhYmVsLWNhY2hlXSBGYWlsZWQgdG8gY2FjaGUgbGFiZWxzIGZvciAke3JlcG99OiAke3dyaXRlUmVzdWx0LmVycm9yLm1lc3NhZ2V9YCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBsYWJlbExpc3QgfTtcbn1cblxuLyoqXG4gKiBJbnZhbGlkYXRlIHRoZSBsYWJlbCBjYWNoZSBmb3IgYSByZXBvLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGFiZWxDYWNoZUludmFsaWRhdGUoXG4gIGNhY2hlRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjYWNoZVBhdGggPSBsYWJlbENhY2hlRmlsZVBhdGgoY2FjaGVEaXIsIHJlcG8pO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKGNhY2hlUGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIEZpbGUgbWF5IG5vdCBleGlzdFxuICB9XG59XG5cbi8qKlxuICogR2V0IGNhY2hlZCBsYWJlbHMsIHJlZnJlc2hpbmcgaWYgbmVlZGVkLlxuICpcbiAqIFRoZSBkaXJlY3RvcnkgaXMgY3JlYXRlZCBhbmQgb3duZXJzaGlwLWNoZWNrZWQgZmlyc3QgKElzc3VlICMxMjQyKS4gQVxuICogZGlyZWN0b3J5IGFub3RoZXIgYWNjb3VudCBjb3VsZCBoYXZlIHdyaXR0ZW4gdG8gaXMgbmV2ZXIgcmVhZCBmcm9tIGFuZFxuICogbmV2ZXIgd3JpdHRlbiB0byDigJQgdGhlIGxhYmVscyBjb21lIHN0cmFpZ2h0IGZyb20gYGdoYCBpbnN0ZWFkLCBzbyBhXG4gKiBwbGFudGVkIGNhY2hlIGZpbGUgY2Fubm90IG1ha2UgYGVuc3VyZUxhYmVsRXhpc3RzYCBza2lwIGEgcmVhbFxuICogYGdoIGxhYmVsIGNyZWF0ZWAuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRDYWNoZWRMYWJlbHMoXG4gIGNhY2hlRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgdHRsU2Vjb25kczogbnVtYmVyLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4sXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmdbXT4+IHtcbiAgY29uc3QgdXNhYmxlID0gYXdhaXQgY2FjaGVEaXJVc2FibGUoY2FjaGVEaXIpO1xuICBpZiAoIXVzYWJsZSkge1xuICAgIHJldHVybiBhd2FpdCBsYWJlbENhY2hlUmVmcmVzaChjYWNoZURpciwgcmVwbywgZ2hDb21tYW5kRm4sIGZhbHNlKTtcbiAgfVxuXG4gIGlmIChhd2FpdCBsYWJlbENhY2hlSXNWYWxpZChjYWNoZURpciwgcmVwbywgdHRsU2Vjb25kcykpIHtcbiAgICBjb25zdCBjYWNoZVBhdGggPSBsYWJlbENhY2hlRmlsZVBhdGgoY2FjaGVEaXIsIHJlcG8pO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoY2FjaGVQYXRoKTtcbiAgICAgIGNvbnN0IGxpbmVzID0gY29udGVudC5zcGxpdChcIlxcblwiKS5zbGljZSgxKS5maWx0ZXIoKGwpID0+IGwubGVuZ3RoID4gMCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGxpbmVzIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBGYWxsIHRocm91Z2ggdG8gcmVmcmVzaFxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBhd2FpdCBsYWJlbENhY2hlUmVmcmVzaChjYWNoZURpciwgcmVwbywgZ2hDb21tYW5kRm4sIHRydWUpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7OztDQWlCQyxHQUdELFNBQVMsV0FBVyxRQUFRLGtCQUFrQjtBQUM5QyxTQUFTLGFBQWEsUUFBUSxjQUFjO0FBQzVDLFNBQVMsY0FBYyxFQUFFLGlCQUFpQixRQUFRLHlCQUF5QjtBQUUzRTs7OztDQUlDLEdBQ0QsT0FBTyxTQUFTLHFCQUNkLE1BQTRDO0VBRTVDLE9BQU8sV0FBVyxZQUNkLGtCQUFrQixzQkFDbEIsa0JBQWtCLG9CQUFvQjtBQUM1QztBQUVBOzs7Ozs7Q0FNQyxHQUNELGVBQWUsZUFBZSxRQUFnQjtFQUM1QyxNQUFNLFFBQVEsTUFBTSxlQUFlO0VBQ25DLElBQUksQ0FBQyxNQUFNLE9BQU8sRUFBRTtJQUNsQixjQUFjLElBQUksQ0FDaEIsa0VBQ0UsaUJBQ0Y7TUFBRTtNQUFVLFFBQVEsTUFBTSxNQUFNLElBQUk7SUFBVTtFQUVsRDtFQUNBLE9BQU8sTUFBTSxPQUFPO0FBQ3RCO0FBRUE7O0NBRUMsR0FDRCxPQUFPLFNBQVMsbUJBQW1CLFFBQWdCLEVBQUUsSUFBWTtFQUMvRCxNQUFNLFVBQVUsS0FBSyxPQUFPLENBQUMsS0FBSztFQUNsQyxPQUFPLEdBQUcsU0FBUyxDQUFDLEVBQUUsUUFBUSxNQUFNLENBQUM7QUFDdkM7QUFFQTs7Q0FFQyxHQUNELE9BQU8sZUFBZSxrQkFDcEIsUUFBZ0IsRUFDaEIsSUFBWSxFQUNaLFVBQWtCO0VBRWxCLE1BQU0sWUFBWSxtQkFBbUIsVUFBVTtFQUMvQyxJQUFJO0lBQ0YsTUFBTSxVQUFVLE1BQU0sS0FBSyxZQUFZLENBQUM7SUFDeEMsTUFBTSxZQUFZLFFBQVEs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
// denoCacheMetadata=11675170942917749254,17046329164861147718