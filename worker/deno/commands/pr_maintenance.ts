/**
 * PR maintenance command (Issue #967, #1119, #1120).
 *
 * Command wrapper for the PR maintenance library.
 * Exposes PR scanning and maintenance operations as a Deno command,
 * including find-pr-comments-to-fix, find-failed-pr-checks, and
 * find-failed-ci-checks for shell delegation.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  assertSafeGitRef,
  buildCheckoutArgs,
  buildFetchArgs,
} from "../lib/git_ref_args.ts";
import {
  ensureAutoMergeOnOpenPrs,
  extractIssueFromBranch,
  findFailedCiChecks,
  findFailedPrChecks,
  findPrCommentsToFix,
} from "../lib/pr_maintenance.ts";
import {
  executePrBranchUpdates,
  isWorkerPr,
  type PrBranchEntry,
  type PrBranchStateEntry,
  scanPrBranchUpdates,
} from "../lib/pr_branch_update.ts";
import { fetchPRBranchStateBatch } from "../lib/pr_branch_state.ts";
import {
  formatPrCommentToFix,
  type PrCommentToFix,
} from "../lib/pr_comments.ts";
import { type FailedCiCheck, formatFailedCheck } from "../lib/pr_ci_checks.ts";
import { createLogger } from "../lib/logger.ts";
import { runGhCommand } from "../lib/github.ts";
import { isAuthorisedCommenter } from "../lib/security.ts";
import { isRepoAllowed } from "../lib/config_validator.ts";
import { shuffleArray } from "../lib/array_utils.ts";
import { getRepoDefaultBranch } from "../lib/shell_helpers.ts";
import { enableAutoMerge } from "../lib/pr_auto_merge.ts";
import { directMergePr } from "../lib/direct_merge.ts";
import { getRepoConfig } from "../lib/repo_config.ts";
import { setupRepo } from "./git_operations.ts";
import { updatePrBranch } from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { getWorkerUniqueId } from "../lib/worker_identity.ts";

// Re-export library functions for external use
export {
  extractIssueFromBranch,
  findFailedCiChecks,
  findFailedPrChecks,
  findPrCommentsToFix,
};
export { ensureAutoMergeOnOpenPrs } from "../lib/pr_maintenance.ts";
export {
  executePrBranchUpdates,
  scanPrBranchUpdates,
} from "../lib/pr_branch_update.ts";

/**
 * Parse repos argument from command args or config.
 */
function parseRepos(
  args: Record<string, unknown>,
  config: WorkerConfig,
): string[] {
  if (Array.isArray(args["repos"])) {
    return (args["repos"] as unknown[]).map(String);
  }
  if (typeof args["repos"] === "string") {
    try {
      return JSON.parse(args["repos"] as string) as string[];
    } catch {
      return (args["repos"] as string).split(",").map((r) => r.trim()).filter(
        Boolean,
      );
    }
  }
  return config.repos ?? [];
}

