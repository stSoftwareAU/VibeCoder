/**
 * PR spelling fix processor command (Issue #967, #1230).
 *
 * Command wrapper for the spelling fix processor library.
 * Exposes spelling fix processing as a Deno command.
 *
 * Issue #1230: Added 'process' operation so shell can delegate the full
 * spelling fix workflow to Deno, including annotation decoding, prompt
 * building, Claude execution, and reply posting.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type CheckAnnotation,
  decodeAnnotations,
  formatAnnotations,
  processSpellingFailure,
  type SpellingFixInput,
  type SpellingFixResult,
  type SpellingProcessorDeps,
} from "../lib/pr_spelling_processor.ts";
import { createDefaultDeps } from "../lib/issue_worker_wiring.ts";
import {
  buildQualityInstructions,
  getCustomInstructions,
  runPreSetupCommand,
} from "../lib/repo_config.ts";

// Re-export library functions for external use
export { decodeAnnotations, formatAnnotations };
export type { CheckAnnotation, SpellingFixResult };

/** The pr-spelling-processor command. */
export const prSpellingProcessorCommand: Command = {
  name: "pr-spelling-processor",
  description: "Process spelling check failures on PRs (Issue #967, #1230)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<SpellingFixResult>> {
    const operation = String(args["operation"] ?? "");

    if (operation === "decode-annotations") {
      const encoded = String(args["encoded"] ?? "");
      const annotations = decodeAnnotations(encoded);
      return {
        success: true,
        message: `Decoded ${annotations.length} annotation(s)`,
        data: {
          processed: true,
          changesPushed: false,
          annotationCount: annotations.length,
          summary: `Decoded ${annotations.length} annotation(s)`,
        },
      };
    }

    if (operation === "format-annotations") {
      const encoded = String(args["encoded"] ?? "");
      const annotations = decodeAnnotations(encoded);
      const formatted = formatAnnotations(annotations);
      return {
        success: true,
        message: formatted,
      };
    }

    // Issue #1230: Full spelling fix workflow — delegates entirely to Deno.
    // Shell wrapper passes repo, pr-number, branch-name, check-run-id,
    // check-name, and encoded-annotations; this operation handles annotation
    // decoding, prompt building, Claude execution, and reply posting.
    if (operation === "process") {
      const repo = String(args["repo"] ?? "");
      const prNumber = Number(args["pr-number"] ?? 0);
      const branchName = String(args["branch-name"] ?? "");
      const checkRunId = String(args["check-run-id"] ?? "");
      const checkName = String(args["check-name"] ?? "");
      const encodedAnnotations = String(args["encoded-annotations"] ?? "");

      if (!repo || !prNumber || !branchName || !checkRunId || !checkName) {
        return {
          success: false,
          message:
            "Missing required arguments: --repo, --pr-number, --branch-name, --check-run-id, --check-name",
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
          ["fetch", "origin", branchName],
          { cwd: repoWorkDir },
        );
        await deps.git.runGitCommand(
          ["checkout", branchName],
          { cwd: repoWorkDir },
        );
        await deps.git.runGitCommand(
          ["pull", "origin", branchName],
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

        const input: SpellingFixInput = {
          repo,
          prNumber,
          branchName,
          checkRunId,
          checkName,
          encodedAnnotations,
        };

        const processorDeps: SpellingProcessorDeps = {
          logger: deps.logger,
          deps,
          workDir: repoWorkDir,
          qualityInstructions,
          customInstructions,
          claudeTimeout: config.claudeTimeout || undefined,
          claudeModel: config.claudeModel || undefined,
        };

        const result = await processSpellingFailure(input, processorDeps);
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
        deps.logger.error("Unhandled exception in spelling fix processing", {
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
            `Failed to fix spelling issues: ${errorMsg.slice(0, 500)}`,
          ]);
        } catch {
          // Best effort — do not mask the original error
        }

        return {
          success: false,
          message: `Unhandled spelling fix error: ${errorMsg}`,
        };
      }
    }

    return {
      success: false,
      message:
        `Unknown operation: ${operation}. Valid: decode-annotations, format-annotations, process`,
    };
  },
};
