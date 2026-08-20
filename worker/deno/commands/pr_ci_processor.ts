/**
 * PR CI fix processor command (Issue #967, #1230).
 *
 * Command wrapper for the CI fix processor library.
 * Exposes CI fix processing as a Deno command.
 *
 * Issue #1230: Added 'process' operation so shell can delegate the full
 * CI fix workflow to Deno, including annotation decoding, retry tracking,
 * prompt building, Claude execution, auto-merge re-enabling, and reply
 * posting.
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
  buildPullArgs,
} from "../lib/git_ref_args.ts";
import {
  type CiFixInput,
  type CiFixResult,
  type CiProcessorDeps,
  formatCiAnnotations,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { decodeAnnotations } from "../lib/pr_spelling_processor.ts";
import { createDefaultDeps } from "../lib/issue_worker_wiring.ts";
import {
  buildQualityInstructions,
  getCustomInstructions,
  runPreSetupCommand,
} from "../lib/repo_config.ts";
import { getWorkerUniqueId } from "../lib/worker_identity.ts";

// Re-export library functions for external use
export { formatCiAnnotations };
export type { CiFixResult };

/** The pr-ci-processor command. */
export const prCiProcessorCommand: Command = {
  name: "pr-ci-processor",
  description: "Process CI check failures on PRs (Issue #967, #1230)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<CiFixResult>> {
    const operation = String(args["operation"] ?? "");

    if (operation === "format-ci-annotations") {
      const encoded = String(args["encoded"] ?? "");
      const annotations = decodeAnnotations(encoded);
      const formatted = formatCiAnnotations(annotations);
      return {
        success: true,
        message: formatted,
      };
    }

    // Issue #1230: Full CI fix workflow — delegates entirely to Deno.
    // Shell wrapper passes repo, pr-number, branch-name, check-run-id,
    // check-name, and encoded-annotations; this operation handles annotation
    // decoding, retry count tracking, prompt building, Claude execution,
    // auto-merge re-enabling, and reply posting.
    if (operation === "process") {
      const repo = String(args["repo"] ?? "");
      const prNumber = Number(args["pr-number"] ?? 0);
      const branchName = String(args["branch-name"] ?? "");
      const checkRunId = String(args["check-run-id"] ?? "");
      const checkName = String(args["check-name"] ?? "");
      const encodedAnnotations = String(args["encoded-annotations"] ?? "");
      // Optional check details URL (Issue #1893) used by the PR failure
      // action dispatcher to locate the upstream Jenkins build. Empty
      // string sentinel becomes `undefined` so the dispatcher reports a
      // clean "no target URL" error rather than treating it as a value.
      const targetUrlArg = String(args["target-url"] ?? "").trim();
      const targetUrl = targetUrlArg === "" ? undefined : targetUrlArg;

      if (!repo || !prNumber || !branchName || !checkRunId || !checkName) {
        return {
          success: false,
          message:
            "Missing required arguments: --repo, --pr-number, --branch-name, --check-run-id, --check-name",
        };
      }

      try {
        assertSafeGitRef(branchName, "PR head branch name");
      } catch (err) {
        return {
          success: false,
          message: `Refusing to process PR #${prNumber}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      const deps = createDefaultDeps();

      // Top-level try/catch to prevent silent crashes (Issue #1230)
      try {
        // Set up the target repo directory
        const setupResult = await deps.git.setupRepo(
          repo,
          config.workDir || "",
        );
        if (!setupResult.ok) {
          return {
            success: false,
            message: `Failed to set up repo: ${setupResult.error.message}`,
          };
        }
        const repoWorkDir = setupResult.value;

        // Checkout and sync the PR branch
        await deps.git.runGitCommand(
          buildFetchArgs("origin", branchName),
          { cwd: repoWorkDir },
        );
        await deps.git.runGitCommand(
          buildCheckoutArgs(branchName),
          { cwd: repoWorkDir },
        );
        await deps.git.runGitCommand(
          buildPullArgs("origin", branchName),
          { cwd: repoWorkDir },
        );

        // Sync feature branch with default branch (Issue #230)
        const defaultBranchResult = await deps.git.getRepoDefaultBranch(repo);
        const defaultBranch = defaultBranchResult.ok
          ? defaultBranchResult.value
          : "main";
        await deps.git.syncFeatureBranchWithDefault(
          branchName,
          defaultBranch,
          { cwd: repoWorkDir },
        );

        // Run pre-setup command if configured
        await runPreSetupCommand(repo, repoWorkDir, config.repoConfig);

        // Build quality and custom instructions from config
        const qualityInstructions = buildQualityInstructions(
          config.repoConfig,
          repo,
        );
        const customInstructions = getCustomInstructions(
          config.repoConfig,
          repo,
        );

        const input: CiFixInput = {
          repo,
          prNumber,
          branchName,
          checkRunId,
          checkName,
          encodedAnnotations,
          ...(targetUrl !== undefined ? { targetUrl } : {}),
        };

        const processorDeps: CiProcessorDeps = {
          logger: deps.logger,
          deps,
          workDir: repoWorkDir,
          qualityInstructions,
          customInstructions,
          // Issue #1824: CI fix uses its own timeout, distinct from the
          // larger issue-work claudeTimeout.
          claudeTimeout: config.ciFixTimeout || undefined,
          claudeModel: config.claudeModel || undefined,
          // Pass repo-specific config so the post-Claude quality check picks
          // up per-repo Docker images and timeouts (Issue #1456).
          repoConfigs: config.repoConfig,
          // Issue #3754: cross-host PR lock so two hosts cannot fix the
          // same PR's CI failure concurrently.
          workerId: getWorkerUniqueId(config.workerName),
        };

        const result = await processCiFailure(input, processorDeps);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        return {
          success: true,
          message: JSON.stringify(result.value),
          data: result.value,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        deps.logger.error("Unhandled exception in CI fix processing", {
          repo,
          prNumber,
          error: errorMsg,
        });

        // Defence-in-depth: post failure comment
        try {
          await deps.github.runGhCommand([
            "pr",
            "comment",
            String(prNumber),
            "--repo",
            repo,
            "--body",
            `Failed to fix CI failure (**${checkName}**): ${
              errorMsg.slice(0, 500)
            }`,
          ]);
        } catch {
          // Best effort — do not mask the original error
        }

        return {
          success: false,
          message: `Unhandled CI fix error: ${errorMsg}`,
        };
      }
    }

    return {
      success: false,
      message:
        `Unknown operation: ${operation}. Valid: format-ci-annotations, process`,
    };
  },
};
