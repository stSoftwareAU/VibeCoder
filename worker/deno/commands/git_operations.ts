/**
 * Git operations command for the Vibe Coder worker (Issue #912).
 *
 * Unified command for all git operations, callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 * Replaces worker/shared/git_operations.sh and worker/shared/git_timeout.sh.
 *
 * Sub-operations (--operation):
 *   - create-branch-name: Create a sanitised branch name from an issue title
 *   - create-milestone-branch-name: Create a sanitised milestone branch name
 *   - is-protected-branch: Check if a branch is protected from force-push
 *   - create-feature-branch: Create a feature branch from a base branch
 *   - ensure-milestone-branch: Ensure a milestone branch exists on remote
 *   - recover-git-state: Recover from broken git states (detached HEAD, etc.)
 *   - setup-repo: Clone or update a repository for work
 *   - sync-feature-branch: Sync a feature branch with the default branch
 *   - sync-milestone-branch: Sync a milestone branch with the default branch
 *   - ensure-default-branch-current: Fetch and update local default branch
 *   - push-unpushed-commits: Push any local commits not yet on remote
 *   - detect-push-rejection: Check if push output indicates rejection
 *   - detect-existing-pr: Extract PR URL from gh error output
 *   - find-open-pr: Find an open PR for a branch
 *   - recover-existing-pr: Recover gracefully when a PR already exists
 *   - recover-push-rejection: Fetch, rebase, and retry push
 *   - resolve-rebase-conflicts: Resolve merge conflicts during rebase
 *   - validate-repo-state: Pre-Claude repository state validation
 *   - update-pr-branch: Update a PR branch to be current with its base
 *   - ensure-pr-mergeable: Check PR mergeability and resolve conflicts
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  createBranchName,
  createFeatureBranchFromBase,
  createMilestoneBranchName,
  ensureMilestoneBranchExists,
  isProtectedBranch,
} from "../lib/git_branch.ts";
import { recoverGitState } from "../lib/git_state_recovery.ts";
import {
  detectExistingPr,
  detectPushRejection,
  ensureDefaultBranchCurrent,
  findOpenPrForBranch,
  pushUnpushedCommits,
  recoverExistingPr,
} from "../lib/git_push.ts";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";
import { resolveRebaseConflicts } from "../lib/git_conflict_resolution.ts";
import { validateRepoState } from "../lib/git_repo_validation.ts";
import {
  ensurePrMergeable,
  syncFeatureBranchWithDefault,
  syncMilestoneBranchWithDefault,
  updatePrBranch,
} from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { requireDiskSpaceForGitOperation } from "../lib/disk_space.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import { getSessionStorePath, restoreSession } from "../lib/session_manager.ts";
import {
  compactSession,
  measureSessionSize,
} from "../lib/session_compaction.ts";
import { isLocalDefaultBranchUpToDate } from "../lib/remote_sha_cache.ts";
import { spawnGh } from "../lib/gh_spawn.ts";

/** Helper to convert unknown to number. */
function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

/**
 * Build the argument list for the primary shallow `gh repo clone` invocation
 * used by `setupRepo()` (Issue #1503).
 *
 * The worker clones each target repo shallow (only the tip of each branch) to
 * save disk and network. `--no-single-branch` is essential: it instructs git
 * to keep remote-tracking refs for every branch so feature/milestone branches
 * remain accessible via `origin/<branch>`. History-dependent operations (e.g.,
 * commit-range logs, merges, rebases) deepen on demand via
 * `ensureHistoryDepth()` from `lib/git_history.ts`.
 *
 * The leading `--` separates gh-level flags from flags forwarded to
 * `git clone` by the gh CLI.
 *
 * private-repo-6 already uses `--depth=1` successfully as a precedent (see
 * `worker/deno/lib/fleet_health.ts`).
 */
export function buildShallowCloneArgs(
  repo: string,
  repoPath: string,
): string[] {
  return [
    "repo",
    "clone",
    repo,
    repoPath,
    "--",
    "--depth=1",
    "--no-single-branch",
  ];
}

