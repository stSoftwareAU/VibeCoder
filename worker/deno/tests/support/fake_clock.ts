/**
 * A clock the test drives, instead of one it waits for.
 *
 * The replacement for a real deadline: a suite that needs
 * `runClaudeWithTimeout` to reach its hard timeout used to ask for a one- to
 * four-second budget and then *sleep* for it — 108 s across twenty-five files,
 * and a watchdog that wakes late on a loaded host reported as a correctness
 * failure. Hand the runner one of these instead and the deadline expires
 * because the test advanced the clock, which reads the same on an idle laptop
 * and on a host with nine other workers on it.
 *
 * Nothing here touches process state, and no timer it hands out is real, so a
 * file that uses it is parallel-safe on both counts.
 *
 * ## How to drive one
 *
 * Advance only once something has *proved* the run reached the state you want
 * to drive — the first `onActivity` chunk, an injected probe's first call, an
 * `onExtension` callback, or {@link FakeClock.nextArm}. {@link
 * FakeClock.advance} fires the timers that are armed when it is called; it
 * does not wait for one to appear, so advancing early simply does nothing and
 * the test hangs until the runner's own timeout fails it loudly.
 *
 * ## A zero delay is not a wait
 *
 * A timer armed for `0` ms fires on its own, on the next turn of the real
 * event loop, without the clock moving. That is what the global does and what
 * every caller means by it: `runClaudeWithRetry` with `initialWaitInterval: 0`
 * says "walk the fallback ladder without sleeping", and a fake clock that held
 * that sleep until someone advanced it would wedge the test rather than speed
 * it up. Every non-zero delay waits for {@link FakeClock.advance}.
 *
 * ```ts
 * const clock = fakeClock();
 * const firstChunk = Promise.withResolvers<void>();
 * const run = runClaudeWithTimeout({
 *   prompt: "test",
 *   agentBinaryPath: stub.path,
 *   timeoutSeconds: 1,
 *   clock,
 *   onActivity: () => firstChunk.resolve(),
 * });
 * await firstChunk.promise; // the child is up and the watchdog is armed
 * await clock.advance(1_000); // the deadline expires, now
 * const result = await run;
 * ```
 *
 * ## The stream drain is armed at spawn
 *
 * `runClaudeWithTimeout` arms its five-second post-settle stream drain
 * (Issue #325) the moment the child is spawned, not when the drain is
 * reached. A test that advances past five seconds therefore pre-expires it,
 * and the run keeps whatever stdout had arrived rather than waiting for the
 * pumps. Name a larger `streamDrainCapSeconds` — it is already a documented
 * test seam — in any case that advances that far and then asserts on output.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Clock, TimerHandle } from "../../lib/clock.ts";

/** One armed timer. */
interface Armed {
  dueMs: number;
  /** Set for `setInterval`; the gap it re-arms itself by. */
  everyMs?: number;
  handler: () => void;
  /** Arming order, so two timers due at the same instant fire in order. */
  seq: number;
}

/** A {@link Clock} whose time only moves when the test says so. */
export interface FakeClock extends Clock {
  /**
   * Move time forward by `ms`, firing every timer that falls due, in order.
   *
   * Microtasks are drained between two firings, so a handler's synchronous
   * tail and the promise chain it queues have run before the next timer is
   * considered. A step that needs real I/O in between — a child process
   * settling, a signal landing — needs two `advance` calls with a rendezvous
   * between them, because no amount of microtask draining waits for the
   * kernel.
   */
  advance(ms: number): Promise<void>;
  /** How many timers are armed right now. */
  readonly armed: number;
  /**
   * Resolves the next time a timer is armed.
   *
   * The general rendezvous for "the code under test has re-armed its
   * watchdog": take the promise *before* the advance that triggers the
   * re-arm, and await it after.
   */
  nextArm(): Promise<void>;
  /**
   * Resolves once a timer has been armed for exactly `delayMs`.
   *
   * The rendezvous for a run that produces no output at all, where there is
   * no chunk to wait on. Each of the runner's watchdogs has a delay only it
   * asks for — the silence watchdog takes `noOutputTimeout`, the hard
   * watchdog the remaining budget — so naming the delay names the watchdog,
   * and "the silence watchdog is up" stops being a guess about how long the
   * spawn takes. Already-armed timers count, so the order of the wait and the
   * arming does not matter.
   */
  armedFor(delayMs: number): Promise<void>;
}

/**
 * A fake epoch far enough from zero that a `Date`-shaped assertion still
 * reads sensibly, and fixed so two runs of the same test agree exactly.
 */
export const FAKE_CLOCK_EPOCH_MS = 1_760_000_000_000;

/**
 * How many timer firings one {@link FakeClock.advance} may perform.
 *
 * A repeating timer with a tiny period and a large advance would otherwise
 * spin forever; failing loudly names the test that asked for it.
 */