/** The pr-maintenance command. */
export const prMaintenanceCommand: Command = {
  name: "pr-maintenance",
  description:
    "PR scanning and maintenance operations (Issue #967, #1119, #1120)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<PrCommentToFix | FailedCiCheck | null>> {
    const operation = String(args["operation"] ?? "");

    if (operation === "extract-issue-from-branch") {
      const branchName = String(args["branch-name"] ?? "");
      const issueNumber = extractIssueFromBranch(branchName);
      return {
        success: true,
        message: issueNumber ?? "",
      };
    }

    if (operation === "find-pr-comments-to-fix") {
      const githubUser = String(
        args["github-user"] ?? Deno.env.get("GITHUB_USER") ?? "",
      );
      const repos = parseRepos(args, config);

      if (!githubUser) {
        return {
          success: false,
          message: "Missing required argument: --github-user",
        };
      }

      if (repos.length === 0) {
        return {
          success: false,
          message: "No repositories configured",
        };
      }

      const logger = createLogger({
        debug: Deno.env.get("DEBUG") === "true",
      });

      const authorisedCommenters = config.authorisedCommenters ?? [];

      const result = await findPrCommentsToFix({
        githubUser,
        repos,
        logger,
        isRepoAllowed: (repo: string) => isRepoAllowed(repos, repo),
        isAuthorisedCommenter: (author: string) =>
          isAuthorisedCommenter(author, authorisedCommenters),
        ghCommandFn: runGhCommand,
        shuffleRepos: shuffleArray,
        prAuthors: config.fleetPrAuthors ?? [],
        allowedAuthors: config.allowedAuthors ?? [],
      });

      if (!result.ok) {
        return { success: false, message: result.error.message };
      }

      if (!result.value) {
        return { success: false, message: "" };
      }

      return {
        success: true,
        message: formatPrCommentToFix(result.value),
        data: result.value,
      };
    }

    // --- find-failed-pr-checks (spelling check failures) — Issue #1120 ---
    if (operation === "find-failed-pr-checks") {
      const githubUser = String(
        args["github-user"] ?? Deno.env.get("GITHUB_USER") ?? "",
      );
      const repos = parseRepos(args, config);

      if (!githubUser) {
        return {
          success: false,
          message: "Missing required argument: --github-user",
        };
      }
      if (repos.length === 0) {
        return { success: false, message: "No repositories configured" };
      }

      const logger = createLogger({
        debug: Deno.env.get("DEBUG") === "true",
      });

      const result = await findFailedPrChecks({
        githubUser,
        repos,
        logger,
        isRepoAllowed: (repo: string) => isRepoAllowed(repos, repo),
        isAuthorisedCommenter: () => true,
        ghCommandFn: runGhCommand,
        shuffleRepos: shuffleArray,
        prAuthors: config.fleetPrAuthors ?? [],
        allowedAuthors: config.allowedAuthors ?? [],
      });

      if (!result.ok) {
        return { success: false, message: result.error.message };
      }

      if (!result.value) {
        return { success: false, message: "" };
      }

      return {
        success: true,
        message: formatFailedCheck(result.value),
        data: result.value,
      };
    }

    // --- find-failed-ci-checks (non-spelling CI failures) — Issue #1120 ---
    if (operation === "find-failed-ci-checks") {
      const githubUser = String(
        args["github-user"] ?? Deno.env.get("GITHUB_USER") ?? "",
      );
      const repos = parseRepos(args, config);
      const maxRetries = Number(args["max-retries"] ?? 3);
      const stateDir = String(
        args["state-dir"] ?? Deno.env.get("CI_CHECK_STATE_DIR") ??
          ".ci_check_state",
      );

      if (!githubUser) {
        return {
          success: false,
          message: "Missing required argument: --github-user",
        };
      }
      if (repos.length === 0) {
        return { success: false, message: "No repositories configured" };
      }

      const logger = createLogger({
        debug: Deno.env.get("DEBUG") === "true",
      });

      const result = await findFailedCiChecks({
        githubUser,
        repos,
        logger,
        isRepoAllowed: (repo: string) => isRepoAllowed(repos, repo),
        isAuthorisedCommenter: () => true,
        ghCommandFn: runGhCommand,
        shuffleRepos: shuffleArray,
        maxRetries,
        stateDir,
        prAuthors: config.fleetPrAuthors ?? [],
        allowedAuthors: config.allowedAuthors ?? [],
        getDefaultBranch: async (repo: string) => {
          const branchResult = await getRepoDefaultBranch(repo);
          if (branchResult.ok) return branchResult.value;
          return "main";
        },
      });

      if (!result.ok) {
        return { success: false, message: result.error.message };
      }

      if (!result.value) {
        return { success: false, message: "" };
      }

      return {
        success: true,
        message: formatFailedCheck(result.value),
        data: result.value,
      };
    }

    // --- update-open-pr-branches (scan + execute) — Issue #1122, #1233 ---
    if (operation === "update-open-pr-branches") {
      const githubUser = String(
        args["github-user"] ?? Deno.env.get("GITHUB_USER") ?? "",
      );
      const repos = parseRepos(args, config);
      const workDir = String(
        args["work-dir"] ?? config.workDir ?? Deno.env.get("WORK_DIR") ?? "",
      );

      if (!githubUser) {
        return {
          success: false,
          message: "Missing required argument: --github-user",
        };
      }
      if (repos.length === 0) {
        return { success: false, message: "No repositories configured" };
      }

      const logger = createLogger({
        debug: Deno.env.get("DEBUG") === "true",
      });

      const getDefaultBranch = async (repo: string): Promise<string> => {
        const branchResult = await getRepoDefaultBranch(repo);
        if (branchResult.ok) return branchResult.value;
        return "main"; // allow-hardcoded-branch — fallback after dynamic detection
      };

      // Phase 1: Scan for PRs that need updating
      const scanResult = await scanPrBranchUpdates({
        repos,
        logger,
        isRepoAllowed: (repo: string) => isRepoAllowed(repos, repo),
        getDefaultBranch,
        listPrs: async (repo: string): Promise<PrBranchEntry[]> => {
          try {
            const output = await runGhCommand([
              "pr",
              "list",
              "--repo",
              repo,
              "--state",
              "open",
              "--json",
              "number,headRefName,baseRefName,body",
              "--limit",
              "50",
            ]);
            const parsed: unknown = JSON.parse(output);
            if (!Array.isArray(parsed)) return [];
            return (parsed as Array<PrBranchEntry & { body?: string }>)
              .filter((pr) => isWorkerPr(pr.body, pr.headRefName))
              .map(({ number, headRefName, baseRefName }) => ({
                number,
                headRefName,
                baseRefName,
              }));
          } catch {
            return [];
          }
        },
        getBehindBy: async (
          repo: string,
          baseBranch: string,
          headBranch: string,
        ): Promise<number> => {
          const output = await runGhCommand([
            "api",
            `repos/${repo}/compare/${baseBranch}...${headBranch}`,
            "--jq",
            ".behind_by // 0",
          ]);
          return Number(output.trim()) || 0;
        },
        getMergeableStatus: async (
          repo: string,
          prNumber: number,
        ): Promise<string> => {
          const output = await runGhCommand([
            "pr",
            "view",
            String(prNumber),
            "--repo",
            repo,
            "--json",
            "mergeable",
            "--jq",
            ".mergeable",
          ]);
          return output.trim();
        },
        // Issue #1807: collapse 2N REST calls to one GraphQL call per
        // repo. On any failure return null so the scanner falls back
        // to the REST pair above.
        fetchBranchStateBatch: async (
          repo: string,
          prs: readonly PrBranchEntry[],
        ): Promise<Map<number, PrBranchStateEntry> | null> => {
          const result = await fetchPRBranchStateBatch(
            repo,
            prs.map((pr) => ({
              number: pr.number,
              baseRefName: pr.baseRefName || "main", // allow-hardcoded-branch — safe fallback
            })),
            runGhCommand,
          );
          if (!result.ok) {
            logger.debug(
              "PR branch-state batch fetch failed; falling back to REST",
              {
                repo,
                error: result.error.message,
              },
            );
            return null;
          }
          const out = new Map<number, PrBranchStateEntry>();
          for (const [num, state] of result.states) {
            out.set(num, {
              behindBy: state.behindBy,
              mergeable: state.mergeable,
            });
          }
          return out;
        },
      });

      if (!scanResult.ok) {
        return { success: false, message: scanResult.error.message };
      }

      const { actions, skippedCount: scanSkipped } = scanResult.value;

      if (actions.length === 0) {
        return {
          success: true,
          message:
            `PR branch update complete: 0 updated, ${scanSkipped} already current, 0 failed (Issue #379)`,
          data: {
            updatedCount: 0,
            skippedCount: scanSkipped,
            failedCount: 0,
            details: [],
          } as unknown as PrCommentToFix,
        };
      }

      // Phase 2: Execute updates (Issue #1233, #1281)
      const workerId = getWorkerUniqueId(config.workerName);
      const execResult = await executePrBranchUpdates(actions, {
        workDir,
        logger,
        workerId,
        setupRepo: async (repo: string, wd: string) => {
          const cmdResult = await setupRepo(repo, wd);
          if (!cmdResult.success) {
            return { ok: false as const, error: new Error(cmdResult.message) };
          }
          return { ok: true as const, value: cmdResult.message };
        },
        getDefaultBranch,
        performBranchUpdate: async (params: {
          repoPath: string;
          branchName: string;
          baseBranch: string;
          defaultBranch: string;
        }) => {
          const gitOptions = { cwd: params.repoPath };

          // Refuse an option-injecting ref before any git runs (Issue #12):
          // the PR head branch is attacker-controlled and can begin with a
          // dash, which git would parse as an option, not a ref.
          try {
            assertSafeGitRef(params.branchName, "PR head branch name");
            assertSafeGitRef(params.baseBranch, "PR base branch name");
          } catch (err) {
            return {
              ok: false as const,
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }

          const fetchBase = await runGitCommand(
            buildFetchArgs("origin", params.baseBranch),
            gitOptions,
          );
          if (!fetchBase.ok || fetchBase.value.code !== 0) {
            return {
              ok: false as const,
              error: new Error(
                `Failed to fetch base branch '${params.baseBranch}'`,
              ),
            };
          }

          // Update the PR branch (rebase + force-push). It checks the branch
          // out at its remote head itself (Issue #211), so this pass never
          // judges the PR by whatever the shared clone's local branch holds.
          const updateResult = await updatePrBranch(
            params.branchName,
            params.baseBranch,
            gitOptions,
          );

          // Restore default branch regardless of update outcome
          await runGitCommand(
            buildCheckoutArgs(params.defaultBranch),
            gitOptions,
          );

          return updateResult;
        },
      });

      if (!execResult.ok) {
        return { success: false, message: execResult.error.message };
      }

      const { updatedCount, failedCount, lockedCount, details } =
        execResult.value;
      const totalSkipped = scanSkipped;

      const lockedSuffix = lockedCount > 0
        ? `, ${lockedCount} locked by another worker`
        : "";
      return {
        success: true,
        message:
          `PR branch update complete: ${updatedCount} updated, ${totalSkipped} already current, ${failedCount} failed${lockedSuffix} (Issue #379)`,
        data: {
          updatedCount,
          skippedCount: totalSkipped,
          failedCount,
          lockedCount,
          details,
        } as unknown as PrCommentToFix,
      };
    }

    // --- ensure-auto-merge-on-open-prs — Issue #1234 ---
    if (operation === "ensure-auto-merge-on-open-prs") {
      const githubUser = String(
        args["github-user"] ?? Deno.env.get("GITHUB_USER") ?? "",
      );
      const repos = parseRepos(args, config);
      const needsScreenshotLabel = String(
        args["needs-screenshot-label"] ??
          Deno.env.get("NEEDS_SCREENSHOT_LABEL") ?? "needs-screenshot",
      );

      if (!githubUser) {
        return {
          success: false,
          message: "Missing required argument: --github-user",
        };
      }
      if (repos.length === 0) {
        return { success: false, message: "No repositories configured" };
      }

      const logger = createLogger({
        debug: Deno.env.get("DEBUG") === "true",
      });

      const repoConfigs = config.repoConfig;

      const result = await ensureAutoMergeOnOpenPrs({
        githubUser,
        repos,
        logger,
        isRepoAllowed: (repo: string) => isRepoAllowed(repos, repo),
        isAuthorisedCommenter: () => true,
        ghCommandFn: runGhCommand,
        prAuthors: config.fleetPrAuthors ?? [],
        allowedAuthors: config.allowedAuthors ?? [],
        getRepoConfig: (repo: string, key: string) =>
          getRepoConfig(repoConfigs, repo, key as "skipAutoMerge"),
        enableAutoMergeFn: async (
          repo: string,
          prNumber: number,
          headRefName?: string,
        ) => {
          const autoMergeResult = await enableAutoMerge({
            repo,
            prNumber,
            headRefName,
            ghCommandFn: runGhCommand,
            log: (message: string) => logger.warn(message),
          });
          return {
            result: autoMergeResult.result,
            message: autoMergeResult.message,
          };
        },
        directMergeFn: async (repo: string, prNumber: number) => {
          // The pre-merge backstop gate inside directMergePr re-checks CI
          // status and branch freshness (Issue #2582), so the redundant
          // pre-check here is removed. The outcome is returned so the scan
          // can update a stale branch or escalate a blocked merge rather
          // than swallowing the failure (Issue #3584).
          const merge = await directMergePr(repo, prNumber, runGhCommand);
          if (!merge.ok) {
            return { kind: "merge_error", message: merge.error.message };
          }
          if (merge.value.merged) {
            return { kind: "landed" };
          }
          logger.info(
            `Deferring direct-merge of PR #${prNumber} in ${repo}: ${
              merge.value.blocked ?? "checks_pending"
            } (Issue #2582)`,
          );
          return { kind: merge.value.blocked ?? "checks_pending" };
        },
        needsScreenshotLabel,
        needsHumanLabel: config.needsHumanLabel || "needs-human",
      });

      if (!result.ok) {
        return { success: false, message: result.error.message };
      }

      const { enabledCount, skippedCount, failedCount } = result.value;
      return {
        success: true,
        message:
          `Auto-merge scan complete: enabled=${enabledCount} skipped=${skippedCount} failed=${failedCount}`,
        data: result.value as unknown as PrCommentToFix,
      };
    }

    return {
      success: false,
      message:
        `Unknown operation: ${operation}. Valid: extract-issue-from-branch, find-pr-comments-to-fix, find-failed-pr-checks, find-failed-ci-checks, update-open-pr-branches, ensure-auto-merge-on-open-prs`,
    };
  },
};
