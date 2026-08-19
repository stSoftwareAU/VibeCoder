/**
 * Progress-extension policy — the pure decision behind the re-armable hard
 * deadline (Issue #4296, part of #4290).
 *
 * #4290 decided that the flat one-hour `claudeTimeout` kill for issue work
 * should become conditional: while the run shows **both** recent tool
 * activity (`agent_progress.ts`, Issue #4293) **and** real working-tree
 * change (`worktree_progress.ts`, Issue #4294), keep extending the deadline;
 * when either signal stops, kill exactly as today.
 *
 * This module is the decision itself and nothing else — no I/O, no timers,
 * no `Date.now()`. The clock is an input, so every rule is exhaustively
 * unit-testable with no subprocess and no repository.
 *
 * Rules encoded here:
 *
 *   - Extend only when the last tool call is inside the configured stall
 *     window **and** the working tree `advanced` since the previous check.
 *   - `unknown` (the probe failed) is **not** progress. An unverifiable run
 *     dies on schedule rather than extending forever on a broken probe.
 *   - Each grant moves the deadline a fixed increment from **now**, never
 *     from the original start, so a run that stalls dies within one
 *     increment of stalling.
 *   - There is no cap on `extensionsGranted` — #4290 accepted that
 *     deliberately, because the slot pool (#4177) bounds the blast radius to
 *     one slot. The counter is carried for logging and telemetry only.
 *   - Every decision names the signal that decided it, because the operator
 *     reads that string in the worker log.
 *   - The tree is sampled every `checkSeconds` between deadline checks
 *     (Issue #4295), so `advanced` describes the last check window rather
 *     than the whole grant. `nextProgressCheckDelayMs()` says when to wake
 *     and `combineTreeEvidence()` folds the last sample into the verdict.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { RunDeadlineReporter } from "./run_deadline.ts";
import type { WorktreeProgressOutcome } from "./worktree_progress.ts";

/** Working-tree outcome since the previous check (Issue #4294). */
export type TreeProgressState = WorktreeProgressOutcome;

/** Tunables the policy reads. Mirrors the `progress_extension_*` config keys. */
export interface ProgressExtensionPolicy {
  /** Off by default — the feature lands dark and is switched on deliberately. */
  enabled: boolean;
  /** Seconds each grant adds to the deadline, measured from now. */
  grantSeconds: number;
  /** A tool call older than this is no longer evidence of activity. */
  activityStallSeconds: number;
  /**
   * How often the working tree is sampled between deadline checks, in
   * seconds (Issue #4295).
   *
   * Omitted (or non-positive) keeps the original cadence: the tree is looked
   * at only when the deadline expires, so `advanced` describes the whole
   * grant. With an interval set, the sample window — and therefore how
   * quickly a stall is noticed — is bounded by the interval instead.
   */
  checkSeconds?: number;
}

/** Everything the decision needs, clock included. */
export interface ProgressExtensionInput {
  /** Current time, epoch-ms. */
  nowMs: number;
  /** Epoch-ms the run started. */
  startMs: number;
  /** The deadline currently armed, epoch-ms. */
  deadlineMs: number;
  /** Epoch-ms of the last tool call, or undefined when none has been seen. */
  lastToolCallAtMs?: number;
  /** Working-tree outcome since the previous check. */
  treeState: TreeProgressState;
  /** Extensions already granted on this run. */
  extensionsGranted: number;
}

/**
 * The runner's opt-in seam (Issue #4296).
 *
 * Absent from `RunClaudeOptions` — every caller other than issue work — the
 * hard watchdog stays the one-shot kill it has always been.
 */
export interface ProgressExtensionOptions {
  /** Policy tunables. `enabled: false` still yields the unchanged kill. */
  policy: ProgressExtensionPolicy;
  /**
   * Working-tree probe, injected so tests need no git repository.
   *
   * Must be bounded — the runner awaits it inside the deadline check, and a
   * probe that never resolves would hold the run open. `worktree_progress.ts`
   * bounds every git read for exactly this reason. A rejection is read as
   * `unknown`, which kills rather than extends.
   */
  treeProbe: () => Promise<TreeProgressState>;
  /**
   * Where each granted extension is reported (Issue #4297).
   *
   * Purely observational — the shutdown drain reads it to account for a
   * legitimately extended run as in-flight. A reporter that throws is logged
   * and ignored: telemetry must never decide whether a run lives.
   */
  onExtension?: RunDeadlineReporter;
}

/** What the watchdog should do when the deadline expires. */
export type ProgressExtensionDecision =
  | { action: "extend"; newDeadlineMs: number; reason: string }
  | { action: "kill"; reason: string };

/** Whole seconds, for operator-facing reason strings. */
function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

