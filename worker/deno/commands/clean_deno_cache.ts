/**
 * Clean Deno cache command — wraps `deno clean` for shell invocation.
 *
 * Issue #1489: Clean Deno cache when low on disk space.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { coerceBooleanFlag } from "../lib/command_args.ts";
import {
  cleanDenoCache,
  DEFAULT_DENO_CLEAN_TIMEOUT_MS,
  type DenoCacheCleanResult,
} from "../lib/deno_cache.ts";

/**
 * Args:
 *   --dry-run [true|false] Pass --dry-run to `deno clean`. A value that is
 *                          neither is refused rather than read as a real
 *                          clean (Issue #1266).
 *   --timeout-ms <number> Override the timeout (default 60000 ms).
 */
export const cleanDenoCacheCommand: Command = {
  name: "clean-deno-cache",
  description: "Run `deno clean` to free space in the Deno download cache",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<DenoCacheCleanResult>> {
    const dryRunResult = coerceBooleanFlag(args["dry-run"], "dry-run", false);
    if (!dryRunResult.ok) {
      return { success: false, message: dryRunResult.error.message };
    }
    const dryRun = dryRunResult.value;

    let timeoutMs = DEFAULT_DENO_CLEAN_TIMEOUT_MS;
    const timeoutArg = args["timeout-ms"];
    if (typeof timeoutArg === "number") {
      timeoutMs = timeoutArg;
    } else if (typeof timeoutArg === "string") {
      const parsed = parseInt(timeoutArg, 10);
      if (!isNaN(parsed)) timeoutMs = parsed;
    }

    const result = await cleanDenoCache({ dryRun, timeoutMs });

    return {
      success: result.success,
      message: result.message,
      data: result,
    };
  },
};
