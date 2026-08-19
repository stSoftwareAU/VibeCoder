/**
 * PATH bootstrap command for the Vibe Coder worker.
 *
 * Bootstraps the PATH environment for cron/launchd runs where only a
 * minimal PATH is available. Outputs the bootstrapped PATH to stdout
 * so the calling shell can capture and export it.
 *
 * Migrated from worker/shared/path_bootstrap.sh (Issue #902).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  applyDefaults,
  ensureCommand,
  type PathBootstrapResult,
} from "../lib/path_bootstrap.ts";

/** Data returned by the path-bootstrap command. */
interface PathBootstrapCommandData extends PathBootstrapResult {
  /** Set when --ensure-command is used. */
  ensureResult?: {
    found: boolean;
    foundIn?: string;
  };
}

/**
 * PATH bootstrap command implementation.
 *
 * Args:
 *   --action <string>          One of: apply-defaults, ensure-command (default: apply-defaults)
 *   --current-path <string>    Current PATH value (default: reads from env)
 *   --home <string>            Home directory (default: reads from env)
 *   --fallback-paths <string>  Colon-separated additional fallback paths
 *   --command <string>         Command name to ensure (for ensure-command action)
 */
export const pathBootstrapCommand: Command = {
  name: "path-bootstrap",
  description:
    "Bootstrap PATH for cron/launchd with Homebrew and system directories",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<PathBootstrapCommandData>> {
    const action = typeof args["action"] === "string"
      ? args["action"]
      : "apply-defaults";

    const currentPath = typeof args["current-path"] === "string"
      ? args["current-path"]
      : (Deno.env.get("PATH") ?? "");

    const homeDir = typeof args["home"] === "string"
      ? args["home"]
      : (Deno.env.get("HOME") ?? "");

    const fallbackPaths = typeof args["fallback-paths"] === "string"
      ? args["fallback-paths"]
      : (Deno.env.get("VIBE_FALLBACK_PATHS") ?? undefined);

    if (action === "ensure-command") {
      const command = typeof args["command"] === "string"
        ? args["command"]
        : "";

      if (!command) {
        return {
          success: false,
          message: "ERROR: --command is required for ensure-command action",
        };
      }

      const result = await ensureCommand(command, currentPath, fallbackPaths);
      return {
        success: result.found,
        message: result.updatedPath,
        data: {
          path: result.updatedPath,
          added: result.foundIn ? [result.foundIn] : [],
          message: result.message,
          ensureResult: {
            found: result.found,
            foundIn: result.foundIn,
          },
        },
      };
    }

    // Default: apply-defaults
    const result = await applyDefaults(currentPath, homeDir, fallbackPaths);

    return {
      success: true,
      message: result.path,
      data: result,
    };
  },
};