export const gitOperationsCommand: Command = {
  name: "git-operations",
  description:
    "Git operations: branch, push, pull, recovery, validation (Issue #912)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");
    const cwd = args["cwd"] ? String(args["cwd"]) : undefined;
    const gitOptions = cwd ? { cwd } : {};

    switch (operation) {
      case "create-branch-name": {
        const issueNumber = toNumber(args["issue-number"], 0);
        const issueTitle = String(args["issue-title"] ?? "");
        if (!issueNumber || !issueTitle) {
          return {
            success: false,
            message:
              "Missing required arguments: --issue-number, --issue-title",
          };
        }
        const name = createBranchName(issueNumber, issueTitle);
        return { success: true, message: name };
      }

      case "create-milestone-branch-name": {
        const milestoneTitle = String(args["milestone-title"] ?? "");
        if (!milestoneTitle) {
          return {
            success: false,
            message: "Missing required argument: --milestone-title",
          };
        }
        const name = createMilestoneBranchName(milestoneTitle);
        return { success: true, message: name };
      }

      case "is-protected-branch": {
        const branchName = String(args["branch-name"] ?? "");
        if (!branchName) {
          return {
            success: false,
            message: "Missing required argument: --branch-name",
          };
        }
        const isProtected = isProtectedBranch(branchName);
        return {
          success: true,
          message: isProtected ? "true" : "false",
          data: { protected: isProtected },
        };
      }

      case "create-feature-branch": {
        const branchName = String(args["branch-name"] ?? "");
        const baseBranch = String(args["base-branch"] ?? "");
        if (!branchName || !baseBranch) {
          return {
            success: false,
            message: "Missing required arguments: --branch-name, --base-branch",
          };
        }
        const result = await createFeatureBranchFromBase(
          branchName,
          baseBranch,
          gitOptions,
        );
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      case "ensure-milestone-branch": {
        const milestoneBranch = String(args["milestone-branch"] ?? "");
        const defaultBranch = String(args["default-branch"] ?? "");
        if (!milestoneBranch || !defaultBranch) {
          return {
            success: false,
            message:
              "Missing required arguments: --milestone-branch, --default-branch",
          };
        }
        // Issue #3910: this path must never fall back to the default
        // branch. A failure is reported as a failure, carrying the
        // underlying git stderr so the caller can name the cause.
        const result = await ensureMilestoneBranchExists(
          milestoneBranch,
          defaultBranch,
          gitOptions,
          ensureDefaultBranchCurrent,
        );
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      case "recover-git-state": {
        const defaultBranch = String(args["default-branch"] ?? "");
        if (!defaultBranch) {
          return {
            success: false,
            message: "Missing required argument: --default-branch",
          };
        }
        const result = await recoverGitState(defaultBranch, gitOptions);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        const { actions } = result.value;
        return {
          success: true,
          message: actions.length > 0
            ? actions.join("\n")
            : "No recovery needed",
          data: { actions },
        };
      }

      case "setup-repo": {
        const repo = String(args["repo"] ?? "");
        const workDir = String(args["work-dir"] ?? "");
        if (!repo || !workDir) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --work-dir",
          };
        }
        return await setupRepo(repo, workDir);
      }

      case "sync-feature-branch": {
        const branchName = String(args["branch-name"] ?? "");
        const defaultBranch = String(args["default-branch"] ?? "");
        if (!branchName || !defaultBranch) {
          return {
            success: false,
            message:
              "Missing required arguments: --branch-name, --default-branch",
          };
        }
        const result = await syncFeatureBranchWithDefault(
          branchName,
          defaultBranch,
          gitOptions,
        );
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      case "sync-milestone-branch": {
        const milestoneBranch = String(args["milestone-branch"] ?? "");
        const defaultBranch = String(args["default-branch"] ?? "");
        if (!milestoneBranch || !defaultBranch) {
          return {
            success: false,
            message:
              "Missing required arguments: --milestone-branch, --default-branch",
          };
        }
        const result = await syncMilestoneBranchWithDefault(
          milestoneBranch,
          defaultBranch,
          gitOptions,
        );
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      case "ensure-default-branch-current": {
        const defaultBranch = String(args["default-branch"] ?? "");
        if (!defaultBranch) {
          return {
            success: false,
            message: "Missing required argument: --default-branch",
          };
        }
        const result = await ensureDefaultBranchCurrent(
          defaultBranch,
          gitOptions,
        );
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      case "push-unpushed-commits": {
        const branchName = String(args["branch-name"] ?? "");
        if (!branchName) {
          return {
            success: false,
            message: "Missing required argument: --branch-name",
          };
        }
        const result = await pushUnpushedCommits(branchName, gitOptions);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: result.value > 0
            ? `Successfully pushed ${result.value} commit(s) to origin`
            : "No unpushed commits — branch is up to date with origin",
          data: { commitsPushed: result.value },
        };
      }

      case "detect-push-rejection": {
        const pushOutput = String(args["push-output"] ?? "");
        const rejected = detectPushRejection(pushOutput);
        return {
          success: true,
          message: rejected ? "true" : "false",
          data: { rejected },
        };
      }

      case "detect-existing-pr": {
        const errorOutput = String(args["error-output"] ?? "");
        const prUrl = detectExistingPr(errorOutput);
        return {
          success: true,
          message: prUrl ?? "",
          data: { prUrl },
        };
      }

      case "find-open-pr": {
        const repo = String(args["repo"] ?? "");
        const branchName = String(args["branch-name"] ?? "");
        if (!repo || !branchName) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --branch-name",
          };
        }
        const result = await findOpenPrForBranch(repo, branchName);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: result.value ?? "",
          data: { prUrl: result.value },
        };
      }

      case "recover-existing-pr": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const prUrl = String(args["pr-url"] ?? "");
        const prBody = args["pr-body"] ? String(args["pr-body"]) : undefined;
        if (!repo || !issueNumber || !prUrl) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --pr-url",
          };
        }
        const result = await recoverExistingPr(
          repo,
          issueNumber,
          prUrl,
          prBody,
        );
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      case "recover-push-rejection": {
        const branchName = String(args["branch-name"] ?? "");
        if (!branchName) {
          return {
            success: false,
            message: "Missing required argument: --branch-name",
          };
        }
        const result = await recoverFromPushRejection(branchName, gitOptions);
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      case "resolve-rebase-conflicts": {
        const result = await resolveRebaseConflicts(gitOptions);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message:
            `Resolved ${result.value.filesResolved} file(s) in ${result.value.rounds} round(s)`,
          data: result.value,
        };
      }

      case "validate-repo-state": {
        const featureBranch = String(args["feature-branch"] ?? "");
        const baseBranch = String(args["base-branch"] ?? "");
        const attemptRecovery = args["attempt-recovery"] === true ||
          args["attempt-recovery"] === "true";
        if (!featureBranch || !baseBranch) {
          return {
            success: false,
            message:
              "Missing required arguments: --feature-branch, --base-branch",
          };
        }
        const result = await validateRepoState(
          featureBranch,
          baseBranch,
          attemptRecovery,
          gitOptions,
        );
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        const { valid, actions, warnings, errorCode } = result.value;
        return {
          success: valid,
          message: valid
            ? "Repository state validation passed"
            : `Repository state validation failed (error code: ${errorCode})`,
          data: { valid, actions, warnings, errorCode },
        };
      }

      case "update-pr-branch": {
        const branchName = String(args["branch-name"] ?? "");
        const baseBranch = String(args["base-branch"] ?? "");
        if (!branchName || !baseBranch) {
          return {
            success: false,
            message: "Missing required arguments: --branch-name, --base-branch",
          };
        }
        const result = await updatePrBranch(branchName, baseBranch, gitOptions);
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      case "ensure-pr-mergeable": {
        const repo = String(args["repo"] ?? "");
        const prNumber = toNumber(args["pr-number"], 0);
        const branchName = String(args["branch-name"] ?? "");
        const baseBranch = String(args["base-branch"] ?? "");
        if (!repo || !prNumber || !branchName || !baseBranch) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --pr-number, --branch-name, --base-branch",
          };
        }
        const result = await ensurePrMergeable(
          repo,
          prNumber,
          branchName,
          baseBranch,
          gitOptions,
        );
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      default:
        return {
          success: false,
          message:
            `Unknown git operation: '${operation}'. Use --operation with one of: create-branch-name, create-milestone-branch-name, is-protected-branch, create-feature-branch, ensure-milestone-branch, recover-git-state, setup-repo, sync-feature-branch, sync-milestone-branch, ensure-default-branch-current, push-unpushed-commits, detect-push-rejection, detect-existing-pr, find-open-pr, recover-existing-pr, recover-push-rejection, resolve-rebase-conflicts, validate-repo-state, update-pr-branch, ensure-pr-mergeable`,
        };
    }
  },
};

