/**
 * Branch HEAD movement tracker (Issue #1861, part of #1855).
 *
 * Captures the current HEAD SHA before a Claude phase runs and reports
 * whether HEAD moved by the end. Processors use this to detect changes
 * that Claude committed-and-pushed itself — the common path that the
 * old `commitAndPushPending`-only check missed, leading to the misleading
 * "could not identify a code change to apply" reply.
 *
 * The module is a thin wrapper over `runGitCommand` from `git_timeout.ts`,
 * with no new dependencies and no shell scripts. Tests inject a custom
 * `gitRunner` to avoid spawning real git subprocesses.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { runGitCommand as defaultRunGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions, GitCommandOutput } from "./git_timeout.ts";

/**
 * Signature of a git runner function. Matches `runGitCommand` in
 * `git_timeout.ts`; accepted as an option to make this module testable
 * without spawning real git subprocesses.
 */
export type GitRunner = (
  args: string[],
  options?: GitCommandOptions,
) => Promise<Result<GitCommandOutput>>;

/** Options for `captureBranchHead` and `branchHeadChanged`. */
export interface BranchHeadTrackerOptions extends GitCommandOptions {
  /** Custom git runner (tests only). */
  gitRunner?: GitRunner;
}

/**
 * Capture the current HEAD SHA of the working tree.
 *
 * The `branchName` parameter is informational — captured to make logs and
 * error messages clearer at the call site. `git rev-parse HEAD` always
 * resolves the current HEAD regardless of branch name, so callers should
 * ensure the desired branch is checked out before invoking this helper.
 *
 * @param branchName - Branch the caller intends to track (used only for
 *   error context; HEAD is read directly).
 * @param options - Optional cwd, env, timeout, and custom runner.
 * @returns `Result<string>` containing the trimmed 40-character SHA on
 *   success, or an error describing why the SHA could not be read
 *   (non-zero exit, runner failure, empty output for detached/empty
 *   branches).
 */
export async function captureBranchHead(
  branchName: string,
  options: BranchHeadTrackerOptions = {},
): Promise<Result<string>> {
  const runner = options.gitRunner ?? defaultRunGitCommand;
  const runOptions: GitCommandOptions = {
    cwd: options.cwd,
    env: options.env,
    timeoutSeconds: options.timeoutSeconds,
  };

  const result = await runner(["rev-parse", "HEAD"], runOptions);

  if (!result.ok) {
    return {
      ok: false,
      error: new Error(
        `branch_head_tracker: rev-parse HEAD failed for branch '${branchName}': ${result.error.message}`,
      ),
    };
  }

  const { code, stdout, stderr } = result.value;

  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
    return {
      ok: false,
      error: new Error(
        `branch_head_tracker: rev-parse HEAD failed for branch '${branchName}' (exit ${code}): ${detail}`,
      ),
    };
  }

  const sha = stdout.trim();
  if (sha === "") {
    return {
      ok: false,
      error: new Error(
        `branch_head_tracker: rev-parse HEAD returned empty SHA for branch '${branchName}' (detached or empty branch?)`,
      ),
    };
  }

  return { ok: true, value: sha };
}

/**
 * Report whether HEAD has moved since `beforeSha` was captured.
 *
 * Re-reads HEAD via `git rev-parse HEAD` and compares against the
 * supplied SHA. **Read failures degrade safely** — any non-zero exit,
 * runner failure, or empty output is treated as "no change" rather
 * than throwing. This prevents a transient git error from being
 * misinterpreted as a HEAD movement (which would produce a worse
 * outcome than the old behaviour: the worker would post a
 * change-detected message even though no commit landed).
 *
 * The returned `Result` is always `ok` — the discriminated union is
 * preserved for symmetry with `captureBranchHead` and to leave room
 * for a future error path if the safe-default contract is relaxed.
 *
 * @param beforeSha - SHA returned by an earlier `captureBranchHead`.
 * @param branchName - Branch the caller is tracking (informational).
 * @param options - Optional cwd, env, timeout, and custom runner.
 * @returns `Result<boolean>` — `true` when HEAD differs from
 *   `beforeSha`, `false` when it matches or could not be read.
 */
export async function branchHeadChanged(
  beforeSha: string,
  branchName: string,
  options: BranchHeadTrackerOptions = {},
): Promise<Result<boolean>> {
  const captured = await captureBranchHead(branchName, options);

  if (!captured.ok) {
    // Safe default: a read failure must not be reported as a HEAD change.
    // The error is swallowed here on purpose — see JSDoc above.
    return { ok: true, value: false };
  }

  return { ok: true, value: captured.value !== beforeSha };
}
