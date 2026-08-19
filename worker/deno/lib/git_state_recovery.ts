/**
 * Git state recovery after failures (Issue #467, #912).
 *
 * Detects and recovers from broken git states left by previous crashed runs:
 *   1. In-progress cherry-pick (CHERRY_PICK_HEAD exists)
 *   2. In-progress merge (MERGE_HEAD exists)
 *   3. In-progress rebase (rebase-merge/ or rebase-apply/ directory exists)
 *   4. Detached HEAD (git rev-parse --abbrev-ref HEAD returns "HEAD")
 *
 * Migrated from worker/shared/git_operations.sh (recover_git_state).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";

/** Details about what was recovered. */
export interface RecoveryDetails {
  /** Actions taken during recovery. */
  actions: string[];
  /** Whether the recovery was successful. */
  recovered: boolean;
}

/**
 * Recover from broken git states left by previous crashed runs (Issue #467).
 *
 * All recovery actions are logged with the SELF-HEALING prefix for debugging.
 * This function should be called before git reset --hard in setup_repo().
 *
 * @param defaultBranch - The default branch to check out if HEAD is detached
 * @param options - Git command options (cwd, etc.)
 * @returns Result with details about recovery actions taken
 */
export async function recoverGitState(
  defaultBranch: string,
  options: GitCommandOptions = {},
): Promise<Result<RecoveryDetails>> {
  const actions: string[] = [];

  // Get the git directory path
  const gitDirResult = await runGitCommand(
    ["rev-parse", "--git-dir"],
    options,
  );

  if (!gitDirResult.ok || gitDirResult.value.code !== 0) {
    return { ok: true, value: { actions: [], recovered: true } };
  }

  const gitDir = gitDirResult.value.stdout.trim();
  const cwd = options.cwd ?? Deno.cwd();
  const resolvedGitDir = gitDir.startsWith("/") ? gitDir : `${cwd}/${gitDir}`;

  // 1. Abort in-progress cherry-pick (Issue #467)
  try {
    const stat = await Deno.stat(`${resolvedGitDir}/CHERRY_PICK_HEAD`);
    if (stat.isFile) {
      actions.push(
        "SELF-HEALING: Detected in-progress cherry-pick — aborting (Issue #467)",
      );
      await runGitCommand(["cherry-pick", "--abort"], options);
      await emitSelfHealEventAuto({
        module: "git_state_recovery",
        action: "abort_cherry_pick",
        reason: "in-progress cherry-pick detected",
        result: "ok",
      });
    }
  } catch {
    // File doesn't exist — no cherry-pick in progress
  }

  // 2. Abort in-progress merge (Issue #467)
  try {
    const stat = await Deno.stat(`${resolvedGitDir}/MERGE_HEAD`);
    if (stat.isFile) {
      actions.push(
        "SELF-HEALING: Detected in-progress merge — aborting (Issue #467)",
      );
      await runGitCommand(["merge", "--abort"], options);
      await emitSelfHealEventAuto({
        module: "git_state_recovery",
        action: "abort_merge",
        reason: "in-progress merge detected",
        result: "ok",
      });
    }
  } catch {
    // File doesn't exist — no merge in progress
  }

  // 3. Abort in-progress rebase (Issue #467)
  let rebaseDetected = false;
  try {
    const stat = await Deno.stat(`${resolvedGitDir}/rebase-merge`);
    if (stat.isDirectory) rebaseDetected = true;
  } catch {
    // Directory doesn't exist
  }
  if (!rebaseDetected) {
    try {
      const stat = await Deno.stat(`${resolvedGitDir}/rebase-apply`);
      if (stat.isDirectory) rebaseDetected = true;
    } catch {
      // Directory doesn't exist
    }
  }
  if (rebaseDetected) {
    actions.push(
      "SELF-HEALING: Detected in-progress rebase — aborting (Issue #467)",
    );
    await runGitCommand(["rebase", "--abort"], options);
    await emitSelfHealEventAuto({
      module: "git_state_recovery",
      action: "abort_rebase",
      reason: "in-progress rebase detected",
      result: "ok",
    });
  }

  // 4. Recover from detached HEAD (Issue #467)
  const headRefResult = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    options,
  );

  if (headRefResult.ok && headRefResult.value.code === 0) {
    const headRef = headRefResult.value.stdout.trim();
    if (headRef === "HEAD") {
      actions.push(
        `SELF-HEALING: Detached HEAD detected — checking out '${defaultBranch}' (Issue #467)`,
      );
      await runGitCommand(["checkout", defaultBranch], options);
      await emitSelfHealEventAuto({
        module: "git_state_recovery",
        action: "detached_head_checkout",
        reason: `checked out ${defaultBranch}`,
        result: "ok",
      });
    }
  }

  return {
    ok: true,
    value: { actions, recovered: true },
  };
}
