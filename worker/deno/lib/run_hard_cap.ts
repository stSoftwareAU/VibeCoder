/**
 * The supervisor's wall-clock cap, as the worker sees it (Issue #421,
 * parent #397).
 *
 * `loop.sh` owns the cap: `timeout --kill-after=<grace> <VIBE_RUN_MAX_SECONDS>`
 * around `run.sh` (Issue #322). Until now that number lived only in the
 * supervisor, so the progress-extension policy could re-arm the deadline for
 * as long as the run kept progressing and nothing knew when the supervisor
 * would step in. With truncation retired (Issue #420) that is a run which
 * ends on a SIGTERM it never saw coming: no orderly WIP commit window, and a
 * launcher-failure exit status recorded against the host (Issue #4072).
 *
 * `loop.sh` now exports the cap and the run's start epoch, `run.sh` passes
 * both into the container, and this module turns them into the absolute
 * epoch-ms past which no grant may be issued — with the SIGTERM→commit→push
 * window held back inside it, so the worker's own kill lands *before* the
 * supervisor's and `wip_checkpoint.ts` has time to finish.
 *
 * Pure but for the default env reader: the environment is an injected input,
 * so the resolution is exhaustively testable. Absent or disabled env yields
 * no ceiling and behaviour is exactly what it was.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** The supervisor's cap, in seconds. `0` documents "disabled" (`loop.sh`). */
export const RUN_MAX_SECONDS_ENV = "VIBE_RUN_MAX_SECONDS";

/** Epoch-**seconds** at which the supervisor started this run. */
export const RUN_STARTED_EPOCH_ENV = "VIBE_RUN_STARTED_EPOCH";

/**
 * Seconds held back for the WIP checkpoint's commit-and-push, on top of the
 * worker's own SIGTERM→SIGKILL grace (`claude_kill_after`).
 *
 * The whole point of stopping before the supervisor does is that the run's
 * work-in-progress is committed and pushed so the next cycle resumes it
 * (Issues #47/#148/#4170). A supervisor SIGKILL landing mid-push loses it,
 * so the window is reserved rather than hoped for.
 */
export const WIP_CHECKPOINT_RESERVE_SECONDS = 120;

/** The resolved ceiling and the numbers an operator needs to check it. */
export interface RunHardCap {
  /** Epoch-ms at which the supervisor's `timeout` sends SIGTERM. */
  supervisorDeadlineMs: number;
  /** Epoch-ms past which no extension grant may move the deadline. */
  ceilingMs: number;
  /** Seconds held back between the ceiling and the supervisor deadline. */
  reserveSeconds: number;
  /** The cap the supervisor was given, in seconds. */
  maxSeconds: number;
  /** Epoch-ms the supervisor started this run. */
  startedMs: number;
}

/**
 * Either a ceiling, or the reason there is none.
 *
 * Never a silent "no ceiling": the reason is logged at run start, so an
 * operator can tell a deliberately uncapped host from a passthrough a
 * launcher refactor dropped.
 */
export type RunHardCapResolution =
  | { capped: true; cap: RunHardCap }
  | { capped: false; reason: string };

/** Inputs to {@link resolveRunHardCap}. */
export interface RunHardCapInput {
  /** Environment reader; injected so the resolution needs no real env. */
  env?: (name: string) => string | undefined;
  /** The worker's own SIGTERM→SIGKILL grace (`claude_kill_after`). */
  killAfterSeconds: number;
  /** Commit-and-push window; defaults to {@link WIP_CHECKPOINT_RESERVE_SECONDS}. */
  checkpointReserveSeconds?: number;
}

/** Read an environment variable, tolerating a denied `--allow-env`. */
function defaultEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** A finite, non-negative integer, or undefined when the text is not one. */
function parseSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Plausible epoch-**seconds**: 2001-09-09 through 5138.
 *
 * Rejecting anything larger is what stops an epoch-milliseconds value being
 * read as seconds, which would put the ceiling ~50 000 years out — unbounded
 * by another name, and silently so.
 */
const MIN_EPOCH_SECONDS = 1_000_000_000;
const MAX_EPOCH_SECONDS = 100_000_000_000;

/**
 * Resolve the extension ceiling from the supervisor's published cap.
 *
 * @param input - Env reader, kill grace and checkpoint reserve.
 * @returns The ceiling, or the reason this run is uncapped.
 */
