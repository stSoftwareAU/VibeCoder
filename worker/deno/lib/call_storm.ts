/**
 * Call-storm stall detection — the pure decision behind stopping a run that
 * polls instead of working (Issue #2230).
 *
 * GRQ-23 slot s2 spent a whole hour and ~700 billed turns watching a
 * background `deno task test`: the agent started the job, then checked on it
 * turn by turn — `pgrep`, `echo w9`, `tail`, `echo w252` — roughly 25 tool
 * calls a minute for twenty minutes, never changing one byte of the
 * checkout. Neither existing guard caught it: the no-output watchdog saw
 * output every second, and the progress extension (Issue #4290) only
 * *declined to extend*, which does nothing until the deadline arrives.
 *
 * A run making dozens of tool calls a minute with no working-tree change is
 * stalled by definition, so this module gives that shape a verdict the
 * runner can act on immediately, the same way a silent agent gets one.
 *
 * Pure: no I/O, no timers, no `Date.now()`. Every input is supplied by the
 * caller, so the rules are exhaustively unit-testable.
 *
 * The tree is the only progress signal read here, and that is deliberate.
 * Issue #508 made a descendant process burning CPU count as progress for the
 * *deadline* decision, because an agent supervising external work is
 * working — but polling that work turn by turn is still the wrong way to wait
 * for it, and is what costs a model turn a second. An agent that waits the
 * way the prompt tells it to, inside one bounded foreground command, issues
 * no tool calls at all while it waits, so it cannot trip this guard however
 * long the command takes.
 *
 * Fail-safe direction, deliberately the opposite of the extension policy's:
 * this guard *kills inside the budget*, so it fires only on affirmative
 * evidence. A tree probe that answers `unknown` never trips it — an
 * unverifiable tree is the deadline check's business (Issue #4294), not a
 * reason to stop a run early.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { TreeProgressState } from "./progress_extension.ts";

/**
 * Consecutive storm checks required before a run is stopped (Issue #2230).
 *
 * One window is a warning, not a verdict. Sixty calls in five minutes is
 * twelve a minute, and a read-heavy investigation — read the issue, grep the
 * repo, read what the grep found — can genuinely reach that before its first
 * edit. Two consecutive windows cannot: ten minutes of that rate with not one
 * byte changed is the poll loop, not the investigation. The incident this
 * guard exists for ran at ~25 calls a minute for twenty minutes, so it is
 * still stopped inside the second window.
 *
 * The verdict itself stays per-window — {@link decideCallStorm} answers "is
 * this window a storm?" — and the caller counts the consecutive ones, because
 * the streak is state and this module is pure.
 */
export const CALL_STORM_CONSECUTIVE_CHECKS = 2;

/** Tunables the guard reads. Mirrors the `call_storm_*` config keys. */
export interface CallStormPolicy {
  /** Off restores the pre-#2230 behaviour exactly: no early stop. */
  enabled: boolean;
  /** Sliding window the calls are counted over, in seconds. */
  windowSeconds: number;
  /** Calls inside the window at or above which the run is a storm. */
  callThreshold: number;
}

/** Everything the decision needs. */
export interface CallStormInput {
  /** Tool calls recorded inside the window. */
  toolCalls: number;
  /** The freshest working-tree verdict. */
  treeState: TreeProgressState;
  /**
   * Milliseconds since the working tree last advanced, measured from the run
   * start when it has never advanced.
   *
   * This is what makes the window whole: a run only a minute old, or one
   * that changed a file thirty seconds ago, has not gone a window without
   * progress and so cannot be storming yet.
   */
  treeUnchangedForMs: number;
  /** The most recent tool call, so the reason names the loop. */
  lastToolSummary?: string;
}

/** Stalled, with the reason an operator reads, or not. */
export type CallStormVerdict =
  | { stalled: false }
  | { stalled: true; reason: string };

/** The window in milliseconds, or 0 when the guard is off. */
export function callStormWindowMs(policy: CallStormPolicy): number {
  if (!policy.enabled) return 0;
  return policy.windowSeconds > 0 ? policy.windowSeconds * 1000 : 0;
}

/**
 * Decide whether the run is a call storm that advances nothing.
 *
 * Pure: same inputs, same verdict, no side effects.
 *
 * @param input - Call count over the window and the working-tree evidence.
 * @param policy - Enable flag, window and call threshold.
 * @returns A stalled verdict naming the loop, or not stalled.
 */
export function decideCallStorm(
  input: CallStormInput,
  policy: CallStormPolicy,
): CallStormVerdict {
  const windowMs = callStormWindowMs(policy);
  if (windowMs <= 0 || policy.callThreshold <= 0) return { stalled: false };
  // The window has to have been observed whole before it can be judged.
  if (input.treeUnchangedForMs < windowMs) return { stalled: false };
  if (input.toolCalls < policy.callThreshold) return { stalled: false };
  // Only an affirmative "unchanged" stops a run early: `advanced` is
  // progress, and `unknown` is unverifiable rather than stalled.
  if (input.treeState !== "unchanged") return { stalled: false };
  const last = input.lastToolSummary ? `; last: ${input.lastToolSummary}` : "";
  return {
    stalled: true,
    reason: `call storm: ${input.toolCalls} calls in ` +
      `${formatWindow(windowMs)}, tree unchanged${last}`,
  };
}

/** Compact window: 45s, 5m, 5m30s. */
function formatWindow(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}
