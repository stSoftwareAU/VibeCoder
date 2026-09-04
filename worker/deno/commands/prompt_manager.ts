/**
 * Prompt manager command for the Vibe Coder worker (Issue #914, #844).
 *
 * Provides prompt template access and validation via the Deno CLI
 * (`deno run mod.ts <command>`). Replaces worker/shared/prompt_manager.sh.
 *
 * Sub-operations (--operation):
 *   - load-prompt: Load a prompt template by name
 *   - record-commit: Record the prompts checkout commit for traceability
 *   - validate-template: Validate a template has required placeholders
 *   - validate-all: Validate all prompt templates
 *   - get-required-placeholders: Get required placeholders for a template type
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  getRequiredPlaceholders,
  loadPrompt,
  recordPromptCommit,
  validateAllPromptTemplates,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const VALID_OPERATIONS = [
  "load-prompt",
  "record-commit",
  "validate-template",
  "validate-all",
  "get-required-placeholders",
];

export const promptManagerCommand: Command = {
  name: "prompt-manager",
  description: "Prompt template access and validation (Issue #914)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");
    const promptsDir = args["prompts-dir"]
      ? String(args["prompts-dir"])
      : undefined;

    switch (operation) {
      case "load-prompt": {
        const promptName = String(args["prompt-name"] ?? "");
        if (!promptName) {
          return {
            success: false,
            message: "Missing required argument: --prompt-name",
          };
        }
        const result = await loadPrompt(promptName, promptsDir);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: result.value };
      }

      case "record-commit": {
        const logFile = String(args["log-file"] ?? "");
        const commit = String(args["commit"] ?? "");
        if (!logFile || !commit) {
          return {
            success: false,
            message: "Missing required arguments: --log-file, --commit",
          };
        }
        const result = await recordPromptCommit(logFile, commit);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "Commit recorded" };
      }

      case "validate-template": {
        const templateType = String(args["template-type"] ?? "");
        const templateContent = String(args["template-content"] ?? "");
        if (!templateType) {
          return {
            success: false,
            message: "Missing required argument: --template-type",
          };
        }
        const result = validatePromptTemplate(templateType, templateContent);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "Template valid" };
      }

      case "validate-all": {
        const result = await validateAllPromptTemplates(promptsDir);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "All templates valid" };
      }

      case "get-required-placeholders": {
        const templateType = String(args["template-type"] ?? "");
        if (!templateType) {
          return {
            success: false,
            message: "Missing required argument: --template-type",
          };
        }
        const result = getRequiredPlaceholders(templateType);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: result.value.join("\n"),
          data: { placeholders: result.value },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown operation: ${operation}. Valid: ${
            VALID_OPERATIONS.join(", ")
          }`,
        };
    }
  },
};
