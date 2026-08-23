/**
 * Self-healing restart backoff for the worker container (Issue #4072).
 *
 * The container is a disposable execution environment: when it dies, the host
 * supervisor re-invokes the launcher and a fresh container is built and
 * started. Two things must not happen while that heals itself — the
 * supervisor must not restart-storm a host that cannot start a container at
 * all, and a permanently broken host must not disappear into a local log.
 *
 * This module is the state machine behind both:
 *
 *   1. **Backoff.** Consecutive launcher failures are counted in a small
 *      persistent state file and each failure waits longer than the last,
 *      capped. A successful run resets the counter.
 *   2. **Attribution.** The launchers (`run.sh`, `run.ps1`) write the phase
 *      they reached to a marker file, so a failure is attributed to runtime
 *      detection, image build, container start or the worker run itself. A
 *      failed image build means the environment cannot be reconstructed on
 *      this host, so it escalates sooner than a crashed worker.
 *   3. **Escalation.** Once the consecutive-failure count crosses the phase's
 *      threshold, the failure is reported through the existing
 *      crash-notification channel (GitHub issue comment plus optional
 *      webhook), whose cooldown provides the rate limiting.
 *   4. **Quota pauses are not failures** (Issue #342). A run that stops
 *      because the host is out of Claude quota exits on purpose, with the
 *      reset already known. It resets the failure streak, escalates nothing,
 *      claims no recovery, and re-probes at a fixed cadence — because the
 *      quota may be extended before its stated reset, and a host whose
 *      interval doubles every cycle would not notice.
 *
 * Every action is also emitted as a structured self-heal event so recoveries
 * show up in `self-heal-summary` rather than only in a host log.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import {
  type CrashNotificationConfig,
  type CrashNotificationParams,
  sendCrashNotification,
} from "./crash_notification.ts";
import { emitSelfHealEvent } from "./self_heal_events.ts";
import { atomicWrite } from "./file_utils.ts";
import { reportStateLoadFailure } from "./state_load_failure.ts";
import {
  QUOTA_PAUSE_EXIT_STATUS,
  type QuotaPauseMarker,
} from "./quota_pause.ts";

/** Module name used for the self-heal events this file emits. */
export const SELF_HEAL_MODULE = "container_restart";

/** Backoff state file, relative to the work directory. */
export const STATE_FILENAME = ".container_restart_state.json";

/** Phase marker file name, relative to the Vibe Coder state directory. */
export const LAUNCH_PHASE_MARKER_FILENAME = "last-launch-phase";

/**
 * What a launcher writes to the marker file as it progresses.
 *
 * Container is the only run mode (Issue #4): the three phases are the
 * container launch's own. A marker from a removed mode (`native_run`,
 * `seatbelt_*`, from a checkout older than the removal) is simply
 * unrecognised and attributed to the worker run.
 */
export type LaunchPhaseMarker =
  | "runtime_detection"
  | "image_build"
  | "container_run";

/** The phase a launcher failure is attributed to. */
export type ContainerFailurePhase =
  | "runtime_detection"
  | "image_build"
  | "container_start"
  | "worker_run";

/**
 * Runtime CLI exit codes that mean the container never started.
 *
 * Docker and Podman both use 125 for "the run command itself failed", 126 for
 * "the entry point could not be invoked" and 127 for "the entry point was not
 * found" — all of them are the container failing to start, not the worker
 * inside it failing.
 */
export const CONTAINER_START_EXIT_CODES: readonly number[] = [125, 126, 127];

/** Tunables for the backoff and escalation behaviour. */
export interface ContainerRestartConfig {
  /** Sleep applied after a clean run, and the first failure's backoff. */
  baseSleepSeconds: number;
  /** Ceiling on the grown backoff. */
  maxBackoffSeconds: number;
  /** Consecutive failures before a failure is escalated to GitHub. */
  escalationThreshold: number;
  /** Lower threshold used when the image itself cannot be built. */
  imageBuildEscalationThreshold: number;
  /**
   * Fixed re-probe interval while the host is out of quota (Issue #342).
   *
   * Backoff is for unknown faults. Quota exhaustion is a known fault whose
   * recovery time is set elsewhere — and the quota may be *extended* before
   * the stated reset, which a host asleep for an ever-growing interval would
   * not notice. So it re-probes at this cadence for as long as the quota is
   * out, matching the hourly agent-side re-probe of Issue #333.
   */
  quotaPauseSleepSeconds: number;
}

