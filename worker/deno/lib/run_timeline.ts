/**
 * The run's timeline: its one-hour target, its two-hour finish, and when the
 * launcher's watchdog will kill it regardless (Issue #4242).
 *
 * The target is the run's one-hour mark and the finish its two-hour mark;
 * both are instants measured from the run's start. The target is read as the
 * start gate: nothing new starts after it (Issue #4243). Subprocess
 * chokepoints clamp their budgets against the finish and, past the finish,
 * against the hard kill (Issue #4247). An agent session's timeout is the
 * smaller of the time it asked for and the time left before the finish, less
 * the kill grace and the WIP reserve, and the user prompt states that
 * deadline (Issue #4244). Progress-extension grants stop at that same instant
 * less the reserve, and the claim floor measures runway to the finish itself
 * (Issue #4245). The drain waits no later than the finish plus that reserve
 * (Issue #4246). The run's claim deadline (`runDurationSeconds`) is the
 * target: it stops new claims, and it is not the finish. The hard kill is the
 * epoch-ms at which the launcher's watchdog ends the run whatever the worker
 * is doing. The finish is held back so the WIP checkpoint (commit and push)
 * lands before that kill: if the configured finish would leave less than the
 * kill grace plus {@link WIP_CHECKPOINT_RESERVE_SECONDS} before the hard kill,
 * it is clamped and the clamp is logged, never applied silently.
 *
 * The hard kill is read from {@link HARD_KILL_AT_EPOCH_ENV} (epoch-**seconds**,
 * published by the launcher) when that is present and plausible. Otherwise it
 * falls back to the supervisor cap resolved by `run_hard_cap.ts`. A malformed
 * value is logged and then ignored in favour of the fallback.
 *
 * The process-wide accessors hold the timeline for the run's other modules.
 * Until one is set, nothing clamps.
 *
 * Pure but for the default env reader: the environment and the warning sink
 * are injected, so the resolution is exhaustively testable.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  defaultEnv,
  parsePlausibleEpochSeconds,
  resolveRunHardCap,
  WIP_CHECKPOINT_RESERVE_SECONDS,
} from "./run_hard_cap.ts";

/** The launcher watchdog's kill, in epoch-**seconds**. */
export const HARD_KILL_AT_EPOCH_ENV = "VIBE_HARD_KILL_AT_EPOCH";

/** Default run target: the one-hour mark, in seconds from the run's start. */
export const DEFAULT_RUN_TARGET_SECONDS = 3600;

/** Default run finish: the two-hour mark, in seconds from the run's start. */
export const DEFAULT_RUN_FINISH_SECONDS = 7200;

/** The run's resolved timeline, with the helpers that read it. */
export interface RunTimeline {
  /** Epoch-ms of the run's target mark (start plus the target seconds). */
  readonly targetMs: number;
  /** Epoch-ms of the run's finish mark, after any clamp. */
  readonly finishMs: number;
  /** Epoch-ms of the hard kill, or null when no kill is known. */
  readonly hardKillMs: number | null;
  /** Why there is no hard kill, when {@link hardKillMs} is null. */
  readonly hardKillReason?: string;
  /** True once `now` has reached the target. */
  pastTarget(now: number): boolean;
  /** True once `now` has reached the finish. */
  pastFinish(now: number): boolean;
  /** Milliseconds left until the finish, never negative. */
  remainingToFinishMs(now: number): number;
  /**
   * Clamp a requested duration so it does not run past the finish, keeping
   * `reserveMs` free at the end.
   *
   * @param requestedMs - The duration asked for, in ms.
   * @param now - Current epoch-ms.
   * @param reserveMs - Milliseconds to hold back before the finish.
   * @returns The duration granted, in ms; never negative.
   */
  clampToFinishMs(requestedMs: number, now: number, reserveMs: number): number;
}

/** The epoch-ms as an ISO-8601 string, for log lines. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Resolve the hard kill from the watchdog variable, or from the supervisor cap.
 *
 * A malformed watchdog value is warned about and then ignored; the fallback
 * still applies. The returned reason is set only when there is no kill.
 *
 * @param env - Environment reader.
 * @param warn - Sink for the malformed-value warning.
 * @param killAfterSeconds - The worker's own SIGTERM→SIGKILL grace.
 * @returns The hard kill in epoch-ms, or null with the reason.
 */
function resolveHardKill(
  env: (name: string) => string | undefined,
  warn: (message: string) => void,
  killAfterSeconds: number,
): { hardKillMs: number | null; hardKillReason?: string } {
  const raw = env(HARD_KILL_AT_EPOCH_ENV);
  const fromWatchdog = parsePlausibleEpochSeconds(raw);
  if (fromWatchdog !== undefined) {
    return { hardKillMs: fromWatchdog * 1000 };
  }

  let source: string;
  if (raw === undefined || raw.trim().length === 0) {
    source = `${HARD_KILL_AT_EPOCH_ENV} is not set`;
  } else {
    source = `${HARD_KILL_AT_EPOCH_ENV}=${JSON.stringify(raw)} is not a ` +
      `plausible epoch-seconds value`;
    warn(`${source} — ignoring it and falling back to the supervisor cap`);
  }

  const cap = resolveRunHardCap({ env, killAfterSeconds });
  if (cap.capped) {
    return { hardKillMs: cap.cap.supervisorDeadlineMs };
  }
  return { hardKillMs: null, hardKillReason: `${source}; ${cap.reason}` };
}

