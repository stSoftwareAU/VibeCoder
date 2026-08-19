/**
 * Crash notification command for the Vibe Coder worker.
 *
 * Posts crash notifications via GitHub issue comments and/or webhooks
 * when the worker exits unexpectedly.
 * Callable from shell via deno_bridge.sh.
 *
 * Sub-operations (--operation):
 *   - send: Send crash notification (main orchestrator)
 *   - is-crash-exit: Check if exit code represents a crash
 *   - build-message: Build crash notification message
 *   - format-elapsed-time: Convert seconds to human-readable format
 *
 * Migrated from worker/shared/crash_notification.sh (Issue #909).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildCrashMessage,
  captureFileTail,
  CRASH_NOTIFICATION_DEFAULTS,
  type CrashNotificationConfig,
  type CrashNotificationParams,
  formatElapsedTime,
  isCrashExit,
  sendCrashNotification,
} from "../lib/crash_notification.ts";

function buildConfig(
  args: Record<string, unknown>,
): CrashNotificationConfig {
  const home = Deno.env.get("HOME") ?? "";
  return {
    workerName: String(
      args["worker-name"] ?? Deno.env.get("WORKER_NAME") ?? "unknown",
    ),
    cooldownSeconds: toNumber(
      args["cooldown-seconds"],
      CRASH_NOTIFICATION_DEFAULTS.cooldownSeconds,
    ),
    logTailMaxBytes: toNumber(
      args["log-tail-max-bytes"],
      CRASH_NOTIFICATION_DEFAULTS.logTailMaxBytes,
    ),
    stateDir: String(
      args["state-dir"] ?? Deno.env.get("CRASH_NOTIFICATION_STATE_DIR") ??
        `${home}/.vibe-coder`,
    ),
    webhookUrl: String(
      args["webhook-url"] ?? Deno.env.get("CRASH_WEBHOOK_URL") ?? "",
    ),
  };
}

function buildParams(args: Record<string, unknown>): CrashNotificationParams {
  return {
    exitCode: toNumber(args["exit-code"], 1),
    repo: String(args["repo"] ?? ""),
    issueNumber: toNumber(args["issue-number"], 0),
    logTail: String(args["log-tail"] ?? ""),
    claudeOutput: String(args["claude-output"] ?? ""),
    workStage: String(
      args["work-stage"] ?? Deno.env.get("_CURRENT_WORK_STAGE") ?? "unknown",
    ),
    workStartTime: toNumber(args["work-start-time"], 0),
    plannedShutdown: String(
      args["planned-shutdown"] ?? Deno.env.get("PLANNED_SHUTDOWN") ?? "",
    ) === "true",
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

export const crashNotificationCommand: Command = {
  name: "crash-notification",
  description: "Crash alerting via GitHub issues/comments and webhooks",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "send");

    switch (operation) {
      case "send": {
        const config = buildConfig(args);
        const params = buildParams(args);

        // Optionally capture log tails from files if paths provided
        if (!params.logTail && args["log-file"]) {
          params.logTail = await captureFileTail(
            String(args["log-file"]),
            80,
            config.logTailMaxBytes,
          );
        }
        if (!params.claudeOutput && args["claude-output-file"]) {
          params.claudeOutput = await captureFileTail(
            String(args["claude-output-file"]),
            100,
            config.logTailMaxBytes,
          );
        }

        const result = await sendCrashNotification(config, params);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: result.value.notified
            ? "NOTIFIED"
            : `SKIPPED:${result.value.reason ?? ""}`,
          data: result.value,
        };
      }

      case "is-crash-exit": {
        const exitCode = toNumber(args["exit-code"], 0);
        const plannedShutdown =
          String(args["planned-shutdown"] ?? "") === "true";
        const crash = isCrashExit(exitCode, plannedShutdown);
        return {
          success: true,
          message: crash ? "CRASH" : "CLEAN",
          data: { isCrash: crash },
        };
      }

      case "build-message": {
        const config = buildConfig(args);
        const params = buildParams(args);
        const message = buildCrashMessage(config, params);
        return {
          success: true,
          message,
        };
      }

      case "format-elapsed-time": {
        const seconds = toNumber(args["seconds"], 0);
        const formatted = formatElapsedTime(seconds);
        return {
          success: true,
          message: formatted,
          data: { formatted },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown crash-notification operation: ${operation}`,
        };
    }
  },
};
