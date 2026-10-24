/**
 * The run's timeline: its one-hour target, its two-hour finish, and when the
 * launcher's watchdog will kill it regardless (Issue #4242).
 *
 * The target is the run's one-hour mark and the finish its two-hour mark;
 * both are instants measured from the run's start, and nothing reads either
 * of them yet: no agent is asked to wrap up at the target, and the run's
 * claim deadline (`runDurationSeconds`) is separate. The hard kill is the
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

/** Forget the process-wide timeline. For tests only. */
export function resetRunTimelineForTests(): void {
  current = undefined;
}
