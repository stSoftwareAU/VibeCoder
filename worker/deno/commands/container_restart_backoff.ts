/**
 * container-restart-backoff command (Issue #4072).
 *
 * The host supervisor (`loop.sh`, `loop.ps1`) calls this after every launcher
 * invocation. It records the outcome, escalates a repeatedly failing host
 * through the crash-notification channel, and prints the number of seconds the
 * supervisor should wait before re-invoking the launcher — one integer on
 * stdout, so the shell can use it directly.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-write --allow-run --allow-net \
 *     mod.ts container-restart-backoff --exit-status 91 \
 *     [--phase-file ~/.vibe-coder/last-launch-phase] \
 *     [--log-dir ~/logs] [--quota-pause-sleep-seconds 3600] \
 *     [--base-sleep-seconds 60] [--work-dir /path]
 *
 * Issue #342: a run that stopped because the host is out of quota declares it
 * — in its exit status and in a marker under the log directory — and that
 * outcome is recorded as a scheduled pause on a fixed re-probe cadence, never
 * as a failure to back off from.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  CONTAINER_RESTART_DEFAULTS,
  type ContainerRestartOutcome,
  launchPhaseMarkerPath,
  readLaunchPhaseMarker,
  recordContainerRestartOutcome,
} from "../lib/container_restart_backoff.ts";
import {
  CRASH_NOTIFICATION_DEFAULTS,
  type CrashNotificationConfig,
} from "../lib/crash_notification.ts";
import { setSelfHealEventsWorkDir } from "../lib/self_heal_events.ts";
import { consumeQuotaPauseMarker } from "../lib/quota_pause.ts";

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(optionalString(value));
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/** Vibe Coder state directory — the launchers write the phase marker here. */
function stateDir(): string {
  const explicit = Deno.env.get("VIBE_STATE_DIR");
  if (explicit) return explicit;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return `${home}/.vibe-coder`;
}

/**
 * Log directory the run writes its quota-pause marker to (Issue #342).
 *
 * `$HOME/logs` on the host and the same path inside the container, because
 * that directory is the one host mount both sides share — the work directory
 * rides a named volume the host cannot read.
 */
function logDir(): string {
  const explicit = Deno.env.get("LOG_DIR");
  if (explicit) return explicit;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return `${home}/logs`;
}

export const containerRestartBackoffCommand: Command = {
  name: "container-restart-backoff",
  description:
    "Record a launcher outcome, back off, and escalate repeated container " +
    "failures (Issue #4072)",

  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ContainerRestartOutcome>> {
    const exitStatus = optionalNumber(args["exit-status"]);
    if (exitStatus === undefined) {
      // Fail loud: a supervisor that cannot say what happened must not be
      // handed a backoff that looks like a healthy one.
      return {
        success: false,
        message: "container-restart-backoff requires --exit-status <integer>",
      };
    }

    // This command is its own host-side process (run.sh invokes it after a
    // launcher exit), so it supplies the sink's wiring itself — the same
    // WORK_DIR-then-HOME resolution the worker driver applies (Issue #4250:
    // the sink no longer falls back to the environment on its own).
    const workDir = optionalString(args["work-dir"]) ??
      Deno.env.get("WORK_DIR") ?? Deno.env.get("HOME") ?? "";
    setSelfHealEventsWorkDir(workDir || undefined);
    const phaseFile = optionalString(args["phase-file"]) ??
      Deno.env.get("VIBE_LAUNCH_PHASE_FILE") ??
      launchPhaseMarkerPath(stateDir());

    const crashConfig: CrashNotificationConfig = {
      workerName: optionalString(args["worker-name"]) ??
        Deno.env.get("WORKER_NAME") ?? "unknown",
      cooldownSeconds: optionalNumber(args["cooldown-seconds"]) ??
        CRASH_NOTIFICATION_DEFAULTS.cooldownSeconds,
      logTailMaxBytes: CRASH_NOTIFICATION_DEFAULTS.logTailMaxBytes,
      stateDir: optionalString(args["state-dir"]) ??
        Deno.env.get("CRASH_NOTIFICATION_STATE_DIR") ?? stateDir(),
      webhookUrl: optionalString(args["webhook-url"]) ??
        Deno.env.get("CRASH_WEBHOOK_URL"),
    };

    // Consumed here, so exactly one launcher outcome is ever classified from
    // a given declaration (Issue #342).
    const quotaPause = await consumeQuotaPauseMarker(
      optionalString(args["log-dir"]) ?? logDir(),
    );

    const outcome = await recordContainerRestartOutcome({
      workDir,
      exitStatus,
      phaseMarker: await readLaunchPhaseMarker(phaseFile),
      quotaPause,
      config: {
        baseSleepSeconds: optionalNumber(args["base-sleep-seconds"]) ??
          CONTAINER_RESTART_DEFAULTS.baseSleepSeconds,
        maxBackoffSeconds: optionalNumber(args["max-backoff-seconds"]) ??
          CONTAINER_RESTART_DEFAULTS.maxBackoffSeconds,
        escalationThreshold: optionalNumber(args["escalation-threshold"]) ??
          CONTAINER_RESTART_DEFAULTS.escalationThreshold,
        imageBuildEscalationThreshold: CONTAINER_RESTART_DEFAULTS
          .imageBuildEscalationThreshold,
        quotaPauseSleepSeconds:
          optionalNumber(args["quota-pause-sleep-seconds"]) ??
            optionalNumber(Deno.env.get("VIBE_QUOTA_PAUSE_SLEEP_SECONDS")) ??
            CONTAINER_RESTART_DEFAULTS.quotaPauseSleepSeconds,
      },
      crashConfig,
      repo: optionalString(args["repo"]),
      issueNumber: optionalNumber(args["issue-number"]),
    });

    // The message is the supervisor's sleep interval and nothing else.
    return {
      success: true,
      message: String(outcome.backoffSeconds),
      data: outcome,
    };
  },
};
