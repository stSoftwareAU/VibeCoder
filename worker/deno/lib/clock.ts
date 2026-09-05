/**
 * The clock and timer seam (Issue #1170 follow-up).
 *
 * `runClaudeWithTimeout` enforces its deadline, its silence watchdog, its
 * post-kill cap and its stream drain against the wall clock. That is correct
 * in production and ruinous in a test: twenty-five suites drove the runner
 * against a real 0.5–4 s deadline, which is 108 s of the serial pass spent
 * asleep, and — worse — a watchdog that wakes late on a loaded host reports a
 * correctness failure. Four of PR #1170's own failures were exactly that.
 *
 * So the runner reads time and arms timers through this interface instead of
 * through the globals. Production passes nothing and gets {@link systemClock},
 * which is `Date.now` and the real `setTimeout`/`setInterval` — bit-for-bit
 * the behaviour it always had. A test passes a fake and *drives* the deadline:
 * the watchdog fires because the test said so, not because a second went by,
 * so the assertion means the same thing on an idle laptop and on a host with
 * nine other workers on it.
 *
 * The same house pattern as `EnvLookup`/`processEnvLookup`, the injected
 * `runGhCommand`, `AgentProgressTracker`'s own `now` and `pid_guard`'s
 * `sleep`: one narrow interface, a real default, and the test names what it
 * wants rather than mutating something the whole process shares.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * A timer handle.
 *
 * `number` is what both Deno globals return, and keeping it a number rather
 * than an opaque type means a caller can hold `undefined` for "no timer armed"
 * exactly as it did with `ReturnType<typeof setTimeout>` — and lets a fake
 * clock mint handles of its own. The `Number(...)` coercions below are for
 * the ambient Node typings, whose `Timeout` object carries the same id.
 */
export type TimerHandle = number;

/** Reading the time and arming timers, as an injectable seam. */
export interface Clock {
  /** Milliseconds since the epoch — the `Date.now()` replacement. */
  now(): number;
  /** Arm a one-shot timer. */
  setTimeout(handler: () => void, delayMs: number): TimerHandle;
  /** Disarm a one-shot timer; `undefined` is a no-op, as with the global. */
  clearTimeout(handle: TimerHandle | undefined): void;
  /** Arm a repeating timer. */
  setInterval(handler: () => void, delayMs: number): TimerHandle;
  /** Disarm a repeating timer; `undefined` is a no-op. */
  clearInterval(handle: TimerHandle | undefined): void;
  /** Resolve after `delayMs` — the in-process backoff wait. */
  sleep(delayMs: number): Promise<void>;
}

/**
 * The real clock: `Date.now()` and the runtime's own timers.
 *
 * Every production call site gets this, because every production call site
 * passes no clock at all.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => Number(setTimeout(handler, delayMs)),
  clearTimeout: (handle) => {
    if (handle !== undefined) clearTimeout(handle);
  },
  setInterval: (handler, delayMs) => Number(setInterval(handler, delayMs)),
  clearInterval: (handle) => {
    if (handle !== undefined) clearInterval(handle);
  },
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};
