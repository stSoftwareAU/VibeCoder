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

/** The worker cache directory: `${WORK_DIR}/.vibe-cache`. */
export function workerCacheDir(): string {
  const workDir = env("WORK_DIR") ??
    `${env("HOME") ?? env("USERPROFILE") ?? "."}/auto-issue-work`;
  return `${workDir}/.vibe-cache`;
}

/** Path of a named cache file in the worker cache directory. */
export function workerCachePath(fileName: string): string {
  return `${workerCacheDir()}/${fileName}`;
}

/**
 * The pre-#4318 location of a cache file, `$HOME/.vibe-coder/<file>` —
 * consulted read-only when the new file does not exist yet.
 */
export function legacyHomeCachePath(fileName: string): string {
  return `${env("HOME") ?? "."}/.vibe-coder/${fileName}`;
}

/**
 * Read a cache file's text, preferring the new location and falling back
 * to the legacy HOME location. Returns null when neither exists.
 */
export async function readCacheWithLegacyFallback(
  fileName: string,
): Promise<string | null> {
  for (
    const path of [workerCachePath(fileName), legacyHomeCachePath(fileName)]
  ) {
    try {
      return await Deno.readTextFile(path);
    } catch {
      // try the next
    }
  }
  return null;
}
