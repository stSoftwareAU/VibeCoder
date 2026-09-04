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

import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** Read an env var through `lookup`, tolerating a denied `--allow-env`. */
function env(
  name: string,
  lookup: EnvLookup = processEnvLookup,
): string | undefined {
  try {
    return lookup(name) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where to look for the work volume root (Issue #960).
 *
 * Both fields exist so a test can name the directory instead of exporting
 * `WORK_DIR` into the process, which races every other test in the run and
 * is what keeps the gate's `deno test` stage serial (Issue #880, plan #944).
 * Production passes neither and reads the process environment exactly as
 * before.
 */
export interface WorkerCacheDirOptions {
  /** The work volume root. Wins over any `WORK_DIR` in the environment. */
  workDir?: string;
  /** Environment lookup; defaults to the real process environment. */
  env?: EnvLookup;
}

/**
 * The worker cache directory: `${WORK_DIR}/.vibe-cache`, or `undefined`
 * when `WORK_DIR` is unset (Issue #131).
 *
 * `WORK_DIR` is only exported by the run driver (`run_worker.ts`,
 * Issue #4370), so any other entry point — setup, launcher, housekeeping,
 * a dev run — has no cache directory at all. There is deliberately NO
 * fallback path (not `$HOME/auto-issue-work`, not XDG, not temp): the old
 * HOME-derived default silently created a stray `~/auto-issue-work` on the
 * host (Issue #118).
 */
export function workerCacheDir(
  options: WorkerCacheDirOptions = {},
): string | undefined {
  const workDir = options.workDir ?? env("WORK_DIR", options.env);
  return workDir ? `${workDir}/.vibe-cache` : undefined;
}

/**
 * Path of a named cache file in the worker cache directory, or `undefined`
 * when there is no cache directory (`WORK_DIR` unset — Issue #131).
 */
export function workerCachePath(fileName: string): string | undefined {
  const dir = workerCacheDir();
  return dir ? `${dir}/${fileName}` : undefined;
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
    if (path === undefined) continue; // no cache dir when WORK_DIR is unset
    try {
      return await Deno.readTextFile(path);
    } catch {
      // try the next
    }
  }
  return null;
}
