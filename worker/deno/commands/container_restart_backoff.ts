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
 *     [--phase-file ~/.vibe-coder/last-launch-phase] [--repo-dir .] \
 *     [--log-dir <host log directory>] [--quota-pause-sleep-seconds 3600] \
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
import { resolveRunHostId } from "../lib/run_mode_record.ts";
import { formatLogTail } from "../lib/launcher_failure_evidence.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";
import { pathStyleFor } from "../lib/host_path_style.ts";
import { resolveLogDir } from "../lib/log_dir.ts";

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(optionalString(value));
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/**
 * Seconds the supervisor waits between quota re-probes (Issue #342).
 *
 * Precedence: the explicit `--quota-pause-sleep-seconds` flag, then the
 * `VIBE_QUOTA_PAUSE_SLEEP_SECONDS` environment variable, then the default.
 *
 * Extracted from `execute` so the environment leg has a seam (Issue #956):
 * a test drives it with a fixed lookup instead of setting the variable on
 * the process, which races every other test under `deno test --parallel`.
 *
 * @param args - The command's parsed arguments.
 * @param env - Environment lookup; defaults to the process environment.
 * @returns The resolved cadence in seconds.
 */
export function resolveQuotaPauseSleepSeconds(
  args: Record<string, unknown>,
  env: EnvLookup = processEnvLookup,
): number {
  return optionalNumber(args["quota-pause-sleep-seconds"]) ??
    optionalNumber(env("VIBE_QUOTA_PAUSE_SLEEP_SECONDS")) ??
    CONTAINER_RESTART_DEFAULTS.quotaPauseSleepSeconds;
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
 * This command runs on the **host**, called by the supervisor between launcher
 * runs, so it resolves the host's log directory — the one host mount both
 * sides share, because the work directory rides a named volume the host cannot
 * read. One resolution with the launcher and the shell (Issues #872, #873):
 * `LAUNCH_LOG_DIR`, then `LOG_DIR`, then the platform's own location.
 */
function logDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return resolveLogDir(home, processEnvLookup, pathStyleFor(home));
}

/**
 * How much of the failing run's log to quote (Issue #633).
 *
 * Enough to show what the run was doing when it stopped, short enough that
 * the alert stays readable in a GitHub comment.
 */
const LAUNCH_LOG_TAIL_LINES = 40;

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

    // Issue #633: the alert named `unknown-host` and quoted no log, so it
    // carried nothing that was not already in the state file. Both were
    // knowable.
    //
    // The host comes from the same resolver the run's own log line uses
    // (Issue #4189), so the alert and the log agree on the machine's name.
    const hostId = resolveRunHostId();

    // The log tail is the launcher's own per-cycle worker log, in $HOME/logs
    // — the one directory the host and the container share, because the work
    // directory rides a named volume the host cannot read. When the worker
    // dies early that file holds only its header line, and saying so is
    // itself the finding: it means the run died before reaching anything
    // that logs.
    const launchLog = optionalString(args["launch-log"]);
    const logTail = launchLog
      ? await formatLogTail({
        path: launchLog,
        maxLines: LAUNCH_LOG_TAIL_LINES,
      }, {
        readTextFile: (path: string) => Deno.readTextFile(path),
      })
      : undefined;

    const outcome = await recordContainerRestartOutcome({
      workDir,
      hostId,
      ...(logTail !== undefined ? { logTail } : {}),
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
        quotaPauseSleepSeconds: resolveQuotaPauseSleepSeconds(args),
      },
      crashConfig,
      repo: optionalString(args["repo"]),
      issueNumber: optionalNumber(args["issue-number"]),
      // A launcher failure has no issue in flight to report on, so the
      // fallback channel is the worker's own repository — named by the
      // checkout the supervisor invokes this from (Issue #556).
      repoDir: optionalString(args["repo-dir"]) ?? Deno.cwd(),
    });

    // The message is the supervisor's sleep interval and nothing else.
    return {
      success: true,
      message: String(outcome.backoffSeconds),
      data: outcome,
    };
  },
};
