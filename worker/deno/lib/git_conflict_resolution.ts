/**
 * Merge conflict detection and resolution (Issue #321, #912).
 *
 * When GitHub Actions (CI) reformats code on push, the remote branch diverges
 * from the local branch. During rebase, this creates merge conflicts on files
 * that both the worker and CI modified. This module resolves those conflicts
 * by accepting the upstream version — since CI has the authoritative formatting.
 *
 * Migrated from worker/shared/git_operations.sh (resolve_rebase_conflicts).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import {
  buildAddPathArgs,
  buildCheckoutStrategyArgs,
} from "./git_conflict_args.ts";

/** Maximum number of conflict resolution rounds during a rebase. */
const MAX_RESOLUTION_ROUNDS = 10;

/** Details about the conflict resolution. */
export interface ConflictResolutionDetails {
  /** Total number of files resolved. */
  filesResolved: number;
  /** Number of resolution rounds needed. */
  rounds: number;
}

/**
 * Check whether a rebase is currently in progress.
 *
 * @param options - Git command options (cwd, etc.)
 * @returns True if a rebase is in progress
 */
export async function isRebaseInProgress(
  options: GitCommandOptions = {},
): Promise<boolean> {
  const gitDirResult = await runGitCommand(
    ["rev-parse", "--git-dir"],
    options,
  );

  if (!gitDirResult.ok || gitDirResult.value.code !== 0) {
    return false;
  }

  const gitDir = gitDirResult.value.stdout.trim();
  const cwd = options.cwd ?? Deno.cwd();
  const resolvedGitDir = gitDir.startsWith("/") ? gitDir : `${cwd}/${gitDir}`;

  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      const stat = await Deno.stat(`${resolvedGitDir}/${dir}`);
      if (stat.isDirectory) return true;
    } catch {
      // Directory doesn't exist
    }
  }

  return false;
}

/**
 * Get the list of files with unresolved merge conflicts.
 *
 * @param options - Git command options (cwd, etc.)
 * @returns Array of conflicted file paths
 */
async function getConflictedFiles(
  options: GitCommandOptions = {},
): Promise<string[]> {
  const result = await runGitCommand(
    ["diff", "--name-only", "--diff-filter=U"],
    options,
  );

  if (!result.ok || result.value.code !== 0) {
    return [];
  }

  return result.value.stdout
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

/**
 * Resolve conflicted files by accepting the specified strategy.
 *
 * During rebase, "ours" is the upstream (remote) side and "theirs" is the
 * patch being replayed (our local commit). Accept the upstream version so
 * CI-formatted content wins.
 *
 * @param files - Array of conflicted file paths
 * @param strategy - Which side to accept ("ours" for upstream, "theirs" for local)
 * @param options - Git command options
 * @returns Number of files resolved
 */
async function resolveFiles(
  files: string[],
  strategy: "ours" | "theirs",
  options: GitCommandOptions = {},
): Promise<number> {
  let resolved = 0;

  for (const file of files) {
    const checkoutResult = await runGitCommand(
      buildCheckoutStrategyArgs(strategy, file),
      options,
    );
    if (checkoutResult.ok && checkoutResult.value.code === 0) {
      await runGitCommand(buildAddPathArgs(file), options);
      resolved++;
    }
  }

  return resolved;
}

/**
 * Resolve merge conflicts during a rebase (Issue #321).
 *
 * This must be called while a rebase is in progress (i.e., after git rebase
 * or git pull --rebase has failed due to conflicts).
 *
 * @param options - Git command options (cwd, etc.)
 * @returns Result with resolution details on success, error on failure
 */
export async function resolveRebaseConflicts(
  options: GitCommandOptions = {},
): Promise<Result<ConflictResolutionDetails>> {
  // Verify HEAD is valid
  const headResult = await runGitCommand(
    ["rev-parse", "--verify", "HEAD"],
    options,
  );
  if (!headResult.ok || headResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error("Not in a git repository or HEAD is invalid"),
    };
  }

  // Check for rebase in progress
  if (!(await isRebaseInProgress(options))) {
    return { ok: false, error: new Error("No rebase in progress") };
  }

  // Get initial conflicted files
  let conflictedFiles = await getConflictedFiles(options);
  if (conflictedFiles.length === 0) {
    return { ok: false, error: new Error("No conflicted files found") };
  }

  let totalResolved = 0;

  // First round: accept upstream ("ours" during rebase = remote)
  totalResolved += await resolveFiles(conflictedFiles, "ours", options);

  // Continue the rebase after resolving
  const continueEnv = { ...options.env, GIT_EDITOR: "true" };
  const continueResult = await runGitCommand(
    ["rebase", "--continue"],
    { ...options, env: continueEnv },
  );

  if (continueResult.ok && continueResult.value.code === 0) {
    return {
      ok: true,
      value: { filesResolved: totalResolved, rounds: 1 },
    };
  }

  // Multiple conflict rounds — rebases can have multiple conflicting commits
  let round = 0;
  while (round < MAX_RESOLUTION_ROUNDS) {
    conflictedFiles = await getConflictedFiles(options);
    if (conflictedFiles.length === 0) {
      break;
    }

    totalResolved += await resolveFiles(conflictedFiles, "theirs", options);

    const retryResult = await runGitCommand(
      ["rebase", "--continue"],
      { ...options, env: continueEnv },
    );

    if (retryResult.ok && retryResult.value.code === 0) {
      return {
        ok: true,
        value: { filesResolved: totalResolved, rounds: round + 2 },
      };
    }

    round++;
  }

  return {
    ok: false,
    error: new Error(
      `Failed to resolve all conflicts after ${round + 1} rounds`,
    ),
  };
}