/** Production defaults. */
export const CONTAINER_RESTART_DEFAULTS: Readonly<ContainerRestartConfig> = {
  baseSleepSeconds: 60,
  maxBackoffSeconds: 1800,
  escalationThreshold: 3,
  imageBuildEscalationThreshold: 2,
  quotaPauseSleepSeconds: 3600,
} as const;

/** Persisted backoff state. */
export interface ContainerRestartState {
  /** Consecutive failed launcher invocations. */
  consecutiveFailures: number;
  /** Phase of the most recent failure, or null after a clean run. */
  lastPhase: ContainerFailurePhase | null;
  /** Exit status of the most recent launcher invocation. */
  lastExitStatus: number | null;
  /** Unix timestamp (seconds) of the last update. */
  lastUpdated: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A clean slate — no failures recorded. */
export function emptyContainerRestartState(
  now: () => number = nowSeconds,
): ContainerRestartState {
  return {
    consecutiveFailures: 0,
    lastPhase: null,
    lastExitStatus: null,
    lastUpdated: now(),
  };
}

/** Clamp a caller-supplied number into a sane range. */
function positiveInteger(value: unknown, fallback: number, min = 1): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  return rounded < min ? min : rounded;
}

/**
 * Merge caller overrides over the defaults, rejecting values that would
 * disable the protection (a zero or negative sleep, a threshold below one, a
 * ceiling under the base sleep).
 */
export function resolveContainerRestartConfig(
  overrides: Partial<ContainerRestartConfig> = {},
): ContainerRestartConfig {
  const baseSleepSeconds = positiveInteger(
    overrides.baseSleepSeconds,
    CONTAINER_RESTART_DEFAULTS.baseSleepSeconds,
  );
  const maxBackoffSeconds = Math.max(
    baseSleepSeconds,
    positiveInteger(
      overrides.maxBackoffSeconds,
      CONTAINER_RESTART_DEFAULTS.maxBackoffSeconds,
    ),
  );
  return {
    baseSleepSeconds,
    maxBackoffSeconds,
    escalationThreshold: positiveInteger(
      overrides.escalationThreshold,
      CONTAINER_RESTART_DEFAULTS.escalationThreshold,
    ),
    imageBuildEscalationThreshold: positiveInteger(
      overrides.imageBuildEscalationThreshold,
      CONTAINER_RESTART_DEFAULTS.imageBuildEscalationThreshold,
    ),
    quotaPauseSleepSeconds: positiveInteger(
      overrides.quotaPauseSleepSeconds,
      CONTAINER_RESTART_DEFAULTS.quotaPauseSleepSeconds,
    ),
  };
}

// ---------------------------------------------------------------------------
// Outcome classification (Issue #342)
// ---------------------------------------------------------------------------

/** What one launcher invocation actually was. */
export type LauncherOutcomeKind = "success" | "quota_pause" | "failure";

/**
 * Classify a launcher outcome.
 *
 * The marker is preferred over the exit status: the run writes it on the way
 * out, so it survives a container runtime that loses the container's exit code
 * and reports its own generic status instead. It is consumed by whoever reads
 * it, so it can only ever describe the invocation that just ended — a host
 * that *crashes* while the quota is out has no marker of its own, keeps its
 * crash status, and so still backs off normally.
 *
 * @param exitStatus - Exit status the launcher reported (0 is success)
 * @param quotaPause - Marker the run wrote, when it declared a quota pause
 */
export function classifyLauncherOutcome(
  exitStatus: number,
  quotaPause?: QuotaPauseMarker | null,
): LauncherOutcomeKind {
  if (quotaPause) return "quota_pause";
  if (exitStatus === QUOTA_PAUSE_EXIT_STATUS) return "quota_pause";
  return exitStatus === 0 ? "success" : "failure";
}

