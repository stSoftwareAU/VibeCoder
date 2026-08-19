/**
 * Prompt builder command for the Vibe Coder worker (Issue #914).
 *
 * Provides Claude prompt template generation via deno_bridge.sh.
 * Replaces worker/shared/prompt_builder.sh.
 *
 * Sub-operations (--operation):
 *   - build-issue-prompt: Build prompt for working on a GitHub issue
 *   - build-planning-prompt: Build prompt for planning mode
 *   - build-question-prompt: Build prompt for answering questions
 *   - build-pr-feedback-prompt: Build prompt for PR feedback
 *   - build-spelling-fix-prompt: Build prompt for spelling fixes
 *   - build-ci-fix-prompt: Build prompt for CI/integration failures
 *   - build-coding-guidelines: Build coding guidelines block
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildCiFixPrompt,
  buildCodingGuidelines,
  buildIssuePrompt,
  buildPlanningPrompt,
  buildPrFeedbackPrompt,
  buildQuestionPrompt,
  buildSpellingFixPrompt,
  buildWorkflowSetupPrompt,
} from "../lib/prompt_builder.ts";

export const promptBuilderCommand: Command = {
  name: "prompt-builder",
  description: "Claude prompt template generation (Issue #914)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");
    const promptsDir = args["prompts-dir"]
      ? String(args["prompts-dir"])
      : undefined;

    switch (operation) {
      case "build-issue-prompt": {
        const result = await buildIssuePrompt({
          repo: String(args["repo"] ?? ""),
          issueNumber: String(args["issue-number"] ?? ""),
          issueTitle: String(args["issue-title"] ?? ""),
          issueBody: String(args["issue-body"] ?? ""),
          issueLabels: String(args["issue-labels"] ?? ""),
          qualityInstructions: String(args["quality-instructions"] ?? ""),
          customInstructions: args["custom-instructions"]
            ? String(args["custom-instructions"])
            : undefined,
          screenshotRequired: args["screenshot-required"] === true ||
            args["screenshot-required"] === "true",
          skipScreenshotCheck: args["skip-screenshot-check"] === true ||
            args["skip-screenshot-check"] === "true",
          milestoneBranch: args["milestone-branch"]
            ? String(args["milestone-branch"])
            : undefined,
          promptsDir,
        });
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        // Return PromptParts as JSON for callers to parse (Issue #1262)
        return { success: true, message: JSON.stringify(result.value) };
      }

      case "build-planning-prompt": {
        const result = await buildPlanningPrompt({
          repo: String(args["repo"] ?? ""),
          issueNumber: String(args["issue-number"] ?? ""),
          issueTitle: String(args["issue-title"] ?? ""),
          issueBody: String(args["issue-body"] ?? ""),
          issueLabels: String(args["issue-labels"] ?? ""),
          issueComments: args["issue-comments"]
            ? String(args["issue-comments"])
            : undefined,
          planningLabel: args["planning-label"]
            ? String(args["planning-label"])
            : undefined,
          complexityContext: args["complexity-context"]
            ? String(args["complexity-context"])
            : undefined,
          promptsDir,
        });
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: JSON.stringify(result.value) };
      }

      case "build-question-prompt": {
        const result = await buildQuestionPrompt({
          repo: String(args["repo"] ?? ""),
          issueNumber: String(args["issue-number"] ?? ""),
          issueTitle: String(args["issue-title"] ?? ""),
          issueBody: String(args["issue-body"] ?? ""),
          issueLabels: String(args["issue-labels"] ?? ""),
          issueComments: args["issue-comments"]
            ? String(args["issue-comments"])
            : undefined,
          questionLabel: args["question-label"]
            ? String(args["question-label"])
            : undefined,
          promptsDir,
        });
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: JSON.stringify(result.value) };
      }

      case "build-pr-feedback-prompt": {
        const result = await buildPrFeedbackPrompt({
          repo: String(args["repo"] ?? ""),
          prNumber: String(args["pr-number"] ?? ""),
          commentBody: String(args["comment-body"] ?? ""),
          qualityInstructions: args["quality-instructions"]
            ? String(args["quality-instructions"])
            : undefined,
          customInstructions: args["custom-instructions"]
            ? String(args["custom-instructions"])
            : undefined,
          promptsDir,
        });
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: JSON.stringify(result.value) };
      }

      case "build-spelling-fix-prompt": {
        const result = await buildSpellingFixPrompt({
          repo: String(args["repo"] ?? ""),
          prNumber: String(args["pr-number"] ?? ""),
          checkName: String(args["check-name"] ?? ""),
          annotationDetails: String(args["annotation-details"] ?? ""),
          qualityInstructions: args["quality-instructions"]
            ? String(args["quality-instructions"])
            : undefined,
          customInstructions: args["custom-instructions"]
            ? String(args["custom-instructions"])
            : undefined,
          promptsDir,
        });
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: JSON.stringify(result.value) };
      }

      case "build-ci-fix-prompt": {
        const result = await buildCiFixPrompt({
          repo: String(args["repo"] ?? ""),
          prNumber: String(args["pr-number"] ?? ""),
          checkName: String(args["check-name"] ?? ""),
          annotationDetails: String(args["annotation-details"] ?? ""),
          qualityInstructions: args["quality-instructions"]
            ? String(args["quality-instructions"])
            : undefined,
          customInstructions: args["custom-instructions"]
            ? String(args["custom-instructions"])
            : undefined,
          promptsDir,
        });
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: JSON.stringify(result.value) };
      }

      case "build-workflow-setup-prompt": {
        const result = await buildWorkflowSetupPrompt({
          repo: String(args["repo"] ?? ""),
          languages: String(args["languages"] ?? ""),
          missingWorkflows: String(args["missing-workflows"] ?? ""),
          defaultBranch: String(args["default-branch"] ?? ""),
          existingWorkflows: String(args["existing-workflows"] ?? ""),
          promptsDir,
        });
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: JSON.stringify(result.value) };
      }

      case "build-coding-guidelines": {
        const skipScreenshots = args["skip-screenshots"] === true ||
          args["skip-screenshots"] === "true";
        const result = await buildCodingGuidelines(
          skipScreenshots,
          promptsDir,
        );
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: result.value };
      }

      default:
        return {
          success: false,
          message:
            `Unknown operation: ${operation}. Valid: build-issue-prompt, build-planning-prompt, build-question-prompt, build-pr-feedback-prompt, build-spelling-fix-prompt, build-ci-fix-prompt, build-workflow-setup-prompt, build-coding-guidelines`,
        };
    }
  },
};
