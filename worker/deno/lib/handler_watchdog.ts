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
 * It also says which handler an agent run belongs to (Issue #2720). An
 * abandoned handler's agent must be terminated — and only that handler's:
 * killing every live agent took two unrelated issue-slot runs down with PR
 * Feedback on the laptop host. The dispatcher runs each handler inside
 * {@link runAsAgentRunOwner}; the runner stamps every agent it registers with
 * {@link currentAgentRunOwner}. The binding follows the async chain, not a
 * shared stack, so an issue slot running beside the maintenance lane is never
 * attributed to a handler. The owner also carries the work item the handler
 * noted, so the abandonment line can name the PR or comment abandoned.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** One handler dispatch that may own agent runs (Issue #2720). */
export interface AgentRunOwner {
  /** Unique per dispatch, e.g. `PR Feedback#3`. */
  readonly id: string;
  /** What the handler is working on, e.g. `owner/repo#740 review 123`. */
  workItem?: string;
}

const ownerStorage = new AsyncLocalStorage<AgentRunOwner>();
let ownerSequence = 0;

/** A fresh owner for one dispatch of the handler called `name`. */
export function newAgentRunOwner(name: string): AgentRunOwner {
  ownerSequence += 1;
  return { id: `${name}#${ownerSequence}` };
}

/** Run `fn` with every agent it starts owned by `owner`. */
export function runAsAgentRunOwner<T>(
  owner: AgentRunOwner,
  fn: () => Promise<T>,
): Promise<T> {
  return ownerStorage.run(owner, fn);
}

/** The owner of the current async chain, if any. */
export function currentAgentRunOwner(): AgentRunOwner | undefined {
  return ownerStorage.getStore();
}

/**
 * Record what the current owner is working on. A no-op outside an owner, so
 * the single-shot CLI processors can call it unconditionally.
 */
export function noteAgentRunWorkItem(workItem: string): void {
  const owner = ownerStorage.getStore();
  if (owner) owner.workItem = workItem;
}

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
  /**
   * Asked each time the hard timeout expires (Issue #2720): milliseconds to
   * re-arm it for, or `<= 0` to abandon the task. Absent, the first expiry
   * abandons it, as before. The caller owns the bound — the watchdog asks
   * again at every expiry, so a caller that never says `0` never abandons.
   */
  extend?: () => number;
}

/** Sentinel distinguishing the timeout branch from any task return value. */
const TIMEOUT: unique symbol = Symbol("watchdog-timeout");

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

  const arm = (ms: number) =>
    opts.delay(ms).then((): typeof TIMEOUT => TIMEOUT);
  // Armed before the task starts, as it always was.
  let timeoutPromise = arm(opts.hardTimeoutMs);
  const running = task();
  let raced: T | typeof TIMEOUT;
  for (;;) {
    raced = await Promise.race([running, timeoutPromise]);
    if (raced !== TIMEOUT) break;
    // Re-armed while the caller still sees progress (Issue #2720).
    const extendMs = opts.extend?.() ?? 0;
    if (extendMs <= 0) {
      opts.onTimeout?.();
      return { outcome: "timedout", durationMs: opts.now() - start };
    }
    timeoutPromise = arm(extendMs);
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