const MAX_FIRINGS_PER_ADVANCE = 10_000;

/** Microtask levels drained between two timer firings. */
const MICROTASK_DRAIN_LEVELS = 16;

/** Let every queued microtask — and the chain it queues — run. */
async function drainMicrotasks(): Promise<void> {
  for (let level = 0; level < MICROTASK_DRAIN_LEVELS; level++) {
    await Promise.resolve();
  }
}

/**
 * Create a clock whose time only moves when {@link FakeClock.advance} says so.
 *
 * @param startMs - The instant `now()` reads before any advance.
 * @returns A clock plus the controls to drive it.
 */
export function fakeClock(startMs: number = FAKE_CLOCK_EPOCH_MS): FakeClock {
  let nowMs = startMs;
  let nextHandle = 1;
  let seq = 0;
  const timers = new Map<TimerHandle, Armed>();
  let armWaiters: (() => void)[] = [];
  /** Delays armed so far, so `armedFor` cannot miss one it asked about late. */
  const armedDelays: number[] = [];
  const delayWaiters = new Map<number, (() => void)[]>();

  /** Fire `handle` now, re-arming it if it repeats. */
  const fire = (handle: TimerHandle): void => {
    const timer = timers.get(handle);
    if (timer === undefined) return;
    nowMs = Math.max(nowMs, timer.dueMs);
    if (timer.everyMs === undefined) timers.delete(handle);
    else timer.dueMs = nowMs + timer.everyMs;
    timer.handler();
  };

  const arm = (
    handler: () => void,
    delayMs: number,
    everyMs?: number,
  ): TimerHandle => {
    const handle = nextHandle++;
    // The globals clamp a negative or non-finite delay to zero; match them,
    // because `armHardWatchdog` computes a delay that can legitimately be
    // negative when the deadline has already passed.
    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
    timers.set(handle, {
      dueMs: nowMs + delay,
      ...(everyMs !== undefined ? { everyMs: Math.max(1, everyMs) } : {}),
      handler,
      seq: seq++,
    });
    // A zero delay is not a wait: fire it on the next turn of the real loop,
    // without moving the clock. `advance` may get there first, in which case
    // this finds the timer gone and does nothing.
    if (delay === 0) setTimeout(() => fire(handle), 0);
    armedDelays.push(delay);
    const forDelay = delayWaiters.get(delay);
    if (forDelay !== undefined) {
      delayWaiters.delete(delay);
      for (const resolve of forDelay) resolve();
    }
    const waiters = armWaiters;
    armWaiters = [];
    for (const resolve of waiters) resolve();
    return handle;
  };

  /** The next timer due at or before `limitMs`, earliest then oldest. */
  const nextDue = (limitMs: number): [TimerHandle, Armed] | undefined => {
    let best: [TimerHandle, Armed] | undefined;
    for (const entry of timers) {
      if (entry[1].dueMs > limitMs) continue;
      if (
        best === undefined ||
        entry[1].dueMs < best[1].dueMs ||
        (entry[1].dueMs === best[1].dueMs && entry[1].seq < best[1].seq)
      ) {
        best = entry;
      }
    }
    return best;
  };

  return {
    now: () => nowMs,
    setTimeout: (handler, delayMs) => arm(handler, delayMs),
    clearTimeout: (handle) => {
      if (handle !== undefined) timers.delete(handle);
    },
    setInterval: (handler, delayMs) => arm(handler, delayMs, delayMs),
    clearInterval: (handle) => {
      if (handle !== undefined) timers.delete(handle);
    },
    sleep: (delayMs) =>
      new Promise<void>((resolve) => {
        arm(resolve, delayMs);
      }),
    get armed() {
      return timers.size;
    },
    nextArm: () =>
      new Promise<void>((resolve) => {
        armWaiters.push(resolve);
      }),
    armedFor: (delayMs) =>
      armedDelays.includes(delayMs)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
          const waiting = delayWaiters.get(delayMs) ?? [];
          waiting.push(resolve);
          delayWaiters.set(delayMs, waiting);
        }),
    advance: async (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`advance needs a non-negative delta, got ${ms}`);
      }
      const target = nowMs + ms;
      for (let fired = 0;; fired++) {
        if (fired >= MAX_FIRINGS_PER_ADVANCE) {
          throw new Error(
            `fake clock fired ${MAX_FIRINGS_PER_ADVANCE} timers in one ` +
              `advance(${ms}) — a repeating timer is spinning; advance in ` +
              `smaller steps or clear it`,
          );
        }
        const due = nextDue(target);
        if (due === undefined) break;
        fire(due[0]);
        await drainMicrotasks();
      }
      nowMs = target;
      await drainMicrotasks();
    },
  };
}