/**
 * Seconds to wait before the next attempt while the host is out of quota.
 *
 * The configured cadence, except when the window reopens sooner than that —
 * sleeping an hour past a reset ten minutes away wastes the quota it was
 * waiting for. Never grows across consecutive pauses, and never drops below
 * the base sleep, so it can neither decay into hours nor become a hot loop.
 */
export function computeQuotaPauseSleepSeconds(
  quotaPause: QuotaPauseMarker | null | undefined,
  config: ContainerRestartConfig,
  nowMs: number = Date.now(),
): number {
  const reset = quotaPause?.resetEpochMs;
  if (typeof reset === "number" && Number.isFinite(reset)) {
    const remaining = Math.ceil((reset - nowMs) / 1000);
    if (remaining > 0 && remaining < config.quotaPauseSleepSeconds) {
      return Math.max(config.baseSleepSeconds, remaining);
    }
  }
  return config.quotaPauseSleepSeconds;
}

/**
 * Attribute a failed launcher invocation to the phase it happened in.
 *
 * @param marker - Contents of the launcher's phase marker file (may be null)
 * @param exitStatus - Exit status the launcher reported
 */
export function resolveFailurePhase(
  marker: string | null | undefined,
  exitStatus: number,
): ContainerFailurePhase {
  switch ((marker ?? "").trim()) {
    case "runtime_detection":
      return "runtime_detection";
    case "image_build":
      return "image_build";
    case "container_run":
      return CONTAINER_START_EXIT_CODES.includes(exitStatus)
        ? "container_start"
        : "worker_run";
    default:
      // An absent or unrecognised marker means the launcher is older than
      // this contract, or never got far enough to write one; the worker run
      // is the honest default because it is the phase that owns the exit
      // status we were handed.
      return "worker_run";
  }
}

/** Human-readable name for a failure phase, used in escalation messages. */
export function describeFailurePhase(phase: ContainerFailurePhase): string {
  switch (phase) {
    case "runtime_detection":
      return "container runtime detection";
    case "image_build":
      return "container image build";
    case "container_start":
      return "container start";
    case "worker_run":
      return "worker run";
  }
}

/**
 * Consecutive failures required before a phase escalates.
 *
 * A failed image build means the known-good environment cannot be
 * reconstructed on this host at all, so it escalates ahead of a phase that a
 * plain retry can plausibly clear.
 */
export function escalationThresholdFor(
  phase: ContainerFailurePhase,
  config: ContainerRestartConfig,
): number {
  return phase === "image_build"
    ? config.imageBuildEscalationThreshold
    : config.escalationThreshold;
}

/**
 * Backoff to apply after `consecutiveFailures` failed invocations.
 *
 * Doubles per failure from the base sleep, capped at the ceiling.
 */
export function computeBackoffSeconds(
  consecutiveFailures: number,
  config: ContainerRestartConfig,
): number {
  if (consecutiveFailures <= 1) return config.baseSleepSeconds;
  const grown = config.baseSleepSeconds * 2 ** (consecutiveFailures - 1);
  return Math.min(grown, config.maxBackoffSeconds);
}

/** What one recorded launcher outcome implies. */
export interface ContainerRestartDecision {
  /** State to persist. */
  state: ContainerRestartState;
  /** What the invocation was (Issue #342). */
  kind: LauncherOutcomeKind;
  /** Failure phase, or null when the launcher exited cleanly. */
  phase: ContainerFailurePhase | null;
  /** Seconds the supervisor should wait before the next attempt. */
  backoffSeconds: number;
  /** True when the failure count has reached the phase's threshold. */
  escalate: boolean;
  /** True when a clean run followed at least one failure. */
  recovered: boolean;
  /** Threshold applied to this phase (0 on a clean run). */
  threshold: number;
}