export function resolveRunHardCap(
  input: RunHardCapInput,
): RunHardCapResolution {
  const env = input.env ?? defaultEnv;
  const rawMax = env(RUN_MAX_SECONDS_ENV);
  const rawStart = env(RUN_STARTED_EPOCH_ENV);

  if (rawMax === undefined || rawMax.trim().length === 0) {
    return {
      capped: false,
      reason: `${RUN_MAX_SECONDS_ENV} is not set — no ceiling`,
    };
  }

  const maxSeconds = parseSeconds(rawMax);
  if (maxSeconds === undefined) {
    return {
      capped: false,
      reason:
        `${RUN_MAX_SECONDS_ENV}=${JSON.stringify(rawMax)} is not a whole ` +
        `number of seconds — no ceiling`,
    };
  }
  if (maxSeconds === 0) {
    // Documented as "disabled" in loop.sh — never "cap at zero".
    return {
      capped: false,
      reason:
        `${RUN_MAX_SECONDS_ENV}=0 disables the supervisor cap — no ceiling`,
    };
  }

  const startedSeconds = parseSeconds(rawStart);
  if (
    startedSeconds === undefined ||
    startedSeconds < MIN_EPOCH_SECONDS ||
    startedSeconds >= MAX_EPOCH_SECONDS
  ) {
    return {
      capped: false,
      reason: rawStart === undefined
        ? `${RUN_STARTED_EPOCH_ENV} is not set, so the cap cannot be ` +
          `anchored — no ceiling`
        : `${RUN_STARTED_EPOCH_ENV}=${JSON.stringify(rawStart)} is not a ` +
          `plausible epoch-seconds value — no ceiling`,
    };
  }

  const reserveSeconds = Math.max(0, input.killAfterSeconds) +
    Math.max(
      0,
      input.checkpointReserveSeconds ?? WIP_CHECKPOINT_RESERVE_SECONDS,
    );
  const startedMs = startedSeconds * 1000;
  const supervisorDeadlineMs = startedMs + maxSeconds * 1000;
  return {
    capped: true,
    cap: {
      supervisorDeadlineMs,
      // A cap smaller than the reserve puts the ceiling at or before the run
      // start: every grant is then refused, which is the fail-safe direction.
      ceilingMs: supervisorDeadlineMs - reserveSeconds * 1000,
      reserveSeconds,
      maxSeconds,
      startedMs,
    },
  };
}

/** The raw pair a launcher forwards into the container (Issue #421). */
export interface RunCapPassthrough {
  /** The supervisor's cap in seconds; `0` is the documented "disabled". */
  maxSeconds: number;
  /** Epoch-seconds at which the supervisor started this run. */
  startedEpochSeconds: number;
}

/**
 * Read the pair `loop.sh` exported, for forwarding into the container.
 *
 * Shape only — `0` is forwarded verbatim so the worker logs a deliberately
 * disabled cap as disabled rather than as a missing passthrough. A pair that
 * is not a usable cap at all is not forwarded, and the worker applies no
 * ceiling.
 *
 * @param env - Environment reader; defaults to the process environment.
 * @returns The pair, or undefined when there is nothing usable to forward.
 */
export function readRunCapPassthrough(
  env: (name: string) => string | undefined = defaultEnv,
): RunCapPassthrough | undefined {
  const maxSeconds = parseSeconds(env(RUN_MAX_SECONDS_ENV));
  const startedEpochSeconds = parseSeconds(env(RUN_STARTED_EPOCH_ENV));
  if (maxSeconds === undefined || startedEpochSeconds === undefined) {
    return undefined;
  }
  if (
    startedEpochSeconds < MIN_EPOCH_SECONDS ||
    startedEpochSeconds >= MAX_EPOCH_SECONDS
  ) {
    return undefined;
  }
  return { maxSeconds, startedEpochSeconds };
}

/**
 * The one-line run-start description an operator reads.
 *
 * @param resolution - What {@link resolveRunHardCap} answered.
 * @param nowMs - Current epoch-ms, for the runway figure.
 * @returns A single line, capped or not.
 */
export function describeRunHardCap(
  resolution: RunHardCapResolution,
  nowMs: number,
): string {
  if (!resolution.capped) return resolution.reason;
  const { cap } = resolution;
  const runwaySeconds = Math.round((cap.ceilingMs - nowMs) / 1000);
  return `${RUN_MAX_SECONDS_ENV}=${cap.maxSeconds}s from run start; ` +
    `progress extensions may not push the deadline past ` +
    `${Math.round((cap.ceilingMs - cap.startedMs) / 1000)}s elapsed ` +
    `(${cap.reserveSeconds}s reserved for the kill grace and the WIP ` +
    `commit-and-push), leaving ${runwaySeconds}s of runway`;
}
