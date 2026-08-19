/**
 * Deepen-on-demand helper for shallow clones (Issue #1502).
 *
 * When the worker clones repositories with `--depth 1` (see #1500, #1503),
 * operations that require full ancestry — commit-range `git log`,
 * `rev-list --count`, `git merge`, `git rebase` — will fail because the
 * common ancestor of the two refs is missing.
 *
 * This module provides two helpers:
 *
 *   - `isShallowRepo()` — detects whether the current repo is a shallow
 *     clone via `git rev-parse --is-shallow-repository`.
 *   - `ensureHistoryDepth(refs, options)` — if the repo is shallow and the
 *     given refs lack a common ancestor, fetches additional history in
 *     doubling steps (50, 100, 200, ...) up to a configurable maximum,
 *     then falls back to `git fetch --unshallow` as a last resort.
 *
 * On a non-shallow clone `ensureHistoryDepth` is a no-op — it does not
 * run any `fetch` subprocess.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { runGitCommand as defaultRunGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions, GitCommandOutput } from "./git_timeout.ts";

/** Initial deepen step size (commits). */
export const INITIAL_DEEPEN_STEP = 50;

/** Default maximum cumulative deepen before falling back to --unshallow. */
export const DEFAULT_MAX_DEEPEN = 6400;

/**
 * Signature of a git runner function. Matches `runGitCommand` in
 * `git_timeout.ts`; accepted as an option to make this module testable
 * without spawning real git subprocesses.
 */
export type GitRunner = (
  args: string[],
  options?: GitCommandOptions,
) => Promise<Result<GitCommandOutput>>;

/** Options for `ensureHistoryDepth`. */
export interface EnsureHistoryDepthOptions extends GitCommandOptions {
  /** Initial deepen step, default 50. */
  initialStep?: number;
  /** Maximum cumulative deepen before --unshallow, default 6400. */
  maxDeepen?: number;
  /** Remote name to deepen from, default "origin". */
  remote?: string;
  /** Custom git runner (tests only). */
  gitRunner?: GitRunner;
}

/** Options for `isShallowRepo`. */
export interface IsShallowOptions extends GitCommandOptions {
  /** Custom git runner (tests only). */
  gitRunner?: GitRunner;
}

/**
 * Check whether the current repository is a shallow clone.
 *
 * Uses `git rev-parse --is-shallow-repository` which reports `true` when
 * a `.git/shallow` file exists. Available in Git 2.15+.
 *
 * @returns Result containing `true` if shallow, `false` if full.
 */
