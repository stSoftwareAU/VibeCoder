/**
 * Where the worker's small persistent caches live (Issue #4318).
 *
 * `baseline_quality_cache.ts` and `default_branch_cache.ts` used to write
 * under `$HOME/.vibe-coder/`. In container mode the runtime creates
 * `~/.vibe-coder` ROOT-owned as the parent of the read-only run-config and
 * credentials mount targets, so the worker (uid 1000) could never create a
 * file beside them: every issue logged "Baseline quality cache write failed
 * (Permission denied)" and re-ran its baseline gate — minutes of cargo on
 * the Rust repos — because a cache that never persists caches nothing.
 *
 * The caches now live on the durable work volume, `${WORK_DIR}/.vibe-cache`,
 * which is worker-owned in every mode and survives container replacement.
 * The legacy HOME location is still READ when the new file is absent, so a
 * native host keeps its warm cache across the move.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Read an env var, tolerating a denied `--allow-env`. */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The two directories every cache path in this module is derived from
 * (Issue #966).
 *
 * Both are paths, so they are taken as plain directory parameters rather
 * than as an environment lookup: the caller says where the caches live and
 * the variable name disappears from the call site. `undefined`/empty
 * `workDir` means "there is no cache directory", which is exactly what an
 * unset `WORK_DIR` has always meant (Issue #131).
 */
export interface CacheRoots {
  /** Durable work volume root — the `WORK_DIR` the run driver exports. */
  workDir?: string;
  /** Home directory backing the legacy read-only fallback. */
  home?: string;
}

/**
 * The roots as the process environment reports them — the production
 * default for every function below, so passing nothing behaves exactly as
 * reading `Deno.env.get` here did.
 */
export function processCacheRoots(): CacheRoots {
  return { workDir: env("WORK_DIR"), home: env("HOME") };
}

/**
 * The worker cache directory: `${workDir}/.vibe-cache`, or `undefined`
 * when there is no work directory (Issue #131).
 *
 * `WORK_DIR` is only exported by the run driver (`run_worker.ts`,
 * Issue #4370), so any other entry point — setup, launcher, housekeeping,
 * a dev run — has no cache directory at all. There is deliberately NO
 * fallback path (not `$HOME/auto-issue-work`, not XDG, not temp): the old
 * HOME-derived default silently created a stray `~/auto-issue-work` on the
 * host (Issue #118).
 */
export function workerCacheDir(
  roots: CacheRoots = processCacheRoots(),
): string | undefined {
  const workDir = roots.workDir;
  return workDir ? `${workDir}/.vibe-cache` : undefined;
}

/**
 * Path of a named cache file in the worker cache directory, or `undefined`
 * when there is no cache directory (no work directory — Issue #131).
 */
export function workerCachePath(
  fileName: string,
  roots: CacheRoots = processCacheRoots(),
): string | undefined {
  const dir = workerCacheDir(roots);
  return dir ? `${dir}/${fileName}` : undefined;
}

/**
 * The pre-#4318 location of a cache file, `$HOME/.vibe-coder/<file>` —
 * consulted read-only when the new file does not exist yet.
 */
export function legacyHomeCachePath(
  fileName: string,
  roots: CacheRoots = processCacheRoots(),
): string {
  return `${roots.home || "."}/.vibe-coder/${fileName}`;
}

/**
 * Read a cache file's text, preferring the new location and falling back
 * to the legacy HOME location. Returns null when neither exists.
 */
export async function readCacheWithLegacyFallback(
  fileName: string,
  roots: CacheRoots = processCacheRoots(),
): Promise<string | null> {
  for (
    const path of [
      workerCachePath(fileName, roots),
      legacyHomeCachePath(fileName, roots),
    ]
  ) {
    if (path === undefined) continue; // no cache dir when WORK_DIR is unset
    try {
      return await Deno.readTextFile(path);
    } catch {
      // try the next
    }
  }
  return null;
}
