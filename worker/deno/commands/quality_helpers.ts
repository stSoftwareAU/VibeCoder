/**
 * Quality helpers command for the Vibe Coder worker (Issue #917).
 *
 * Provides a command interface for quality helper operations that
 * issue_worker.sh needs. Replaces worker/shared/quality_helpers.sh
 * functions that were called from the worker.
 *
 * Sub-operations (--operation):
 *   - format-failure-message: Format quality check failure message
 *   - format-baseline-note: Format baseline quality note
 *   - detect-missing-tools: Detect missing quality tools
 *   - format-missing-tools-message: Format missing tools message
 *   - detect-tool: Detect if a tool is available
 *   - run-quality-with-timeout: Run quality command with timeout
 *   - cleanup-ports: Clean up stale dev server ports
 *   - cleanup-subprocesses: Clean up orphaned quality subprocesses
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { coerceBooleanFlag } from "../lib/command_args.ts";
import {
  detectMissingQualityTools,
  detectTool,
  formatBaselineQualityNote,
  formatMissingToolsMessage,
  formatQualityFailureMessage,
} from "../lib/quality_helpers.ts";

/** Data returned by quality helper operations. */
interface QualityHelpersData {
  message?: string;
  missingTools?: string[];
  toolPath?: string;
  exitCode?: number;
  output?: string;
}

export const qualityHelpersCommand: Command = {
  name: "quality-helpers",
  description: "Quality check helper operations (formatting, tool detection)",
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<QualityHelpersData>> {
    const operation = String(args["operation"] ?? "");

    switch (operation) {
      case "format-failure-message": {
        const qualityOutput = String(args["quality-output"] ?? "");
        // See Issue #1266: the old `!== "false"` test could never be
        // satisfied, so a failing baseline always read as a passing one.
        const baselinePassedResult = coerceBooleanFlag(
          args["baseline-passed"],
          "baseline-passed",
          true,
        );
        if (!baselinePassedResult.ok) {
          return {
            success: false,
            message: baselinePassedResult.error.message,
          };
        }
        const baselinePassed = baselinePassedResult.value;
        const baselineOutput = String(args["baseline-output"] ?? "");

        const message = formatQualityFailureMessage(
          qualityOutput,
          baselinePassed,
          baselineOutput || undefined,
        );
        return {
          success: true,
          message,
          data: { message },
        };
      }

      case "format-baseline-note": {
        const baselineOutput = String(args["baseline-output"] ?? "");
        const note = formatBaselineQualityNote(baselineOutput);
        return {
          success: true,
          message: note,
          data: { message: note },
        };
      }

      case "detect-missing-tools": {
        const qualityScript = String(
          args["quality-script"] ?? "./quality.sh",
        );
        const result = await detectMissingQualityTools(qualityScript);
        if (!result.ok) {
          return {
            success: false,
            message: `Failed to detect missing tools: ${result.error.message}`,
          };
        }
        const missing = result.value;
        if (missing.length > 0) {
          return {
            success: false,
            message: missing.join("\n"),
            data: { missingTools: missing },
          };
        }
        return {
          success: true,
          message: "",
          data: { missingTools: [] },
        };
      }

      case "format-missing-tools-message": {
        const toolsStr = String(args["missing-tools"] ?? "");
        const qualityScript = String(
          args["quality-script"] ?? "./quality.sh",
        );
        const tools = toolsStr.split("\n").filter((t) => t.trim());
        const message = formatMissingToolsMessage(tools, qualityScript);
        return {
          success: true,
          message,
          data: { message },
        };
      }

      case "detect-tool": {
        const toolName = String(args["tool-name"] ?? "");
        if (!toolName) {
          return {
            success: false,
            message: "Missing required argument: --tool-name",
          };
        }
        const result = await detectTool(toolName);
        if (result.ok) {
          return {
            success: true,
            message: result.value,
            data: { toolPath: result.value },
          };
        }
        return {
          success: false,
          message: `Tool not found: ${toolName}`,
        };
      }

      case "run-quality-with-timeout": {
        const command = String(args["command"] ?? "./quality.sh");
        const timeoutSeconds = Number(args["timeout-seconds"] ?? 600);

        // Clean up ports before running
        await cleanupDevServerPorts();

        const exitCode = await runWithTimeout(command, timeoutSeconds);

        // Clean up after running
        await cleanupQualitySubprocesses();

        if (exitCode === 124 || exitCode === 137) {
          return {
            success: false,
            message: `Quality check timed out after ${timeoutSeconds}s`,
            data: { exitCode },
          };
        }

        return {
          success: exitCode === 0,
          message: exitCode === 0
            ? "Quality check passed"
            : `Quality check failed (exit ${exitCode})`,
          data: { exitCode },
        };
      }

      case "cleanup-ports": {
        await cleanupDevServerPorts();
        return { success: true, message: "Port cleanup complete" };
      }

      case "cleanup-subprocesses": {
        await cleanupQualitySubprocesses();
        return { success: true, message: "Subprocess cleanup complete" };
      }

      default:
        return {
          success: false,
          message:
            `Unknown operation: ${operation}. Valid operations: format-failure-message, format-baseline-note, detect-missing-tools, format-missing-tools-message, detect-tool, run-quality-with-timeout, cleanup-ports, cleanup-subprocesses`,
        };
    }
  },
};

