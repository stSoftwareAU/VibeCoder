/**
 * Software updates command for the Vibe Coder worker.
 *
 * Orchestrates weekly software update checks for Claude CLI, GH CLI, and Deno.
 * Callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Migrated from worker/shared/software_updates.sh (Issue #906).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { createLogger } from "../lib/logger.ts";
import {
  checkSoftwareUpdates,
  softwareUpdateOptionsFromEnv,
} from "../lib/software_updates.ts";

interface SoftwareUpdateData {
  timestampDir: string;
}

/**
 * Software updates command implementation.
 *
 * Args:
 *   --timestamp-dir <string>  Directory for timestamp file (default: HOME)
 *   --interval <number>       Check interval in seconds (default: 604800 = 7 days)
 *   --timeout <number>        Timeout per update command in seconds (default: 120)
 *   --skip-claude             Skip Claude CLI update
 *   --skip-gh                 Skip GH CLI update
 *   --skip-deno               Skip Deno update
 */
export const softwareUpdatesCommand: Command = {
  name: "software-updates",
  description:
    "Check for and install software updates (Claude CLI, GH CLI, Deno)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<SoftwareUpdateData>> {
    const timestampDir = typeof args["timestamp-dir"] === "string"
      ? args["timestamp-dir"]
      : (Deno.env.get("SOFTWARE_UPDATE_TIMESTAMP_DIR") ??
        Deno.env.get("HOME") ??
        Deno.env.get("USERPROFILE") ?? ".");

    const intervalSeconds = typeof args["interval"] === "number"
      ? args["interval"]
      : (typeof args["interval"] === "string"
        ? parseInt(args["interval"], 10)
        : undefined);

    const timeout = typeof args["timeout"] === "number"
      ? args["timeout"]
      : (typeof args["timeout"] === "string"
        ? parseInt(args["timeout"], 10)
        : undefined);

    const logger = createLogger({
      debug: Deno.env.get("DEBUG") === "true",
    });

    // Issue #2622: per-tool version floors from config trigger an immediate
    // update when the installed version is below the floor. Issue #3655: the
    // shared env builder supplies the skip flags and the release-age
    // quarantine window; CLI flags layer on top.
    const envOptions = softwareUpdateOptionsFromEnv(config);
    await checkSoftwareUpdates(logger, {
      ...envOptions,
      timestampDir,
      intervalSeconds: intervalSeconds ?? envOptions.intervalSeconds,
      timeout: timeout ?? envOptions.timeout,
      skipClaude: args["skip-claude"] === true || envOptions.skipClaude,
      skipGh: args["skip-gh"] === true || envOptions.skipGh,
      skipDeno: args["skip-deno"] === true || envOptions.skipDeno,
    });

    return {
      success: true,
      message: "Software update check complete",
      data: { timestampDir },
    };
  },
};
