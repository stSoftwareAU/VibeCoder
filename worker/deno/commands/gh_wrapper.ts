/**
 * GitHub CLI wrapper command for the Vibe Coder worker.
 *
 * Provides timeout-protected gh CLI execution and rate limit circuit
 * breaker, callable from shell via deno_bridge.sh. Supports sub-operations:
 *   - run: Execute a gh command with timeout and circuit breaker protection
 *   - reset-circuit-breaker: Reset the rate limit circuit breaker
 *   - is-timeout: Check if an exit code indicates a timeout
 *
 * Migrated from worker/shared/gh_wrapper.sh (Issue #905, Issue #619, Issue #650).
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type GhCommandResult,
  type GhWrapperConfig,
  isGhTimeout,
  isRateLimitActive,
  resetRateLimitBreaker,
  safeGhCommand,
  tripRateLimitBreaker,
} from "../lib/gh_wrapper.ts";

/** Combined result type for the gh-wrapper command. */
type GhWrapperData =
  | GhCommandResult
  | { isTimeout: boolean }
  | {
    reset: boolean;
  }
  | { active: boolean }
  | { tripped: boolean; freshActivation: boolean };

/**
 * Build wrapper configuration from environment variables and command args.
 */
function buildConfig(args: Record<string, unknown>): GhWrapperConfig {
  return {
    ghCommandTimeout: args["timeout"] ? Number(args["timeout"]) : undefined,
    ghCloneTimeout: args["clone-timeout"]
      ? Number(args["clone-timeout"])
      : undefined,
    rateLimitCooldown: args["rate-limit-cooldown"]
      ? Number(args["rate-limit-cooldown"])
      : undefined,
    rateLimitFlagDir: args["rate-limit-flag-dir"]
      ? String(args["rate-limit-flag-dir"])
      : undefined,
  };
}

/**
 * GH wrapper command implementation.
 *
 * Args:
 *   --operation <string>           Operation: run, reset-circuit-breaker, is-timeout
 *   --gh-args <string>             JSON array of gh command arguments (for run)
 *   --exit-code <number>           Exit code to check (for is-timeout)
 *   --timeout <number>             Command timeout in seconds
 *   --clone-timeout <number>       Clone timeout in seconds
 *   --rate-limit-cooldown <number> Circuit breaker cooldown in seconds
 *   --rate-limit-flag-dir <string> Directory for circuit breaker flag file
 */
export const ghWrapperCommand: Command = {
  name: "gh-wrapper",
  description: "GitHub CLI wrapper with timeout and rate limit protection",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<GhWrapperData>> {
    const operation = String(args["operation"] ?? "run");
    const config = buildConfig(args);

    switch (operation) {
      case "run": {
        // Parse gh arguments from JSON array
        let ghArgs: string[];
        const rawGhArgs = args["gh-args"];
        if (typeof rawGhArgs === "string") {
          try {
            ghArgs = JSON.parse(rawGhArgs) as string[];
          } catch {
            ghArgs = rawGhArgs.split(" ");
          }
        } else if (Array.isArray(rawGhArgs)) {
          ghArgs = (rawGhArgs as unknown[]).map(String);
        } else {
          return {
            success: false,
            message: "Missing --gh-args: provide gh command arguments",
          };
        }

        const result = await safeGhCommand(ghArgs, config);

        if (!result.ok) {
          return {
            success: false,
            message: result.error.message,
          };
        }

        const { stdout, exitCode, timedOut, rateLimited, circuitBroken } =
          result.value;

        // For the run operation, output stdout directly as the message
        // so shell callers can capture it the same way they captured
        // the output from safe_gh_command
        const success = exitCode === 0;
        let message = stdout;
        if (timedOut) {
          message = `TIMEOUT: gh ${ghArgs.join(" ")} timed out after ${
            config.ghCommandTimeout ?? 60
          }s`;
        } else if (circuitBroken) {
          message = "RATE_LIMITED: circuit breaker active";
        } else if (rateLimited) {
          message =
            "RATE_LIMITED: rate limit detected, circuit breaker tripped";
        }

        return {
          success,
          message,
          data: result.value,
        };
      }

      case "reset-circuit-breaker": {
        await resetRateLimitBreaker(config);
        return {
          success: true,
          message: "Circuit breaker reset",
          data: { reset: true },
        };
      }

      case "is-timeout": {
        const exitCode = typeof args["exit-code"] === "number"
          ? args["exit-code"]
          : parseInt(String(args["exit-code"] ?? "0"), 10);
        const timeout = isGhTimeout(exitCode);
        return {
          success: true,
          message: timeout ? "IS_TIMEOUT" : "NOT_TIMEOUT",
          data: { isTimeout: timeout },
        };
      }

      case "is-rate-limit-active": {
        const active = await isRateLimitActive(config);
        return {
          success: true,
          message: active ? "ACTIVE" : "NOT_ACTIVE",
          data: { active },
        };
      }

      case "trip-rate-limit": {
        const freshActivation = await tripRateLimitBreaker(config);
        return {
          success: true,
          message: freshActivation ? "TRIPPED" : "ALREADY_ACTIVE",
          data: { tripped: true, freshActivation },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown gh-wrapper operation: ${operation}`,
        };
    }
  },
};