export async function isShallowRepo(
  options: IsShallowOptions = {},
): Promise<Result<boolean, Error>> {
  const runner = options.gitRunner ?? defaultRunGitCommand;
  const result = await runner(
    ["rev-parse", "--is-shallow-repository"],
    stripInternalOptions(options),
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  if (result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git rev-parse --is-shallow-repository failed (exit ${result.value.code}): ${result.value.stderr.trim()}`,
      ),
    };
  }

  return { ok: true, value: result.value.stdout.trim() === "true" };
}

/**
 * Ensure the repository has enough history for the given refs to share a
 * common ancestor.
 *
 * Behaviour:
 *   1. If the repo is not shallow, returns ok immediately without running
 *      any fetch subprocess.
 *   2. If the refs already share a common ancestor, returns ok.
 *   3. Otherwise fetches additional history via `git fetch --deepen=<N>`
 *      with `N` starting at `initialStep` (default 50) and doubling each
 *      round, stopping when either the common ancestor is present or the
 *      cumulative deepen reaches `maxDeepen` (default 6400).
 *   4. As a last resort, runs `git fetch --unshallow`. If that still does
 *      not produce a common ancestor, returns an error.
 *
 * The common ancestor is detected via `git merge-base` across all
 * supplied refs.
 *
 * @param refs Two or more refs (e.g. ["main", "HEAD"]) that must share a
 *   common ancestor for the caller's operation to succeed.
 * @param options Deepen behaviour plus standard git options.
 * @returns Result<void> — ok on success, error when the ancestor cannot
 *   be produced even after --unshallow.
 */
export async function ensureHistoryDepth(
  refs: string[],
  options: EnsureHistoryDepthOptions = {},
): Promise<Result<void, Error>> {
  if (refs.length < 2) {
    // Nothing to anchor against — no deepening needed.
    return { ok: true, value: undefined };
  }

  const runner = options.gitRunner ?? defaultRunGitCommand;
  const gitOptions = stripInternalOptions(options);
  const remote = options.remote ?? "origin";
  const initialStep = Math.max(1, options.initialStep ?? INITIAL_DEEPEN_STEP);
  const maxDeepen = Math.max(
    initialStep,
    options.maxDeepen ?? DEFAULT_MAX_DEEPEN,
  );

  // Fast path — non-shallow clones need no work.
  const shallow = await isShallowRepo({ ...options });
  if (!shallow.ok) {
    return { ok: false, error: shallow.error };
  }
  if (!shallow.value) {
    return { ok: true, value: undefined };
  }

  // Already have the ancestor? Done.
  if (await hasCommonAncestor(runner, refs, gitOptions)) {
    return { ok: true, value: undefined };
  }

  // Deepen in doubling steps until the ancestor appears or we hit maxDeepen.
  let step = initialStep;
  let total = 0;
  while (total < maxDeepen) {
    const thisStep = Math.min(step, maxDeepen - total);
    const fetchResult = await runner(
      ["fetch", `--deepen=${thisStep}`, remote],
      gitOptions,
    );
    total += thisStep;

    // A failed deepen is non-fatal — break to the --unshallow fallback.
    if (!fetchResult.ok || fetchResult.value.code !== 0) {
      break;
    }

    if (await hasCommonAncestor(runner, refs, gitOptions)) {
      return { ok: true, value: undefined };
    }

    step = step * 2;
  }

  // Fallback: fully unshallow.
  const unshallowResult = await runner(
    ["fetch", "--unshallow", remote],
    gitOptions,
  );
  if (!unshallowResult.ok || unshallowResult.value.code !== 0) {
    // Git refuses --unshallow on a complete repo with a non-zero exit — if
    // the repo is now full and the ancestor exists, treat this as success.
    const stillShallow = await isShallowRepo({ ...options });
    if (
      stillShallow.ok && !stillShallow.value &&
      await hasCommonAncestor(runner, refs, gitOptions)
    ) {
      return { ok: true, value: undefined };
    }
    const errMsg = unshallowResult.ok
      ? unshallowResult.value.stderr.trim()
      : unshallowResult.error.message;
    return {
      ok: false,
      error: new Error(
        `Failed to deepen repo to find common ancestor of [${
          refs.join(", ")
        }]: ${errMsg}`,
      ),
    };
  }

  if (await hasCommonAncestor(runner, refs, gitOptions)) {
    return { ok: true, value: undefined };
  }

  return {
    ok: false,
    error: new Error(
      `Could not find common ancestor of [${
        refs.join(", ")
      }] after git fetch --unshallow`,
    ),
  };
}

/**
 * Return true when `git merge-base` produces a commit for the supplied refs.
 */
async function hasCommonAncestor(
  runner: GitRunner,
  refs: string[],
  options: GitCommandOptions,
): Promise<boolean> {
  const result = await runner(["merge-base", ...refs], options);
  if (!result.ok) return false;
  if (result.value.code !== 0) return false;
  return result.value.stdout.trim().length > 0;
}

/**
 * Remove options fields that belong to this module and must not be
 * forwarded to `runGitCommand`.
 */
function stripInternalOptions(
  options: EnsureHistoryDepthOptions | IsShallowOptions,
): GitCommandOptions {
  const { cwd, timeoutSeconds, env } = options;
  const result: GitCommandOptions = {};
  if (cwd !== undefined) result.cwd = cwd;
  if (timeoutSeconds !== undefined) result.timeoutSeconds = timeoutSeconds;
  if (env !== undefined) result.env = env;
  return result;
}
