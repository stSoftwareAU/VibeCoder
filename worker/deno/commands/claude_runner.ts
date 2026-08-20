/**
 * Claude runner command for the Vibe Coder worker (Issue #913).
 *
 * Unified command for Claude CLI execution operations, callable from shell
 * via the Deno CLI (`deno run mod.ts <command>`). Replaces worker/shared/claude_runner.sh.
 *
 * Sub-operations (--operation):
 *   - strip-escape-codes: Remove terminal escape sequences from text
 *   - get-token-estimate: Estimate token count for text
 *   - extract-error-patterns: Find error patterns in output
 *   - extract-failure-summary: Find failure reasons in output
 *   - detect-already-complete: Check if issue is already done
 *   - detect-github-api-success: Check for successful GitHub API ops
 *   - detect-rate-limit: Check for rate limiting indicators
 *   - build-model-args: Build Claude CLI model arguments
 *   - capture-timeout-diagnostics: Capture diagnostic context
 *   - extract-stream-json-text: Extract text from stream-json output
 *   - check-dependencies: Validate required CLI tools
 *   - get-github-user: Get authenticated GitHub username
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildClaudeModelArgs,
  captureTimeoutDiagnostics,
  detectAlreadyComplete,
  detectGithubApiSuccess,
  detectRateLimit,
  extractErrorPatterns,
  extractFailureSummary,
  extractStreamJsonText,
  getTokenEstimate,
  stripEscapeCodes,
} from "../lib/claude_executor.ts";
import {
  checkDependencies,
  getGithubUser,
  summariseLargeContent,
} from "../lib/claude_runner.ts";

/** Helper to convert unknown to number. */
function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

