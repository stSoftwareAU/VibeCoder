/**
 * Health check cache command for the Vibe Coder worker.
 *
 * Provides file-based caching of health check results to avoid expensive
 * repeated checks during scan cycles. Callable from shell via deno_bridge.sh.
 *
 * Migrated from worker/shared/health_check_cache.sh (Issue #906).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  invalidateHealthCache,
  isHealthCacheValid,
  recordHealthCheckSuccess,
} from "../lib/health_check_cache.ts";

interface HealthCacheData {
  action: string;
  checkType: string;
  valid?: boolean;
}

/**
 * Health check cache command implementation.
 *
 * Args:
 *   --action <string>       Action: "is-valid", "record-success", "invalidate"
 *   --check-type <string>   Health check identifier (e.g., "claude", "gh_auth")
 *   --work-dir <string>     Directory for cache files (defaults to config workDir)
 *   --ttl <number>          Cache TTL in seconds (default: 300)
 */
export const healthCheckCacheCommand: Command = {
  name: "health-check-cache",
  description:
    "Manage health check cache (is-valid, record-success, invalidate)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<HealthCacheData>> {
    const action = String(args["action"] ?? "");
    const checkType = String(args["check-type"] ?? "");
    const workDir = typeof args["work-dir"] === "string"
      ? args["work-dir"]
      : (config.workDir || Deno.env.get("WORK_DIR") || ".");
    const ttl = typeof args["ttl"] === "number"
      ? args["ttl"]
      : (typeof args["ttl"] === "string" ? parseInt(args["ttl"], 10) : 300);

    if (!action) {
      return { success: false, message: "Missing --action argument" };
    }
    if (!checkType) {
      return { success: false, message: "Missing --check-type argument" };
    }

    await Promise.resolve(); // Satisfy async signature

    switch (action) {
      case "is-valid": {
        const result = isHealthCacheValid(workDir, checkType, ttl);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: result.value ? "valid" : "expired",
          data: { action, checkType, valid: result.value },
        };
      }

      case "record-success": {
        const result = recordHealthCheckSuccess(workDir, checkType);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: "recorded",
          data: { action, checkType },
        };
      }

      case "invalidate": {
        const result = invalidateHealthCache(workDir, checkType);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: "invalidated",
          data: { action, checkType },
        };
      }

      default:
        return {
          success: false,
          message:
            `Unknown action: ${action}. Use is-valid, record-success, or invalidate`,
        };
    }
  },
};