/**
 * Pure state transition for one launcher outcome.
 *
 * @param previous - State loaded from disk
 * @param exitStatus - Launcher exit status (0 is success)
 * @param marker - Launcher phase marker contents
 * @param config - Resolved tunables
 * @param now - Clock seam, in Unix seconds
 * @param quotaPause - Quota-pause marker the run wrote, when it declared one
 */
export function nextContainerRestartDecision(
  previous: ContainerRestartState,
  exitStatus: number,
  marker: string | null | undefined,
  config: ContainerRestartConfig,
  now: () => number = nowSeconds,
  quotaPause?: QuotaPauseMarker | null,
): ContainerRestartDecision {
  const kind = classifyLauncherOutcome(exitStatus, quotaPause);

  // A quota pause is a scheduled outcome, not an error (Issue #342): the
  // streak resets rather than growing, nothing escalates, and the wait is the
  // fixed re-probe cadence. It is deliberately not reported as a *recovery*
  // either — a paused worker proves nothing about the container image, so
  // there is no environment reconstruction to announce.
  if (kind === "quota_pause") {
    return {
      state: {
        consecutiveFailures: 0,
        lastPhase: null,
        lastExitStatus: exitStatus,
        lastUpdated: now(),
      },
      kind,
      phase: null,
      backoffSeconds: computeQuotaPauseSleepSeconds(
        quotaPause,
        config,
        now() * 1000,
      ),
      escalate: false,
      recovered: false,
      threshold: 0,
    };
  }

  if (kind === "success") {
    return {
      state: {
        consecutiveFailures: 0,
        lastPhase: null,
        lastExitStatus: 0,
        lastUpdated: now(),
      },
      kind,
      phase: null,
      backoffSeconds: config.baseSleepSeconds,
      escalate: false,
      recovered: previous.consecutiveFailures > 0,
      threshold: 0,
    };
  }

  const phase = resolveFailurePhase(marker, exitStatus);
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const threshold = escalationThresholdFor(phase, config);

  return {
    state: {
      consecutiveFailures,
      lastPhase: phase,
      lastExitStatus: exitStatus,
      lastUpdated: now(),
    },
    kind,
    phase,
    backoffSeconds: computeBackoffSeconds(consecutiveFailures, config),
    escalate: consecutiveFailures >= threshold,
    recovered: false,
    threshold,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function statePath(workDir: string): string {
  return `${workDir}/${STATE_FILENAME}`;
}

/** Path of the phase marker a launcher writes inside a state directory. */
export function launchPhaseMarkerPath(stateDir: string): string {
  return `${stateDir}/${LAUNCH_PHASE_MARKER_FILENAME}`;
}

/** Read a launcher's phase marker; returns null when there is none. */
export async function readLaunchPhaseMarker(
  path: string,
): Promise<string | null> {
  if (!path) return null;
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch {
    // A missing marker is the ordinary first run.
    return null;
  }
}

/**
 * Load the backoff state.
 *
 * A missing file is the ordinary first run and stays quiet; a corrupt file is
 * reported through `warn` rather than silently discarding accumulated backoff.
 */
export async function loadContainerRestartState(
  workDir: string,
  warn?: (message: string) => void,
): Promise<ContainerRestartState> {
  if (!workDir) return emptyContainerRestartState();
  const path = statePath(workDir);

  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      reportStateLoadFailure("container-restart state", path, err, warn);
    }
    return emptyContainerRestartState();
  }

  try {
    const parsed = JSON.parse(content) as Partial<ContainerRestartState>;
    if (typeof parsed.consecutiveFailures !== "number") {
      throw new Error("malformed state: consecutiveFailures is not a number");
    }
    return {
      consecutiveFailures: Math.max(0, Math.floor(parsed.consecutiveFailures)),
      lastPhase: typeof parsed.lastPhase === "string"
        ? parsed.lastPhase as ContainerFailurePhase
        : null,
      lastExitStatus: typeof parsed.lastExitStatus === "number"
        ? parsed.lastExitStatus
        : null,
      lastUpdated: typeof parsed.lastUpdated === "number"
        ? parsed.lastUpdated
        : nowSeconds(),
    };
  } catch (err) {
    reportStateLoadFailure("container-restart state", path, err, warn);
    return emptyContainerRestartState();
  }
}