export const claudeRunnerCommand: Command = {
  name: "claude-runner",
  description: "Claude CLI execution operations (Issue #913)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");

    switch (operation) {
      case "strip-escape-codes": {
        const text = String(args["text"] ?? "");
        return { success: true, message: stripEscapeCodes(text) };
      }

      case "get-token-estimate": {
        const text = String(args["text"] ?? "");
        const charsPerToken = toNumber(args["chars-per-token"], 4);
        const estimate = getTokenEstimate(text, charsPerToken);
        return {
          success: true,
          message: String(estimate),
          data: { tokenEstimate: estimate },
        };
      }

      case "extract-error-patterns": {
        const filePath = String(args["file-path"] ?? "");
        if (!filePath) {
          return {
            success: false,
            message: "Missing required argument: --file-path",
          };
        }
        let content: string;
        try {
          content = await Deno.readTextFile(filePath);
        } catch {
          return { success: true, message: "" };
        }
        const patterns = extractErrorPatterns(content);
        return { success: true, message: patterns.join("\n") };
      }

      case "extract-failure-summary": {
        const filePath = String(args["file-path"] ?? "");
        if (!filePath) {
          return {
            success: false,
            message: "Missing required argument: --file-path",
          };
        }
        let content: string;
        try {
          content = await Deno.readTextFile(filePath);
        } catch {
          return { success: true, message: "" };
        }
        const maxLines = toNumber(args["max-lines"], 10);
        const summary = extractFailureSummary(content, maxLines);
        return { success: true, message: summary.join("\n") };
      }

      case "detect-already-complete": {
        const filePath = String(args["file-path"] ?? "");
        if (!filePath) {
          return {
            success: false,
            message: "Missing required argument: --file-path",
          };
        }
        let content: string;
        try {
          content = await Deno.readTextFile(filePath);
        } catch {
          return {
            success: true,
            message: "false",
            data: { isComplete: false },
          };
        }
        const isComplete = detectAlreadyComplete(content);
        return {
          success: true,
          message: String(isComplete),
          data: { isComplete },
        };
      }

      case "detect-github-api-success": {
        const filePath = String(args["file-path"] ?? "");
        if (!filePath) {
          return {
            success: false,
            message: "Missing required argument: --file-path",
          };
        }
        let content: string;
        try {
          content = await Deno.readTextFile(filePath);
        } catch {
          return {
            success: true,
            message: "false",
            data: { isSuccess: false },
          };
        }
        const isSuccess = detectGithubApiSuccess(content);
        return {
          success: true,
          message: String(isSuccess),
          data: { isSuccess },
        };
      }

      case "detect-rate-limit": {
        const filePath = String(args["file-path"] ?? "");
        if (!filePath) {
          return {
            success: false,
            message: "Missing required argument: --file-path",
          };
        }
        let content: string;
        try {
          content = await Deno.readTextFile(filePath);
        } catch {
          return {
            success: true,
            message: "false",
            data: { isRateLimited: false },
          };
        }
        const tailLines = toNumber(args["tail-lines"], 30);
        const result = detectRateLimit(content, tailLines);
        return {
          success: true,
          message: String(result.isRateLimited),
          data: result,
        };
      }

      case "build-model-args": {
        const phase = args["phase"] ? String(args["phase"]) : undefined;
        const modelArgs = buildClaudeModelArgs(phase);
        return {
          success: true,
          message: modelArgs.join(" "),
          data: { args: modelArgs },
        };
      }

      case "capture-timeout-diagnostics": {
        const filePath = String(args["file-path"] ?? "");
        if (!filePath) {
          return {
            success: false,
            message: "Missing required argument: --file-path",
          };
        }
        let content: string;
        try {
          content = await Deno.readTextFile(filePath);
        } catch {
          return { success: true, message: "" };
        }
        const op = String(args["op-name"] ?? "unknown");
        const diagLines = toNumber(args["diagnostic-lines"], 50);
        const diag = captureTimeoutDiagnostics(content, op, diagLines);

        // Write diagnostic report to a temp file
        const tempFile = await Deno.makeTempFile({ prefix: "timeout-diag-" });
        await Deno.writeTextFile(tempFile, diag.report);

        return {
          success: true,
          message: tempFile,
          data: {
            diagnosticFile: tempFile,
            errorPatternCount: diag.errorPatterns.length,
            linesCaptured: diag.linesCaptured,
          },
        };
      }

      case "extract-stream-json-text": {
        const filePath = String(args["file-path"] ?? "");
        if (!filePath) {
          return {
            success: false,
            message: "Missing required argument: --file-path",
          };
        }
        let content: string;
        try {
          content = await Deno.readTextFile(filePath);
        } catch {
          return { success: true, message: "" };
        }
        const text = extractStreamJsonText(content);
        return { success: true, message: text };
      }

      case "summarise-large-content": {
        const filePath = String(args["file-path"] ?? "");
        const context = String(args["context"] ?? "content");
        const timeoutSecs = toNumber(args["timeout-seconds"], 120);
        const killAfterSecs = toNumber(args["kill-after-seconds"], 10);

        let content: string;
        if (filePath) {
          try {
            content = await Deno.readTextFile(filePath);
          } catch {
            return { success: false, message: `Cannot read file: ${filePath}` };
          }
        } else {
          content = String(args["content"] ?? "");
        }

        if (!content.trim()) {
          return {
            success: false,
            message: "No content provided for summarisation",
          };
        }

        const summariseResult = await summariseLargeContent({
          content,
          context,
          timeoutSeconds: timeoutSecs,
          killAfterSeconds: killAfterSecs,
        });

        if (!summariseResult.ok) {
          return { success: false, message: summariseResult.error.message };
        }

        return { success: true, message: summariseResult.value };
      }

      case "check-dependencies": {
        const result = await checkDependencies();
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: result.value,
          data: { timeoutCommand: result.value },
        };
      }

      case "get-github-user": {
        const result = await getGithubUser();
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: result.value };
      }

      default:
        return {
          success: false,
          message:
            `Unknown operation: ${operation}. Valid: strip-escape-codes, get-token-estimate, extract-error-patterns, extract-failure-summary, detect-already-complete, detect-github-api-success, detect-rate-limit, build-model-args, capture-timeout-diagnostics, extract-stream-json-text, summarise-large-content, check-dependencies, get-github-user`,
        };
    }
  },
};
