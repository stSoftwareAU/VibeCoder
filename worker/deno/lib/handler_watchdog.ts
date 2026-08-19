/**
 * Per-iteration watchdog for the worker dispatch loop (Issue #2473).
 *
 * The main loop awaits each Priority 1.x handler's `execute()` directly. A
 * single `gh`/network call that hangs indefinitely therefore freezes the
 * whole loop with no operator signal — the symptom behind the #2472 fleet
 * stall (a frozen `scan_cursor` stuck at Priority 1.8). This module bounds
 * each handler with a hard timeout so a wedged call cannot freeze the loop,
 * and emits a soft warning when a handler is slow but still returns.
 *
 * The timer is injected (`delay`) and the clock is injected (`now`), following
 * the existing `nowFn` injection style, so the timeout is deterministically
 * testable with no real sleep.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Outcome of running a task under the watchdog. */
export type WatchdogOutcome = "completed" | "timedout";

/** Result of {@link runWithWatchdog}. */
export interface WatchdogResult<T> {
  /** Whether the task completed or was abandoned on hard timeout. */
  outcome: WatchdogOutcome;
  /** The task's resolved value — present only when `outcome === "completed"`. */
  value?: T;
  /** Elapsed wall-clock duration in milliseconds, measured via the injected clock. */
  durationMs: number;
}

/** Options controlling the watchdog. */
export interface WatchdogOptions {
  /**
   * Hard timeout in milliseconds. When the task does not resolve within this
   * window the watchdog abandons it (stops awaiting) and reports a timeout.
   * A value `<= 0` disables the hard timeout — the task is awaited directly.
   */
  hardTimeoutMs: number;
  /**
   * Soft threshold in milliseconds. When a task completes but took at least
   * this long, `onSoftWarning` fires. A value `<= 0` disables soft warnings.
   */
  softTimeoutMs: number;
  /** Injected clock (epoch milliseconds) for elapsed measurement. */
  now: () => number;
  /**
   * Injected timer: resolves after `ms` milliseconds. Production wires this to
   * `setTimeout`; tests pass a controllable promise so the timeout fires
   * deterministically without a real sleep.
   */
  delay: (ms: number) => Promise<void>;
  /** Called when a completed task exceeded the soft threshold. */
  onSoftWarning?: (durationMs: number) => void;
  /** Called when the task exceeded the hard timeout and was abandoned. */
  onTimeout?: () => void;
}

/** Sentinel distinguishing the timeout branch from any task return value. */
const TIMEOUT = Symbol("watchdog-timeout");

/**
 * Run `task` under the watchdog.
 *
 * The task is raced against the injected timer. If the timer wins, the task is
 * abandoned (left to settle on its own — its result is ignored) and the result
 * reports `outcome: "timedout"`. Otherwise the task's value is returned, and if
 * it took at least `softTimeoutMs` the soft-warning callback fires.
 *
 * A rejection thrown by `task` propagates to the caller unchanged, so the
 * dispatch loop's existing rate-limit re-throw and generic catch are preserved.
 */
export async function runWithWatchdog<T>(
  task: () => Promise<T>,
  opts: WatchdogOptions,
): Promise<WatchdogResult<T>> {
  const start = opts.now();

  // Disabled hard timeout: await directly, still measure for the soft warning.
  if (opts.hardTimeoutMs <= 0) {
    const value = await task();
    const durationMs = opts.now() - start;
    maybeWarn(durationMs, opts);
    return { outcome: "completed", value, durationMs };
  }

  const timeoutPromise = opts.delay(opts.hardTimeoutMs).then(() => TIMEOUT);
  const raced = await Promise.race([task(), timeoutPromise]);

  if (raced === TIMEOUT) {
    opts.onTimeout?.();
    return { outcome: "timedout", durationMs: opts.now() - start };
  }

  const durationMs = opts.now() - start;
  maybeWarn(durationMs, opts);
  return { outcome: "completed", value: raced as T, durationMs };
}

/** Fire the soft-warning callback when the soft threshold is met. */
function maybeWarn(durationMs: number, opts: WatchdogOptions): void {
  if (opts.softTimeoutMs > 0 && durationMs >= opts.softTimeoutMs) {
    opts.onSoftWarning?.(durationMs);
  }
}