/**
 * Resolve the run's timeline from its start, its configured target and finish,
 * and the hard kill the launcher publishes.
 *
 * The finish is clamped (and the clamp warned) when it would leave less than
 * the kill grace plus the WIP checkpoint reserve before the hard kill.
 *
 * @param input - Start, durations, environment, kill grace and warning sink.
 * @returns The resolved timeline.
 */
export function resolveRunTimeline(input: {
  startedMs: number;
  runDurationSeconds: number;
  runFinishSeconds: number;
  env?: (name: string) => string | undefined;
  killAfterSeconds: number;
  warn?: (message: string) => void;
}): RunTimeline {
  const env = input.env ?? defaultEnv;
  const warn = input.warn ?? ((message: string) => console.warn(message));

  const targetMs = input.startedMs + input.runDurationSeconds * 1000;
  const configuredFinishMs = input.startedMs + input.runFinishSeconds * 1000;
  let finishMs = configuredFinishMs;

  const { hardKillMs, hardKillReason } = resolveHardKill(
    env,
    warn,
    input.killAfterSeconds,
  );

  if (hardKillMs !== null) {
    const latestFinishMs = hardKillMs -
      (input.killAfterSeconds + WIP_CHECKPOINT_RESERVE_SECONDS) * 1000;
    if (finishMs >= latestFinishMs) {
      warn(
        `Run finish ${isoOf(configuredFinishMs)} leaves less than the kill ` +
          `grace and WIP reserve before the hard kill at ` +
          `${isoOf(hardKillMs)}; clamped the finish to ` +
          `${isoOf(latestFinishMs)}`,
      );
      finishMs = latestFinishMs;
    }
  }

  return {
    targetMs,
    finishMs,
    hardKillMs,
    hardKillReason,
    pastTarget: (now) => now >= targetMs,
    pastFinish: (now) => now >= finishMs,
    remainingToFinishMs: (now) => Math.max(0, finishMs - now),
    clampToFinishMs: (requestedMs, now, reserveMs) =>
      Math.min(requestedMs, Math.max(0, finishMs - now - reserveMs)),
  };
}

/**
 * The one-line timeline an operator reads. The caller prepends `Run timeline: `.
 *
 * @param t - The resolved timeline.
 * @returns `target=<ISO> finish=<ISO> hard-kill=<ISO | none (<reason>)>`.
 */
export function describeRunTimeline(t: RunTimeline): string {
  const hardKill = t.hardKillMs === null
    ? `none (${t.hardKillReason ?? "no reason recorded"})`
    : isoOf(t.hardKillMs);
  return `target=${isoOf(t.targetMs)} finish=${isoOf(t.finishMs)} ` +
    `hard-kill=${hardKill}`;
}

/** The timeline in force for this process, once one has been set. */
let current: RunTimeline | undefined;

/**
 * Record the run's timeline for the other modules to read.
 *
 * @param t - The resolved timeline.
 */
export function setRunTimeline(t: RunTimeline): void {
  current = t;
}

/**
 * The timeline in force for this process.
 *
 * @returns The timeline, or undefined when none is set (nothing clamps).
 */
export function getRunTimeline(): RunTimeline | undefined {
  return current;
}

/**
 * Whether the run's target mark has passed. Start-gates ("nothing new starts
 * after the target", Issue #4243) call this with their own clock reading.
 *
 * @param now - Current epoch-ms (the caller's injected clock).
 * @returns True once the process-wide timeline's target has been reached;
 *   false when no timeline is set (nothing refuses).
 */
export function pastRunTarget(now: number): boolean {
  return current?.pastTarget(now) ?? false;
}

/**
 * Floor beneath which an agent session is not started (Issue #4244).
 *
 * A finish-deadline budget shorter than this cannot commit and push, so the
 * chokepoint refuses the spawn instead of handing the agent a few seconds.
 */
export const MIN_AGENT_SESSION_SECONDS = 120;

/**
 * Kill grace plus the WIP commit-and-push window, in seconds (Issues #4244,
 * #4245, #4246).
 *
 * A session, an extension grant and the drain all keep this reserve clear of
 * the finish so the checkpoint can land before the agent is killed.
 *
 * @param killAfterSeconds - The worker's SIGTERM-to-SIGKILL grace.
 * @returns Seconds held back from the finish. Never negative.
 */
export function finishSessionReserveSeconds(killAfterSeconds: number): number {
  return Math.max(0, killAfterSeconds) + WIP_CHECKPOINT_RESERVE_SECONDS;
}

/**
 * The finish deadline and the extension ceiling, when a timeline is set.
 *
 * The ceiling is the finish less {@link finishSessionReserveSeconds}: a grant
 * may land on that instant and no later. The claim floor measures to
 * `finishMs` itself, which is later than the ceiling by the reserve.
 *
 * @param killAfterSeconds - The worker's SIGTERM-to-SIGKILL grace.
 * @returns Both instants, or undefined when no timeline is set.
 */
