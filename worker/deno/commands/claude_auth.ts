/**
 * Claude authentication command for the Vibe Coder worker (Issue #913).
 *
 * Provides Claude CLI authentication verification via the Deno CLI (`deno run mod.ts <command>`).
 * Replaces worker/shared/claude_auth.sh.
 *
 * Sub-operations (--operation):
 *   - is-auth-error: Check if error text indicates auth failure
 *   - is-auth-error-in-file: Check if a file's tail contains auth errors
 *   - actionable-message: Return human-readable fix instructions
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  claudeAuthActionableMessage,
  isClaudeAuthError,
  isClaudeAuthErrorInFile,
} from "../lib/claude_auth.ts";

export const claudeAuthCommand: Command = {
  name: "claude-auth",
  description: "Claude CLI authentication verification (Issue #913)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");

    switch (operation) {
      case "is-auth-error": {
        const errorOutput = String(args["error-output"] ?? "");
        const isError = isClaudeAuthError(errorOutput);
        return {
          success: true,
          message: String(isError),
          data: { isAuthError: isError },
        };
      }

      case "is-auth-error-in-file": {
        const filePath = String(args["file-path"] ?? "");
        if (!filePath) {
          return {
            success: false,
            message: "Missing required argument: --file-path",
          };
        }
        const result = await isClaudeAuthErrorInFile(filePath);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: String(result.value),
          data: { isAuthError: result.value },
        };
      }

      case "actionable-message": {
        const message = claudeAuthActionableMessage();
        return { success: true, message };
      }

      default:
        return {
          success: false,
          message:
            `Unknown operation: ${operation}. Valid: is-auth-error, is-auth-error-in-file, actionable-message`,
        };
    }
  },
};