/**
 * Clean up stale processes on common dev server ports.
 */
async function cleanupDevServerPorts(): Promise<void> {
  const ports = (Deno.env.get("DEV_SERVER_PORTS") ?? "3000 3001 5173 8080 8081")
    .split(/\s+/);

  for (const port of ports) {
    try {
      const lsof = new Deno.Command("lsof", {
        args: ["-ti:" + port],
        stdout: "piped",
        stderr: "null",
      });
      const result = await lsof.output();
      if (result.success) {
        const pids = new TextDecoder().decode(result.stdout).trim();
        if (pids) {
          const kill = new Deno.Command("kill", {
            args: ["-9", ...pids.split("\n")],
            stdout: "null",
            stderr: "null",
          });
          await kill.output();
        }
      }
    } catch {
      // Port not in use or lsof not available
    }
  }
}

/**
 * Clean up orphaned quality subprocesses.
 */
async function cleanupQualitySubprocesses(): Promise<void> {
  // Clean up dev server ports first
  await cleanupDevServerPorts();

  // Kill common orphaned dev server process patterns
  const patterns = [
    "react-scripts",
    "webpack-dev-server",
    "vite",
    "next-dev",
  ];

  for (const pattern of patterns) {
    try {
      const pgrep = new Deno.Command("pgrep", {
        args: ["-f", pattern],
        stdout: "piped",
        stderr: "null",
      });
      const result = await pgrep.output();
      if (result.success) {
        const pids = new TextDecoder().decode(result.stdout).trim();
        if (pids) {
          const kill = new Deno.Command("kill", {
            args: ["-9", ...pids.split("\n")],
            stdout: "null",
            stderr: "null",
          });
          await kill.output();
        }
      }
    } catch {
      // pgrep not available or no matching processes
    }
  }
}

/**
 * Run a command with a timeout.
 *
 * Returns the exit code (124 if timed out, 137 if killed).
 */
async function runWithTimeout(
  command: string,
  timeoutSeconds: number,
): Promise<number> {
  // Try to find a timeout command
  const timeoutCmd = Deno.env.get("TIMEOUT_CMD") ?? "";
  let cmdArgs: string[];

  if (timeoutCmd) {
    cmdArgs = [
      timeoutCmd,
      "--kill-after=10",
      String(timeoutSeconds),
      "bash",
      "-c",
      command,
    ];
  } else {
    // Try gtimeout (macOS) then timeout (Linux)
    let foundTimeout = "";
    for (const t of ["gtimeout", "timeout"]) {
      try {
        const which = new Deno.Command("which", {
          args: [t],
          stdout: "null",
          stderr: "null",
        });
        const result = await which.output();
        if (result.success) {
          foundTimeout = t;
          break;
        }
      } catch {
        // Not found
      }
    }

    if (foundTimeout) {
      cmdArgs = [
        foundTimeout,
        "--kill-after=10",
        String(timeoutSeconds),
        "bash",
        "-c",
        command,
      ];
    } else {
      // No timeout command available — run directly
      cmdArgs = ["bash", "-c", command];
    }
  }

  try {
    const proc = new Deno.Command(cmdArgs[0]!, {
      args: cmdArgs.slice(1),
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    });
    const result = await proc.output();
    return result.code;
  } catch {
    return 1;
  }
}
