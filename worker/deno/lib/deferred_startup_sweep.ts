/**
 * Deferred startup sweeps (Issue #4822).
 *
 * Startup sweeps such as the GitHub branch cleanup used to run to completion
 * before the first claim, which delayed every run's first issue. They now
 * start in the background alongside the main loop, and the run gives any
 * sweep still going a bounded grace once the loop has ended. A sweep that
 * outlives the grace is abandoned, not killed: its progress persists in its
 * own state, so the next run resumes it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/** Default grace the run gives a still-running sweep once the main loop has ended, ms. */
export const DEFERRED_SWEEP_GRACE_MS = 120_000;

/** A sweep started in the background. `done` never rejects. */
export interface DeferredSweep {
  readonly name: string;
  readonly done: Promise<void>;
}

/** Where sweep progress and failures are reported. */
export interface DeferredSweepSink {
  log(message: string): void;
  logError(message: string): void;
}

/** Injectable timer so tests do not sleep. */
export interface SweepTimer {
  start(ms: number): { expired: Promise<void>; cancel(): void };
}

/** The production timer, backed by `setTimeout` and `clearTimeout`. */
export const realSweepTimer: SweepTimer = {
  start(ms: number) {
    let resolveExpired: () => void = () => {};
    const expired = new Promise<void>((resolve) => {
      resolveExpired = resolve;
    });
    const timerId: ReturnType<typeof setTimeout> = setTimeout(
      () => resolveExpired(),
      ms,
    );
    return {
      expired,
      cancel: () => clearTimeout(timerId),
    };
  },
};

/** The message text of a thrown value, whatever its type. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start `run` now WITHOUT awaiting it. A throw or rejection is logged via
 * `sink.logError` and never propagates; success logs nothing extra beyond
 * what `run` itself logs. `run` is invoked synchronously, so it has begun
 * before the caller's next `await`.
 */
export function startDeferredSweep(
  name: string,
  run: () => Promise<unknown>,
  sink: DeferredSweepSink,
): DeferredSweep {
  let started: Promise<unknown>;
  try {
    started = Promise.resolve(run());
  } catch (error) {
    started = Promise.reject(error);
  }
  const done = started.then(
    () => {},
    (error: unknown) => {
      sink.logError(
        `[deferred-sweep] ${name} failed (continuing): ${messageOf(error)}`,
      );
    },
  );
  return { name, done };
}

/**
 * Wait for the sweeps to finish, but no longer than `graceMs`. Returns the
 * names of the sweeps still running when the grace expired (empty when all
 * finished). Each abandoned sweep is named in `sink.logError`. The timer is
 * always cancelled, and empty input returns at once without starting one.
 */
export async function settleDeferredSweeps(
  sweeps: readonly DeferredSweep[],
  sink: DeferredSweepSink,
  options: { graceMs?: number; timer?: SweepTimer } = {},
): Promise<string[]> {
  if (sweeps.length === 0) return [];
  const graceMs = options.graceMs ?? DEFERRED_SWEEP_GRACE_MS;
  const timer = options.timer ?? realSweepTimer;

  const finished = sweeps.map(() => false);
  const markFinished = (index: number) => () => {
    finished[index] = true;
  };
  const tracked = sweeps.map((sweep, index) =>
    sweep.done.then(markFinished(index), markFinished(index))
  );

  const grace = timer.start(graceMs);
  try {
    await Promise.race([Promise.all(tracked), grace.expired]);
  } finally {
    grace.cancel();
  }

  const abandoned = sweeps
    .filter((_, index) => !finished[index])
    .map((sweep) => sweep.name);
  if (abandoned.length > 0) {
    sink.logError(
      `[deferred-sweep] still running after the ${graceMs} ms grace, left unfinished ` +
        `(progress persists, the next run resumes): ${abandoned.join(", ")}`,
    );
  }
  return abandoned;
}