/**
 * The check interval in milliseconds, or 0 when the policy samples the
 * working tree at the deadline only (Issue #4295).
 *
 * @param policy - Enable flag and check interval.
 * @returns Interval in ms; 0 means "no interim sampling".
 */
export function progressCheckIntervalMs(
  policy: ProgressExtensionPolicy,
): number {
  if (!policy.enabled) return 0;
  const configured = policy.checkSeconds ?? 0;
  return configured > 0 ? configured * 1000 : 0;
}

/**
 * How long until the watchdog should next wake (Issue #4295).
 *
 * Pure. With a check interval configured the watchdog wakes on the interval
 * to sample the working tree, and on the deadline itself to decide — whichever
 * comes first. Without one the only wake is the deadline, exactly as #4296
 * shipped it.
 *
 * @param nowMs - Current time, epoch-ms.
 * @param deadlineMs - The deadline currently armed, epoch-ms.
 * @param policy - Enable flag and check interval.
 * @returns Milliseconds to wait, never negative.
 */
export function nextProgressCheckDelayMs(
  nowMs: number,
  deadlineMs: number,
  policy: ProgressExtensionPolicy,
): number {
  const untilDeadline = Math.max(0, deadlineMs - nowMs);
  const interval = progressCheckIntervalMs(policy);
  if (interval <= 0) return untilDeadline;
  return Math.min(untilDeadline, interval);
}

/** A working-tree verdict recorded by an interim check (Issue #4295). */
export interface TreeProgressSample {
  /** What that check saw. */
  outcome: TreeProgressState;
  /** How long ago the check ran, in milliseconds. */
  ageMs: number;
}

/**
 * Fold an interim sample into the verdict taken at the deadline (Issue #4295).
 *
 * Pure. The deadline can land moments after an interim check, leaving the
 * fresh probe a near-zero window in which nothing could plausibly have
 * changed. Carrying the previous sample forward for one check interval keeps
 * the observed window a full interval wide, so unlucky timing cannot kill a
 * run that demonstrably advanced.
 *
 * An `unknown` fresh probe is never overridden: an unverifiable tree dies on
 * schedule (Issue #4294), sample or no sample.
 *
 * @param fresh - The verdict probed at the deadline.
 * @param sample - The most recent interim sample, if any.
 * @param policy - Supplies the check interval that bounds a sample's life.
 * @returns The tree state the decision should use.
 */
export function combineTreeEvidence(
  fresh: TreeProgressState,
  sample: TreeProgressSample | undefined,
  policy: ProgressExtensionPolicy,
): TreeProgressState {
  if (fresh === "advanced") return fresh;
  if (fresh === "unknown") return fresh;
  const interval = progressCheckIntervalMs(policy);
  if (interval <= 0 || sample === undefined) return fresh;
  if (sample.outcome === "advanced" && sample.ageMs <= interval) {
    return "advanced";
  }
  return fresh;
}

/**
 * Decide whether an expired deadline may be extended.
 *
 * Pure: same inputs, same decision, no side effects.
 *
 * @param input - Clock, deadline and the two progress signals.
 * @param policy - Enable flag, grant increment and stall window.
 * @returns Extend with the new deadline, or kill — each with a reason
 *   naming the signal that decided it.
 */
export function decideProgressExtension(
  input: ProgressExtensionInput,
  policy: ProgressExtensionPolicy,
): ProgressExtensionDecision {
  if (!policy.enabled) {
    return { action: "kill", reason: "progress extension disabled" };
  }

  if (input.lastToolCallAtMs === undefined) {
    return { action: "kill", reason: "no tool activity recorded" };
  }

  const idleSeconds = seconds(input.nowMs - input.lastToolCallAtMs);
  if (idleSeconds > policy.activityStallSeconds) {
    return {
      action: "kill",
      reason:
        `tool activity stale (last tool call ${idleSeconds}s ago, window ` +
        `${policy.activityStallSeconds}s)`,
    };
  }

  if (input.treeState === "unknown") {
    // Fail-safe direction (Issue #4294): a probe that cannot answer is not
    // evidence of progress, so the run dies on schedule.
    return {
      action: "kill",
      reason: "working-tree probe returned unknown — progress unverifiable",
    };
  }

  if (input.treeState !== "advanced") {
    return {
      action: "kill",
      reason:
        `working tree unchanged despite tool activity ${idleSeconds}s ago`,
    };
  }

  return {
    action: "extend",
    // From now, not from the original start: a run that stalls after this
    // grant dies within one increment of stalling.
    newDeadlineMs: input.nowMs + policy.grantSeconds * 1000,
    reason:
      `working tree advanced and tool activity ${idleSeconds}s ago (within ` +
      `the ${policy.activityStallSeconds}s window)`,
  };
}
