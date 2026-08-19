/**
 * Prompt manager command for the Vibe Coder worker (Issue #914).
 *
 * Provides prompt version management and immutability enforcement
 * via deno_bridge.sh. Replaces worker/shared/prompt_manager.sh.
 *
 * Sub-operations (--operation):
 *   - get-latest-version: Get the latest version for a prompt
 *   - list-versions: List available versions for a prompt
 *   - load-prompt: Load a prompt template by name and version
 *   - record-version: Record prompt version usage for traceability
 *   - validate-template: Validate a template has required placeholders
 *   - validate-all: Validate all prompt templates
 *   - validate-immutability: Check no existing versions were modified
 *   - get-required-placeholders: Get required placeholders for a template type
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  getLatestVersion,
  getRequiredPlaceholders,
  listPromptVersions,
  loadPrompt,
  recordPromptVersion,
  validateAllPromptTemplates,
  validatePromptImmutability,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

export const promptManagerCommand: Command = {
  name: "prompt-manager",
  description: "Prompt version management and immutability (Issue #914)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");
    const promptsDir = args["prompts-dir"]
      ? String(args["prompts-dir"])
      : undefined;

    switch (operation) {
      case "get-latest-version": {
        const promptName = String(args["prompt-name"] ?? "");
        if (!promptName) {
          return {
            success: false,
            message: "Missing required argument: --prompt-name",
          };
        }
        const result = await getLatestVersion(promptName, promptsDir);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: result.value };
      }

      case "list-versions": {
        const promptName = String(args["prompt-name"] ?? "");
        if (!promptName) {
          return {
            success: false,
            message: "Missing required argument: --prompt-name",
          };
        }
        const result = await listPromptVersions(promptName, promptsDir);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: result.value.join("\n"),
          data: { versions: result.value },
        };
      }

      case "load-prompt": {
        const promptName = String(args["prompt-name"] ?? "");
        const version = args["version"] ? String(args["version"]) : undefined;
        if (!promptName) {
          return {
            success: false,
            message: "Missing required argument: --prompt-name",
          };
        }
        const result = await loadPrompt(promptName, version, promptsDir);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: result.value };
      }

      case "record-version": {
        const logFile = String(args["log-file"] ?? "");
        const promptName = String(args["prompt-name"] ?? "");
        const version = String(args["version"] ?? "");
        if (!logFile || !promptName || !version) {
          return {
            success: false,
            message:
              "Missing required arguments: --log-file, --prompt-name, --version",
          };
        }
        const result = await recordPromptVersion(logFile, promptName, version);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "Version recorded" };
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

      case "validate-immutability": {
        const repoDir = String(args["repo-dir"] ?? "");
        const baseBranch = args["base-branch"]
          ? String(args["base-branch"])
          : undefined;
        if (!repoDir) {
          return {
            success: false,
            message: "Missing required argument: --repo-dir",
          };
        }
        const result = await validatePromptImmutability(repoDir, baseBranch);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "No immutability violations" };
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
          message:
            `Unknown operation: ${operation}. Valid: get-latest-version, list-versions, load-prompt, record-version, validate-template, validate-all, validate-immutability, get-required-placeholders`,
        };
    }
  },
};
