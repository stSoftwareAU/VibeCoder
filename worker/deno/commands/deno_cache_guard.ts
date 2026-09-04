/**
 * Deno cache guard command (Issue #4302).
 *
 * Bounds the durable Deno cache the container entrypoint keeps at
 * `${workDir}/.deno-cache`. Run from startup housekeeping.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  DEFAULT_DENO_CACHE_MAX_BYTES,
  type DenoCacheGuardResult,
  guardDenoCache,
} from "../lib/deno_cache_guard.ts";
import { resolveCommandWorkDir } from "../lib/command_work_dir.ts";

/**
 * Args:
 *   --work-dir <string>   Directory containing `.deno-cache/`.
 *                         Defaults to config.workDir or WORK_DIR env.
 *   --max-bytes <num>     Size cap in bytes (default: 2147483648).
 */
export const denoCacheGuardCommand = {
  name: "deno-cache-guard",
  description:
    "Wipe the durable Deno cache when it exceeds its size cap (Issue #4302)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    envWorkDir: string | undefined = Deno.env.get("WORK_DIR"),
  ): Promise<CommandResult<DenoCacheGuardResult>> {
    const workDir = resolveCommandWorkDir(args, config.workDir, envWorkDir);
    if (!workDir) {
      return {
        success: false,
        message:
          "deno-cache-guard: --work-dir is required (no config.workDir or WORK_DIR env var)",
      };
    }

    let maxBytes = DEFAULT_DENO_CACHE_MAX_BYTES;
    const rawMax = args["max-bytes"];
    if (rawMax !== undefined) {
      const parsed = Number(rawMax);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          success: false,
          message: `deno-cache-guard: invalid --max-bytes: ${String(rawMax)}`,
        };
      }
      maxBytes = parsed;
    }

    const result = await guardDenoCache({ workDir, maxBytes });
    return { success: true, message: result.message, data: result };
  },
  // `satisfies`, not an annotation: the registry only ever calls
  // `execute(args, config)`, but the third parameter has to stay visible on
  // this constant so a test can hand it an empty `WORK_DIR` (Issue #966).
} satisfies Command;