/** Persist the backoff state atomically. */
export async function persistContainerRestartState(
  workDir: string,
  state: ContainerRestartState,
): Promise<Result<void>> {
  if (!workDir) {
    return { ok: false, error: new Error("no work directory for state") };
  }
  const result = await atomicWrite({
    targetFile: statePath(workDir),
    content: JSON.stringify(state, null, 2),
  });
  if (result.ok) return { ok: true, value: undefined };
  return {
    ok: false,
    error: new Error(
      `Failed to persist container restart state: ${result.error.message}`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** Everything the escalation message needs. */
export interface ContainerEscalationInput {
  phase: ContainerFailurePhase;
  exitStatus: number;
  consecutiveFailures: number;
  backoffSeconds: number;
  threshold: number;
  /** Repository of the issue the container was working on, if known. */
  repo?: string;
  /** Issue the container was working on, if known. */
  issueNumber?: number;
  /** Optional host-side log tail to append. */
  logTail?: string;
}

/**
 * Build the crash-notification parameters for a container failure.
 *
 * The phase is carried in both the stage field (which renders in the
 * notification's summary table) and the body, so the report names what broke
 * — an image that cannot be built is a different operator action from a
 * worker that keeps crashing.
 */
export function buildContainerEscalationParams(
  input: ContainerEscalationInput,
): CrashNotificationParams {
  const description = describeFailurePhase(input.phase);
  const lines = [
    "Vibe Coder container self-heal escalation",
    `Failure phase: ${input.phase} (${description})`,
    `Consecutive launcher failures: ${input.consecutiveFailures} ` +
    `(escalation threshold ${input.threshold})`,
    `Last launcher exit status: ${input.exitStatus}`,
    `Next attempt after a ${input.backoffSeconds}s backoff`,
  ];

  if (input.phase === "image_build") {
    lines.push(
      "The container image could not be built, so the known-good environment " +
        "cannot be reconstructed on this host — a retry alone will not fix it.",
    );
  }
  if (input.logTail) lines.push("", input.logTail);

  return {
    exitCode: input.exitStatus,
    repo: input.repo ?? "",
    issueNumber: input.issueNumber ?? 0,
    logTail: lines.join("\n"),
    claudeOutput: "",
    workStage: `container launch — ${description}`,
    workStartTime: 0,
    plannedShutdown: false,
  };
}

/** Issue a crashed container was working on, recovered from the work dir. */
export interface InFlightIssue {
  repo: string;
  issueNumber: number;
}

/**
 * Find the issue the container was working on when it died.
 *
 * The worker writes `.heartbeat_<owner>_<repo>_<issue>` into the work
 * directory while an issue is claimed, and the work directory is host-visible,
 * so the most recently touched heartbeat names the escalation target. Returns
 * null when no issue was in progress — the escalation then goes to the
 * webhook channel only.
 */
export async function resolveInFlightIssue(
  workDir: string,
): Promise<InFlightIssue | null> {
  if (!workDir) return null;

  let newest: { issue: InFlightIssue; modified: number } | null = null;
  try {
    for await (const entry of Deno.readDir(workDir)) {
      if (!entry.isFile || !entry.name.startsWith(".heartbeat_")) continue;

      // `.heartbeat_<owner>_<repo>_<issue>`; GitHub owner names cannot
      // contain an underscore, so the first separator splits owner from repo
      // and the last splits repo from the issue number.
      const body = entry.name.slice(".heartbeat_".length);
      const lastSeparator = body.lastIndexOf("_");
      const firstSeparator = body.indexOf("_");
      if (lastSeparator <= firstSeparator || firstSeparator <= 0) continue;

      const issueNumber = Number(body.slice(lastSeparator + 1));
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) continue;

      const owner = body.slice(0, firstSeparator);
      const repoName = body.slice(firstSeparator + 1, lastSeparator);
      if (!owner || !repoName) continue;

      let modified = 0;
      try {
        const info = await Deno.stat(`${workDir}/${entry.name}`);
        modified = info.mtime?.getTime() ?? 0;
      } catch {
        continue;
      }

      if (!newest || modified > newest.modified) {
        newest = {
          issue: { repo: `${owner}/${repoName}`, issueNumber },
          modified,
        };
      }
    }
  } catch {
    // An unreadable work directory just means no target — never fatal.
    return null;
  }

  return newest?.issue ?? null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Notification seam — the real crash channel by default. */
export type CrashNotifier = (
  config: CrashNotificationConfig,
  params: CrashNotificationParams,
) => Promise<Result<{ notified: boolean; reason?: string }>>;

/** Options for {@link recordContainerRestartOutcome}. */
export interface RecordContainerOutcomeOptions {
  /** Work directory holding the state file and the self-heal events log. */
  workDir: string;
  /** Exit status the launcher reported (0 is success). */
  exitStatus: number;
  /** Phase marker the launcher wrote, if any. */
  phaseMarker?: string | null;
  /**
   * Quota-pause marker the run wrote on the way out (Issue #342). Already
   * consumed by the caller, so it describes this invocation and no other.
   */
  quotaPause?: QuotaPauseMarker | null;
  /** Tunable overrides. */
  config?: Partial<ContainerRestartConfig>;
  /** Crash-notification channel configuration (cooldown, webhook, state). */
  crashConfig: CrashNotificationConfig;
  /** Escalation target repository — resolved from the work dir when absent. */
  repo?: string;
  /** Escalation target issue — resolved from the work dir when absent. */
  issueNumber?: number;
  /** Optional host log tail to include in the escalation. */
  logTail?: string;
  /** Clock seam, in Unix seconds. */
  now?: () => number;
  /** Notification seam (tests inject a recorder). */
  send?: CrashNotifier;
  /** Sink for warnings (defaults to `console.error` via the state reporter). */
  warn?: (message: string) => void;
}

/** What the supervisor is told after recording an outcome. */
export interface ContainerRestartOutcome {
  /** What the invocation was (Issue #342). */
  kind: LauncherOutcomeKind;
  /** Failure phase, or null when the launcher exited cleanly. */
  phase: ContainerFailurePhase | null;
  /** Consecutive failures after this outcome. */
  consecutiveFailures: number;
  /** Seconds to wait before re-invoking the launcher. */
  backoffSeconds: number;
  /** True when this clean run followed at least one failure. */
  recovered: boolean;
  /** True when a GitHub/webhook escalation was actually sent. */
  escalated: boolean;
  /** Why an escalation was not sent (e.g. `rate_limited`), else null. */
  escalationReason: string | null;
}

/**
 * Record one launcher outcome: update the backoff, emit the self-heal events,
 * and escalate through GitHub once the phase's threshold is crossed.
 *
 * Telemetry and escalation failures never change the returned backoff — the
 * supervisor must keep supervising even when it cannot report.
 */
export async function recordContainerRestartOutcome(
  options: RecordContainerOutcomeOptions,
): Promise<ContainerRestartOutcome> {
  const config = resolveContainerRestartConfig(options.config);
  const now = options.now ?? nowSeconds;
  const send = options.send ?? sendCrashNotification;

  const previous = await loadContainerRestartState(
    options.workDir,
    options.warn,
  );
  const decision = nextContainerRestartDecision(
    previous,
    options.exitStatus,
    options.phaseMarker,
    config,
    now,
    options.quotaPause,
  );

  const persisted = await persistContainerRestartState(
    options.workDir,
    decision.state,
  );
  if (!persisted.ok) {
    // Fail loud: without the state file the backoff silently resets to the
    // base sleep on every failure, which is the restart storm this guards.
    (options.warn ?? console.error)(
      `[container-restart] ${persisted.error.message}`,
    );
  }

  const outcome: ContainerRestartOutcome = {
    kind: decision.kind,
    phase: decision.phase,
    consecutiveFailures: decision.state.consecutiveFailures,
    backoffSeconds: decision.backoffSeconds,
    recovered: decision.recovered,
    escalated: false,
    escalationReason: null,
  };

  // Quota pause (Issue #342): recorded as the scheduled outcome it is, with
  // the streak already reset above. No escalation, no recovery claim, and a
  // fixed cadence — the operator reading `self-heal-summary` sees "out of
  // quota", not a host that keeps crashing.
  if (decision.kind === "quota_pause") {
    const reset = options.quotaPause?.resetEpochMs;
    await emitSelfHealEvent({
      module: SELF_HEAL_MODULE,
      action: "quota_pause",
      reason: `worker paused: out of quota — re-probing in ` +
        `${decision.backoffSeconds}s` +
        (previous.consecutiveFailures > 0
          ? ` (failure streak of ${previous.consecutiveFailures} cleared — ` +
            "a scheduled pause is not a failure)"
          : ""),
      result: "ok",
      details: {
        exitStatus: options.exitStatus,
        sleepSeconds: decision.backoffSeconds,
        previousFailures: previous.consecutiveFailures,
        reason: options.quotaPause?.reason ?? null,
        resetEpochMs: reset ?? null,
        remainingSeconds: typeof reset === "number"
          ? Math.max(0, Math.ceil((reset - now() * 1000) / 1000))
          : null,
      },
    }, { workDir: options.workDir });
    return outcome;
  }

  if (decision.recovered) {
    await emitSelfHealEvent({
      module: SELF_HEAL_MODULE,
      action: "recovered",
      reason:
        `launcher succeeded after ${previous.consecutiveFailures} consecutive ` +
        "failures — container environment reconstructed",
      result: "ok",
      details: {
        previousFailures: previous.consecutiveFailures,
        previousPhase: previous.lastPhase,
      },
    }, { workDir: options.workDir });
  }

  if (!decision.phase) return outcome;

  await emitSelfHealEvent({
    module: SELF_HEAL_MODULE,
    action: "restart_backoff",
    reason: `${describeFailurePhase(decision.phase)} failed ` +
      `(${decision.state.consecutiveFailures} consecutive) — retrying in ` +
      `${decision.backoffSeconds}s`,
    result: "ok",
    details: {
      phase: decision.phase,
      exitStatus: options.exitStatus,
      consecutiveFailures: decision.state.consecutiveFailures,
      backoffSeconds: decision.backoffSeconds,
    },
  }, { workDir: options.workDir });

  if (!decision.escalate) return outcome;

  const target = options.repo
    ? { repo: options.repo, issueNumber: options.issueNumber ?? 0 }
    : await resolveInFlightIssue(options.workDir);

  const params = buildContainerEscalationParams({
    phase: decision.phase,
    exitStatus: options.exitStatus,
    consecutiveFailures: decision.state.consecutiveFailures,
    backoffSeconds: decision.backoffSeconds,
    threshold: decision.threshold,
    repo: target?.repo,
    issueNumber: target?.issueNumber,
    logTail: options.logTail,
  });

  let notified = false;
  let reason: string | null = null;
  try {
    const result = await send(options.crashConfig, params);
    if (result.ok) {
      notified = result.value.notified;
      reason = result.value.reason ?? null;
    } else {
      reason = result.error.message;
    }
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }

  outcome.escalated = notified;
  outcome.escalationReason = notified ? null : reason;

  await emitSelfHealEvent({
    module: SELF_HEAL_MODULE,
    action: "escalated",
    reason: notified
      ? `reported ${decision.phase} failure to GitHub after ` +
        `${decision.state.consecutiveFailures} consecutive failures`
      : `escalation for ${decision.phase} not sent (${reason ?? "unknown"})`,
    result: notified ? "ok" : "skipped",
    details: {
      phase: decision.phase,
      consecutiveFailures: decision.state.consecutiveFailures,
      threshold: decision.threshold,
      repo: params.repo,
      issueNumber: params.issueNumber,
      reason,
    },
  }, { workDir: options.workDir });

  return outcome;
}
