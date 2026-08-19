/**
 * Mermaid validator command for the Vibe Coder worker (Issue #914).
 *
 * Validates Mermaid gitGraph syntax in documentation.
 * Replaces worker/shared/mermaid_validator.sh.
 *
 * Sub-operations (--operation):
 *   - validate-gitgraph: Validate a gitGraph block
 *   - extract-blocks: Extract gitGraph blocks from markdown
 *   - validate-file: Extract and validate gitGraph blocks from a file
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  extractGitgraphBlocks,
  validateGitgraphFile,
  validateGitgraphSyntax,
} from "../lib/mermaid_validator.ts";

export const mermaidValidatorCommand: Command = {
  name: "mermaid-validator",
  description: "Mermaid gitGraph syntax validation (Issue #914)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");

    switch (operation) {
      case "validate-gitgraph": {
        const block = String(args["block"] ?? "");
        const result = validateGitgraphSyntax(block);
        if (!result.valid) {
          return {
            success: false,
            message: `ERROR: ${result.error}`,
          };
        }
        return { success: true, message: "Valid gitGraph block" };
      }

      case "extract-blocks": {
        const content = String(args["content"] ?? "");
        const blocks = extractGitgraphBlocks(content);
        return {
          success: true,
          message: blocks.join("\n---BLOCK---\n"),
          data: { blocks, count: blocks.length },
        };
      }

      case "validate-file": {
        const filePath = String(args["file-path"] ?? "");
        if (!filePath) {
          return {
            success: false,
            message: "Missing required argument: --file-path",
          };
        }
        const result = await validateGitgraphFile(filePath);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        const failures = result.value.filter((r) => !r.valid);
        if (failures.length > 0) {
          const errors = failures.map((f) => f.error).join("; ");
          return {
            success: false,
            message: `Invalid gitGraph blocks: ${errors}`,
          };
        }

        return {
          success: true,
          message: `All ${result.value.length} gitGraph blocks valid`,
          data: { blocksValidated: result.value.length },
        };
      }

      default:
        return {
          success: false,
          message:
            `Unknown operation: ${operation}. Valid: validate-gitgraph, extract-blocks, validate-file`,
        };
    }
  },
};
