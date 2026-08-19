/**
 * Repository state validation (Issue #621, #912).
 *
 * Validates the repository is in a safe state before invoking Claude.
 * Catches issues like uncommitted changes, detached HEAD, or diverged
 * branches early — avoiding 15+ minutes of wasted compute time.
 *
 * Migrated from worker/shared/git_operations.sh (validate_repo_state).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";

/**
 * Validation error codes.
 *   0 - Repository state is valid (or was successfully recovered)
 *   1 - Uncommitted changes remain from previous session
 *   2 - HEAD is detached or not on the expected feature branch
 *   3 - Feature branch has diverged from target base branch (warning only)
 *   4 - Local branch has diverged from remote tracking branch
 */

/** Result of repository validation. */
export interface ValidationResult {
  /** Whether validation passed. */
  valid: boolean;
  /** Actions taken during recovery (if attempted). */
  actions: string[];
  /** Warnings that don't block validation. */
  warnings: string[];
  /** Error code if validation failed. */
  errorCode?: number;
}

/**
 * Pre-Claude repository state validation (Issue #621).
 *
 * @param featureBranch - The expected feature branch name
 * @param baseBranch - The target base branch
 * @param attemptRecovery - Whether to attempt automatic recovery
 * @param options - Git command options
 * @returns Result with validation details
 */
export async function validateRepoState(
  featureBranch: string,
  baseBranch: string,
  attemptRecovery: boolean = false,
  options: GitCommandOptions = {},
): Promise<Result<ValidationResult>> {
  const actions: string[] = [];
  const warnings: string[] = [];

  // 1. Check for uncommitted changes
  const statusResult = await runGitCommand(["status", "--porcelain"], options);
  if (!statusResult.ok || statusResult.value.code !== 0) {
    return {
      ok: true,
      value: { valid: false, actions, warnings, errorCode: 1 },
    };
  }

  const porcelainStatus = statusResult.value.stdout.trim();
  if (porcelainStatus) {
    if (attemptRecovery) {
      actions.push(
        "SELF-HEALING: Resetting uncommitted changes to restore clean state (Issue #621)",
      );
      await runGitCommand(["reset", "--hard", "HEAD"], options);
      await runGitCommand(["clean", "-fd"], options);

      // Re-check
      const recheckResult = await runGitCommand(
        ["status", "--porcelain"],
        options,
      );
      if (recheckResult.ok && recheckResult.value.stdout.trim()) {
        return {
          ok: true,
          value: { valid: false, actions, warnings, errorCode: 1 },
        };
      }
      actions.push(
        "SELF-HEALING: Uncommitted changes cleared successfully (Issue #621)",
      );
    } else {
      return {
        ok: true,
        value: { valid: false, actions, warnings, errorCode: 1 },
      };
    }
  }

  // 2. Verify current branch is the feature branch
  const headResult = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    options,
  );
  let currentBranch = headResult.ok ? headResult.value.stdout.trim() : "";

  if (currentBranch === "HEAD") {
    if (attemptRecovery) {
      actions.push(
        `SELF-HEALING: Recovering from detached HEAD — checking out '${featureBranch}' (Issue #621)`,
      );
      const checkoutResult = await runGitCommand(
        ["checkout", featureBranch],
        options,
      );
      if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
        return {
          ok: true,
          value: { valid: false, actions, warnings, errorCode: 2 },
        };
      }
      const newHead = await runGitCommand(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        options,
      );
      currentBranch = newHead.ok ? newHead.value.stdout.trim() : "";
    } else {
      return {
        ok: true,
        value: { valid: false, actions, warnings, errorCode: 2 },
      };
    }
  }

  if (currentBranch !== featureBranch) {
    if (attemptRecovery) {
      actions.push(
        `SELF-HEALING: Checking out expected feature branch '${featureBranch}' (Issue #621)`,
      );
      const checkoutResult = await runGitCommand(
        ["checkout", featureBranch],
        options,
      );
      if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
        return {
          ok: true,
          value: { valid: false, actions, warnings, errorCode: 2 },
        };
      }
    } else {
      return {
        ok: true,
        value: { valid: false, actions, warnings, errorCode: 2 },
      };
    }
  }

  // 3. Check divergence from base branch (warning only)
  const behindBaseResult = await runGitCommand(
    ["rev-list", "--count", `HEAD..${baseBranch}`],
    options,
  );
  const behindBaseCount =
    behindBaseResult.ok && behindBaseResult.value.code === 0
      ? parseInt(behindBaseResult.value.stdout.trim(), 10) || 0
      : 0;

  if (behindBaseCount > 0) {
    warnings.push(
      `Feature branch '${featureBranch}' is ${behindBaseCount} commit(s) behind '${baseBranch}'`,
    );
    if (behindBaseCount > 50) {
      warnings.push(
        `Significant divergence from '${baseBranch}' (${behindBaseCount} commits behind)`,
      );
    }
  }

  // 4. Check remote tracking branch
  await runGitCommand(["fetch", "origin", featureBranch], options);

  const showRefResult = await runGitCommand(
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${featureBranch}`],
    options,
  );

  if (showRefResult.ok && showRefResult.value.code === 0) {
    const localShaResult = await runGitCommand(["rev-parse", "HEAD"], options);
    const remoteShaResult = await runGitCommand(
      ["rev-parse", `origin/${featureBranch}`],
      options,
    );

    const localSha = localShaResult.ok
      ? localShaResult.value.stdout.trim()
      : "";
    const remoteSha = remoteShaResult.ok
      ? remoteShaResult.value.stdout.trim()
      : "";

    if (localSha && remoteSha && localSha !== remoteSha) {
      const behindResult = await runGitCommand(
        ["rev-list", "--count", `HEAD..origin/${featureBranch}`],
        options,
      );
      const behindCount = behindResult.ok && behindResult.value.code === 0
        ? parseInt(behindResult.value.stdout.trim(), 10) || 0
        : 0;

      if (behindCount > 0) {
        if (attemptRecovery) {
          actions.push(
            "SELF-HEALING: Pulling remote changes to resolve upstream divergence (Issue #621)",
          );
          const pullResult = await runGitCommand(
            ["pull", "--rebase", "origin", featureBranch],
            options,
          );

          if (!pullResult.ok || pullResult.value.code !== 0) {
            await runGitCommand(["rebase", "--abort"], options);
            actions.push(
              "SELF-HEALING: Resetting to remote version to resolve divergence (Issue #621)",
            );
            await runGitCommand(
              ["reset", "--hard", `origin/${featureBranch}`],
              options,
            );
          }
        } else {
          return {
            ok: true,
            value: { valid: false, actions, warnings, errorCode: 4 },
          };
        }
      }
    }
  }

  return {
    ok: true,
    value: { valid: true, actions, warnings },
  };
}