/**
 * Setup a repository for work (clone or update).
 *
 * This operation orchestrates multiple git commands and side effects.
 *
 * @param repo - Repository in "owner/repo" format
 * @param workDir - Directory where repos are cloned
 * @returns CommandResult with the repo path
 */
export async function setupRepo(
  repo: string,
  workDir: string,
): Promise<CommandResult> {
  const repoName = repo.split("/").pop() ?? repo;
  const repoPath = `${workDir}/${repoName}`;

  // Defence in depth (Issue #2692): reject any slug whose derived path
  // would escape WORK_DIR before running destructive git commands. The
  // tightened REPO_SLUG_PATTERN already rejects `..`/dot-only segments at
  // the config/add-repo boundary, but setupRepo() is the choke-point that
  // runs `git reset --hard` / `git clean -fd`, so it re-asserts the
  // invariant rather than trusting upstream validation.
  if (
    repoName === "" || repoName === "." || repoName === ".." ||
    repoName.includes("/") || repoName.includes("\\")
  ) {
    return {
      success: false,
      message: `Refusing to set up repo with unsafe path segment ` +
        `"${repoName}" derived from slug "${repo}".`,
    };
  }

  // Check if repo directory exists
  try {
    const stat = await Deno.stat(repoPath);
    if (stat.isDirectory) {
      // Update existing repo
      const defaultBranchResult = await runGitCommand(
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        { cwd: repoPath },
      );
      let defaultBranch = "main"; // allow-hardcoded-branch — fallback after git symbolic-ref
      if (defaultBranchResult.ok && defaultBranchResult.value.code === 0) {
        const ref = defaultBranchResult.value.stdout.trim();
        defaultBranch = ref.replace("refs/remotes/origin/", "");
      }

      // Read cached default branch if available
      try {
        const cached = await Deno.readTextFile(
          `${repoPath}/.vibe_default_branch`,
        );
        if (cached.trim()) defaultBranch = cached.trim();
      } catch {
        // No cached default branch
      }

      // Recover from broken git states (Issue #467)
      await recoverGitState(defaultBranch, { cwd: repoPath });

      await runGitCommand(["reset", "--hard", "HEAD"], { cwd: repoPath });
      await runGitCommand(["clean", "-fd"], { cwd: repoPath });

      // Measure and compact session before restoring (Issue #1328)
      const sessionStorePath = getSessionStorePath(workDir, repo);
      const sizeResult = await measureSessionSize(sessionStorePath);
      if (sizeResult.ok && sizeResult.value > 0) {
        const maxSessionSize = OPERATIONAL_DEFAULTS.maxSessionSizeBytes;
        const maxSessionAge = OPERATIONAL_DEFAULTS.maxSessionAgeDays;
        if (sizeResult.value > maxSessionSize) {
          await compactSession(sessionStorePath, {
            maxSizeBytes: maxSessionSize,
            maxAgeDays: maxSessionAge,
          });
        }
      }

      // Restore per-repo Claude session state (Issue #1321, replaces Issue #384 blanket deletion)
      await restoreSession(repoPath, workDir, repo);

      await runGitCommand(["checkout", defaultBranch], { cwd: repoPath });

      // Fast-path: if `origin/<defaultBranch>` already matches the remote
      // tip, skip `git fetch origin` (Issue #1810). Most priority cycles on
      // most repos are no-op fetches; `git ls-remote refs/heads/<branch>`
      // is a single ~1 KB round-trip cached for 60 s. Failures fall through
      // to the original fetch path.
      const freshness = await isLocalDefaultBranchUpToDate(
        repoPath,
        defaultBranch,
      );
      if (freshness.upToDate) {
        console.log(
          `[setup-repo] fast-path skip (Issue #1810): ${repo} ${freshness.reason} (remote-sha source: ${freshness.remoteShaSource})`,
        );
      } else {
        console.log(
          `[setup-repo] full fetch (Issue #1810): ${repo} ${freshness.reason}`,
        );

        // Pre-check disk space before fetch (Issue #1174)
        const fetchSpaceCheck = await requireDiskSpaceForGitOperation(
          repoPath,
          "git fetch origin",
          OPERATIONAL_DEFAULTS.minDiskSpaceMb,
        );
        if (!fetchSpaceCheck.ok) {
          return { success: false, message: fetchSpaceCheck.error.message };
        }

        await runGitCommand(["fetch", "origin"], { cwd: repoPath });
      }

      // Always reset hard to origin/<defaultBranch> — purely local cleanup
      // that discards any uncommitted state from the previous iteration.
      await runGitCommand(["reset", "--hard", `origin/${defaultBranch}`], {
        cwd: repoPath,
      });

      // Store the default branch
      await Deno.writeTextFile(
        `${repoPath}/.vibe_default_branch`,
        defaultBranch,
      );

      return {
        success: true,
        message: repoPath,
        data: { repoPath, defaultBranch },
      };
    }
  } catch {
    // Directory doesn't exist — will clone below
  }

  // Pre-check disk space before clone (Issue #1174)
  const cloneSpaceCheck = await requireDiskSpaceForGitOperation(
    workDir,
    `gh repo clone ${repo}`,
    OPERATIONAL_DEFAULTS.minDiskSpaceMb,
  );
  if (!cloneSpaceCheck.ok) {
    return { success: false, message: cloneSpaceCheck.error.message };
  }

  // Clone the repository shallowly (--depth=1) while preserving remote-tracking
  // refs for every branch (--no-single-branch) so feature/milestone branches
  // remain accessible via origin/<branch>. History is deepened on demand by
  // ensureHistoryDepth() for commit-range/merge operations (Issue #1503).
  const cloneResult = await spawnGh(buildShallowCloneArgs(repo, repoPath));
  if (cloneResult.code !== 0) {
    return {
      success: false,
      message: `Failed to clone ${repo}: ${cloneResult.stderr}`,
    };
  }

  // Sanity check: confirm remote refs are reachable after the shallow clone.
  // Non-fatal — a network glitch should not abort the setup since we already
  // have a working clone. Failure is logged for observability.
  const lsRemoteResult = await runGitCommand(["ls-remote", "origin"], {
    cwd: repoPath,
  });
  if (!lsRemoteResult.ok || lsRemoteResult.value.code !== 0) {
    const detail = lsRemoteResult.ok
      ? lsRemoteResult.value.stderr.trim() ||
        `exit ${lsRemoteResult.value.code}`
      : lsRemoteResult.error.message;
    console.warn(
      `[setup-repo] Warning: git ls-remote origin failed after clone: ${detail}`,
    );
  }

  // Log the resulting clone size for observability (shallow vs full comparison).
  const sizeResult = await measureSessionSize(repoPath);
  if (sizeResult.ok) {
    const kib = Math.round(sizeResult.value / 1024);
    console.log(`[setup-repo] Shallow clone of ${repo} complete: ${kib} KiB`);
  }

  // Determine default branch
  const defaultBranchResult = await runGitCommand(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd: repoPath },
  );
  let defaultBranch = "main"; // allow-hardcoded-branch — fallback after git symbolic-ref
  if (defaultBranchResult.ok && defaultBranchResult.value.code === 0) {
    const ref = defaultBranchResult.value.stdout.trim();
    defaultBranch = ref.replace("refs/remotes/origin/", "");
  }

  // Store the default branch
  await Deno.writeTextFile(`${repoPath}/.vibe_default_branch`, defaultBranch);

  return {
    success: true,
    message: repoPath,
    data: { repoPath, defaultBranch },
  };
}
