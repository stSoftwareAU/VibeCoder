/**
 * Circuit breaker command for the Vibe Coder worker.
 *
 * Provides scan-cycle backoff and operation-specific backoff tracking
 * callable from shell via deno_bridge.sh. Supports sub-operations:
 *   - record-zero-progress: Record a zero-progress scan cycle
 *   - reset: Reset the circuit breaker (on success)
 *   - get-sleep-interval: Get the current backed-off sleep interval
 *   - is-active: Check if backoff is currently active
 *   - record-operation-failure: Record failure for a specific operation
 *   - reset-operation: Reset failure count for an operation
 *   - get-operation-failure-count: Get failure count for an operation
 *   - get-operation-sleep-interval: Get backoff interval for an operation
 *
 * Migrated from worker/shared/circuit_breaker.sh (Issue #908).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  CIRCUIT_BREAKER_DEFAULTS,
  type CircuitBreakerConfig,
  getOperationFailureCount,
  getOperationSleepInterval,
  getSleepInterval,
  isActive,
  recordOperationFailure,
  recordZeroProgress,
  reset,
  resetOperation,
} from "../lib/circuit_breaker.ts";

/** Build config from command args, falling back to WorkerConfig then defaults. */
function buildConfig(
  args: Record<string, unknown>,
  config: WorkerConfig,
): CircuitBreakerConfig {
  return {
    workDir: String(args["work-dir"] ?? config.workDir ?? ""),
    threshold: toNumber(args["threshold"], CIRCUIT_BREAKER_DEFAULTS.threshold),
    sleepInterval: toNumber(
      args["sleep-interval"],
      config.sleepInterval || CIRCUIT_BREAKER_DEFAULTS.sleepInterval,
    ),
    creditWaitInterval: toNumber(
      args["credit-wait-interval"],
      config.creditWaitInterval || CIRCUIT_BREAKER_DEFAULTS.creditWaitInterval,
    ),
    stateExpirySeconds: toNumber(
      args["state-expiry-seconds"],
      CIRCUIT_BREAKER_DEFAULTS.stateExpirySeconds,
    ),
    operationBackoffThreshold: toNumber(
      args["operation-backoff-threshold"],
      CIRCUIT_BREAKER_DEFAULTS.operationBackoffThreshold,
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

export const circuitBreakerCommand: Command = {
  name: "circuit-breaker",
  description: "Scan-cycle backoff and operation-specific failure tracking",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "get-sleep-interval");
    const cbConfig = buildConfig(args, config);

    switch (operation) {
      case "record-zero-progress": {
        const result = await recordZeroProgress(cbConfig);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: String(result.value.zeroCycles),
          data: result.value,
        };
      }

      case "reset": {
        const result = await reset(cbConfig);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: "0",
          data: result.value,
        };
      }

      case "get-sleep-interval": {
        const interval = await getSleepInterval(cbConfig);
        return {
          success: true,
          message: String(interval),
          data: { interval },
        };
      }

      case "is-active": {
        const active = await isActive(cbConfig);
        return {
          success: true,
          message: active ? "ACTIVE" : "NOT_ACTIVE",
          data: { active },
        };
      }

      case "record-operation-failure": {
        const op = String(args["op-name"] ?? "");
        if (!op) {
          return { success: false, message: "Missing --op-name argument" };
        }
        const result = await recordOperationFailure(cbConfig, op);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: String(result.value),
          data: { failureCount: result.value },
        };
      }

      case "reset-operation": {
        const op = String(args["op-name"] ?? "");
        if (!op) {
          return { success: false, message: "Missing --op-name argument" };
        }
        const result = await resetOperation(cbConfig, op);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: String(result.value),
          data: { previousCount: result.value },
        };
      }

      case "get-operation-failure-count": {
        const op = String(args["op-name"] ?? "");
        if (!op) {
          return { success: false, message: "Missing --op-name argument" };
        }
        const count = await getOperationFailureCount(cbConfig, op);
        return {
          success: true,
          message: String(count),
          data: { failureCount: count },
        };
      }

      case "get-operation-sleep-interval": {
        const op = String(args["op-name"] ?? "");
        if (!op) {
          return { success: false, message: "Missing --op-name argument" };
        }
        const interval = await getOperationSleepInterval(cbConfig, op);
        return {
          success: true,
          message: String(interval),
          data: { interval },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown circuit-breaker operation: ${operation}`,
        };
    }
  },
};
