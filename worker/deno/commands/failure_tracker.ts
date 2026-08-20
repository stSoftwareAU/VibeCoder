/**
 * Failure tracker command for the Vibe Coder worker.
 *
 * Tracks consecutive work failures and triggers self-healing exits when the
 * threshold is reached. Callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Sub-operations:
 *   - track-failure: Record a failure for a work item key
 *   - reset-failures: Reset the failure counter (on success)
 *   - should-exit-on-failures: Check if the failure threshold has been reached
 *
 * Migrated from worker/shared/failure_tracker.sh (Issue #908).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  FAILURE_TRACKER_DEFAULTS,
  type FailureTrackerConfig,
  resetFailures,
  shouldExitOnFailures,
  trackFailure,
} from "../lib/failure_tracker.ts";

/** Build config from command args, falling back to defaults. */
function buildConfig(
  args: Record<string, unknown>,
  config: WorkerConfig,
): FailureTrackerConfig {
  return {
    workDir: String(args["work-dir"] ?? config.workDir ?? ""),
    maxConsecutiveFailures: toNumber(
      args["max-consecutive-failures"],
      FAILURE_TRACKER_DEFAULTS.maxConsecutiveFailures,
    ),
    stateExpirySeconds: toNumber(
      args["state-expiry-seconds"],
      FAILURE_TRACKER_DEFAULTS.stateExpirySeconds,
    ),
  };
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

export const failureTrackerCommand: Command = {
  name: "failure-tracker",
  description: "Consecutive failure tracking and self-healing exit thresholds",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "should-exit-on-failures");
    const ftConfig = buildConfig(args, config);

    switch (operation) {
      case "track-failure": {
        const failureKey = String(args["failure-key"] ?? "");
        if (!failureKey) {
          return { success: false, message: "Missing --failure-key argument" };
        }
        const result = await trackFailure(ftConfig, failureKey);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: String(result.value.consecutiveFailures),
          data: result.value,
        };
      }

      case "reset-failures": {
        const result = await resetFailures(ftConfig);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: "0",
          data: result.value,
        };
      }

      case "should-exit-on-failures": {
        const shouldExit = await shouldExitOnFailures(ftConfig);
        return {
          success: true,
          message: shouldExit ? "SHOULD_EXIT" : "CONTINUE",
          data: { shouldExit },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown failure-tracker operation: ${operation}`,
        };
    }
  },
};