export function finishDeadlineBounds(killAfterSeconds: number): {
  finishMs: number;
  ceilingMs: number;
} | undefined {
  const timeline = getRunTimeline();
  if (!timeline) return undefined;
  return {
    finishMs: timeline.finishMs,
    ceilingMs: timeline.finishMs -
      finishSessionReserveSeconds(killAfterSeconds) * 1000,
  };
}

/**
 * The ceiling every progress-extension grant is measured against.
 *
 * When a timeline is set and its ceiling is the nearer bound, the label is
 * the finish deadline and a clamped grant says so. Otherwise the supervisor
 * hard cap keeps its own wording. Undefined when neither bound exists.
 *
 * @param killAfterSeconds - The worker's SIGTERM-to-SIGKILL grace.
 * @param hardCapCeilingMs - The supervisor ceiling, when this run has one.
 * @returns The nearer ceiling and the words the clamp line uses.
 */
export function extensionCeiling(
  killAfterSeconds: number,
  hardCapCeilingMs: number | undefined,
):
  | { ceilingMs: number; label: "the finish deadline" | "the run hard cap" }
  | undefined {
  const bounds = finishDeadlineBounds(killAfterSeconds);
  if (
    bounds &&
    (hardCapCeilingMs === undefined || bounds.ceilingMs <= hardCapCeilingMs)
  ) {
    return { ceilingMs: bounds.ceilingMs, label: "the finish deadline" };
  }
  if (hardCapCeilingMs !== undefined) {
    return { ceilingMs: hardCapCeilingMs, label: "the run hard cap" };
  }
  return undefined;
}

/** How {@link clampTimeoutToFinishDeadline} bounded one session. */
export interface FinishSessionClamp {
  /** Seconds the session may run. Never more than the time the caller asked. */
  timeoutSeconds: number;
  /** True when the finish deadline reduced the caller's timeout. */
  clamped: boolean;
  /**
   * True when the finish deadline leaves less than
   * {@link MIN_AGENT_SESSION_SECONDS} of session budget. The agent is not
   * spawned.
   */
  belowFloor: boolean;
  /** The finish deadline, ISO-8601. */
  finishIso: string;
  /** Whole seconds from `now` until the finish deadline, never negative. */
  remainingSeconds: number;
}

/**
 * Bound one agent session by the finish deadline (Issue #4244).
 *
 * The budget is the smaller of the requested timeout and
 * finish − now − kill grace − {@link WIP_CHECKPOINT_RESERVE_SECONDS}.
 * A negative remainder is zero. The caller refuses the spawn when
 * {@link FinishSessionClamp.belowFloor} is set.
 *
 * @param input - The requested timeout, the kill grace, the clock and the timeline.
 * @returns The budget the session may use.
 */
export function clampTimeoutToFinishDeadline(input: {
  requestedTimeoutSeconds: number;
  killAfterSeconds: number;
  nowMs: number;
  timeline: RunTimeline;
}): FinishSessionClamp {
  const remainingMs = input.timeline.finishMs - input.nowMs;
  const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const reserveSeconds = finishSessionReserveSeconds(input.killAfterSeconds);
  const allowedSeconds = Math.floor(remainingMs / 1000) - reserveSeconds;
  return {
    timeoutSeconds: Math.min(
      input.requestedTimeoutSeconds,
      Math.max(0, allowedSeconds),
    ),
    clamped: allowedSeconds < input.requestedTimeoutSeconds,
    belowFloor: allowedSeconds < MIN_AGENT_SESSION_SECONDS,
    finishIso: new Date(input.timeline.finishMs).toISOString(),
    remainingSeconds,
  };
}

/**
 * The one worker-written line appended to the end of the user prompt
 * (Issue #4244). It names the finish deadline, the seconds remaining, and
 * that the agent must commit and push before then.
 *
 * @param clamp - The deadline and the seconds left until it.
 * @returns The line, with no leading newline.
 */
export function finishDeadlinePromptLine(
  clamp: Pick<FinishSessionClamp, "finishIso" | "remainingSeconds">,
): string {
  return `Finish deadline: ${clamp.finishIso} (${clamp.remainingSeconds} seconds remaining). Commit and push your work before then.`;
}

/**
 * Append {@link finishDeadlinePromptLine} to the user prompt.
 *
 * An empty prompt becomes the line alone, so the deadline is still the last
 * thing the agent reads.
 *
 * @param prompt - The user prompt the caller built.
 * @param clamp - The deadline and the seconds left until it.
 * @returns The prompt the agent receives.
 */
export function appendFinishDeadlinePrompt(
  prompt: string,
  clamp: Pick<FinishSessionClamp, "finishIso" | "remainingSeconds">,
): string {
  const line = finishDeadlinePromptLine(clamp);
  return prompt.length === 0 ? line : `${prompt}\n${line}`;
}

/** Forget the process-wide timeline. For tests only. */
export function resetRunTimelineForTests(): void {
  current = undefined;
}
