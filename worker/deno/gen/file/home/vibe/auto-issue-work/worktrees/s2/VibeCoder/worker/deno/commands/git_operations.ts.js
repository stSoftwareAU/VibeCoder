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
 *   - recover-push-rejection: Fetch, merge, and retry a plain push
 *   - resolve-rebase-conflicts: Resolve merge conflicts during rebase
 *   - validate-repo-state: Pre-Claude repository state validation
 *   - update-pr-branch: Update a PR branch to be current with its base
 *   - ensure-pr-mergeable: Check PR mergeability and resolve conflicts
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { createBranchName, createFeatureBranchFromBase, createMilestoneBranchName, ensureMilestoneBranchExists, isProtectedBranch } from "../lib/git_branch.ts";
import { recoverGitState } from "../lib/git_state_recovery.ts";
import { detectExistingPr, detectPushRejection, ensureDefaultBranchCurrent, findOpenPrForBranch, pushUnpushedCommits, recoverExistingPr } from "../lib/git_push.ts";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";
import { resolveRebaseConflicts } from "../lib/git_conflict_resolution.ts";
import { validateRepoState } from "../lib/git_repo_validation.ts";
import { ensurePrMergeable, syncFeatureBranchWithDefault, syncMilestoneBranchWithDefault, updatePrBranch } from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { checkCloneOwnership, discardBrokenClone, probeCorruptClone } from "../lib/broken_clone.ts";
import { isCloneCorruption, recoverCorruptClone } from "../lib/corrupt_clone_recovery.ts";
import { cleanWorkingTree } from "../lib/ignored_path_clean.ts";
import { assertSafeRefComponent, buildCheckoutArgs } from "../lib/git_ref_args.ts";
import { requireDiskSpaceForGitOperation } from "../lib/disk_space.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import { getSessionStorePath, restoreSession } from "../lib/session_manager.ts";
import { compactSession, measureSessionSize } from "../lib/session_compaction.ts";
import { isLocalDefaultBranchUpToDate } from "../lib/remote_sha_cache.ts";
import { ensureAllBranchesFetchRefspec } from "../lib/git_fetch_refspec.ts";
import { spawnGh } from "../lib/gh_spawn.ts";
/** Helper to convert unknown to number. */ function toNumber(value, fallback) {
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
 */ export function buildShallowCloneArgs(repo, repoPath) {
  return [
    "repo",
    "clone",
    repo,
    repoPath,
    "--",
    "--depth=1",
    "--no-single-branch"
  ];
}
export const gitOperationsCommand = {
  name: "git-operations",
  description: "Git operations: branch, push, pull, recovery, validation (Issue #912)",
  async execute (args, _config) {
    const operation = String(args["operation"] ?? "");
    const cwd = args["cwd"] ? String(args["cwd"]) : undefined;
    const gitOptions = cwd ? {
      cwd
    } : {};
    switch(operation){
      case "create-branch-name":
        {
          const issueNumber = toNumber(args["issue-number"], 0);
          const issueTitle = String(args["issue-title"] ?? "");
          if (!issueNumber || !issueTitle) {
            return {
              success: false,
              message: "Missing required arguments: --issue-number, --issue-title"
            };
          }
          const name = createBranchName(issueNumber, issueTitle);
          return {
            success: true,
            message: name
          };
        }
      case "create-milestone-branch-name":
        {
          const milestoneTitle = String(args["milestone-title"] ?? "");
          if (!milestoneTitle) {
            return {
              success: false,
              message: "Missing required argument: --milestone-title"
            };
          }
          const name = createMilestoneBranchName(milestoneTitle);
          return {
            success: true,
            message: name
          };
        }
      case "is-protected-branch":
        {
          const branchName = String(args["branch-name"] ?? "");
          if (!branchName) {
            return {
              success: false,
              message: "Missing required argument: --branch-name"
            };
          }
          const isProtected = isProtectedBranch(branchName);
          return {
            success: true,
            message: isProtected ? "true" : "false",
            data: {
              protected: isProtected
            }
          };
        }
      case "create-feature-branch":
        {
          const branchName = String(args["branch-name"] ?? "");
          const baseBranch = String(args["base-branch"] ?? "");
          if (!branchName || !baseBranch) {
            return {
              success: false,
              message: "Missing required arguments: --branch-name, --base-branch"
            };
          }
          const result = await createFeatureBranchFromBase(branchName, baseBranch, gitOptions);
          return {
            success: result.ok,
            message: result.ok ? result.value : result.error.message
          };
        }
      case "ensure-milestone-branch":
        {
          const milestoneBranch = String(args["milestone-branch"] ?? "");
          const defaultBranch = String(args["default-branch"] ?? "");
          if (!milestoneBranch || !defaultBranch) {
            return {
              success: false,
              message: "Missing required arguments: --milestone-branch, --default-branch"
            };
          }
          // Issue #3910: this path must never fall back to the default
          // branch. A failure is reported as a failure, carrying the
          // underlying git stderr so the caller can name the cause.
          const result = await ensureMilestoneBranchExists(milestoneBranch, defaultBranch, gitOptions, ensureDefaultBranchCurrent);
          return {
            success: result.ok,
            message: result.ok ? result.value : result.error.message
          };
        }
      case "recover-git-state":
        {
          const defaultBranch = String(args["default-branch"] ?? "");
          if (!defaultBranch) {
            return {
              success: false,
              message: "Missing required argument: --default-branch"
            };
          }
          const result = await recoverGitState(defaultBranch, gitOptions);
          if (!result.ok) {
            return {
              success: false,
              message: result.error.message
            };
          }
          const { actions } = result.value;
          return {
            success: true,
            message: actions.length > 0 ? actions.join("\n") : "No recovery needed",
            data: {
              actions
            }
          };
        }
      case "setup-repo":
        {
          const repo = String(args["repo"] ?? "");
          const workDir = String(args["work-dir"] ?? "");
          if (!repo || !workDir) {
            return {
              success: false,
              message: "Missing required arguments: --repo, --work-dir"
            };
          }
          return await setupRepo(repo, workDir);
        }
      case "sync-feature-branch":
        {
          const branchName = String(args["branch-name"] ?? "");
          const defaultBranch = String(args["default-branch"] ?? "");
          if (!branchName || !defaultBranch) {
            return {
              success: false,
              message: "Missing required arguments: --branch-name, --default-branch"
            };
          }
          const result = await syncFeatureBranchWithDefault(branchName, defaultBranch, gitOptions);
          return {
            success: result.ok,
            message: result.ok ? result.value : result.error.message
          };
        }
      case "sync-milestone-branch":
        {
          const milestoneBranch = String(args["milestone-branch"] ?? "");
          const defaultBranch = String(args["default-branch"] ?? "");
          if (!milestoneBranch || !defaultBranch) {
            return {
              success: false,
              message: "Missing required arguments: --milestone-branch, --default-branch"
            };
          }
          const result = await syncMilestoneBranchWithDefault(milestoneBranch, defaultBranch, gitOptions);
          return {
            success: result.ok,
            message: result.ok ? result.value.message : result.error.message
          };
        }
      case "ensure-default-branch-current":
        {
          const defaultBranch = String(args["default-branch"] ?? "");
          if (!defaultBranch) {
            return {
              success: false,
              message: "Missing required argument: --default-branch"
            };
          }
          const result = await ensureDefaultBranchCurrent(defaultBranch, gitOptions);
          return {
            success: result.ok,
            message: result.ok ? result.value : result.error.message
          };
        }
      case "push-unpushed-commits":
        {
          const branchName = String(args["branch-name"] ?? "");
          if (!branchName) {
            return {
              success: false,
              message: "Missing required argument: --branch-name"
            };
          }
          const result = await pushUnpushedCommits(branchName, gitOptions);
          if (!result.ok) {
            return {
              success: false,
              message: result.error.message
            };
          }
          return {
            success: true,
            message: result.value > 0 ? `Successfully pushed ${result.value} commit(s) to origin` : "No unpushed commits — branch is up to date with origin",
            data: {
              commitsPushed: result.value
            }
          };
        }
      case "detect-push-rejection":
        {
          const pushOutput = String(args["push-output"] ?? "");
          const rejected = detectPushRejection(pushOutput);
          return {
            success: true,
            message: rejected ? "true" : "false",
            data: {
              rejected
            }
          };
        }
      case "detect-existing-pr":
        {
          const errorOutput = String(args["error-output"] ?? "");
          const prUrl = detectExistingPr(errorOutput);
          return {
            success: true,
            message: prUrl ?? "",
            data: {
              prUrl
            }
          };
        }
      case "find-open-pr":
        {
          const repo = String(args["repo"] ?? "");
          const branchName = String(args["branch-name"] ?? "");
          if (!repo || !branchName) {
            return {
              success: false,
              message: "Missing required arguments: --repo, --branch-name"
            };
          }
          const result = await findOpenPrForBranch(repo, branchName);
          if (!result.ok) {
            return {
              success: false,
              message: result.error.message
            };
          }
          return {
            success: true,
            message: result.value ?? "",
            data: {
              prUrl: result.value
            }
          };
        }
      case "recover-existing-pr":
        {
          const repo = String(args["repo"] ?? "");
          const issueNumber = toNumber(args["issue-number"], 0);
          const prUrl = String(args["pr-url"] ?? "");
          const prBody = args["pr-body"] ? String(args["pr-body"]) : undefined;
          if (!repo || !issueNumber || !prUrl) {
            return {
              success: false,
              message: "Missing required arguments: --repo, --issue-number, --pr-url"
            };
          }
          const result = await recoverExistingPr(repo, issueNumber, prUrl, prBody);
          return {
            success: result.ok,
            message: result.ok ? result.value : result.error.message
          };
        }
      case "recover-push-rejection":
        {
          const branchName = String(args["branch-name"] ?? "");
          if (!branchName) {
            return {
              success: false,
              message: "Missing required argument: --branch-name"
            };
          }
          const result = await recoverFromPushRejection(branchName, gitOptions);
          return {
            success: result.ok,
            message: result.ok ? result.value : result.error.message
          };
        }
      case "resolve-rebase-conflicts":
        {
          const result = await resolveRebaseConflicts(gitOptions);
          if (!result.ok) {
            return {
              success: false,
              message: result.error.message
            };
          }
          return {
            success: true,
            message: `Resolved ${result.value.filesResolved} file(s) in ${result.value.rounds} round(s)`,
            data: result.value
          };
        }
      case "validate-repo-state":
        {
          const featureBranch = String(args["feature-branch"] ?? "");
          const baseBranch = String(args["base-branch"] ?? "");
          const attemptRecovery = args["attempt-recovery"] === true || args["attempt-recovery"] === "true";
          if (!featureBranch || !baseBranch) {
            return {
              success: false,
              message: "Missing required arguments: --feature-branch, --base-branch"
            };
          }
          const result = await validateRepoState(featureBranch, baseBranch, attemptRecovery, gitOptions);
          if (!result.ok) {
            return {
              success: false,
              message: result.error.message
            };
          }
          const { valid, actions, warnings, errorCode } = result.value;
          return {
            success: valid,
            message: valid ? "Repository state validation passed" : `Repository state validation failed (error code: ${errorCode})`,
            data: {
              valid,
              actions,
              warnings,
              errorCode
            }
          };
        }
      case "update-pr-branch":
        {
          const branchName = String(args["branch-name"] ?? "");
          const baseBranch = String(args["base-branch"] ?? "");
          if (!branchName || !baseBranch) {
            return {
              success: false,
              message: "Missing required arguments: --branch-name, --base-branch"
            };
          }
          const result = await updatePrBranch(branchName, baseBranch, gitOptions);
          return {
            success: result.ok,
            message: result.ok ? result.value : result.error.message
          };
        }
      case "ensure-pr-mergeable":
        {
          const repo = String(args["repo"] ?? "");
          const prNumber = toNumber(args["pr-number"], 0);
          const branchName = String(args["branch-name"] ?? "");
          const baseBranch = String(args["base-branch"] ?? "");
          if (!repo || !prNumber || !branchName || !baseBranch) {
            return {
              success: false,
              message: "Missing required arguments: --repo, --pr-number, --branch-name, --base-branch"
            };
          }
          const result = await ensurePrMergeable(repo, prNumber, branchName, baseBranch, gitOptions);
          return {
            success: result.ok,
            message: result.ok ? result.value : result.error.message
          };
        }
      default:
        return {
          success: false,
          message: `Unknown git operation: '${operation}'. Use --operation with one of: create-branch-name, create-milestone-branch-name, is-protected-branch, create-feature-branch, ensure-milestone-branch, recover-git-state, setup-repo, sync-feature-branch, sync-milestone-branch, ensure-default-branch-current, push-unpushed-commits, detect-push-rejection, detect-existing-pr, find-open-pr, recover-existing-pr, recover-push-rejection, resolve-rebase-conflicts, validate-repo-state, update-pr-branch, ensure-pr-mergeable`
        };
    }
  }
};
/**
 * Where a clone's default-branch cache lives (Issue #1652):
 * `<git common dir>/vibe/default_branch` — `.git/vibe/default_branch` in the
 * shared clone, and the same file for every lane worktree linked to it.
 *
 * It used to be `.vibe_default_branch` at the root of the working tree. A
 * file in the tree is a file the repository can commit (three monitored
 * repositories had) and a file `git add -A` stages, which is how the
 * merge-conflict pass's final-mile commit came to be refused by the
 * pre-commit safety gate on GRQ-AutoTrader#58 (Issue #1644). Inside the git
 * directory it can be neither committed nor staged, and — because the read
 * happens before `reset --hard` — a repository can no longer plant the value
 * the worker checks out (Issue #1269 stays closed by construction, and the
 * `assertSafeRefComponent` check stays as defence in depth).
 *
 * Resolved through git rather than assumed to be `${repoPath}/.git`, so a
 * lane worktree (whose `.git` is a file pointing at the clone) shares the
 * clone's cache instead of getting one of its own.
 *
 * @param repoPath - The clone or worktree
 * @returns The cache file's absolute path, or `null` when the git directory
 *   could not be resolved (not a repository, or git refused)
 */ export async function defaultBranchCachePath(repoPath) {
  const result = await runGitCommand([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ], {
    cwd: repoPath
  });
  if (!result.ok || result.value.code !== 0) return null;
  const gitDir = result.value.stdout.trim();
  if (gitDir.length === 0) return null;
  return `${gitDir}/vibe/default_branch`;
}
/**
 * Read the cached default branch from the clone's git directory (Issue #1652).
 *
 * @returns The trimmed cached value, or `""` when there is no cache
 */ async function readDefaultBranchCache(repoPath) {
  const path = await defaultBranchCachePath(repoPath);
  if (path === null) return "";
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch  {
    return "";
  }
}
/**
 * Write the default branch into the clone's git directory (Issue #1652),
 * creating `vibe/` when absent. A write that fails is reported with the path
 * rather than swallowed: the next run would otherwise silently lose the
 * cache and nobody would know why.
 */ async function writeDefaultBranchCache(repoPath, defaultBranch) {
  const path = await defaultBranchCachePath(repoPath);
  if (path === null) {
    return {
      ok: false,
      error: new Error(`Could not resolve the git directory of ${repoPath} to store the ` + `default-branch cache (Issue #1652)`)
    };
  }
  try {
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
      recursive: true
    });
    await Deno.writeTextFile(path, defaultBranch);
    return {
      ok: true,
      value: undefined
    };
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Could not write the default-branch cache ${path}: ${error instanceof Error ? error.message : String(error)} (Issue #1652)`)
    };
  }
}
/**
 * Classify a `runGitCommand` outcome as clone corruption (Issue #2957).
 *
 * A failed reset/checkout/fetch during the reuse path can mean many things;
 * only the subset `isCloneCorruption` recognises (e.g. a bad object/ref) is
 * worth moving the clone aside for, so every other failure keeps today's
 * behaviour of being logged/ignored by its caller.
 *
 * @returns the combined git output when it is clone corruption, else `null`.
 */ function classifyGitCorruption(result) {
  if (!result.ok || result.value.code === 0) return null;
  const combined = `${result.value.stdout}\n${result.value.stderr}`;
  return isCloneCorruption(combined) ? combined : null;
}
/**
 * Setup a repository for work (clone or update).
 *
 * This operation orchestrates multiple git commands and side effects.
 *
 * @param repo - Repository in "owner/repo" format
 * @param workDir - Directory where repos are cloned
 * @returns CommandResult with the repo path
 */ export async function setupRepo(repo, workDir, ownershipCheck = checkCloneOwnership, git = runGitCommand) {
  const repoName = repo.split("/").pop() ?? repo;
  const repoPath = `${workDir}/${repoName}`;
  // Defence in depth (Issue #2692): reject any slug whose derived path
  // would escape WORK_DIR before running destructive git commands. The
  // tightened REPO_SLUG_PATTERN already rejects `..`/dot-only segments at
  // the config/add-repo boundary, but setupRepo() is the choke-point that
  // runs `git reset --hard` / `git clean -fd`, so it re-asserts the
  // invariant rather than trusting upstream validation.
  if (repoName === "" || repoName === "." || repoName === ".." || repoName.includes("/") || repoName.includes("\\")) {
    return {
      success: false,
      message: `Refusing to set up repo with unsafe path segment ` + `"${repoName}" derived from slug "${repo}".`
    };
  }
  const ownershipError = await ownershipCheck(repoPath);
  if (ownershipError) return {
    success: false,
    message: ownershipError
  };
  // A directory left by an interrupted clone holds no repository: every git
  // call in it dies at the filesystem boundary, wedging each run at setup.
  // Discard it so the clone below starts afresh (Issue #2848).
  const discarded = await discardBrokenClone(repoPath);
  if (!discarded.ok) {
    return {
      success: false,
      message: discarded.error.message
    };
  }
  // A clone whose `.git` directory is present but corrupt (e.g. a garbage
  // `.git/config` line) fails every git call before setup ever reaches the
  // reuse logic below. Move it aside and re-clone, at most once per repo per
  // 24 h per host (Issue #2957) — a healthy clone is never touched.
  let recoveryAside = null;
  let preProbe;
  try {
    preProbe = await probeCorruptClone(repoPath);
  } catch (error) {
    return {
      success: false,
      message: String(error)
    };
  }
  if (preProbe !== null) {
    const recovered = await recoverCorruptClone(repo, repoPath, workDir, preProbe);
    if (!recovered.ok) {
      return {
        success: false,
        message: recovered.error.message
      };
    }
    recoveryAside = recovered.value;
  }
  // Check if repo directory exists
  try {
    const stat = await Deno.stat(repoPath);
    if (stat.isDirectory) {
      const reuseError = ownershipCheck === checkCloneOwnership ? await checkCloneOwnership(repoPath, undefined, undefined, true) : await ownershipCheck(repoPath);
      if (reuseError) return {
        success: false,
        message: reuseError
      };
      // Update existing repo
      const defaultBranchResult = await git([
        "symbolic-ref",
        "refs/remotes/origin/HEAD"
      ], {
        cwd: repoPath
      });
      let defaultBranch = "main"; // allow-hardcoded-branch — fallback after git symbolic-ref
      if (defaultBranchResult.ok && defaultBranchResult.value.code === 0) {
        const ref = defaultBranchResult.value.stdout.trim();
        defaultBranch = ref.replace("refs/remotes/origin/", "");
      }
      // Read the cached default branch if available. It lives in the clone's
      // git directory (`.git/vibe/default_branch`, Issue #1652), never in the
      // working tree — so a repository cannot commit the value the worker
      // reads (Issue #1269) and `git add -A` cannot stage it (Issue #1644).
      // The value is still validated as a ref component before it can reach
      // `git checkout` as a positional: defence in depth costs one call.
      const cached = await readDefaultBranchCache(repoPath);
      if (cached) {
        try {
          assertSafeRefComponent(cached, "cached default branch");
          defaultBranch = cached;
        } catch (error) {
          // Ignore the bad cache rather than latch on it; `defaultBranch`
          // still holds the value `git symbolic-ref` derived above, and the
          // rewrite at the end of this setup replaces the file.
          console.error(`[setup-repo] SECURITY (Issue #1269): ignoring ` + `${await defaultBranchCachePath(repoPath)} — ` + `${error instanceof Error ? error.message : String(error)}. ` + `Falling back to '${defaultBranch}'.`);
        }
      }
      // Recover from broken git states (Issue #467)
      await recoverGitState(defaultBranch, {
        cwd: repoPath
      });
      const resetHeadResult = await git([
        "reset",
        "--hard",
        "HEAD"
      ], {
        cwd: repoPath
      });
      // Issue #1443: the clean also erases the ignored directories that carry
      // executable content (`node_modules/`, `.venv/`, `target/`, …), so a
      // previous run cannot leave something behind for this one to execute.
      // Pure download caches are left warm — see `ignored_path_clean.ts`.
      // A clean that could not do that refuses the setup rather than handing
      // the run a tree whose executable content is last run's.
      const cleaned = await cleanWorkingTree({
        cwd: repoPath
      });
      if (!cleaned.ok) {
        return {
          success: false,
          message: cleaned.error.message
        };
      }
      // Measure and compact session before restoring (Issue #1328)
      const sessionStorePath = getSessionStorePath(workDir, repo);
      const sizeResult = await measureSessionSize(sessionStorePath);
      if (sizeResult.ok && sizeResult.value > 0) {
        const maxSessionSize = OPERATIONAL_DEFAULTS.maxSessionSizeBytes;
        const maxSessionAge = OPERATIONAL_DEFAULTS.maxSessionAgeDays;
        if (sizeResult.value > maxSessionSize) {
          await compactSession(sessionStorePath, {
            maxSizeBytes: maxSessionSize,
            maxAgeDays: maxSessionAge
          });
        }
      }
      // Restore per-repo Claude session state (Issue #1321, replaces Issue #384 blanket deletion)
      await restoreSession(repoPath, workDir, repo);
      const checkoutResult = await git(buildCheckoutArgs(defaultBranch), {
        cwd: repoPath
      });
      // Repair a legacy single-branch clone (Issue #211). A clone made with a
      // bare `--depth=1` only ever tracks the default branch, so every
      // feature branch is invisible to `origin/<branch>` — which made a good
      // push look failed and a mergeable PR look conflicted. Re-fetch
      // immediately after a repair so the tracking refs actually materialise.
      const refspecRepair = await ensureAllBranchesFetchRefspec({
        cwd: repoPath
      });
      if (!refspecRepair.ok) {
        console.warn(`[setup-repo] Could not check the fetch refspec for ${repo}: ${refspecRepair.error.message}`);
      } else if (refspecRepair.value.repaired) {
        console.log(`[setup-repo] Repaired single-branch fetch refspec for ${repo} (Issue #211): was [${refspecRepair.value.before.join(", ")}]`);
      }
      const refspecWasRepaired = refspecRepair.ok && refspecRepair.value.repaired;
      // Fast-path: if `origin/<defaultBranch>` already matches the remote
      // tip, skip `git fetch origin` (Issue #1810). Most priority cycles on
      // most repos are no-op fetches; `git ls-remote refs/heads/<branch>`
      // is a single ~1 KB round-trip cached for 60 s. Failures fall through
      // to the original fetch path.
      const freshness = await isLocalDefaultBranchUpToDate(repoPath, defaultBranch);
      let fetchResult = null;
      if (freshness.upToDate && !refspecWasRepaired) {
        console.log(`[setup-repo] fast-path skip (Issue #1810): ${repo} ${freshness.reason} (remote-sha source: ${freshness.remoteShaSource})`);
      } else {
        console.log(`[setup-repo] full fetch (Issue #1810): ${repo} ${refspecWasRepaired ? "fetch refspec repaired" : freshness.reason}`);
        // Pre-check disk space before fetch (Issue #1174)
        const fetchSpaceCheck = await requireDiskSpaceForGitOperation(repoPath, "git fetch origin", OPERATIONAL_DEFAULTS.minDiskSpaceMb);
        if (!fetchSpaceCheck.ok) {
          return {
            success: false,
            message: fetchSpaceCheck.error.message
          };
        }
        fetchResult = await git([
          "fetch",
          "origin"
        ], {
          cwd: repoPath
        });
      }
      // Always reset hard to origin/<defaultBranch> — purely local cleanup
      // that discards any uncommitted state from the previous iteration.
      const resetOriginResult = await git([
        "reset",
        "--hard",
        `origin/${defaultBranch}`
      ], {
        cwd: repoPath
      });
      // Clone corruption (Issue #2957): a bad object/ref surfaces as a
      // non-zero exit from one of the commands above rather than from the
      // `git rev-parse --git-dir` probe run before this branch, since the
      // git directory itself still resolves. Only the subset of failures
      // `isCloneCorruption` recognises is treated this way — every other
      // failure keeps today's behaviour of being silently carried forward.
      const corruption = classifyGitCorruption(resetHeadResult) ?? classifyGitCorruption(checkoutResult) ?? (fetchResult ? classifyGitCorruption(fetchResult) : null) ?? classifyGitCorruption(resetOriginResult);
      if (corruption !== null) {
        const recovered = await recoverCorruptClone(repo, repoPath, workDir, corruption);
        if (!recovered.ok) {
          return {
            success: false,
            message: recovered.error.message
          };
        }
        recoveryAside = recovered.value;
      // The corrupt clone has been moved aside; fall through to the fresh
      // clone path below, which now finds repoPath absent.
      } else {
        // Store the default branch in the git directory (Issue #1652).
        const stored = await writeDefaultBranchCache(repoPath, defaultBranch);
        if (!stored.ok) {
          return {
            success: false,
            message: stored.error.message
          };
        }
        return {
          success: true,
          message: repoPath,
          data: {
            repoPath,
            defaultBranch
          }
        };
      }
    }
  } catch  {
  // Directory doesn't exist — will clone below
  }
  // Pre-check disk space before clone (Issue #1174)
  const cloneSpaceCheck = await requireDiskSpaceForGitOperation(workDir, `gh repo clone ${repo}`, OPERATIONAL_DEFAULTS.minDiskSpaceMb);
  if (!cloneSpaceCheck.ok) {
    return {
      success: false,
      message: cloneSpaceCheck.error.message
    };
  }
  // Clone the repository shallowly (--depth=1) while preserving remote-tracking
  // refs for every branch (--no-single-branch) so feature/milestone branches
  // remain accessible via origin/<branch>. History is deepened on demand by
  // ensureHistoryDepth() for commit-range/merge operations (Issue #1503).
  const cloneResult = await spawnGh(buildShallowCloneArgs(repo, repoPath));
  if (cloneResult.code !== 0) {
    // Issue #2957: name the aside path so a failed recovery re-clone is
    // distinguishable from an ordinary first clone, while keeping the
    // `CLONE_FAILED_PATTERN` prefix host-fault detection matches on.
    const message = recoveryAside !== null ? `Failed to clone ${repo}: ${cloneResult.stderr} (re-clone into ${repoPath} after moving the corrupt clone aside to ${recoveryAside})` : `Failed to clone ${repo}: ${cloneResult.stderr}`;
    return {
      success: false,
      message
    };
  }
  // A different account can create the destination while gh resolves the
  // repository. Never run git in the resulting clone until ownership is checked.
  const cloneOwnershipError = await ownershipCheck(repoPath);
  if (cloneOwnershipError) {
    try {
      const quarantine = await Deno.makeTempDir({
        dir: workDir,
        prefix: `.untrusted-${repoName}-`
      });
      await Deno.rename(repoPath, `${quarantine}/${repoName}`);
      return {
        success: false,
        message: `${cloneOwnershipError}; moved clone to ${quarantine}`
      };
    } catch (error) {
      return {
        success: false,
        message: `${cloneOwnershipError}; could not quarantine clone: ${error}`
      };
    }
  }
  // Sanity check: confirm remote refs are reachable after the shallow clone.
  // Non-fatal — a network glitch should not abort the setup since we already
  // have a working clone. Failure is logged for observability.
  const lsRemoteResult = await git([
    "ls-remote",
    "origin"
  ], {
    cwd: repoPath
  });
  if (!lsRemoteResult.ok || lsRemoteResult.value.code !== 0) {
    const detail = lsRemoteResult.ok ? lsRemoteResult.value.stderr.trim() || `exit ${lsRemoteResult.value.code}` : lsRemoteResult.error.message;
    console.warn(`[setup-repo] Warning: git ls-remote origin failed after clone: ${detail}`);
  }
  // Log the resulting clone size for observability (shallow vs full comparison).
  const sizeResult = await measureSessionSize(repoPath);
  if (sizeResult.ok) {
    const kib = Math.round(sizeResult.value / 1024);
    console.log(`[setup-repo] Shallow clone of ${repo} complete: ${kib} KiB`);
  }
  // Determine default branch
  const defaultBranchResult = await git([
    "symbolic-ref",
    "refs/remotes/origin/HEAD"
  ], {
    cwd: repoPath
  });
  let defaultBranch = "main"; // allow-hardcoded-branch — fallback after git symbolic-ref
  if (defaultBranchResult.ok && defaultBranchResult.value.code === 0) {
    const ref = defaultBranchResult.value.stdout.trim();
    defaultBranch = ref.replace("refs/remotes/origin/", "");
  }
  // Store the default branch in the git directory (Issue #1652).
  const stored = await writeDefaultBranchCache(repoPath, defaultBranch);
  if (!stored.ok) {
    return {
      success: false,
      message: stored.error.message
    };
  }
  return {
    success: true,
    message: repoPath,
    data: {
      repoPath,
      defaultBranch
    }
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2NvbW1hbmRzL2dpdF9vcGVyYXRpb25zLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogR2l0IG9wZXJhdGlvbnMgY29tbWFuZCBmb3IgdGhlIFZpYmUgQ29kZXIgd29ya2VyIChJc3N1ZSAjOTEyKS5cbiAqXG4gKiBVbmlmaWVkIGNvbW1hbmQgZm9yIGFsbCBnaXQgb3BlcmF0aW9ucywgY2FsbGFibGUgZnJvbSBzaGVsbCB2aWEgdGhlIERlbm8gQ0xJIChgZGVubyBydW4gbW9kLnRzIDxjb21tYW5kPmApLlxuICogUmVwbGFjZXMgd29ya2VyL3NoYXJlZC9naXRfb3BlcmF0aW9ucy5zaCBhbmQgd29ya2VyL3NoYXJlZC9naXRfdGltZW91dC5zaC5cbiAqXG4gKiBTdWItb3BlcmF0aW9ucyAoLS1vcGVyYXRpb24pOlxuICogICAtIGNyZWF0ZS1icmFuY2gtbmFtZTogQ3JlYXRlIGEgc2FuaXRpc2VkIGJyYW5jaCBuYW1lIGZyb20gYW4gaXNzdWUgdGl0bGVcbiAqICAgLSBjcmVhdGUtbWlsZXN0b25lLWJyYW5jaC1uYW1lOiBDcmVhdGUgYSBzYW5pdGlzZWQgbWlsZXN0b25lIGJyYW5jaCBuYW1lXG4gKiAgIC0gaXMtcHJvdGVjdGVkLWJyYW5jaDogQ2hlY2sgaWYgYSBicmFuY2ggaXMgcHJvdGVjdGVkIGZyb20gZm9yY2UtcHVzaFxuICogICAtIGNyZWF0ZS1mZWF0dXJlLWJyYW5jaDogQ3JlYXRlIGEgZmVhdHVyZSBicmFuY2ggZnJvbSBhIGJhc2UgYnJhbmNoXG4gKiAgIC0gZW5zdXJlLW1pbGVzdG9uZS1icmFuY2g6IEVuc3VyZSBhIG1pbGVzdG9uZSBicmFuY2ggZXhpc3RzIG9uIHJlbW90ZVxuICogICAtIHJlY292ZXItZ2l0LXN0YXRlOiBSZWNvdmVyIGZyb20gYnJva2VuIGdpdCBzdGF0ZXMgKGRldGFjaGVkIEhFQUQsIGV0Yy4pXG4gKiAgIC0gc2V0dXAtcmVwbzogQ2xvbmUgb3IgdXBkYXRlIGEgcmVwb3NpdG9yeSBmb3Igd29ya1xuICogICAtIHN5bmMtZmVhdHVyZS1icmFuY2g6IFN5bmMgYSBmZWF0dXJlIGJyYW5jaCB3aXRoIHRoZSBkZWZhdWx0IGJyYW5jaFxuICogICAtIHN5bmMtbWlsZXN0b25lLWJyYW5jaDogU3luYyBhIG1pbGVzdG9uZSBicmFuY2ggd2l0aCB0aGUgZGVmYXVsdCBicmFuY2hcbiAqICAgLSBlbnN1cmUtZGVmYXVsdC1icmFuY2gtY3VycmVudDogRmV0Y2ggYW5kIHVwZGF0ZSBsb2NhbCBkZWZhdWx0IGJyYW5jaFxuICogICAtIHB1c2gtdW5wdXNoZWQtY29tbWl0czogUHVzaCBhbnkgbG9jYWwgY29tbWl0cyBub3QgeWV0IG9uIHJlbW90ZVxuICogICAtIGRldGVjdC1wdXNoLXJlamVjdGlvbjogQ2hlY2sgaWYgcHVzaCBvdXRwdXQgaW5kaWNhdGVzIHJlamVjdGlvblxuICogICAtIGRldGVjdC1leGlzdGluZy1wcjogRXh0cmFjdCBQUiBVUkwgZnJvbSBnaCBlcnJvciBvdXRwdXRcbiAqICAgLSBmaW5kLW9wZW4tcHI6IEZpbmQgYW4gb3BlbiBQUiBmb3IgYSBicmFuY2hcbiAqICAgLSByZWNvdmVyLWV4aXN0aW5nLXByOiBSZWNvdmVyIGdyYWNlZnVsbHkgd2hlbiBhIFBSIGFscmVhZHkgZXhpc3RzXG4gKiAgIC0gcmVjb3Zlci1wdXNoLXJlamVjdGlvbjogRmV0Y2gsIG1lcmdlLCBhbmQgcmV0cnkgYSBwbGFpbiBwdXNoXG4gKiAgIC0gcmVzb2x2ZS1yZWJhc2UtY29uZmxpY3RzOiBSZXNvbHZlIG1lcmdlIGNvbmZsaWN0cyBkdXJpbmcgcmViYXNlXG4gKiAgIC0gdmFsaWRhdGUtcmVwby1zdGF0ZTogUHJlLUNsYXVkZSByZXBvc2l0b3J5IHN0YXRlIHZhbGlkYXRpb25cbiAqICAgLSB1cGRhdGUtcHItYnJhbmNoOiBVcGRhdGUgYSBQUiBicmFuY2ggdG8gYmUgY3VycmVudCB3aXRoIGl0cyBiYXNlXG4gKiAgIC0gZW5zdXJlLXByLW1lcmdlYWJsZTogQ2hlY2sgUFIgbWVyZ2VhYmlsaXR5IGFuZCByZXNvbHZlIGNvbmZsaWN0c1xuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQ29tbWFuZCwgQ29tbWFuZFJlc3VsdCwgUmVzdWx0LCBXb3JrZXJDb25maWcgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIGNyZWF0ZUJyYW5jaE5hbWUsXG4gIGNyZWF0ZUZlYXR1cmVCcmFuY2hGcm9tQmFzZSxcbiAgY3JlYXRlTWlsZXN0b25lQnJhbmNoTmFtZSxcbiAgZW5zdXJlTWlsZXN0b25lQnJhbmNoRXhpc3RzLFxuICBpc1Byb3RlY3RlZEJyYW5jaCxcbn0gZnJvbSBcIi4uL2xpYi9naXRfYnJhbmNoLnRzXCI7XG5pbXBvcnQgeyByZWNvdmVyR2l0U3RhdGUgfSBmcm9tIFwiLi4vbGliL2dpdF9zdGF0ZV9yZWNvdmVyeS50c1wiO1xuaW1wb3J0IHtcbiAgZGV0ZWN0RXhpc3RpbmdQcixcbiAgZGV0ZWN0UHVzaFJlamVjdGlvbixcbiAgZW5zdXJlRGVmYXVsdEJyYW5jaEN1cnJlbnQsXG4gIGZpbmRPcGVuUHJGb3JCcmFuY2gsXG4gIHB1c2hVbnB1c2hlZENvbW1pdHMsXG4gIHJlY292ZXJFeGlzdGluZ1ByLFxufSBmcm9tIFwiLi4vbGliL2dpdF9wdXNoLnRzXCI7XG5pbXBvcnQgeyByZWNvdmVyRnJvbVB1c2hSZWplY3Rpb24gfSBmcm9tIFwiLi4vbGliL2dpdF9wdXNoX3JlY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlUmViYXNlQ29uZmxpY3RzIH0gZnJvbSBcIi4uL2xpYi9naXRfY29uZmxpY3RfcmVzb2x1dGlvbi50c1wiO1xuaW1wb3J0IHsgdmFsaWRhdGVSZXBvU3RhdGUgfSBmcm9tIFwiLi4vbGliL2dpdF9yZXBvX3ZhbGlkYXRpb24udHNcIjtcbmltcG9ydCB7XG4gIGVuc3VyZVByTWVyZ2VhYmxlLFxuICBzeW5jRmVhdHVyZUJyYW5jaFdpdGhEZWZhdWx0LFxuICBzeW5jTWlsZXN0b25lQnJhbmNoV2l0aERlZmF1bHQsXG4gIHVwZGF0ZVByQnJhbmNoLFxufSBmcm9tIFwiLi4vbGliL2dpdF9wdWxsLnRzXCI7XG5pbXBvcnQgeyBydW5HaXRDb21tYW5kIH0gZnJvbSBcIi4uL2xpYi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHtcbiAgY2hlY2tDbG9uZU93bmVyc2hpcCxcbiAgZGlzY2FyZEJyb2tlbkNsb25lLFxuICBwcm9iZUNvcnJ1cHRDbG9uZSxcbn0gZnJvbSBcIi4uL2xpYi9icm9rZW5fY2xvbmUudHNcIjtcbmltcG9ydCB7XG4gIGlzQ2xvbmVDb3JydXB0aW9uLFxuICByZWNvdmVyQ29ycnVwdENsb25lLFxufSBmcm9tIFwiLi4vbGliL2NvcnJ1cHRfY2xvbmVfcmVjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNsZWFuV29ya2luZ1RyZWUgfSBmcm9tIFwiLi4vbGliL2lnbm9yZWRfcGF0aF9jbGVhbi50c1wiO1xuaW1wb3J0IHtcbiAgYXNzZXJ0U2FmZVJlZkNvbXBvbmVudCxcbiAgYnVpbGRDaGVja291dEFyZ3MsXG59IGZyb20gXCIuLi9saWIvZ2l0X3JlZl9hcmdzLnRzXCI7XG5pbXBvcnQgeyByZXF1aXJlRGlza1NwYWNlRm9yR2l0T3BlcmF0aW9uIH0gZnJvbSBcIi4uL2xpYi9kaXNrX3NwYWNlLnRzXCI7XG5pbXBvcnQgeyBPUEVSQVRJT05BTF9ERUZBVUxUUyB9IGZyb20gXCIuLi9saWIvY29uZmlnX2RlZmF1bHRzLnRzXCI7XG5pbXBvcnQgeyBnZXRTZXNzaW9uU3RvcmVQYXRoLCByZXN0b3JlU2Vzc2lvbiB9IGZyb20gXCIuLi9saWIvc2Vzc2lvbl9tYW5hZ2VyLnRzXCI7XG5pbXBvcnQge1xuICBjb21wYWN0U2Vzc2lvbixcbiAgbWVhc3VyZVNlc3Npb25TaXplLFxufSBmcm9tIFwiLi4vbGliL3Nlc3Npb25fY29tcGFjdGlvbi50c1wiO1xuaW1wb3J0IHsgaXNMb2NhbERlZmF1bHRCcmFuY2hVcFRvRGF0ZSB9IGZyb20gXCIuLi9saWIvcmVtb3RlX3NoYV9jYWNoZS50c1wiO1xuaW1wb3J0IHsgZW5zdXJlQWxsQnJhbmNoZXNGZXRjaFJlZnNwZWMgfSBmcm9tIFwiLi4vbGliL2dpdF9mZXRjaF9yZWZzcGVjLnRzXCI7XG5pbXBvcnQgeyBzcGF3bkdoIH0gZnJvbSBcIi4uL2xpYi9naF9zcGF3bi50c1wiO1xuXG4vKiogSGVscGVyIHRvIGNvbnZlcnQgdW5rbm93biB0byBudW1iZXIuICovXG5mdW5jdGlvbiB0b051bWJlcih2YWx1ZTogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwibnVtYmVyXCIpIHJldHVybiB2YWx1ZTtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IG4gPSBwYXJzZUludCh2YWx1ZSwgMTApO1xuICAgIHJldHVybiBpc05hTihuKSA/IGZhbGxiYWNrIDogbjtcbiAgfVxuICByZXR1cm4gZmFsbGJhY2s7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGFyZ3VtZW50IGxpc3QgZm9yIHRoZSBwcmltYXJ5IHNoYWxsb3cgYGdoIHJlcG8gY2xvbmVgIGludm9jYXRpb25cbiAqIHVzZWQgYnkgYHNldHVwUmVwbygpYCAoSXNzdWUgIzE1MDMpLlxuICpcbiAqIFRoZSB3b3JrZXIgY2xvbmVzIGVhY2ggdGFyZ2V0IHJlcG8gc2hhbGxvdyAob25seSB0aGUgdGlwIG9mIGVhY2ggYnJhbmNoKSB0b1xuICogc2F2ZSBkaXNrIGFuZCBuZXR3b3JrLiBgLS1uby1zaW5nbGUtYnJhbmNoYCBpcyBlc3NlbnRpYWw6IGl0IGluc3RydWN0cyBnaXRcbiAqIHRvIGtlZXAgcmVtb3RlLXRyYWNraW5nIHJlZnMgZm9yIGV2ZXJ5IGJyYW5jaCBzbyBmZWF0dXJlL21pbGVzdG9uZSBicmFuY2hlc1xuICogcmVtYWluIGFjY2Vzc2libGUgdmlhIGBvcmlnaW4vPGJyYW5jaD5gLiBIaXN0b3J5LWRlcGVuZGVudCBvcGVyYXRpb25zIChlLmcuLFxuICogY29tbWl0LXJhbmdlIGxvZ3MsIG1lcmdlcywgcmViYXNlcykgZGVlcGVuIG9uIGRlbWFuZCB2aWFcbiAqIGBlbnN1cmVIaXN0b3J5RGVwdGgoKWAgZnJvbSBgbGliL2dpdF9oaXN0b3J5LnRzYC5cbiAqXG4gKiBUaGUgbGVhZGluZyBgLS1gIHNlcGFyYXRlcyBnaC1sZXZlbCBmbGFncyBmcm9tIGZsYWdzIGZvcndhcmRlZCB0b1xuICogYGdpdCBjbG9uZWAgYnkgdGhlIGdoIENMSS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU2hhbGxvd0Nsb25lQXJncyhcbiAgcmVwbzogc3RyaW5nLFxuICByZXBvUGF0aDogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuICByZXR1cm4gW1xuICAgIFwicmVwb1wiLFxuICAgIFwiY2xvbmVcIixcbiAgICByZXBvLFxuICAgIHJlcG9QYXRoLFxuICAgIFwiLS1cIixcbiAgICBcIi0tZGVwdGg9MVwiLFxuICAgIFwiLS1uby1zaW5nbGUtYnJhbmNoXCIsXG4gIF07XG59XG5cbmV4cG9ydCBjb25zdCBnaXRPcGVyYXRpb25zQ29tbWFuZDogQ29tbWFuZCA9IHtcbiAgbmFtZTogXCJnaXQtb3BlcmF0aW9uc1wiLFxuICBkZXNjcmlwdGlvbjpcbiAgICBcIkdpdCBvcGVyYXRpb25zOiBicmFuY2gsIHB1c2gsIHB1bGwsIHJlY292ZXJ5LCB2YWxpZGF0aW9uIChJc3N1ZSAjOTEyKVwiLFxuXG4gIGFzeW5jIGV4ZWN1dGUoXG4gICAgYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgX2NvbmZpZzogV29ya2VyQ29uZmlnLFxuICApOiBQcm9taXNlPENvbW1hbmRSZXN1bHQ+IHtcbiAgICBjb25zdCBvcGVyYXRpb24gPSBTdHJpbmcoYXJnc1tcIm9wZXJhdGlvblwiXSA/PyBcIlwiKTtcbiAgICBjb25zdCBjd2QgPSBhcmdzW1wiY3dkXCJdID8gU3RyaW5nKGFyZ3NbXCJjd2RcIl0pIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGdpdE9wdGlvbnMgPSBjd2QgPyB7IGN3ZCB9IDoge307XG5cbiAgICBzd2l0Y2ggKG9wZXJhdGlvbikge1xuICAgICAgY2FzZSBcImNyZWF0ZS1icmFuY2gtbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IGlzc3VlTnVtYmVyID0gdG9OdW1iZXIoYXJnc1tcImlzc3VlLW51bWJlclwiXSwgMCk7XG4gICAgICAgIGNvbnN0IGlzc3VlVGl0bGUgPSBTdHJpbmcoYXJnc1tcImlzc3VlLXRpdGxlXCJdID8/IFwiXCIpO1xuICAgICAgICBpZiAoIWlzc3VlTnVtYmVyIHx8ICFpc3N1ZVRpdGxlKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgbWVzc2FnZTpcbiAgICAgICAgICAgICAgXCJNaXNzaW5nIHJlcXVpcmVkIGFyZ3VtZW50czogLS1pc3N1ZS1udW1iZXIsIC0taXNzdWUtdGl0bGVcIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG5hbWUgPSBjcmVhdGVCcmFuY2hOYW1lKGlzc3VlTnVtYmVyLCBpc3N1ZVRpdGxlKTtcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgbWVzc2FnZTogbmFtZSB9O1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwiY3JlYXRlLW1pbGVzdG9uZS1icmFuY2gtbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IG1pbGVzdG9uZVRpdGxlID0gU3RyaW5nKGFyZ3NbXCJtaWxlc3RvbmUtdGl0bGVcIl0gPz8gXCJcIik7XG4gICAgICAgIGlmICghbWlsZXN0b25lVGl0bGUpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICBtZXNzYWdlOiBcIk1pc3NpbmcgcmVxdWlyZWQgYXJndW1lbnQ6IC0tbWlsZXN0b25lLXRpdGxlXCIsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBuYW1lID0gY3JlYXRlTWlsZXN0b25lQnJhbmNoTmFtZShtaWxlc3RvbmVUaXRsZSk7XG4gICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIG1lc3NhZ2U6IG5hbWUgfTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcImlzLXByb3RlY3RlZC1icmFuY2hcIjoge1xuICAgICAgICBjb25zdCBicmFuY2hOYW1lID0gU3RyaW5nKGFyZ3NbXCJicmFuY2gtbmFtZVwiXSA/PyBcIlwiKTtcbiAgICAgICAgaWYgKCFicmFuY2hOYW1lKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgbWVzc2FnZTogXCJNaXNzaW5nIHJlcXVpcmVkIGFyZ3VtZW50OiAtLWJyYW5jaC1uYW1lXCIsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBpc1Byb3RlY3RlZCA9IGlzUHJvdGVjdGVkQnJhbmNoKGJyYW5jaE5hbWUpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgICAgbWVzc2FnZTogaXNQcm90ZWN0ZWQgPyBcInRydWVcIiA6IFwiZmFsc2VcIixcbiAgICAgICAgICBkYXRhOiB7IHByb3RlY3RlZDogaXNQcm90ZWN0ZWQgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcImNyZWF0ZS1mZWF0dXJlLWJyYW5jaFwiOiB7XG4gICAgICAgIGNvbnN0IGJyYW5jaE5hbWUgPSBTdHJpbmcoYXJnc1tcImJyYW5jaC1uYW1lXCJdID8/IFwiXCIpO1xuICAgICAgICBjb25zdCBiYXNlQnJhbmNoID0gU3RyaW5nKGFyZ3NbXCJiYXNlLWJyYW5jaFwiXSA/PyBcIlwiKTtcbiAgICAgICAgaWYgKCFicmFuY2hOYW1lIHx8ICFiYXNlQnJhbmNoKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgbWVzc2FnZTogXCJNaXNzaW5nIHJlcXVpcmVkIGFyZ3VtZW50czogLS1icmFuY2gtbmFtZSwgLS1iYXNlLWJyYW5jaFwiLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY3JlYXRlRmVhdHVyZUJyYW5jaEZyb21CYXNlKFxuICAgICAgICAgIGJyYW5jaE5hbWUsXG4gICAgICAgICAgYmFzZUJyYW5jaCxcbiAgICAgICAgICBnaXRPcHRpb25zLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN1Y2Nlc3M6IHJlc3VsdC5vayxcbiAgICAgICAgICBtZXNzYWdlOiByZXN1bHQub2sgPyByZXN1bHQudmFsdWUgOiByZXN1bHQuZXJyb3IubWVzc2FnZSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcImVuc3VyZS1taWxlc3RvbmUtYnJhbmNoXCI6IHtcbiAgICAgICAgY29uc3QgbWlsZXN0b25lQnJhbmNoID0gU3RyaW5nKGFyZ3NbXCJtaWxlc3RvbmUtYnJhbmNoXCJdID8/IFwiXCIpO1xuICAgICAgICBjb25zdCBkZWZhdWx0QnJhbmNoID0gU3RyaW5nKGFyZ3NbXCJkZWZhdWx0LWJyYW5jaFwiXSA/PyBcIlwiKTtcbiAgICAgICAgaWYgKCFtaWxlc3RvbmVCcmFuY2ggfHwgIWRlZmF1bHRCcmFuY2gpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICAgICBcIk1pc3NpbmcgcmVxdWlyZWQgYXJndW1lbnRzOiAtLW1pbGVzdG9uZS1icmFuY2gsIC0tZGVmYXVsdC1icmFuY2hcIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIC8vIElzc3VlICMzOTEwOiB0aGlzIHBhdGggbXVzdCBuZXZlciBmYWxsIGJhY2sgdG8gdGhlIGRlZmF1bHRcbiAgICAgICAgLy8gYnJhbmNoLiBBIGZhaWx1cmUgaXMgcmVwb3J0ZWQgYXMgYSBmYWlsdXJlLCBjYXJyeWluZyB0aGVcbiAgICAgICAgLy8gdW5kZXJseWluZyBnaXQgc3RkZXJyIHNvIHRoZSBjYWxsZXIgY2FuIG5hbWUgdGhlIGNhdXNlLlxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBlbnN1cmVNaWxlc3RvbmVCcmFuY2hFeGlzdHMoXG4gICAgICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgICAgICAgZ2l0T3B0aW9ucyxcbiAgICAgICAgICBlbnN1cmVEZWZhdWx0QnJhbmNoQ3VycmVudCxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiByZXN1bHQub2ssXG4gICAgICAgICAgbWVzc2FnZTogcmVzdWx0Lm9rID8gcmVzdWx0LnZhbHVlIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJyZWNvdmVyLWdpdC1zdGF0ZVwiOiB7XG4gICAgICAgIGNvbnN0IGRlZmF1bHRCcmFuY2ggPSBTdHJpbmcoYXJnc1tcImRlZmF1bHQtYnJhbmNoXCJdID8/IFwiXCIpO1xuICAgICAgICBpZiAoIWRlZmF1bHRCcmFuY2gpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICBtZXNzYWdlOiBcIk1pc3NpbmcgcmVxdWlyZWQgYXJndW1lbnQ6IC0tZGVmYXVsdC1icmFuY2hcIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlY292ZXJHaXRTdGF0ZShkZWZhdWx0QnJhbmNoLCBnaXRPcHRpb25zKTtcbiAgICAgICAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgbWVzc2FnZTogcmVzdWx0LmVycm9yLm1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB7IGFjdGlvbnMgfSA9IHJlc3VsdC52YWx1ZTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgIG1lc3NhZ2U6IGFjdGlvbnMubGVuZ3RoID4gMFxuICAgICAgICAgICAgPyBhY3Rpb25zLmpvaW4oXCJcXG5cIilcbiAgICAgICAgICAgIDogXCJObyByZWNvdmVyeSBuZWVkZWRcIixcbiAgICAgICAgICBkYXRhOiB7IGFjdGlvbnMgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcInNldHVwLXJlcG9cIjoge1xuICAgICAgICBjb25zdCByZXBvID0gU3RyaW5nKGFyZ3NbXCJyZXBvXCJdID8/IFwiXCIpO1xuICAgICAgICBjb25zdCB3b3JrRGlyID0gU3RyaW5nKGFyZ3NbXCJ3b3JrLWRpclwiXSA/PyBcIlwiKTtcbiAgICAgICAgaWYgKCFyZXBvIHx8ICF3b3JrRGlyKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgbWVzc2FnZTogXCJNaXNzaW5nIHJlcXVpcmVkIGFyZ3VtZW50czogLS1yZXBvLCAtLXdvcmstZGlyXCIsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYXdhaXQgc2V0dXBSZXBvKHJlcG8sIHdvcmtEaXIpO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwic3luYy1mZWF0dXJlLWJyYW5jaFwiOiB7XG4gICAgICAgIGNvbnN0IGJyYW5jaE5hbWUgPSBTdHJpbmcoYXJnc1tcImJyYW5jaC1uYW1lXCJdID8/IFwiXCIpO1xuICAgICAgICBjb25zdCBkZWZhdWx0QnJhbmNoID0gU3RyaW5nKGFyZ3NbXCJkZWZhdWx0LWJyYW5jaFwiXSA/PyBcIlwiKTtcbiAgICAgICAgaWYgKCFicmFuY2hOYW1lIHx8ICFkZWZhdWx0QnJhbmNoKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgbWVzc2FnZTpcbiAgICAgICAgICAgICAgXCJNaXNzaW5nIHJlcXVpcmVkIGFyZ3VtZW50czogLS1icmFuY2gtbmFtZSwgLS1kZWZhdWx0LWJyYW5jaFwiLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY0ZlYXR1cmVCcmFuY2hXaXRoRGVmYXVsdChcbiAgICAgICAgICBicmFuY2hOYW1lLFxuICAgICAgICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgICAgICAgZ2l0T3B0aW9ucyxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiByZXN1bHQub2ssXG4gICAgICAgICAgbWVzc2FnZTogcmVzdWx0Lm9rID8gcmVzdWx0LnZhbHVlIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJzeW5jLW1pbGVzdG9uZS1icmFuY2hcIjoge1xuICAgICAgICBjb25zdCBtaWxlc3RvbmVCcmFuY2ggPSBTdHJpbmcoYXJnc1tcIm1pbGVzdG9uZS1icmFuY2hcIl0gPz8gXCJcIik7XG4gICAgICAgIGNvbnN0IGRlZmF1bHRCcmFuY2ggPSBTdHJpbmcoYXJnc1tcImRlZmF1bHQtYnJhbmNoXCJdID8/IFwiXCIpO1xuICAgICAgICBpZiAoIW1pbGVzdG9uZUJyYW5jaCB8fCAhZGVmYXVsdEJyYW5jaCkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgIG1lc3NhZ2U6XG4gICAgICAgICAgICAgIFwiTWlzc2luZyByZXF1aXJlZCBhcmd1bWVudHM6IC0tbWlsZXN0b25lLWJyYW5jaCwgLS1kZWZhdWx0LWJyYW5jaFwiLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY01pbGVzdG9uZUJyYW5jaFdpdGhEZWZhdWx0KFxuICAgICAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICAgICAgICBkZWZhdWx0QnJhbmNoLFxuICAgICAgICAgIGdpdE9wdGlvbnMsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogcmVzdWx0Lm9rLFxuICAgICAgICAgIG1lc3NhZ2U6IHJlc3VsdC5vayA/IHJlc3VsdC52YWx1ZS5tZXNzYWdlIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJlbnN1cmUtZGVmYXVsdC1icmFuY2gtY3VycmVudFwiOiB7XG4gICAgICAgIGNvbnN0IGRlZmF1bHRCcmFuY2ggPSBTdHJpbmcoYXJnc1tcImRlZmF1bHQtYnJhbmNoXCJdID8/IFwiXCIpO1xuICAgICAgICBpZiAoIWRlZmF1bHRCcmFuY2gpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICBtZXNzYWdlOiBcIk1pc3NpbmcgcmVxdWlyZWQgYXJndW1lbnQ6IC0tZGVmYXVsdC1icmFuY2hcIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGVuc3VyZURlZmF1bHRCcmFuY2hDdXJyZW50KFxuICAgICAgICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgICAgICAgZ2l0T3B0aW9ucyxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiByZXN1bHQub2ssXG4gICAgICAgICAgbWVzc2FnZTogcmVzdWx0Lm9rID8gcmVzdWx0LnZhbHVlIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJwdXNoLXVucHVzaGVkLWNvbW1pdHNcIjoge1xuICAgICAgICBjb25zdCBicmFuY2hOYW1lID0gU3RyaW5nKGFyZ3NbXCJicmFuY2gtbmFtZVwiXSA/PyBcIlwiKTtcbiAgICAgICAgaWYgKCFicmFuY2hOYW1lKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgbWVzc2FnZTogXCJNaXNzaW5nIHJlcXVpcmVkIGFyZ3VtZW50OiAtLWJyYW5jaC1uYW1lXCIsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwdXNoVW5wdXNoZWRDb21taXRzKGJyYW5jaE5hbWUsIGdpdE9wdGlvbnMpO1xuICAgICAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBtZXNzYWdlOiByZXN1bHQuZXJyb3IubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICBtZXNzYWdlOiByZXN1bHQudmFsdWUgPiAwXG4gICAgICAgICAgICA/IGBTdWNjZXNzZnVsbHkgcHVzaGVkICR7cmVzdWx0LnZhbHVlfSBjb21taXQocykgdG8gb3JpZ2luYFxuICAgICAgICAgICAgOiBcIk5vIHVucHVzaGVkIGNvbW1pdHMg4oCUIGJyYW5jaCBpcyB1cCB0byBkYXRlIHdpdGggb3JpZ2luXCIsXG4gICAgICAgICAgZGF0YTogeyBjb21taXRzUHVzaGVkOiByZXN1bHQudmFsdWUgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcImRldGVjdC1wdXNoLXJlamVjdGlvblwiOiB7XG4gICAgICAgIGNvbnN0IHB1c2hPdXRwdXQgPSBTdHJpbmcoYXJnc1tcInB1c2gtb3V0cHV0XCJdID8/IFwiXCIpO1xuICAgICAgICBjb25zdCByZWplY3RlZCA9IGRldGVjdFB1c2hSZWplY3Rpb24ocHVzaE91dHB1dCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICBtZXNzYWdlOiByZWplY3RlZCA/IFwidHJ1ZVwiIDogXCJmYWxzZVwiLFxuICAgICAgICAgIGRhdGE6IHsgcmVqZWN0ZWQgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcImRldGVjdC1leGlzdGluZy1wclwiOiB7XG4gICAgICAgIGNvbnN0IGVycm9yT3V0cHV0ID0gU3RyaW5nKGFyZ3NbXCJlcnJvci1vdXRwdXRcIl0gPz8gXCJcIik7XG4gICAgICAgIGNvbnN0IHByVXJsID0gZGV0ZWN0RXhpc3RpbmdQcihlcnJvck91dHB1dCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICBtZXNzYWdlOiBwclVybCA/PyBcIlwiLFxuICAgICAgICAgIGRhdGE6IHsgcHJVcmwgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcImZpbmQtb3Blbi1wclwiOiB7XG4gICAgICAgIGNvbnN0IHJlcG8gPSBTdHJpbmcoYXJnc1tcInJlcG9cIl0gPz8gXCJcIik7XG4gICAgICAgIGNvbnN0IGJyYW5jaE5hbWUgPSBTdHJpbmcoYXJnc1tcImJyYW5jaC1uYW1lXCJdID8/IFwiXCIpO1xuICAgICAgICBpZiAoIXJlcG8gfHwgIWJyYW5jaE5hbWUpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICBtZXNzYWdlOiBcIk1pc3NpbmcgcmVxdWlyZWQgYXJndW1lbnRzOiAtLXJlcG8sIC0tYnJhbmNoLW5hbWVcIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGZpbmRPcGVuUHJGb3JCcmFuY2gocmVwbywgYnJhbmNoTmFtZSk7XG4gICAgICAgIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIG1lc3NhZ2U6IHJlc3VsdC5lcnJvci5tZXNzYWdlIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgIG1lc3NhZ2U6IHJlc3VsdC52YWx1ZSA/PyBcIlwiLFxuICAgICAgICAgIGRhdGE6IHsgcHJVcmw6IHJlc3VsdC52YWx1ZSB9LFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwicmVjb3Zlci1leGlzdGluZy1wclwiOiB7XG4gICAgICAgIGNvbnN0IHJlcG8gPSBTdHJpbmcoYXJnc1tcInJlcG9cIl0gPz8gXCJcIik7XG4gICAgICAgIGNvbnN0IGlzc3VlTnVtYmVyID0gdG9OdW1iZXIoYXJnc1tcImlzc3VlLW51bWJlclwiXSwgMCk7XG4gICAgICAgIGNvbnN0IHByVXJsID0gU3RyaW5nKGFyZ3NbXCJwci11cmxcIl0gPz8gXCJcIik7XG4gICAgICAgIGNvbnN0IHByQm9keSA9IGFyZ3NbXCJwci1ib2R5XCJdID8gU3RyaW5nKGFyZ3NbXCJwci1ib2R5XCJdKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKCFyZXBvIHx8ICFpc3N1ZU51bWJlciB8fCAhcHJVcmwpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICAgICBcIk1pc3NpbmcgcmVxdWlyZWQgYXJndW1lbnRzOiAtLXJlcG8sIC0taXNzdWUtbnVtYmVyLCAtLXByLXVybFwiLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVjb3ZlckV4aXN0aW5nUHIoXG4gICAgICAgICAgcmVwbyxcbiAgICAgICAgICBpc3N1ZU51bWJlcixcbiAgICAgICAgICBwclVybCxcbiAgICAgICAgICBwckJvZHksXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogcmVzdWx0Lm9rLFxuICAgICAgICAgIG1lc3NhZ2U6IHJlc3VsdC5vayA/IHJlc3VsdC52YWx1ZSA6IHJlc3VsdC5lcnJvci5tZXNzYWdlLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwicmVjb3Zlci1wdXNoLXJlamVjdGlvblwiOiB7XG4gICAgICAgIGNvbnN0IGJyYW5jaE5hbWUgPSBTdHJpbmcoYXJnc1tcImJyYW5jaC1uYW1lXCJdID8/IFwiXCIpO1xuICAgICAgICBpZiAoIWJyYW5jaE5hbWUpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICBtZXNzYWdlOiBcIk1pc3NpbmcgcmVxdWlyZWQgYXJndW1lbnQ6IC0tYnJhbmNoLW5hbWVcIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlY292ZXJGcm9tUHVzaFJlamVjdGlvbihicmFuY2hOYW1lLCBnaXRPcHRpb25zKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiByZXN1bHQub2ssXG4gICAgICAgICAgbWVzc2FnZTogcmVzdWx0Lm9rID8gcmVzdWx0LnZhbHVlIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJyZXNvbHZlLXJlYmFzZS1jb25mbGljdHNcIjoge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlUmViYXNlQ29uZmxpY3RzKGdpdE9wdGlvbnMpO1xuICAgICAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBtZXNzYWdlOiByZXN1bHQuZXJyb3IubWVzc2FnZSB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICAgYFJlc29sdmVkICR7cmVzdWx0LnZhbHVlLmZpbGVzUmVzb2x2ZWR9IGZpbGUocykgaW4gJHtyZXN1bHQudmFsdWUucm91bmRzfSByb3VuZChzKWAsXG4gICAgICAgICAgZGF0YTogcmVzdWx0LnZhbHVlLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwidmFsaWRhdGUtcmVwby1zdGF0ZVwiOiB7XG4gICAgICAgIGNvbnN0IGZlYXR1cmVCcmFuY2ggPSBTdHJpbmcoYXJnc1tcImZlYXR1cmUtYnJhbmNoXCJdID8/IFwiXCIpO1xuICAgICAgICBjb25zdCBiYXNlQnJhbmNoID0gU3RyaW5nKGFyZ3NbXCJiYXNlLWJyYW5jaFwiXSA/PyBcIlwiKTtcbiAgICAgICAgY29uc3QgYXR0ZW1wdFJlY292ZXJ5ID0gYXJnc1tcImF0dGVtcHQtcmVjb3ZlcnlcIl0gPT09IHRydWUgfHxcbiAgICAgICAgICBhcmdzW1wiYXR0ZW1wdC1yZWNvdmVyeVwiXSA9PT0gXCJ0cnVlXCI7XG4gICAgICAgIGlmICghZmVhdHVyZUJyYW5jaCB8fCAhYmFzZUJyYW5jaCkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgIG1lc3NhZ2U6XG4gICAgICAgICAgICAgIFwiTWlzc2luZyByZXF1aXJlZCBhcmd1bWVudHM6IC0tZmVhdHVyZS1icmFuY2gsIC0tYmFzZS1icmFuY2hcIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHZhbGlkYXRlUmVwb1N0YXRlKFxuICAgICAgICAgIGZlYXR1cmVCcmFuY2gsXG4gICAgICAgICAgYmFzZUJyYW5jaCxcbiAgICAgICAgICBhdHRlbXB0UmVjb3ZlcnksXG4gICAgICAgICAgZ2l0T3B0aW9ucyxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgbWVzc2FnZTogcmVzdWx0LmVycm9yLm1lc3NhZ2UgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB7IHZhbGlkLCBhY3Rpb25zLCB3YXJuaW5ncywgZXJyb3JDb2RlIH0gPSByZXN1bHQudmFsdWU7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogdmFsaWQsXG4gICAgICAgICAgbWVzc2FnZTogdmFsaWRcbiAgICAgICAgICAgID8gXCJSZXBvc2l0b3J5IHN0YXRlIHZhbGlkYXRpb24gcGFzc2VkXCJcbiAgICAgICAgICAgIDogYFJlcG9zaXRvcnkgc3RhdGUgdmFsaWRhdGlvbiBmYWlsZWQgKGVycm9yIGNvZGU6ICR7ZXJyb3JDb2RlfSlgLFxuICAgICAgICAgIGRhdGE6IHsgdmFsaWQsIGFjdGlvbnMsIHdhcm5pbmdzLCBlcnJvckNvZGUgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcInVwZGF0ZS1wci1icmFuY2hcIjoge1xuICAgICAgICBjb25zdCBicmFuY2hOYW1lID0gU3RyaW5nKGFyZ3NbXCJicmFuY2gtbmFtZVwiXSA/PyBcIlwiKTtcbiAgICAgICAgY29uc3QgYmFzZUJyYW5jaCA9IFN0cmluZyhhcmdzW1wiYmFzZS1icmFuY2hcIl0gPz8gXCJcIik7XG4gICAgICAgIGlmICghYnJhbmNoTmFtZSB8fCAhYmFzZUJyYW5jaCkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgIG1lc3NhZ2U6IFwiTWlzc2luZyByZXF1aXJlZCBhcmd1bWVudHM6IC0tYnJhbmNoLW5hbWUsIC0tYmFzZS1icmFuY2hcIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHVwZGF0ZVByQnJhbmNoKGJyYW5jaE5hbWUsIGJhc2VCcmFuY2gsIGdpdE9wdGlvbnMpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN1Y2Nlc3M6IHJlc3VsdC5vayxcbiAgICAgICAgICBtZXNzYWdlOiByZXN1bHQub2sgPyByZXN1bHQudmFsdWUgOiByZXN1bHQuZXJyb3IubWVzc2FnZSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY2FzZSBcImVuc3VyZS1wci1tZXJnZWFibGVcIjoge1xuICAgICAgICBjb25zdCByZXBvID0gU3RyaW5nKGFyZ3NbXCJyZXBvXCJdID8/IFwiXCIpO1xuICAgICAgICBjb25zdCBwck51bWJlciA9IHRvTnVtYmVyKGFyZ3NbXCJwci1udW1iZXJcIl0sIDApO1xuICAgICAgICBjb25zdCBicmFuY2hOYW1lID0gU3RyaW5nKGFyZ3NbXCJicmFuY2gtbmFtZVwiXSA/PyBcIlwiKTtcbiAgICAgICAgY29uc3QgYmFzZUJyYW5jaCA9IFN0cmluZyhhcmdzW1wiYmFzZS1icmFuY2hcIl0gPz8gXCJcIik7XG4gICAgICAgIGlmICghcmVwbyB8fCAhcHJOdW1iZXIgfHwgIWJyYW5jaE5hbWUgfHwgIWJhc2VCcmFuY2gpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICAgICBcIk1pc3NpbmcgcmVxdWlyZWQgYXJndW1lbnRzOiAtLXJlcG8sIC0tcHItbnVtYmVyLCAtLWJyYW5jaC1uYW1lLCAtLWJhc2UtYnJhbmNoXCIsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBlbnN1cmVQck1lcmdlYWJsZShcbiAgICAgICAgICByZXBvLFxuICAgICAgICAgIHByTnVtYmVyLFxuICAgICAgICAgIGJyYW5jaE5hbWUsXG4gICAgICAgICAgYmFzZUJyYW5jaCxcbiAgICAgICAgICBnaXRPcHRpb25zLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN1Y2Nlc3M6IHJlc3VsdC5vayxcbiAgICAgICAgICBtZXNzYWdlOiByZXN1bHQub2sgPyByZXN1bHQudmFsdWUgOiByZXN1bHQuZXJyb3IubWVzc2FnZSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICAgYFVua25vd24gZ2l0IG9wZXJhdGlvbjogJyR7b3BlcmF0aW9ufScuIFVzZSAtLW9wZXJhdGlvbiB3aXRoIG9uZSBvZjogY3JlYXRlLWJyYW5jaC1uYW1lLCBjcmVhdGUtbWlsZXN0b25lLWJyYW5jaC1uYW1lLCBpcy1wcm90ZWN0ZWQtYnJhbmNoLCBjcmVhdGUtZmVhdHVyZS1icmFuY2gsIGVuc3VyZS1taWxlc3RvbmUtYnJhbmNoLCByZWNvdmVyLWdpdC1zdGF0ZSwgc2V0dXAtcmVwbywgc3luYy1mZWF0dXJlLWJyYW5jaCwgc3luYy1taWxlc3RvbmUtYnJhbmNoLCBlbnN1cmUtZGVmYXVsdC1icmFuY2gtY3VycmVudCwgcHVzaC11bnB1c2hlZC1jb21taXRzLCBkZXRlY3QtcHVzaC1yZWplY3Rpb24sIGRldGVjdC1leGlzdGluZy1wciwgZmluZC1vcGVuLXByLCByZWNvdmVyLWV4aXN0aW5nLXByLCByZWNvdmVyLXB1c2gtcmVqZWN0aW9uLCByZXNvbHZlLXJlYmFzZS1jb25mbGljdHMsIHZhbGlkYXRlLXJlcG8tc3RhdGUsIHVwZGF0ZS1wci1icmFuY2gsIGVuc3VyZS1wci1tZXJnZWFibGVgLFxuICAgICAgICB9O1xuICAgIH1cbiAgfSxcbn07XG5cbi8qKlxuICogV2hlcmUgYSBjbG9uZSdzIGRlZmF1bHQtYnJhbmNoIGNhY2hlIGxpdmVzIChJc3N1ZSAjMTY1Mik6XG4gKiBgPGdpdCBjb21tb24gZGlyPi92aWJlL2RlZmF1bHRfYnJhbmNoYCDigJQgYC5naXQvdmliZS9kZWZhdWx0X2JyYW5jaGAgaW4gdGhlXG4gKiBzaGFyZWQgY2xvbmUsIGFuZCB0aGUgc2FtZSBmaWxlIGZvciBldmVyeSBsYW5lIHdvcmt0cmVlIGxpbmtlZCB0byBpdC5cbiAqXG4gKiBJdCB1c2VkIHRvIGJlIGAudmliZV9kZWZhdWx0X2JyYW5jaGAgYXQgdGhlIHJvb3Qgb2YgdGhlIHdvcmtpbmcgdHJlZS4gQVxuICogZmlsZSBpbiB0aGUgdHJlZSBpcyBhIGZpbGUgdGhlIHJlcG9zaXRvcnkgY2FuIGNvbW1pdCAodGhyZWUgbW9uaXRvcmVkXG4gKiByZXBvc2l0b3JpZXMgaGFkKSBhbmQgYSBmaWxlIGBnaXQgYWRkIC1BYCBzdGFnZXMsIHdoaWNoIGlzIGhvdyB0aGVcbiAqIG1lcmdlLWNvbmZsaWN0IHBhc3MncyBmaW5hbC1taWxlIGNvbW1pdCBjYW1lIHRvIGJlIHJlZnVzZWQgYnkgdGhlXG4gKiBwcmUtY29tbWl0IHNhZmV0eSBnYXRlIG9uIEdSUS1BdXRvVHJhZGVyIzU4IChJc3N1ZSAjMTY0NCkuIEluc2lkZSB0aGUgZ2l0XG4gKiBkaXJlY3RvcnkgaXQgY2FuIGJlIG5laXRoZXIgY29tbWl0dGVkIG5vciBzdGFnZWQsIGFuZCDigJQgYmVjYXVzZSB0aGUgcmVhZFxuICogaGFwcGVucyBiZWZvcmUgYHJlc2V0IC0taGFyZGAg4oCUIGEgcmVwb3NpdG9yeSBjYW4gbm8gbG9uZ2VyIHBsYW50IHRoZSB2YWx1ZVxuICogdGhlIHdvcmtlciBjaGVja3Mgb3V0IChJc3N1ZSAjMTI2OSBzdGF5cyBjbG9zZWQgYnkgY29uc3RydWN0aW9uLCBhbmQgdGhlXG4gKiBgYXNzZXJ0U2FmZVJlZkNvbXBvbmVudGAgY2hlY2sgc3RheXMgYXMgZGVmZW5jZSBpbiBkZXB0aCkuXG4gKlxuICogUmVzb2x2ZWQgdGhyb3VnaCBnaXQgcmF0aGVyIHRoYW4gYXNzdW1lZCB0byBiZSBgJHtyZXBvUGF0aH0vLmdpdGAsIHNvIGFcbiAqIGxhbmUgd29ya3RyZWUgKHdob3NlIGAuZ2l0YCBpcyBhIGZpbGUgcG9pbnRpbmcgYXQgdGhlIGNsb25lKSBzaGFyZXMgdGhlXG4gKiBjbG9uZSdzIGNhY2hlIGluc3RlYWQgb2YgZ2V0dGluZyBvbmUgb2YgaXRzIG93bi5cbiAqXG4gKiBAcGFyYW0gcmVwb1BhdGggLSBUaGUgY2xvbmUgb3Igd29ya3RyZWVcbiAqIEByZXR1cm5zIFRoZSBjYWNoZSBmaWxlJ3MgYWJzb2x1dGUgcGF0aCwgb3IgYG51bGxgIHdoZW4gdGhlIGdpdCBkaXJlY3RvcnlcbiAqICAgY291bGQgbm90IGJlIHJlc29sdmVkIChub3QgYSByZXBvc2l0b3J5LCBvciBnaXQgcmVmdXNlZClcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlZmF1bHRCcmFuY2hDYWNoZVBhdGgoXG4gIHJlcG9QYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLXBhdGgtZm9ybWF0PWFic29sdXRlXCIsIFwiLS1naXQtY29tbW9uLWRpclwiXSxcbiAgICB7IGN3ZDogcmVwb1BhdGggfSxcbiAgKTtcbiAgaWYgKCFyZXN1bHQub2sgfHwgcmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBnaXREaXIgPSByZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKTtcbiAgaWYgKGdpdERpci5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICByZXR1cm4gYCR7Z2l0RGlyfS92aWJlL2RlZmF1bHRfYnJhbmNoYDtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBjYWNoZWQgZGVmYXVsdCBicmFuY2ggZnJvbSB0aGUgY2xvbmUncyBnaXQgZGlyZWN0b3J5IChJc3N1ZSAjMTY1MikuXG4gKlxuICogQHJldHVybnMgVGhlIHRyaW1tZWQgY2FjaGVkIHZhbHVlLCBvciBgXCJcImAgd2hlbiB0aGVyZSBpcyBubyBjYWNoZVxuICovXG5hc3luYyBmdW5jdGlvbiByZWFkRGVmYXVsdEJyYW5jaENhY2hlKHJlcG9QYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBwYXRoID0gYXdhaXQgZGVmYXVsdEJyYW5jaENhY2hlUGF0aChyZXBvUGF0aCk7XG4gIGlmIChwYXRoID09PSBudWxsKSByZXR1cm4gXCJcIjtcbiAgdHJ5IHtcbiAgICByZXR1cm4gKGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHBhdGgpKS50cmltKCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG59XG5cbi8qKlxuICogV3JpdGUgdGhlIGRlZmF1bHQgYnJhbmNoIGludG8gdGhlIGNsb25lJ3MgZ2l0IGRpcmVjdG9yeSAoSXNzdWUgIzE2NTIpLFxuICogY3JlYXRpbmcgYHZpYmUvYCB3aGVuIGFic2VudC4gQSB3cml0ZSB0aGF0IGZhaWxzIGlzIHJlcG9ydGVkIHdpdGggdGhlIHBhdGhcbiAqIHJhdGhlciB0aGFuIHN3YWxsb3dlZDogdGhlIG5leHQgcnVuIHdvdWxkIG90aGVyd2lzZSBzaWxlbnRseSBsb3NlIHRoZVxuICogY2FjaGUgYW5kIG5vYm9keSB3b3VsZCBrbm93IHdoeS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gd3JpdGVEZWZhdWx0QnJhbmNoQ2FjaGUoXG4gIHJlcG9QYXRoOiBzdHJpbmcsXG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZyxcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIGNvbnN0IHBhdGggPSBhd2FpdCBkZWZhdWx0QnJhbmNoQ2FjaGVQYXRoKHJlcG9QYXRoKTtcbiAgaWYgKHBhdGggPT09IG51bGwpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCByZXNvbHZlIHRoZSBnaXQgZGlyZWN0b3J5IG9mICR7cmVwb1BhdGh9IHRvIHN0b3JlIHRoZSBgICtcbiAgICAgICAgICBgZGVmYXVsdC1icmFuY2ggY2FjaGUgKElzc3VlICMxNjUyKWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKHBhdGguc2xpY2UoMCwgcGF0aC5sYXN0SW5kZXhPZihcIi9cIikpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUocGF0aCwgZGVmYXVsdEJyYW5jaCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCB3cml0ZSB0aGUgZGVmYXVsdC1icmFuY2ggY2FjaGUgJHtwYXRofTogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfSAoSXNzdWUgIzE2NTIpYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIENsYXNzaWZ5IGEgYHJ1bkdpdENvbW1hbmRgIG91dGNvbWUgYXMgY2xvbmUgY29ycnVwdGlvbiAoSXNzdWUgIzI5NTcpLlxuICpcbiAqIEEgZmFpbGVkIHJlc2V0L2NoZWNrb3V0L2ZldGNoIGR1cmluZyB0aGUgcmV1c2UgcGF0aCBjYW4gbWVhbiBtYW55IHRoaW5ncztcbiAqIG9ubHkgdGhlIHN1YnNldCBgaXNDbG9uZUNvcnJ1cHRpb25gIHJlY29nbmlzZXMgKGUuZy4gYSBiYWQgb2JqZWN0L3JlZikgaXNcbiAqIHdvcnRoIG1vdmluZyB0aGUgY2xvbmUgYXNpZGUgZm9yLCBzbyBldmVyeSBvdGhlciBmYWlsdXJlIGtlZXBzIHRvZGF5J3NcbiAqIGJlaGF2aW91ciBvZiBiZWluZyBsb2dnZWQvaWdub3JlZCBieSBpdHMgY2FsbGVyLlxuICpcbiAqIEByZXR1cm5zIHRoZSBjb21iaW5lZCBnaXQgb3V0cHV0IHdoZW4gaXQgaXMgY2xvbmUgY29ycnVwdGlvbiwgZWxzZSBgbnVsbGAuXG4gKi9cbmZ1bmN0aW9uIGNsYXNzaWZ5R2l0Q29ycnVwdGlvbihcbiAgcmVzdWx0OiBSZXN1bHQ8eyBjb2RlOiBudW1iZXI7IHN0ZG91dDogc3RyaW5nOyBzdGRlcnI6IHN0cmluZyB9Pixcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIXJlc3VsdC5vayB8fCByZXN1bHQudmFsdWUuY29kZSA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNvbWJpbmVkID0gYCR7cmVzdWx0LnZhbHVlLnN0ZG91dH1cXG4ke3Jlc3VsdC52YWx1ZS5zdGRlcnJ9YDtcbiAgcmV0dXJuIGlzQ2xvbmVDb3JydXB0aW9uKGNvbWJpbmVkKSA/IGNvbWJpbmVkIDogbnVsbDtcbn1cblxuLyoqXG4gKiBTZXR1cCBhIHJlcG9zaXRvcnkgZm9yIHdvcmsgKGNsb25lIG9yIHVwZGF0ZSkuXG4gKlxuICogVGhpcyBvcGVyYXRpb24gb3JjaGVzdHJhdGVzIG11bHRpcGxlIGdpdCBjb21tYW5kcyBhbmQgc2lkZSBlZmZlY3RzLlxuICpcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSB3b3JrRGlyIC0gRGlyZWN0b3J5IHdoZXJlIHJlcG9zIGFyZSBjbG9uZWRcbiAqIEByZXR1cm5zIENvbW1hbmRSZXN1bHQgd2l0aCB0aGUgcmVwbyBwYXRoXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXR1cFJlcG8oXG4gIHJlcG86IHN0cmluZyxcbiAgd29ya0Rpcjogc3RyaW5nLFxuICBvd25lcnNoaXBDaGVjazogKHBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCBudWxsPiA9XG4gICAgY2hlY2tDbG9uZU93bmVyc2hpcCxcbiAgZ2l0OiB0eXBlb2YgcnVuR2l0Q29tbWFuZCA9IHJ1bkdpdENvbW1hbmQsXG4pOiBQcm9taXNlPENvbW1hbmRSZXN1bHQ+IHtcbiAgY29uc3QgcmVwb05hbWUgPSByZXBvLnNwbGl0KFwiL1wiKS5wb3AoKSA/PyByZXBvO1xuICBjb25zdCByZXBvUGF0aCA9IGAke3dvcmtEaXJ9LyR7cmVwb05hbWV9YDtcblxuICAvLyBEZWZlbmNlIGluIGRlcHRoIChJc3N1ZSAjMjY5Mik6IHJlamVjdCBhbnkgc2x1ZyB3aG9zZSBkZXJpdmVkIHBhdGhcbiAgLy8gd291bGQgZXNjYXBlIFdPUktfRElSIGJlZm9yZSBydW5uaW5nIGRlc3RydWN0aXZlIGdpdCBjb21tYW5kcy4gVGhlXG4gIC8vIHRpZ2h0ZW5lZCBSRVBPX1NMVUdfUEFUVEVSTiBhbHJlYWR5IHJlamVjdHMgYC4uYC9kb3Qtb25seSBzZWdtZW50cyBhdFxuICAvLyB0aGUgY29uZmlnL2FkZC1yZXBvIGJvdW5kYXJ5LCBidXQgc2V0dXBSZXBvKCkgaXMgdGhlIGNob2tlLXBvaW50IHRoYXRcbiAgLy8gcnVucyBgZ2l0IHJlc2V0IC0taGFyZGAgLyBgZ2l0IGNsZWFuIC1mZGAsIHNvIGl0IHJlLWFzc2VydHMgdGhlXG4gIC8vIGludmFyaWFudCByYXRoZXIgdGhhbiB0cnVzdGluZyB1cHN0cmVhbSB2YWxpZGF0aW9uLlxuICBpZiAoXG4gICAgcmVwb05hbWUgPT09IFwiXCIgfHwgcmVwb05hbWUgPT09IFwiLlwiIHx8IHJlcG9OYW1lID09PSBcIi4uXCIgfHxcbiAgICByZXBvTmFtZS5pbmNsdWRlcyhcIi9cIikgfHwgcmVwb05hbWUuaW5jbHVkZXMoXCJcXFxcXCIpXG4gICkge1xuICAgIHJldHVybiB7XG4gICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2U6IGBSZWZ1c2luZyB0byBzZXQgdXAgcmVwbyB3aXRoIHVuc2FmZSBwYXRoIHNlZ21lbnQgYCArXG4gICAgICAgIGBcIiR7cmVwb05hbWV9XCIgZGVyaXZlZCBmcm9tIHNsdWcgXCIke3JlcG99XCIuYCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3Qgb3duZXJzaGlwRXJyb3IgPSBhd2FpdCBvd25lcnNoaXBDaGVjayhyZXBvUGF0aCk7XG4gIGlmIChvd25lcnNoaXBFcnJvcikgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIG1lc3NhZ2U6IG93bmVyc2hpcEVycm9yIH07XG5cbiAgLy8gQSBkaXJlY3RvcnkgbGVmdCBieSBhbiBpbnRlcnJ1cHRlZCBjbG9uZSBob2xkcyBubyByZXBvc2l0b3J5OiBldmVyeSBnaXRcbiAgLy8gY2FsbCBpbiBpdCBkaWVzIGF0IHRoZSBmaWxlc3lzdGVtIGJvdW5kYXJ5LCB3ZWRnaW5nIGVhY2ggcnVuIGF0IHNldHVwLlxuICAvLyBEaXNjYXJkIGl0IHNvIHRoZSBjbG9uZSBiZWxvdyBzdGFydHMgYWZyZXNoIChJc3N1ZSAjMjg0OCkuXG4gIGNvbnN0IGRpc2NhcmRlZCA9IGF3YWl0IGRpc2NhcmRCcm9rZW5DbG9uZShyZXBvUGF0aCk7XG4gIGlmICghZGlzY2FyZGVkLm9rKSB7XG4gICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIG1lc3NhZ2U6IGRpc2NhcmRlZC5lcnJvci5tZXNzYWdlIH07XG4gIH1cblxuICAvLyBBIGNsb25lIHdob3NlIGAuZ2l0YCBkaXJlY3RvcnkgaXMgcHJlc2VudCBidXQgY29ycnVwdCAoZS5nLiBhIGdhcmJhZ2VcbiAgLy8gYC5naXQvY29uZmlnYCBsaW5lKSBmYWlscyBldmVyeSBnaXQgY2FsbCBiZWZvcmUgc2V0dXAgZXZlciByZWFjaGVzIHRoZVxuICAvLyByZXVzZSBsb2dpYyBiZWxvdy4gTW92ZSBpdCBhc2lkZSBhbmQgcmUtY2xvbmUsIGF0IG1vc3Qgb25jZSBwZXIgcmVwbyBwZXJcbiAgLy8gMjQgaCBwZXIgaG9zdCAoSXNzdWUgIzI5NTcpIOKAlCBhIGhlYWx0aHkgY2xvbmUgaXMgbmV2ZXIgdG91Y2hlZC5cbiAgbGV0IHJlY292ZXJ5QXNpZGU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgcHJlUHJvYmU6IHN0cmluZyB8IG51bGw7XG4gIHRyeSB7XG4gICAgcHJlUHJvYmUgPSBhd2FpdCBwcm9iZUNvcnJ1cHRDbG9uZShyZXBvUGF0aCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIG1lc3NhZ2U6IFN0cmluZyhlcnJvcikgfTtcbiAgfVxuICBpZiAocHJlUHJvYmUgIT09IG51bGwpIHtcbiAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCByZWNvdmVyQ29ycnVwdENsb25lKFxuICAgICAgcmVwbyxcbiAgICAgIHJlcG9QYXRoLFxuICAgICAgd29ya0RpcixcbiAgICAgIHByZVByb2JlLFxuICAgICk7XG4gICAgaWYgKCFyZWNvdmVyZWQub2spIHtcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBtZXNzYWdlOiByZWNvdmVyZWQuZXJyb3IubWVzc2FnZSB9O1xuICAgIH1cbiAgICByZWNvdmVyeUFzaWRlID0gcmVjb3ZlcmVkLnZhbHVlO1xuICB9XG5cbiAgLy8gQ2hlY2sgaWYgcmVwbyBkaXJlY3RvcnkgZXhpc3RzXG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChyZXBvUGF0aCk7XG4gICAgaWYgKHN0YXQuaXNEaXJlY3RvcnkpIHtcbiAgICAgIGNvbnN0IHJldXNlRXJyb3IgPSBvd25lcnNoaXBDaGVjayA9PT0gY2hlY2tDbG9uZU93bmVyc2hpcFxuICAgICAgICA/IGF3YWl0IGNoZWNrQ2xvbmVPd25lcnNoaXAocmVwb1BhdGgsIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCB0cnVlKVxuICAgICAgICA6IGF3YWl0IG93bmVyc2hpcENoZWNrKHJlcG9QYXRoKTtcbiAgICAgIGlmIChyZXVzZUVycm9yKSByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgbWVzc2FnZTogcmV1c2VFcnJvciB9O1xuICAgICAgLy8gVXBkYXRlIGV4aXN0aW5nIHJlcG9cbiAgICAgIGNvbnN0IGRlZmF1bHRCcmFuY2hSZXN1bHQgPSBhd2FpdCBnaXQoXG4gICAgICAgIFtcInN5bWJvbGljLXJlZlwiLCBcInJlZnMvcmVtb3Rlcy9vcmlnaW4vSEVBRFwiXSxcbiAgICAgICAgeyBjd2Q6IHJlcG9QYXRoIH0sXG4gICAgICApO1xuICAgICAgbGV0IGRlZmF1bHRCcmFuY2ggPSBcIm1haW5cIjsgLy8gYWxsb3ctaGFyZGNvZGVkLWJyYW5jaCDigJQgZmFsbGJhY2sgYWZ0ZXIgZ2l0IHN5bWJvbGljLXJlZlxuICAgICAgaWYgKGRlZmF1bHRCcmFuY2hSZXN1bHQub2sgJiYgZGVmYXVsdEJyYW5jaFJlc3VsdC52YWx1ZS5jb2RlID09PSAwKSB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGRlZmF1bHRCcmFuY2hSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKTtcbiAgICAgICAgZGVmYXVsdEJyYW5jaCA9IHJlZi5yZXBsYWNlKFwicmVmcy9yZW1vdGVzL29yaWdpbi9cIiwgXCJcIik7XG4gICAgICB9XG5cbiAgICAgIC8vIFJlYWQgdGhlIGNhY2hlZCBkZWZhdWx0IGJyYW5jaCBpZiBhdmFpbGFibGUuIEl0IGxpdmVzIGluIHRoZSBjbG9uZSdzXG4gICAgICAvLyBnaXQgZGlyZWN0b3J5IChgLmdpdC92aWJlL2RlZmF1bHRfYnJhbmNoYCwgSXNzdWUgIzE2NTIpLCBuZXZlciBpbiB0aGVcbiAgICAgIC8vIHdvcmtpbmcgdHJlZSDigJQgc28gYSByZXBvc2l0b3J5IGNhbm5vdCBjb21taXQgdGhlIHZhbHVlIHRoZSB3b3JrZXJcbiAgICAgIC8vIHJlYWRzIChJc3N1ZSAjMTI2OSkgYW5kIGBnaXQgYWRkIC1BYCBjYW5ub3Qgc3RhZ2UgaXQgKElzc3VlICMxNjQ0KS5cbiAgICAgIC8vIFRoZSB2YWx1ZSBpcyBzdGlsbCB2YWxpZGF0ZWQgYXMgYSByZWYgY29tcG9uZW50IGJlZm9yZSBpdCBjYW4gcmVhY2hcbiAgICAgIC8vIGBnaXQgY2hlY2tvdXRgIGFzIGEgcG9zaXRpb25hbDogZGVmZW5jZSBpbiBkZXB0aCBjb3N0cyBvbmUgY2FsbC5cbiAgICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IHJlYWREZWZhdWx0QnJhbmNoQ2FjaGUocmVwb1BhdGgpO1xuICAgICAgaWYgKGNhY2hlZCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGFzc2VydFNhZmVSZWZDb21wb25lbnQoY2FjaGVkLCBcImNhY2hlZCBkZWZhdWx0IGJyYW5jaFwiKTtcbiAgICAgICAgICBkZWZhdWx0QnJhbmNoID0gY2FjaGVkO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIC8vIElnbm9yZSB0aGUgYmFkIGNhY2hlIHJhdGhlciB0aGFuIGxhdGNoIG9uIGl0OyBgZGVmYXVsdEJyYW5jaGBcbiAgICAgICAgICAvLyBzdGlsbCBob2xkcyB0aGUgdmFsdWUgYGdpdCBzeW1ib2xpYy1yZWZgIGRlcml2ZWQgYWJvdmUsIGFuZCB0aGVcbiAgICAgICAgICAvLyByZXdyaXRlIGF0IHRoZSBlbmQgb2YgdGhpcyBzZXR1cCByZXBsYWNlcyB0aGUgZmlsZS5cbiAgICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgICAgYFtzZXR1cC1yZXBvXSBTRUNVUklUWSAoSXNzdWUgIzEyNjkpOiBpZ25vcmluZyBgICtcbiAgICAgICAgICAgICAgYCR7YXdhaXQgZGVmYXVsdEJyYW5jaENhY2hlUGF0aChyZXBvUGF0aCl9IOKAlCBgICtcbiAgICAgICAgICAgICAgYCR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfS4gYCArXG4gICAgICAgICAgICAgIGBGYWxsaW5nIGJhY2sgdG8gJyR7ZGVmYXVsdEJyYW5jaH0nLmAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBSZWNvdmVyIGZyb20gYnJva2VuIGdpdCBzdGF0ZXMgKElzc3VlICM0NjcpXG4gICAgICBhd2FpdCByZWNvdmVyR2l0U3RhdGUoZGVmYXVsdEJyYW5jaCwgeyBjd2Q6IHJlcG9QYXRoIH0pO1xuXG4gICAgICBjb25zdCByZXNldEhlYWRSZXN1bHQgPSBhd2FpdCBnaXQoW1wicmVzZXRcIiwgXCItLWhhcmRcIiwgXCJIRUFEXCJdLCB7XG4gICAgICAgIGN3ZDogcmVwb1BhdGgsXG4gICAgICB9KTtcbiAgICAgIC8vIElzc3VlICMxNDQzOiB0aGUgY2xlYW4gYWxzbyBlcmFzZXMgdGhlIGlnbm9yZWQgZGlyZWN0b3JpZXMgdGhhdCBjYXJyeVxuICAgICAgLy8gZXhlY3V0YWJsZSBjb250ZW50IChgbm9kZV9tb2R1bGVzL2AsIGAudmVudi9gLCBgdGFyZ2V0L2AsIOKApiksIHNvIGFcbiAgICAgIC8vIHByZXZpb3VzIHJ1biBjYW5ub3QgbGVhdmUgc29tZXRoaW5nIGJlaGluZCBmb3IgdGhpcyBvbmUgdG8gZXhlY3V0ZS5cbiAgICAgIC8vIFB1cmUgZG93bmxvYWQgY2FjaGVzIGFyZSBsZWZ0IHdhcm0g4oCUIHNlZSBgaWdub3JlZF9wYXRoX2NsZWFuLnRzYC5cbiAgICAgIC8vIEEgY2xlYW4gdGhhdCBjb3VsZCBub3QgZG8gdGhhdCByZWZ1c2VzIHRoZSBzZXR1cCByYXRoZXIgdGhhbiBoYW5kaW5nXG4gICAgICAvLyB0aGUgcnVuIGEgdHJlZSB3aG9zZSBleGVjdXRhYmxlIGNvbnRlbnQgaXMgbGFzdCBydW4ncy5cbiAgICAgIGNvbnN0IGNsZWFuZWQgPSBhd2FpdCBjbGVhbldvcmtpbmdUcmVlKHsgY3dkOiByZXBvUGF0aCB9KTtcbiAgICAgIGlmICghY2xlYW5lZC5vaykge1xuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgbWVzc2FnZTogY2xlYW5lZC5lcnJvci5tZXNzYWdlIH07XG4gICAgICB9XG5cbiAgICAgIC8vIE1lYXN1cmUgYW5kIGNvbXBhY3Qgc2Vzc2lvbiBiZWZvcmUgcmVzdG9yaW5nIChJc3N1ZSAjMTMyOClcbiAgICAgIGNvbnN0IHNlc3Npb25TdG9yZVBhdGggPSBnZXRTZXNzaW9uU3RvcmVQYXRoKHdvcmtEaXIsIHJlcG8pO1xuICAgICAgY29uc3Qgc2l6ZVJlc3VsdCA9IGF3YWl0IG1lYXN1cmVTZXNzaW9uU2l6ZShzZXNzaW9uU3RvcmVQYXRoKTtcbiAgICAgIGlmIChzaXplUmVzdWx0Lm9rICYmIHNpemVSZXN1bHQudmFsdWUgPiAwKSB7XG4gICAgICAgIGNvbnN0IG1heFNlc3Npb25TaXplID0gT1BFUkFUSU9OQUxfREVGQVVMVFMubWF4U2Vzc2lvblNpemVCeXRlcztcbiAgICAgICAgY29uc3QgbWF4U2Vzc2lvbkFnZSA9IE9QRVJBVElPTkFMX0RFRkFVTFRTLm1heFNlc3Npb25BZ2VEYXlzO1xuICAgICAgICBpZiAoc2l6ZVJlc3VsdC52YWx1ZSA+IG1heFNlc3Npb25TaXplKSB7XG4gICAgICAgICAgYXdhaXQgY29tcGFjdFNlc3Npb24oc2Vzc2lvblN0b3JlUGF0aCwge1xuICAgICAgICAgICAgbWF4U2l6ZUJ5dGVzOiBtYXhTZXNzaW9uU2l6ZSxcbiAgICAgICAgICAgIG1heEFnZURheXM6IG1heFNlc3Npb25BZ2UsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gUmVzdG9yZSBwZXItcmVwbyBDbGF1ZGUgc2Vzc2lvbiBzdGF0ZSAoSXNzdWUgIzEzMjEsIHJlcGxhY2VzIElzc3VlICMzODQgYmxhbmtldCBkZWxldGlvbilcbiAgICAgIGF3YWl0IHJlc3RvcmVTZXNzaW9uKHJlcG9QYXRoLCB3b3JrRGlyLCByZXBvKTtcblxuICAgICAgY29uc3QgY2hlY2tvdXRSZXN1bHQgPSBhd2FpdCBnaXQoXG4gICAgICAgIGJ1aWxkQ2hlY2tvdXRBcmdzKGRlZmF1bHRCcmFuY2gpLFxuICAgICAgICB7IGN3ZDogcmVwb1BhdGggfSxcbiAgICAgICk7XG5cbiAgICAgIC8vIFJlcGFpciBhIGxlZ2FjeSBzaW5nbGUtYnJhbmNoIGNsb25lIChJc3N1ZSAjMjExKS4gQSBjbG9uZSBtYWRlIHdpdGggYVxuICAgICAgLy8gYmFyZSBgLS1kZXB0aD0xYCBvbmx5IGV2ZXIgdHJhY2tzIHRoZSBkZWZhdWx0IGJyYW5jaCwgc28gZXZlcnlcbiAgICAgIC8vIGZlYXR1cmUgYnJhbmNoIGlzIGludmlzaWJsZSB0byBgb3JpZ2luLzxicmFuY2g+YCDigJQgd2hpY2ggbWFkZSBhIGdvb2RcbiAgICAgIC8vIHB1c2ggbG9vayBmYWlsZWQgYW5kIGEgbWVyZ2VhYmxlIFBSIGxvb2sgY29uZmxpY3RlZC4gUmUtZmV0Y2hcbiAgICAgIC8vIGltbWVkaWF0ZWx5IGFmdGVyIGEgcmVwYWlyIHNvIHRoZSB0cmFja2luZyByZWZzIGFjdHVhbGx5IG1hdGVyaWFsaXNlLlxuICAgICAgY29uc3QgcmVmc3BlY1JlcGFpciA9IGF3YWl0IGVuc3VyZUFsbEJyYW5jaGVzRmV0Y2hSZWZzcGVjKHtcbiAgICAgICAgY3dkOiByZXBvUGF0aCxcbiAgICAgIH0pO1xuICAgICAgaWYgKCFyZWZzcGVjUmVwYWlyLm9rKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICBgW3NldHVwLXJlcG9dIENvdWxkIG5vdCBjaGVjayB0aGUgZmV0Y2ggcmVmc3BlYyBmb3IgJHtyZXBvfTogJHtyZWZzcGVjUmVwYWlyLmVycm9yLm1lc3NhZ2V9YCxcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSBpZiAocmVmc3BlY1JlcGFpci52YWx1ZS5yZXBhaXJlZCkge1xuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBgW3NldHVwLXJlcG9dIFJlcGFpcmVkIHNpbmdsZS1icmFuY2ggZmV0Y2ggcmVmc3BlYyBmb3IgJHtyZXBvfSAoSXNzdWUgIzIxMSk6IHdhcyBbJHtcbiAgICAgICAgICAgIHJlZnNwZWNSZXBhaXIudmFsdWUuYmVmb3JlLmpvaW4oXCIsIFwiKVxuICAgICAgICAgIH1dYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlZnNwZWNXYXNSZXBhaXJlZCA9IHJlZnNwZWNSZXBhaXIub2sgJiZcbiAgICAgICAgcmVmc3BlY1JlcGFpci52YWx1ZS5yZXBhaXJlZDtcblxuICAgICAgLy8gRmFzdC1wYXRoOiBpZiBgb3JpZ2luLzxkZWZhdWx0QnJhbmNoPmAgYWxyZWFkeSBtYXRjaGVzIHRoZSByZW1vdGVcbiAgICAgIC8vIHRpcCwgc2tpcCBgZ2l0IGZldGNoIG9yaWdpbmAgKElzc3VlICMxODEwKS4gTW9zdCBwcmlvcml0eSBjeWNsZXMgb25cbiAgICAgIC8vIG1vc3QgcmVwb3MgYXJlIG5vLW9wIGZldGNoZXM7IGBnaXQgbHMtcmVtb3RlIHJlZnMvaGVhZHMvPGJyYW5jaD5gXG4gICAgICAvLyBpcyBhIHNpbmdsZSB+MSBLQiByb3VuZC10cmlwIGNhY2hlZCBmb3IgNjAgcy4gRmFpbHVyZXMgZmFsbCB0aHJvdWdoXG4gICAgICAvLyB0byB0aGUgb3JpZ2luYWwgZmV0Y2ggcGF0aC5cbiAgICAgIGNvbnN0IGZyZXNobmVzcyA9IGF3YWl0IGlzTG9jYWxEZWZhdWx0QnJhbmNoVXBUb0RhdGUoXG4gICAgICAgIHJlcG9QYXRoLFxuICAgICAgICBkZWZhdWx0QnJhbmNoLFxuICAgICAgKTtcbiAgICAgIGxldCBmZXRjaFJlc3VsdDpcbiAgICAgICAgfCBSZXN1bHQ8XG4gICAgICAgICAgeyBjb2RlOiBudW1iZXI7IHN0ZG91dDogc3RyaW5nOyBzdGRlcnI6IHN0cmluZyB9XG4gICAgICAgID5cbiAgICAgICAgfCBudWxsID0gbnVsbDtcbiAgICAgIGlmIChmcmVzaG5lc3MudXBUb0RhdGUgJiYgIXJlZnNwZWNXYXNSZXBhaXJlZCkge1xuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBgW3NldHVwLXJlcG9dIGZhc3QtcGF0aCBza2lwIChJc3N1ZSAjMTgxMCk6ICR7cmVwb30gJHtmcmVzaG5lc3MucmVhc29ufSAocmVtb3RlLXNoYSBzb3VyY2U6ICR7ZnJlc2huZXNzLnJlbW90ZVNoYVNvdXJjZX0pYCxcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgIGBbc2V0dXAtcmVwb10gZnVsbCBmZXRjaCAoSXNzdWUgIzE4MTApOiAke3JlcG99ICR7XG4gICAgICAgICAgICByZWZzcGVjV2FzUmVwYWlyZWQgPyBcImZldGNoIHJlZnNwZWMgcmVwYWlyZWRcIiA6IGZyZXNobmVzcy5yZWFzb25cbiAgICAgICAgICB9YCxcbiAgICAgICAgKTtcblxuICAgICAgICAvLyBQcmUtY2hlY2sgZGlzayBzcGFjZSBiZWZvcmUgZmV0Y2ggKElzc3VlICMxMTc0KVxuICAgICAgICBjb25zdCBmZXRjaFNwYWNlQ2hlY2sgPSBhd2FpdCByZXF1aXJlRGlza1NwYWNlRm9yR2l0T3BlcmF0aW9uKFxuICAgICAgICAgIHJlcG9QYXRoLFxuICAgICAgICAgIFwiZ2l0IGZldGNoIG9yaWdpblwiLFxuICAgICAgICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLm1pbkRpc2tTcGFjZU1iLFxuICAgICAgICApO1xuICAgICAgICBpZiAoIWZldGNoU3BhY2VDaGVjay5vaykge1xuICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBtZXNzYWdlOiBmZXRjaFNwYWNlQ2hlY2suZXJyb3IubWVzc2FnZSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgZmV0Y2hSZXN1bHQgPSBhd2FpdCBnaXQoW1wiZmV0Y2hcIiwgXCJvcmlnaW5cIl0sIHtcbiAgICAgICAgICBjd2Q6IHJlcG9QYXRoLFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gQWx3YXlzIHJlc2V0IGhhcmQgdG8gb3JpZ2luLzxkZWZhdWx0QnJhbmNoPiDigJQgcHVyZWx5IGxvY2FsIGNsZWFudXBcbiAgICAgIC8vIHRoYXQgZGlzY2FyZHMgYW55IHVuY29tbWl0dGVkIHN0YXRlIGZyb20gdGhlIHByZXZpb3VzIGl0ZXJhdGlvbi5cbiAgICAgIGNvbnN0IHJlc2V0T3JpZ2luUmVzdWx0ID0gYXdhaXQgZ2l0KFxuICAgICAgICBbXCJyZXNldFwiLCBcIi0taGFyZFwiLCBgb3JpZ2luLyR7ZGVmYXVsdEJyYW5jaH1gXSxcbiAgICAgICAgeyBjd2Q6IHJlcG9QYXRoIH0sXG4gICAgICApO1xuXG4gICAgICAvLyBDbG9uZSBjb3JydXB0aW9uIChJc3N1ZSAjMjk1Nyk6IGEgYmFkIG9iamVjdC9yZWYgc3VyZmFjZXMgYXMgYVxuICAgICAgLy8gbm9uLXplcm8gZXhpdCBmcm9tIG9uZSBvZiB0aGUgY29tbWFuZHMgYWJvdmUgcmF0aGVyIHRoYW4gZnJvbSB0aGVcbiAgICAgIC8vIGBnaXQgcmV2LXBhcnNlIC0tZ2l0LWRpcmAgcHJvYmUgcnVuIGJlZm9yZSB0aGlzIGJyYW5jaCwgc2luY2UgdGhlXG4gICAgICAvLyBnaXQgZGlyZWN0b3J5IGl0c2VsZiBzdGlsbCByZXNvbHZlcy4gT25seSB0aGUgc3Vic2V0IG9mIGZhaWx1cmVzXG4gICAgICAvLyBgaXNDbG9uZUNvcnJ1cHRpb25gIHJlY29nbmlzZXMgaXMgdHJlYXRlZCB0aGlzIHdheSDigJQgZXZlcnkgb3RoZXJcbiAgICAgIC8vIGZhaWx1cmUga2VlcHMgdG9kYXkncyBiZWhhdmlvdXIgb2YgYmVpbmcgc2lsZW50bHkgY2FycmllZCBmb3J3YXJkLlxuICAgICAgY29uc3QgY29ycnVwdGlvbiA9IGNsYXNzaWZ5R2l0Q29ycnVwdGlvbihyZXNldEhlYWRSZXN1bHQpID8/XG4gICAgICAgIGNsYXNzaWZ5R2l0Q29ycnVwdGlvbihjaGVja291dFJlc3VsdCkgPz9cbiAgICAgICAgKGZldGNoUmVzdWx0ID8gY2xhc3NpZnlHaXRDb3JydXB0aW9uKGZldGNoUmVzdWx0KSA6IG51bGwpID8/XG4gICAgICAgIGNsYXNzaWZ5R2l0Q29ycnVwdGlvbihyZXNldE9yaWdpblJlc3VsdCk7XG5cbiAgICAgIGlmIChjb3JydXB0aW9uICE9PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHJlY292ZXJlZCA9IGF3YWl0IHJlY292ZXJDb3JydXB0Q2xvbmUoXG4gICAgICAgICAgcmVwbyxcbiAgICAgICAgICByZXBvUGF0aCxcbiAgICAgICAgICB3b3JrRGlyLFxuICAgICAgICAgIGNvcnJ1cHRpb24sXG4gICAgICAgICk7XG4gICAgICAgIGlmICghcmVjb3ZlcmVkLm9rKSB7XG4gICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIG1lc3NhZ2U6IHJlY292ZXJlZC5lcnJvci5tZXNzYWdlIH07XG4gICAgICAgIH1cbiAgICAgICAgcmVjb3ZlcnlBc2lkZSA9IHJlY292ZXJlZC52YWx1ZTtcbiAgICAgICAgLy8gVGhlIGNvcnJ1cHQgY2xvbmUgaGFzIGJlZW4gbW92ZWQgYXNpZGU7IGZhbGwgdGhyb3VnaCB0byB0aGUgZnJlc2hcbiAgICAgICAgLy8gY2xvbmUgcGF0aCBiZWxvdywgd2hpY2ggbm93IGZpbmRzIHJlcG9QYXRoIGFic2VudC5cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFN0b3JlIHRoZSBkZWZhdWx0IGJyYW5jaCBpbiB0aGUgZ2l0IGRpcmVjdG9yeSAoSXNzdWUgIzE2NTIpLlxuICAgICAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCB3cml0ZURlZmF1bHRCcmFuY2hDYWNoZShyZXBvUGF0aCwgZGVmYXVsdEJyYW5jaCk7XG4gICAgICAgIGlmICghc3RvcmVkLm9rKSB7XG4gICAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIG1lc3NhZ2U6IHN0b3JlZC5lcnJvci5tZXNzYWdlIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgICAgbWVzc2FnZTogcmVwb1BhdGgsXG4gICAgICAgICAgZGF0YTogeyByZXBvUGF0aCwgZGVmYXVsdEJyYW5jaCB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gRGlyZWN0b3J5IGRvZXNuJ3QgZXhpc3Qg4oCUIHdpbGwgY2xvbmUgYmVsb3dcbiAgfVxuXG4gIC8vIFByZS1jaGVjayBkaXNrIHNwYWNlIGJlZm9yZSBjbG9uZSAoSXNzdWUgIzExNzQpXG4gIGNvbnN0IGNsb25lU3BhY2VDaGVjayA9IGF3YWl0IHJlcXVpcmVEaXNrU3BhY2VGb3JHaXRPcGVyYXRpb24oXG4gICAgd29ya0RpcixcbiAgICBgZ2ggcmVwbyBjbG9uZSAke3JlcG99YCxcbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5taW5EaXNrU3BhY2VNYixcbiAgKTtcbiAgaWYgKCFjbG9uZVNwYWNlQ2hlY2sub2spIHtcbiAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgbWVzc2FnZTogY2xvbmVTcGFjZUNoZWNrLmVycm9yLm1lc3NhZ2UgfTtcbiAgfVxuXG4gIC8vIENsb25lIHRoZSByZXBvc2l0b3J5IHNoYWxsb3dseSAoLS1kZXB0aD0xKSB3aGlsZSBwcmVzZXJ2aW5nIHJlbW90ZS10cmFja2luZ1xuICAvLyByZWZzIGZvciBldmVyeSBicmFuY2ggKC0tbm8tc2luZ2xlLWJyYW5jaCkgc28gZmVhdHVyZS9taWxlc3RvbmUgYnJhbmNoZXNcbiAgLy8gcmVtYWluIGFjY2Vzc2libGUgdmlhIG9yaWdpbi88YnJhbmNoPi4gSGlzdG9yeSBpcyBkZWVwZW5lZCBvbiBkZW1hbmQgYnlcbiAgLy8gZW5zdXJlSGlzdG9yeURlcHRoKCkgZm9yIGNvbW1pdC1yYW5nZS9tZXJnZSBvcGVyYXRpb25zIChJc3N1ZSAjMTUwMykuXG4gIGNvbnN0IGNsb25lUmVzdWx0ID0gYXdhaXQgc3Bhd25HaChidWlsZFNoYWxsb3dDbG9uZUFyZ3MocmVwbywgcmVwb1BhdGgpKTtcbiAgaWYgKGNsb25lUmVzdWx0LmNvZGUgIT09IDApIHtcbiAgICAvLyBJc3N1ZSAjMjk1NzogbmFtZSB0aGUgYXNpZGUgcGF0aCBzbyBhIGZhaWxlZCByZWNvdmVyeSByZS1jbG9uZSBpc1xuICAgIC8vIGRpc3Rpbmd1aXNoYWJsZSBmcm9tIGFuIG9yZGluYXJ5IGZpcnN0IGNsb25lLCB3aGlsZSBrZWVwaW5nIHRoZVxuICAgIC8vIGBDTE9ORV9GQUlMRURfUEFUVEVSTmAgcHJlZml4IGhvc3QtZmF1bHQgZGV0ZWN0aW9uIG1hdGNoZXMgb24uXG4gICAgY29uc3QgbWVzc2FnZSA9IHJlY292ZXJ5QXNpZGUgIT09IG51bGxcbiAgICAgID8gYEZhaWxlZCB0byBjbG9uZSAke3JlcG99OiAke2Nsb25lUmVzdWx0LnN0ZGVycn0gKHJlLWNsb25lIGludG8gJHtyZXBvUGF0aH0gYWZ0ZXIgbW92aW5nIHRoZSBjb3JydXB0IGNsb25lIGFzaWRlIHRvICR7cmVjb3ZlcnlBc2lkZX0pYFxuICAgICAgOiBgRmFpbGVkIHRvIGNsb25lICR7cmVwb306ICR7Y2xvbmVSZXN1bHQuc3RkZXJyfWA7XG4gICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIG1lc3NhZ2UgfTtcbiAgfVxuXG4gIC8vIEEgZGlmZmVyZW50IGFjY291bnQgY2FuIGNyZWF0ZSB0aGUgZGVzdGluYXRpb24gd2hpbGUgZ2ggcmVzb2x2ZXMgdGhlXG4gIC8vIHJlcG9zaXRvcnkuIE5ldmVyIHJ1biBnaXQgaW4gdGhlIHJlc3VsdGluZyBjbG9uZSB1bnRpbCBvd25lcnNoaXAgaXMgY2hlY2tlZC5cbiAgY29uc3QgY2xvbmVPd25lcnNoaXBFcnJvciA9IGF3YWl0IG93bmVyc2hpcENoZWNrKHJlcG9QYXRoKTtcbiAgaWYgKGNsb25lT3duZXJzaGlwRXJyb3IpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcXVhcmFudGluZSA9IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoe1xuICAgICAgICBkaXI6IHdvcmtEaXIsXG4gICAgICAgIHByZWZpeDogYC51bnRydXN0ZWQtJHtyZXBvTmFtZX0tYCxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgRGVuby5yZW5hbWUocmVwb1BhdGgsIGAke3F1YXJhbnRpbmV9LyR7cmVwb05hbWV9YCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgbWVzc2FnZTogYCR7Y2xvbmVPd25lcnNoaXBFcnJvcn07IG1vdmVkIGNsb25lIHRvICR7cXVhcmFudGluZX1gLFxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIG1lc3NhZ2U6IGAke2Nsb25lT3duZXJzaGlwRXJyb3J9OyBjb3VsZCBub3QgcXVhcmFudGluZSBjbG9uZTogJHtlcnJvcn1gLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBTYW5pdHkgY2hlY2s6IGNvbmZpcm0gcmVtb3RlIHJlZnMgYXJlIHJlYWNoYWJsZSBhZnRlciB0aGUgc2hhbGxvdyBjbG9uZS5cbiAgLy8gTm9uLWZhdGFsIOKAlCBhIG5ldHdvcmsgZ2xpdGNoIHNob3VsZCBub3QgYWJvcnQgdGhlIHNldHVwIHNpbmNlIHdlIGFscmVhZHlcbiAgLy8gaGF2ZSBhIHdvcmtpbmcgY2xvbmUuIEZhaWx1cmUgaXMgbG9nZ2VkIGZvciBvYnNlcnZhYmlsaXR5LlxuICBjb25zdCBsc1JlbW90ZVJlc3VsdCA9IGF3YWl0IGdpdChbXCJscy1yZW1vdGVcIiwgXCJvcmlnaW5cIl0sIHtcbiAgICBjd2Q6IHJlcG9QYXRoLFxuICB9KTtcbiAgaWYgKCFsc1JlbW90ZVJlc3VsdC5vayB8fCBsc1JlbW90ZVJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgY29uc3QgZGV0YWlsID0gbHNSZW1vdGVSZXN1bHQub2tcbiAgICAgID8gbHNSZW1vdGVSZXN1bHQudmFsdWUuc3RkZXJyLnRyaW0oKSB8fFxuICAgICAgICBgZXhpdCAke2xzUmVtb3RlUmVzdWx0LnZhbHVlLmNvZGV9YFxuICAgICAgOiBsc1JlbW90ZVJlc3VsdC5lcnJvci5tZXNzYWdlO1xuICAgIGNvbnNvbGUud2FybihcbiAgICAgIGBbc2V0dXAtcmVwb10gV2FybmluZzogZ2l0IGxzLXJlbW90ZSBvcmlnaW4gZmFpbGVkIGFmdGVyIGNsb25lOiAke2RldGFpbH1gLFxuICAgICk7XG4gIH1cblxuICAvLyBMb2cgdGhlIHJlc3VsdGluZyBjbG9uZSBzaXplIGZvciBvYnNlcnZhYmlsaXR5IChzaGFsbG93IHZzIGZ1bGwgY29tcGFyaXNvbikuXG4gIGNvbnN0IHNpemVSZXN1bHQgPSBhd2FpdCBtZWFzdXJlU2Vzc2lvblNpemUocmVwb1BhdGgpO1xuICBpZiAoc2l6ZVJlc3VsdC5vaykge1xuICAgIGNvbnN0IGtpYiA9IE1hdGgucm91bmQoc2l6ZVJlc3VsdC52YWx1ZSAvIDEwMjQpO1xuICAgIGNvbnNvbGUubG9nKGBbc2V0dXAtcmVwb10gU2hhbGxvdyBjbG9uZSBvZiAke3JlcG99IGNvbXBsZXRlOiAke2tpYn0gS2lCYCk7XG4gIH1cblxuICAvLyBEZXRlcm1pbmUgZGVmYXVsdCBicmFuY2hcbiAgY29uc3QgZGVmYXVsdEJyYW5jaFJlc3VsdCA9IGF3YWl0IGdpdChcbiAgICBbXCJzeW1ib2xpYy1yZWZcIiwgXCJyZWZzL3JlbW90ZXMvb3JpZ2luL0hFQURcIl0sXG4gICAgeyBjd2Q6IHJlcG9QYXRoIH0sXG4gICk7XG4gIGxldCBkZWZhdWx0QnJhbmNoID0gXCJtYWluXCI7IC8vIGFsbG93LWhhcmRjb2RlZC1icmFuY2gg4oCUIGZhbGxiYWNrIGFmdGVyIGdpdCBzeW1ib2xpYy1yZWZcbiAgaWYgKGRlZmF1bHRCcmFuY2hSZXN1bHQub2sgJiYgZGVmYXVsdEJyYW5jaFJlc3VsdC52YWx1ZS5jb2RlID09PSAwKSB7XG4gICAgY29uc3QgcmVmID0gZGVmYXVsdEJyYW5jaFJlc3VsdC52YWx1ZS5zdGRvdXQudHJpbSgpO1xuICAgIGRlZmF1bHRCcmFuY2ggPSByZWYucmVwbGFjZShcInJlZnMvcmVtb3Rlcy9vcmlnaW4vXCIsIFwiXCIpO1xuICB9XG5cbiAgLy8gU3RvcmUgdGhlIGRlZmF1bHQgYnJhbmNoIGluIHRoZSBnaXQgZGlyZWN0b3J5IChJc3N1ZSAjMTY1MikuXG4gIGNvbnN0IHN0b3JlZCA9IGF3YWl0IHdyaXRlRGVmYXVsdEJyYW5jaENhY2hlKHJlcG9QYXRoLCBkZWZhdWx0QnJhbmNoKTtcbiAgaWYgKCFzdG9yZWQub2spIHtcbiAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgbWVzc2FnZTogc3RvcmVkLmVycm9yLm1lc3NhZ2UgfTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBtZXNzYWdlOiByZXBvUGF0aCxcbiAgICBkYXRhOiB7IHJlcG9QYXRoLCBkZWZhdWx0QnJhbmNoIH0sXG4gIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBNkJDLEdBR0QsU0FDRSxnQkFBZ0IsRUFDaEIsMkJBQTJCLEVBQzNCLHlCQUF5QixFQUN6QiwyQkFBMkIsRUFDM0IsaUJBQWlCLFFBQ1osdUJBQXVCO0FBQzlCLFNBQVMsZUFBZSxRQUFRLCtCQUErQjtBQUMvRCxTQUNFLGdCQUFnQixFQUNoQixtQkFBbUIsRUFDbkIsMEJBQTBCLEVBQzFCLG1CQUFtQixFQUNuQixtQkFBbUIsRUFDbkIsaUJBQWlCLFFBQ1oscUJBQXFCO0FBQzVCLFNBQVMsd0JBQXdCLFFBQVEsOEJBQThCO0FBQ3ZFLFNBQVMsc0JBQXNCLFFBQVEsb0NBQW9DO0FBQzNFLFNBQVMsaUJBQWlCLFFBQVEsZ0NBQWdDO0FBQ2xFLFNBQ0UsaUJBQWlCLEVBQ2pCLDRCQUE0QixFQUM1Qiw4QkFBOEIsRUFDOUIsY0FBYyxRQUNULHFCQUFxQjtBQUM1QixTQUFTLGFBQWEsUUFBUSx3QkFBd0I7QUFDdEQsU0FDRSxtQkFBbUIsRUFDbkIsa0JBQWtCLEVBQ2xCLGlCQUFpQixRQUNaLHlCQUF5QjtBQUNoQyxTQUNFLGlCQUFpQixFQUNqQixtQkFBbUIsUUFDZCxtQ0FBbUM7QUFDMUMsU0FBUyxnQkFBZ0IsUUFBUSwrQkFBK0I7QUFDaEUsU0FDRSxzQkFBc0IsRUFDdEIsaUJBQWlCLFFBQ1oseUJBQXlCO0FBQ2hDLFNBQVMsK0JBQStCLFFBQVEsdUJBQXVCO0FBQ3ZFLFNBQVMsb0JBQW9CLFFBQVEsNEJBQTRCO0FBQ2pFLFNBQVMsbUJBQW1CLEVBQUUsY0FBYyxRQUFRLDRCQUE0QjtBQUNoRixTQUNFLGNBQWMsRUFDZCxrQkFBa0IsUUFDYiwrQkFBK0I7QUFDdEMsU0FBUyw0QkFBNEIsUUFBUSw2QkFBNkI7QUFDMUUsU0FBUyw2QkFBNkIsUUFBUSw4QkFBOEI7QUFDNUUsU0FBUyxPQUFPLFFBQVEscUJBQXFCO0FBRTdDLHlDQUF5QyxHQUN6QyxTQUFTLFNBQVMsS0FBYyxFQUFFLFFBQWdCO0VBQ2hELElBQUksT0FBTyxVQUFVLFVBQVUsT0FBTztFQUN0QyxJQUFJLE9BQU8sVUFBVSxVQUFVO0lBQzdCLE1BQU0sSUFBSSxTQUFTLE9BQU87SUFDMUIsT0FBTyxNQUFNLEtBQUssV0FBVztFQUMvQjtFQUNBLE9BQU87QUFDVDtBQUVBOzs7Ozs7Ozs7Ozs7O0NBYUMsR0FDRCxPQUFPLFNBQVMsc0JBQ2QsSUFBWSxFQUNaLFFBQWdCO0VBRWhCLE9BQU87SUFDTDtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtHQUNEO0FBQ0g7QUFFQSxPQUFPLE1BQU0sdUJBQWdDO0VBQzNDLE1BQU07RUFDTixhQUNFO0VBRUYsTUFBTSxTQUNKLElBQTZCLEVBQzdCLE9BQXFCO0lBRXJCLE1BQU0sWUFBWSxPQUFPLElBQUksQ0FBQyxZQUFZLElBQUk7SUFDOUMsTUFBTSxNQUFNLElBQUksQ0FBQyxNQUFNLEdBQUcsT0FBTyxJQUFJLENBQUMsTUFBTSxJQUFJO0lBQ2hELE1BQU0sYUFBYSxNQUFNO01BQUU7SUFBSSxJQUFJLENBQUM7SUFFcEMsT0FBUTtNQUNOLEtBQUs7UUFBc0I7VUFDekIsTUFBTSxjQUFjLFNBQVMsSUFBSSxDQUFDLGVBQWUsRUFBRTtVQUNuRCxNQUFNLGFBQWEsT0FBTyxJQUFJLENBQUMsY0FBYyxJQUFJO1VBQ2pELElBQUksQ0FBQyxlQUFlLENBQUMsWUFBWTtZQUMvQixPQUFPO2NBQ0wsU0FBUztjQUNULFNBQ0U7WUFDSjtVQUNGO1VBQ0EsTUFBTSxPQUFPLGlCQUFpQixhQUFhO1VBQzNDLE9BQU87WUFBRSxTQUFTO1lBQU0sU0FBUztVQUFLO1FBQ3hDO01BRUEsS0FBSztRQUFnQztVQUNuQyxNQUFNLGlCQUFpQixPQUFPLElBQUksQ0FBQyxrQkFBa0IsSUFBSTtVQUN6RCxJQUFJLENBQUMsZ0JBQWdCO1lBQ25CLE9BQU87Y0FDTCxTQUFTO2NBQ1QsU0FBUztZQUNYO1VBQ0Y7VUFDQSxNQUFNLE9BQU8sMEJBQTBCO1VBQ3ZDLE9BQU87WUFBRSxTQUFTO1lBQU0sU0FBUztVQUFLO1FBQ3hDO01BRUEsS0FBSztRQUF1QjtVQUMxQixNQUFNLGFBQWEsT0FBTyxJQUFJLENBQUMsY0FBYyxJQUFJO1VBQ2pELElBQUksQ0FBQyxZQUFZO1lBQ2YsT0FBTztjQUNMLFNBQVM7Y0FDVCxTQUFTO1lBQ1g7VUFDRjtVQUNBLE1BQU0sY0FBYyxrQkFBa0I7VUFDdEMsT0FBTztZQUNMLFNBQVM7WUFDVCxTQUFTLGNBQWMsU0FBUztZQUNoQyxNQUFNO2NBQUUsV0FBVztZQUFZO1VBQ2pDO1FBQ0Y7TUFFQSxLQUFLO1FBQXlCO1VBQzVCLE1BQU0sYUFBYSxPQUFPLElBQUksQ0FBQyxjQUFjLElBQUk7VUFDakQsTUFBTSxhQUFhLE9BQU8sSUFBSSxDQUFDLGNBQWMsSUFBSTtVQUNqRCxJQUFJLENBQUMsY0FBYyxDQUFDLFlBQVk7WUFDOUIsT0FBTztjQUNMLFNBQVM7Y0FDVCxTQUFTO1lBQ1g7VUFDRjtVQUNBLE1BQU0sU0FBUyxNQUFNLDRCQUNuQixZQUNBLFlBQ0E7VUFFRixPQUFPO1lBQ0wsU0FBUyxPQUFPLEVBQUU7WUFDbEIsU0FBUyxPQUFPLEVBQUUsR0FBRyxPQUFPLEtBQUssR0FBRyxPQUFPLEtBQUssQ0FBQyxPQUFPO1VBQzFEO1FBQ0Y7TUFFQSxLQUFLO1FBQTJCO1VBQzlCLE1BQU0sa0JBQWtCLE9BQU8sSUFBSSxDQUFDLG1CQUFtQixJQUFJO1VBQzNELE1BQU0sZ0JBQWdCLE9BQU8sSUFBSSxDQUFDLGlCQUFpQixJQUFJO1VBQ3ZELElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxlQUFlO1lBQ3RDLE9BQU87Y0FDTCxTQUFTO2NBQ1QsU0FDRTtZQUNKO1VBQ0Y7VUFDQSw2REFBNkQ7VUFDN0QsMkRBQTJEO1VBQzNELDBEQUEwRDtVQUMxRCxNQUFNLFNBQVMsTUFBTSw0QkFDbkIsaUJBQ0EsZUFDQSxZQUNBO1VBRUYsT0FBTztZQUNMLFNBQVMsT0FBTyxFQUFFO1lBQ2xCLFNBQVMsT0FBTyxFQUFFLEdBQUcsT0FBTyxLQUFLLEdBQUcsT0FBTyxLQUFLLENBQUMsT0FBTztVQUMxRDtRQUNGO01BRUEsS0FBSztRQUFxQjtVQUN4QixNQUFNLGdCQUFnQixPQUFPLElBQUksQ0FBQyxpQkFBaUIsSUFBSTtVQUN2RCxJQUFJLENBQUMsZUFBZTtZQUNsQixPQUFPO2NBQ0wsU0FBUztjQUNULFNBQVM7WUFDWDtVQUNGO1VBQ0EsTUFBTSxTQUFTLE1BQU0sZ0JBQWdCLGVBQWU7VUFDcEQsSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUFFO1lBQ2QsT0FBTztjQUFFLFNBQVM7Y0FBTyxTQUFTLE9BQU8sS0FBSyxDQUFDLE9BQU87WUFBQztVQUN6RDtVQUNBLE1BQU0sRUFBRSxPQUFPLEVBQUUsR0FBRyxPQUFPLEtBQUs7VUFDaEMsT0FBTztZQUNMLFNBQVM7WUFDVCxTQUFTLFFBQVEsTUFBTSxHQUFHLElBQ3RCLFFBQVEsSUFBSSxDQUFDLFFBQ2I7WUFDSixNQUFNO2NBQUU7WUFBUTtVQUNsQjtRQUNGO01BRUEsS0FBSztRQUFjO1VBQ2pCLE1BQU0sT0FBTyxPQUFPLElBQUksQ0FBQyxPQUFPLElBQUk7VUFDcEMsTUFBTSxVQUFVLE9BQU8sSUFBSSxDQUFDLFdBQVcsSUFBSTtVQUMzQyxJQUFJLENBQUMsUUFBUSxDQUFDLFNBQVM7WUFDckIsT0FBTztjQUNMLFNBQVM7Y0FDVCxTQUFTO1lBQ1g7VUFDRjtVQUNBLE9BQU8sTUFBTSxVQUFVLE1BQU07UUFDL0I7TUFFQSxLQUFLO1FBQXVCO1VBQzFCLE1BQU0sYUFBYSxPQUFPLElBQUksQ0FBQyxjQUFjLElBQUk7VUFDakQsTUFBTSxnQkFBZ0IsT0FBTyxJQUFJLENBQUMsaUJBQWlCLElBQUk7VUFDdkQsSUFBSSxDQUFDLGNBQWMsQ0FBQyxlQUFlO1lBQ2pDLE9BQU87Y0FDTCxTQUFTO2NBQ1QsU0FDRTtZQUNKO1VBQ0Y7VUFDQSxNQUFNLFNBQVMsTUFBTSw2QkFDbkIsWUFDQSxlQUNBO1VBRUYsT0FBTztZQUNMLFNBQVMsT0FBTyxFQUFFO1lBQ2xCLFNBQVMsT0FBTyxFQUFFLEdBQUcsT0FBTyxLQUFLLEdBQUcsT0FBTyxLQUFLLENBQUMsT0FBTztVQUMxRDtRQUNGO01BRUEsS0FBSztRQUF5QjtVQUM1QixNQUFNLGtCQUFrQixPQUFPLElBQUksQ0FBQyxtQkFBbUIsSUFBSTtVQUMzRCxNQUFNLGdCQUFnQixPQUFPLElBQUksQ0FBQyxpQkFBaUIsSUFBSTtVQUN2RCxJQUFJLENBQUMsbUJBQW1CLENBQUMsZUFBZTtZQUN0QyxPQUFPO2NBQ0wsU0FBUztjQUNULFNBQ0U7WUFDSjtVQUNGO1VBQ0EsTUFBTSxTQUFTLE1BQU0sK0JBQ25CLGlCQUNBLGVBQ0E7VUFFRixPQUFPO1lBQ0wsU0FBUyxPQUFPLEVBQUU7WUFDbEIsU0FBUyxPQUFPLEVBQUUsR0FBRyxPQUFPLEtBQUssQ0FBQyxPQUFPLEdBQUcsT0FBTyxLQUFLLENBQUMsT0FBTztVQUNsRTtRQUNGO01BRUEsS0FBSztRQUFpQztVQUNwQyxNQUFNLGdCQUFnQixPQUFPLElBQUksQ0FBQyxpQkFBaUIsSUFBSTtVQUN2RCxJQUFJLENBQUMsZUFBZTtZQUNsQixPQUFPO2NBQ0wsU0FBUztjQUNULFNBQVM7WUFDWDtVQUNGO1VBQ0EsTUFBTSxTQUFTLE1BQU0sMkJBQ25CLGVBQ0E7VUFFRixPQUFPO1lBQ0wsU0FBUyxPQUFPLEVBQUU7WUFDbEIsU0FBUyxPQUFPLEVBQUUsR0FBRyxPQUFPLEtBQUssR0FBRyxPQUFPLEtBQUssQ0FBQyxPQUFPO1VBQzFEO1FBQ0Y7TUFFQSxLQUFLO1FBQXlCO1VBQzVCLE1BQU0sYUFBYSxPQUFPLElBQUksQ0FBQyxjQUFjLElBQUk7VUFDakQsSUFBSSxDQUFDLFlBQVk7WUFDZixPQUFPO2NBQ0wsU0FBUztjQUNULFNBQVM7WUFDWDtVQUNGO1VBQ0EsTUFBTSxTQUFTLE1BQU0sb0JBQW9CLFlBQVk7VUFDckQsSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUFFO1lBQ2QsT0FBTztjQUFFLFNBQVM7Y0FBTyxTQUFTLE9BQU8sS0FBSyxDQUFDLE9BQU87WUFBQztVQUN6RDtVQUNBLE9BQU87WUFDTCxTQUFTO1lBQ1QsU0FBUyxPQUFPLEtBQUssR0FBRyxJQUNwQixDQUFDLG9CQUFvQixFQUFFLE9BQU8sS0FBSyxDQUFDLG9CQUFvQixDQUFDLEdBQ3pEO1lBQ0osTUFBTTtjQUFFLGVBQWUsT0FBTyxLQUFLO1lBQUM7VUFDdEM7UUFDRjtNQUVBLEtBQUs7UUFBeUI7VUFDNUIsTUFBTSxhQUFhLE9BQU8sSUFBSSxDQUFDLGNBQWMsSUFBSTtVQUNqRCxNQUFNLFdBQVcsb0JBQW9CO1VBQ3JDLE9BQU87WUFDTCxTQUFTO1lBQ1QsU0FBUyxXQUFXLFNBQVM7WUFDN0IsTUFBTTtjQUFFO1lBQVM7VUFDbkI7UUFDRjtNQUVBLEtBQUs7UUFBc0I7VUFDekIsTUFBTSxjQUFjLE9BQU8sSUFBSSxDQUFDLGVBQWUsSUFBSTtVQUNuRCxNQUFNLFFBQVEsaUJBQWlCO1VBQy9CLE9BQU87WUFDTCxTQUFTO1lBQ1QsU0FBUyxTQUFTO1lBQ2xCLE1BQU07Y0FBRTtZQUFNO1VBQ2hCO1FBQ0Y7TUFFQSxLQUFLO1FBQWdCO1VBQ25CLE1BQU0sT0FBTyxPQUFPLElBQUksQ0FBQyxPQUFPLElBQUk7VUFDcEMsTUFBTSxhQUFhLE9BQU8sSUFBSSxDQUFDLGNBQWMsSUFBSTtVQUNqRCxJQUFJLENBQUMsUUFBUSxDQUFDLFlBQVk7WUFDeEIsT0FBTztjQUNMLFNBQVM7Y0FDVCxTQUFTO1lBQ1g7VUFDRjtVQUNBLE1BQU0sU0FBUyxNQUFNLG9CQUFvQixNQUFNO1VBQy9DLElBQUksQ0FBQyxPQUFPLEVBQUUsRUFBRTtZQUNkLE9BQU87Y0FBRSxTQUFTO2NBQU8sU0FBUyxPQUFPLEtBQUssQ0FBQyxPQUFPO1lBQUM7VUFDekQ7VUFDQSxPQUFPO1lBQ0wsU0FBUztZQUNULFNBQVMsT0FBTyxLQUFLLElBQUk7WUFDekIsTUFBTTtjQUFFLE9BQU8sT0FBTyxLQUFLO1lBQUM7VUFDOUI7UUFDRjtNQUVBLEtBQUs7UUFBdUI7VUFDMUIsTUFBTSxPQUFPLE9BQU8sSUFBSSxDQUFDLE9BQU8sSUFBSTtVQUNwQyxNQUFNLGNBQWMsU0FBUyxJQUFJLENBQUMsZUFBZSxFQUFFO1VBQ25ELE1BQU0sUUFBUSxPQUFPLElBQUksQ0FBQyxTQUFTLElBQUk7VUFDdkMsTUFBTSxTQUFTLElBQUksQ0FBQyxVQUFVLEdBQUcsT0FBTyxJQUFJLENBQUMsVUFBVSxJQUFJO1VBQzNELElBQUksQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLE9BQU87WUFDbkMsT0FBTztjQUNMLFNBQVM7Y0FDVCxTQUNFO1lBQ0o7VUFDRjtVQUNBLE1BQU0sU0FBUyxNQUFNLGtCQUNuQixNQUNBLGFBQ0EsT0FDQTtVQUVGLE9BQU87WUFDTCxTQUFTLE9BQU8sRUFBRTtZQUNsQixTQUFTLE9BQU8sRUFBRSxHQUFHLE9BQU8sS0FBSyxHQUFHLE9BQU8sS0FBSyxDQUFDLE9BQU87VUFDMUQ7UUFDRjtNQUVBLEtBQUs7UUFBMEI7VUFDN0IsTUFBTSxhQUFhLE9BQU8sSUFBSSxDQUFDLGNBQWMsSUFBSTtVQUNqRCxJQUFJLENBQUMsWUFBWTtZQUNmLE9BQU87Y0FDTCxTQUFTO2NBQ1QsU0FBUztZQUNYO1VBQ0Y7VUFDQSxNQUFNLFNBQVMsTUFBTSx5QkFBeUIsWUFBWTtVQUMxRCxPQUFPO1lBQ0wsU0FBUyxPQUFPLEVBQUU7WUFDbEIsU0FBUyxPQUFPLEVBQUUsR0FBRyxPQUFPLEtBQUssR0FBRyxPQUFPLEtBQUssQ0FBQyxPQUFPO1VBQzFEO1FBQ0Y7TUFFQSxLQUFLO1FBQTRCO1VBQy9CLE1BQU0sU0FBUyxNQUFNLHVCQUF1QjtVQUM1QyxJQUFJLENBQUMsT0FBTyxFQUFFLEVBQUU7WUFDZCxPQUFPO2NBQUUsU0FBUztjQUFPLFNBQVMsT0FBTyxLQUFLLENBQUMsT0FBTztZQUFDO1VBQ3pEO1VBQ0EsT0FBTztZQUNMLFNBQVM7WUFDVCxTQUNFLENBQUMsU0FBUyxFQUFFLE9BQU8sS0FBSyxDQUFDLGFBQWEsQ0FBQyxZQUFZLEVBQUUsT0FBTyxLQUFLLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQztZQUNyRixNQUFNLE9BQU8sS0FBSztVQUNwQjtRQUNGO01BRUEsS0FBSztRQUF1QjtVQUMxQixNQUFNLGdCQUFnQixPQUFPLElBQUksQ0FBQyxpQkFBaUIsSUFBSTtVQUN2RCxNQUFNLGFBQWEsT0FBTyxJQUFJLENBQUMsY0FBYyxJQUFJO1VBQ2pELE1BQU0sa0JBQWtCLElBQUksQ0FBQyxtQkFBbUIsS0FBSyxRQUNuRCxJQUFJLENBQUMsbUJBQW1CLEtBQUs7VUFDL0IsSUFBSSxDQUFDLGlCQUFpQixDQUFDLFlBQVk7WUFDakMsT0FBTztjQUNMLFNBQVM7Y0FDVCxTQUNFO1lBQ0o7VUFDRjtVQUNBLE1BQU0sU0FBUyxNQUFNLGtCQUNuQixlQUNBLFlBQ0EsaUJBQ0E7VUFFRixJQUFJLENBQUMsT0FBTyxFQUFFLEVBQUU7WUFDZCxPQUFPO2NBQUUsU0FBUztjQUFPLFNBQVMsT0FBTyxLQUFLLENBQUMsT0FBTztZQUFDO1VBQ3pEO1VBQ0EsTUFBTSxFQUFFLEtBQUssRUFBRSxPQUFPLEVBQUUsUUFBUSxFQUFFLFNBQVMsRUFBRSxHQUFHLE9BQU8sS0FBSztVQUM1RCxPQUFPO1lBQ0wsU0FBUztZQUNULFNBQVMsUUFDTCx1Q0FDQSxDQUFDLGdEQUFnRCxFQUFFLFVBQVUsQ0FBQyxDQUFDO1lBQ25FLE1BQU07Y0FBRTtjQUFPO2NBQVM7Y0FBVTtZQUFVO1VBQzlDO1FBQ0Y7TUFFQSxLQUFLO1FBQW9CO1VBQ3ZCLE1BQU0sYUFBYSxPQUFPLElBQUksQ0FBQyxjQUFjLElBQUk7VUFDakQsTUFBTSxhQUFhLE9BQU8sSUFBSSxDQUFDLGNBQWMsSUFBSTtVQUNqRCxJQUFJLENBQUMsY0FBYyxDQUFDLFlBQVk7WUFDOUIsT0FBTztjQUNMLFNBQVM7Y0FDVCxTQUFTO1lBQ1g7VUFDRjtVQUNBLE1BQU0sU0FBUyxNQUFNLGVBQWUsWUFBWSxZQUFZO1VBQzVELE9BQU87WUFDTCxTQUFTLE9BQU8sRUFBRTtZQUNsQixTQUFTLE9BQU8sRUFBRSxHQUFHLE9BQU8sS0FBSyxHQUFHLE9BQU8sS0FBSyxDQUFDLE9BQU87VUFDMUQ7UUFDRjtNQUVBLEtBQUs7UUFBdUI7VUFDMUIsTUFBTSxPQUFPLE9BQU8sSUFBSSxDQUFDLE9BQU8sSUFBSTtVQUNwQyxNQUFNLFdBQVcsU0FBUyxJQUFJLENBQUMsWUFBWSxFQUFFO1VBQzdDLE1BQU0sYUFBYSxPQUFPLElBQUksQ0FBQyxjQUFjLElBQUk7VUFDakQsTUFBTSxhQUFhLE9BQU8sSUFBSSxDQUFDLGNBQWMsSUFBSTtVQUNqRCxJQUFJLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxjQUFjLENBQUMsWUFBWTtZQUNwRCxPQUFPO2NBQ0wsU0FBUztjQUNULFNBQ0U7WUFDSjtVQUNGO1VBQ0EsTUFBTSxTQUFTLE1BQU0sa0JBQ25CLE1BQ0EsVUFDQSxZQUNBLFlBQ0E7VUFFRixPQUFPO1lBQ0wsU0FBUyxPQUFPLEVBQUU7WUFDbEIsU0FBUyxPQUFPLEVBQUUsR0FBRyxPQUFPLEtBQUssR0FBRyxPQUFPLEtBQUssQ0FBQyxPQUFPO1VBQzFEO1FBQ0Y7TUFFQTtRQUNFLE9BQU87VUFDTCxTQUFTO1VBQ1QsU0FDRSxDQUFDLHdCQUF3QixFQUFFLFVBQVUsa2RBQWtkLENBQUM7UUFDNWY7SUFDSjtFQUNGO0FBQ0YsRUFBRTtBQUVGOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBc0JDLEdBQ0QsT0FBTyxlQUFlLHVCQUNwQixRQUFnQjtFQUVoQixNQUFNLFNBQVMsTUFBTSxjQUNuQjtJQUFDO0lBQWE7SUFBMEI7R0FBbUIsRUFDM0Q7SUFBRSxLQUFLO0VBQVM7RUFFbEIsSUFBSSxDQUFDLE9BQU8sRUFBRSxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHLE9BQU87RUFDbEQsTUFBTSxTQUFTLE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJO0VBQ3ZDLElBQUksT0FBTyxNQUFNLEtBQUssR0FBRyxPQUFPO0VBQ2hDLE9BQU8sR0FBRyxPQUFPLG9CQUFvQixDQUFDO0FBQ3hDO0FBRUE7Ozs7Q0FJQyxHQUNELGVBQWUsdUJBQXVCLFFBQWdCO0VBQ3BELE1BQU0sT0FBTyxNQUFNLHVCQUF1QjtFQUMxQyxJQUFJLFNBQVMsTUFBTSxPQUFPO0VBQzFCLElBQUk7SUFDRixPQUFPLENBQUMsTUFBTSxLQUFLLFlBQVksQ0FBQyxLQUFLLEVBQUUsSUFBSTtFQUM3QyxFQUFFLE9BQU07SUFDTixPQUFPO0VBQ1Q7QUFDRjtBQUVBOzs7OztDQUtDLEdBQ0QsZUFBZSx3QkFDYixRQUFnQixFQUNoQixhQUFxQjtFQUVyQixNQUFNLE9BQU8sTUFBTSx1QkFBdUI7RUFDMUMsSUFBSSxTQUFTLE1BQU07SUFDakIsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLElBQUksTUFDVCxDQUFDLHVDQUF1QyxFQUFFLFNBQVMsY0FBYyxDQUFDLEdBQ2hFLENBQUMsa0NBQWtDLENBQUM7SUFFMUM7RUFDRjtFQUNBLElBQUk7SUFDRixNQUFNLEtBQUssS0FBSyxDQUFDLEtBQUssS0FBSyxDQUFDLEdBQUcsS0FBSyxXQUFXLENBQUMsT0FBTztNQUFFLFdBQVc7SUFBSztJQUN6RSxNQUFNLEtBQUssYUFBYSxDQUFDLE1BQU07SUFDL0IsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO0lBQVU7RUFDdEMsRUFBRSxPQUFPLE9BQU87SUFDZCxPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUNULENBQUMseUNBQXlDLEVBQUUsS0FBSyxFQUFFLEVBQ2pELGlCQUFpQixRQUFRLE1BQU0sT0FBTyxHQUFHLE9BQU8sT0FDakQsY0FBYyxDQUFDO0lBRXBCO0VBQ0Y7QUFDRjtBQUVBOzs7Ozs7Ozs7Q0FTQyxHQUNELFNBQVMsc0JBQ1AsTUFBZ0U7RUFFaEUsSUFBSSxDQUFDLE9BQU8sRUFBRSxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHLE9BQU87RUFDbEQsTUFBTSxXQUFXLEdBQUcsT0FBTyxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsRUFBRSxPQUFPLEtBQUssQ0FBQyxNQUFNLEVBQUU7RUFDakUsT0FBTyxrQkFBa0IsWUFBWSxXQUFXO0FBQ2xEO0FBRUE7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLGVBQWUsVUFDcEIsSUFBWSxFQUNaLE9BQWUsRUFDZixpQkFDRSxtQkFBbUIsRUFDckIsTUFBNEIsYUFBYTtFQUV6QyxNQUFNLFdBQVcsS0FBSyxLQUFLLENBQUMsS0FBSyxHQUFHLE1BQU07RUFDMUMsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDLEVBQUUsVUFBVTtFQUV6QyxxRUFBcUU7RUFDckUscUVBQXFFO0VBQ3JFLHdFQUF3RTtFQUN4RSx3RUFBd0U7RUFDeEUsa0VBQWtFO0VBQ2xFLHNEQUFzRDtFQUN0RCxJQUNFLGFBQWEsTUFBTSxhQUFhLE9BQU8sYUFBYSxRQUNwRCxTQUFTLFFBQVEsQ0FBQyxRQUFRLFNBQVMsUUFBUSxDQUFDLE9BQzVDO0lBQ0EsT0FBTztNQUNMLFNBQVM7TUFDVCxTQUFTLENBQUMsaURBQWlELENBQUMsR0FDMUQsQ0FBQyxDQUFDLEVBQUUsU0FBUyxxQkFBcUIsRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUNoRDtFQUNGO0VBRUEsTUFBTSxpQkFBaUIsTUFBTSxlQUFlO0VBQzVDLElBQUksZ0JBQWdCLE9BQU87SUFBRSxTQUFTO0lBQU8sU0FBUztFQUFlO0VBRXJFLDBFQUEwRTtFQUMxRSx5RUFBeUU7RUFDekUsNkRBQTZEO0VBQzdELE1BQU0sWUFBWSxNQUFNLG1CQUFtQjtFQUMzQyxJQUFJLENBQUMsVUFBVSxFQUFFLEVBQUU7SUFDakIsT0FBTztNQUFFLFNBQVM7TUFBTyxTQUFTLFVBQVUsS0FBSyxDQUFDLE9BQU87SUFBQztFQUM1RDtFQUVBLHdFQUF3RTtFQUN4RSx5RUFBeUU7RUFDekUsMkVBQTJFO0VBQzNFLGtFQUFrRTtFQUNsRSxJQUFJLGdCQUErQjtFQUNuQyxJQUFJO0VBQ0osSUFBSTtJQUNGLFdBQVcsTUFBTSxrQkFBa0I7RUFDckMsRUFBRSxPQUFPLE9BQU87SUFDZCxPQUFPO01BQUUsU0FBUztNQUFPLFNBQVMsT0FBTztJQUFPO0VBQ2xEO0VBQ0EsSUFBSSxhQUFhLE1BQU07SUFDckIsTUFBTSxZQUFZLE1BQU0sb0JBQ3RCLE1BQ0EsVUFDQSxTQUNBO0lBRUYsSUFBSSxDQUFDLFVBQVUsRUFBRSxFQUFFO01BQ2pCLE9BQU87UUFBRSxTQUFTO1FBQU8sU0FBUyxVQUFVLEtBQUssQ0FBQyxPQUFPO01BQUM7SUFDNUQ7SUFDQSxnQkFBZ0IsVUFBVSxLQUFLO0VBQ2pDO0VBRUEsaUNBQWlDO0VBQ2pDLElBQUk7SUFDRixNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksQ0FBQztJQUM3QixJQUFJLEtBQUssV0FBVyxFQUFFO01BQ3BCLE1BQU0sYUFBYSxtQkFBbUIsc0JBQ2xDLE1BQU0sb0JBQW9CLFVBQVUsV0FBVyxXQUFXLFFBQzFELE1BQU0sZUFBZTtNQUN6QixJQUFJLFlBQVksT0FBTztRQUFFLFNBQVM7UUFBTyxTQUFTO01BQVc7TUFDN0QsdUJBQXVCO01BQ3ZCLE1BQU0sc0JBQXNCLE1BQU0sSUFDaEM7UUFBQztRQUFnQjtPQUEyQixFQUM1QztRQUFFLEtBQUs7TUFBUztNQUVsQixJQUFJLGdCQUFnQixRQUFRLDJEQUEyRDtNQUN2RixJQUFJLG9CQUFvQixFQUFFLElBQUksb0JBQW9CLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztRQUNsRSxNQUFNLE1BQU0sb0JBQW9CLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSTtRQUNqRCxnQkFBZ0IsSUFBSSxPQUFPLENBQUMsd0JBQXdCO01BQ3REO01BRUEsdUVBQXVFO01BQ3ZFLHdFQUF3RTtNQUN4RSxvRUFBb0U7TUFDcEUsc0VBQXNFO01BQ3RFLHNFQUFzRTtNQUN0RSxtRUFBbUU7TUFDbkUsTUFBTSxTQUFTLE1BQU0sdUJBQXVCO01BQzVDLElBQUksUUFBUTtRQUNWLElBQUk7VUFDRix1QkFBdUIsUUFBUTtVQUMvQixnQkFBZ0I7UUFDbEIsRUFBRSxPQUFPLE9BQU87VUFDZCxnRUFBZ0U7VUFDaEUsa0VBQWtFO1VBQ2xFLHNEQUFzRDtVQUN0RCxRQUFRLEtBQUssQ0FDWCxDQUFDLDhDQUE4QyxDQUFDLEdBQzlDLEdBQUcsTUFBTSx1QkFBdUIsVUFBVSxHQUFHLENBQUMsR0FDOUMsR0FBRyxpQkFBaUIsUUFBUSxNQUFNLE9BQU8sR0FBRyxPQUFPLE9BQU8sRUFBRSxDQUFDLEdBQzdELENBQUMsaUJBQWlCLEVBQUUsY0FBYyxFQUFFLENBQUM7UUFFM0M7TUFDRjtNQUVBLDhDQUE4QztNQUM5QyxNQUFNLGdCQUFnQixlQUFlO1FBQUUsS0FBSztNQUFTO01BRXJELE1BQU0sa0JBQWtCLE1BQU0sSUFBSTtRQUFDO1FBQVM7UUFBVTtPQUFPLEVBQUU7UUFDN0QsS0FBSztNQUNQO01BQ0Esd0VBQXdFO01BQ3hFLHFFQUFxRTtNQUNyRSxzRUFBc0U7TUFDdEUsb0VBQW9FO01BQ3BFLHVFQUF1RTtNQUN2RSx5REFBeUQ7TUFDekQsTUFBTSxVQUFVLE1BQU0saUJBQWlCO1FBQUUsS0FBSztNQUFTO01BQ3ZELElBQUksQ0FBQyxRQUFRLEVBQUUsRUFBRTtRQUNmLE9BQU87VUFBRSxTQUFTO1VBQU8sU0FBUyxRQUFRLEtBQUssQ0FBQyxPQUFPO1FBQUM7TUFDMUQ7TUFFQSw2REFBNkQ7TUFDN0QsTUFBTSxtQkFBbUIsb0JBQW9CLFNBQVM7TUFDdEQsTUFBTSxhQUFhLE1BQU0sbUJBQW1CO01BQzVDLElBQUksV0FBVyxFQUFFLElBQUksV0FBVyxLQUFLLEdBQUcsR0FBRztRQUN6QyxNQUFNLGlCQUFpQixxQkFBcUIsbUJBQW1CO1FBQy9ELE1BQU0sZ0JBQWdCLHFCQUFxQixpQkFBaUI7UUFDNUQsSUFBSSxXQUFXLEtBQUssR0FBRyxnQkFBZ0I7VUFDckMsTUFBTSxlQUFlLGtCQUFrQjtZQUNyQyxjQUFjO1lBQ2QsWUFBWTtVQUNkO1FBQ0Y7TUFDRjtNQUVBLDRGQUE0RjtNQUM1RixNQUFNLGVBQWUsVUFBVSxTQUFTO01BRXhDLE1BQU0saUJBQWlCLE1BQU0sSUFDM0Isa0JBQWtCLGdCQUNsQjtRQUFFLEtBQUs7TUFBUztNQUdsQix3RUFBd0U7TUFDeEUsaUVBQWlFO01BQ2pFLHVFQUF1RTtNQUN2RSxnRUFBZ0U7TUFDaEUsd0VBQXdFO01BQ3hFLE1BQU0sZ0JBQWdCLE1BQU0sOEJBQThCO1FBQ3hELEtBQUs7TUFDUDtNQUNBLElBQUksQ0FBQyxjQUFjLEVBQUUsRUFBRTtRQUNyQixRQUFRLElBQUksQ0FDVixDQUFDLG1EQUFtRCxFQUFFLEtBQUssRUFBRSxFQUFFLGNBQWMsS0FBSyxDQUFDLE9BQU8sRUFBRTtNQUVoRyxPQUFPLElBQUksY0FBYyxLQUFLLENBQUMsUUFBUSxFQUFFO1FBQ3ZDLFFBQVEsR0FBRyxDQUNULENBQUMsc0RBQXNELEVBQUUsS0FBSyxvQkFBb0IsRUFDaEYsY0FBYyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxNQUNqQyxDQUFDLENBQUM7TUFFUDtNQUNBLE1BQU0scUJBQXFCLGNBQWMsRUFBRSxJQUN6QyxjQUFjLEtBQUssQ0FBQyxRQUFRO01BRTlCLG9FQUFvRTtNQUNwRSxzRUFBc0U7TUFDdEUsb0VBQW9FO01BQ3BFLHNFQUFzRTtNQUN0RSw4QkFBOEI7TUFDOUIsTUFBTSxZQUFZLE1BQU0sNkJBQ3RCLFVBQ0E7TUFFRixJQUFJLGNBSU87TUFDWCxJQUFJLFVBQVUsUUFBUSxJQUFJLENBQUMsb0JBQW9CO1FBQzdDLFFBQVEsR0FBRyxDQUNULENBQUMsMkNBQTJDLEVBQUUsS0FBSyxDQUFDLEVBQUUsVUFBVSxNQUFNLENBQUMscUJBQXFCLEVBQUUsVUFBVSxlQUFlLENBQUMsQ0FBQyxDQUFDO01BRTlILE9BQU87UUFDTCxRQUFRLEdBQUcsQ0FDVCxDQUFDLHVDQUF1QyxFQUFFLEtBQUssQ0FBQyxFQUM5QyxxQkFBcUIsMkJBQTJCLFVBQVUsTUFBTSxFQUNoRTtRQUdKLGtEQUFrRDtRQUNsRCxNQUFNLGtCQUFrQixNQUFNLGdDQUM1QixVQUNBLG9CQUNBLHFCQUFxQixjQUFjO1FBRXJDLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxFQUFFO1VBQ3ZCLE9BQU87WUFBRSxTQUFTO1lBQU8sU0FBUyxnQkFBZ0IsS0FBSyxDQUFDLE9BQU87VUFBQztRQUNsRTtRQUVBLGNBQWMsTUFBTSxJQUFJO1VBQUM7VUFBUztTQUFTLEVBQUU7VUFDM0MsS0FBSztRQUNQO01BQ0Y7TUFFQSxxRUFBcUU7TUFDckUsbUVBQW1FO01BQ25FLE1BQU0sb0JBQW9CLE1BQU0sSUFDOUI7UUFBQztRQUFTO1FBQVUsQ0FBQyxPQUFPLEVBQUUsZUFBZTtPQUFDLEVBQzlDO1FBQUUsS0FBSztNQUFTO01BR2xCLGlFQUFpRTtNQUNqRSxvRUFBb0U7TUFDcEUsb0VBQW9FO01BQ3BFLG1FQUFtRTtNQUNuRSxtRUFBbUU7TUFDbkUscUVBQXFFO01BQ3JFLE1BQU0sYUFBYSxzQkFBc0Isb0JBQ3ZDLHNCQUFzQixtQkFDdEIsQ0FBQyxjQUFjLHNCQUFzQixlQUFlLElBQUksS0FDeEQsc0JBQXNCO01BRXhCLElBQUksZUFBZSxNQUFNO1FBQ3ZCLE1BQU0sWUFBWSxNQUFNLG9CQUN0QixNQUNBLFVBQ0EsU0FDQTtRQUVGLElBQUksQ0FBQyxVQUFVLEVBQUUsRUFBRTtVQUNqQixPQUFPO1lBQUUsU0FBUztZQUFPLFNBQVMsVUFBVSxLQUFLLENBQUMsT0FBTztVQUFDO1FBQzVEO1FBQ0EsZ0JBQWdCLFVBQVUsS0FBSztNQUMvQixvRUFBb0U7TUFDcEUscURBQXFEO01BQ3ZELE9BQU87UUFDTCwrREFBK0Q7UUFDL0QsTUFBTSxTQUFTLE1BQU0sd0JBQXdCLFVBQVU7UUFDdkQsSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUFFO1VBQ2QsT0FBTztZQUFFLFNBQVM7WUFBTyxTQUFTLE9BQU8sS0FBSyxDQUFDLE9BQU87VUFBQztRQUN6RDtRQUVBLE9BQU87VUFDTCxTQUFTO1VBQ1QsU0FBUztVQUNULE1BQU07WUFBRTtZQUFVO1VBQWM7UUFDbEM7TUFDRjtJQUNGO0VBQ0YsRUFBRSxPQUFNO0VBQ04sNkNBQTZDO0VBQy9DO0VBRUEsa0RBQWtEO0VBQ2xELE1BQU0sa0JBQWtCLE1BQU0sZ0NBQzVCLFNBQ0EsQ0FBQyxjQUFjLEVBQUUsTUFBTSxFQUN2QixxQkFBcUIsY0FBYztFQUVyQyxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsRUFBRTtJQUN2QixPQUFPO01BQUUsU0FBUztNQUFPLFNBQVMsZ0JBQWdCLEtBQUssQ0FBQyxPQUFPO0lBQUM7RUFDbEU7RUFFQSw4RUFBOEU7RUFDOUUsMkVBQTJFO0VBQzNFLDBFQUEwRTtFQUMxRSx3RUFBd0U7RUFDeEUsTUFBTSxjQUFjLE1BQU0sUUFBUSxzQkFBc0IsTUFBTTtFQUM5RCxJQUFJLFlBQVksSUFBSSxLQUFLLEdBQUc7SUFDMUIsb0VBQW9FO0lBQ3BFLGtFQUFrRTtJQUNsRSxpRUFBaUU7SUFDakUsTUFBTSxVQUFVLGtCQUFrQixPQUM5QixDQUFDLGdCQUFnQixFQUFFLEtBQUssRUFBRSxFQUFFLFlBQVksTUFBTSxDQUFDLGdCQUFnQixFQUFFLFNBQVMseUNBQXlDLEVBQUUsY0FBYyxDQUFDLENBQUMsR0FDckksQ0FBQyxnQkFBZ0IsRUFBRSxLQUFLLEVBQUUsRUFBRSxZQUFZLE1BQU0sRUFBRTtJQUNwRCxPQUFPO01BQUUsU0FBUztNQUFPO0lBQVE7RUFDbkM7RUFFQSx1RUFBdUU7RUFDdkUsK0VBQStFO0VBQy9FLE1BQU0sc0JBQXNCLE1BQU0sZUFBZTtFQUNqRCxJQUFJLHFCQUFxQjtJQUN2QixJQUFJO01BQ0YsTUFBTSxhQUFhLE1BQU0sS0FBSyxXQUFXLENBQUM7UUFDeEMsS0FBSztRQUNMLFFBQVEsQ0FBQyxXQUFXLEVBQUUsU0FBUyxDQUFDLENBQUM7TUFDbkM7TUFDQSxNQUFNLEtBQUssTUFBTSxDQUFDLFVBQVUsR0FBRyxXQUFXLENBQUMsRUFBRSxVQUFVO01BQ3ZELE9BQU87UUFDTCxTQUFTO1FBQ1QsU0FBUyxHQUFHLG9CQUFvQixpQkFBaUIsRUFBRSxZQUFZO01BQ2pFO0lBQ0YsRUFBRSxPQUFPLE9BQU87TUFDZCxPQUFPO1FBQ0wsU0FBUztRQUNULFNBQVMsR0FBRyxvQkFBb0IsOEJBQThCLEVBQUUsT0FBTztNQUN6RTtJQUNGO0VBQ0Y7RUFFQSwyRUFBMkU7RUFDM0UsMkVBQTJFO0VBQzNFLDZEQUE2RDtFQUM3RCxNQUFNLGlCQUFpQixNQUFNLElBQUk7SUFBQztJQUFhO0dBQVMsRUFBRTtJQUN4RCxLQUFLO0VBQ1A7RUFDQSxJQUFJLENBQUMsZUFBZSxFQUFFLElBQUksZUFBZSxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUc7SUFDekQsTUFBTSxTQUFTLGVBQWUsRUFBRSxHQUM1QixlQUFlLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUNoQyxDQUFDLEtBQUssRUFBRSxlQUFlLEtBQUssQ0FBQyxJQUFJLEVBQUUsR0FDbkMsZUFBZSxLQUFLLENBQUMsT0FBTztJQUNoQyxRQUFRLElBQUksQ0FDVixDQUFDLCtEQUErRCxFQUFFLFFBQVE7RUFFOUU7RUFFQSwrRUFBK0U7RUFDL0UsTUFBTSxhQUFhLE1BQU0sbUJBQW1CO0VBQzVDLElBQUksV0FBVyxFQUFFLEVBQUU7SUFDakIsTUFBTSxNQUFNLEtBQUssS0FBSyxDQUFDLFdBQVcsS0FBSyxHQUFHO0lBQzFDLFFBQVEsR0FBRyxDQUFDLENBQUMsOEJBQThCLEVBQUUsS0FBSyxXQUFXLEVBQUUsSUFBSSxJQUFJLENBQUM7RUFDMUU7RUFFQSwyQkFBMkI7RUFDM0IsTUFBTSxzQkFBc0IsTUFBTSxJQUNoQztJQUFDO0lBQWdCO0dBQTJCLEVBQzVDO0lBQUUsS0FBSztFQUFTO0VBRWxCLElBQUksZ0JBQWdCLFFBQVEsMkRBQTJEO0VBQ3ZGLElBQUksb0JBQW9CLEVBQUUsSUFBSSxvQkFBb0IsS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHO0lBQ2xFLE1BQU0sTUFBTSxvQkFBb0IsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJO0lBQ2pELGdCQUFnQixJQUFJLE9BQU8sQ0FBQyx3QkFBd0I7RUFDdEQ7RUFFQSwrREFBK0Q7RUFDL0QsTUFBTSxTQUFTLE1BQU0sd0JBQXdCLFVBQVU7RUFDdkQsSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUFFO0lBQ2QsT0FBTztNQUFFLFNBQVM7TUFBTyxTQUFTLE9BQU8sS0FBSyxDQUFDLE9BQU87SUFBQztFQUN6RDtFQUVBLE9BQU87SUFDTCxTQUFTO0lBQ1QsU0FBUztJQUNULE1BQU07TUFBRTtNQUFVO0lBQWM7RUFDbEM7QUFDRiJ9
// denoCacheMetadata=17803177395726065976,2643741504860082038