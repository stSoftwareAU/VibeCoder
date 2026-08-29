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
 * Issue #508 then narrowed the tree half of that rule. A tree delta is a
 * proxy for progress that fails precisely where the work is *external* to the
 * checkout: an agent supervising a job it started makes tool calls every few
 * seconds and changes not one byte while it waits, so it looked identical to
 * one that was spinning and was killed mid-flight. The tree is therefore one
 * of several progress signals rather than the only one — a descendant process
 * burning CPU (`descendant_progress.ts`) counts as work too.
 *
 * Rules encoded here:
 *
 *   - Extend only when the last tool call is inside the configured stall
 *     window **and** at least one progress signal holds: the working tree
 *     `advanced` since the previous check, or external work is `active`.
 *   - `unknown` (the probe failed) is **not** progress, for either signal. An
 *     unverifiable run dies on schedule rather than extending forever on a
 *     broken probe, and a signal that cannot be evaluated can never become a
 *     way to earn an extension by being unmeasurable.
 *   - A tree probe that answers `unknown` kills outright (Issue #4294),
 *     external evidence notwithstanding: the fail-safe direction is unchanged
 *     by #508, which only narrows what `unchanged` means.
 *   - Each grant moves the deadline a fixed increment from **now**, never
 *     from the original start, so a run that stalls dies within one
 *     increment of stalling.
 *   - There is no cap on `extensionsGranted` — #4290 accepted that
 *     deliberately, because the slot pool (#4177) bounds the blast radius to
 *     one slot. The counter is carried for logging and telemetry only.
 *   - There **is** a cap on wall-clock: the optional `ceilingMs` input
 *     (Issue #421) is the absolute epoch-ms the supervisor's own cap allows,
 *     less the shutdown reserve. A grant that would cross it is clamped to
 *     it — a run with 200 s of runway gets 200 s, not a full increment and
 *     not zero — and a run with no runway left is refused, so the worker's
 *     kill lands before `timeout` SIGTERMs the whole launcher. An undefined
 *     ceiling (CLI runs, tests, `VIBE_RUN_MAX_SECONDS=0`) is unbounded, as
 *     before. `run_hard_cap.ts` resolves it; the policy only reads it.
 *   - Every decision names the signal that decided it, because the operator
 *     reads that string in the worker log.
 *   - The tree is sampled every `checkSeconds` between deadline checks
 *     (Issue #4295), so `advanced` describes the last check window rather
 *     than the whole grant. `nextProgressCheckDelayMs()` says when to wake
 *     and `combineTreeEvidence()` folds the last sample into the verdict.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { DescendantActivityOutcome } from "./descendant_progress.ts";
import type { RunDeadlineReporter } from "./run_deadline.ts";
import type { RunBudgetNotice } from "./wind_down_notice.ts";
import type { WorktreeProgressOutcome } from "./worktree_progress.ts";

/** Working-tree outcome since the previous check (Issue #4294). */
export type TreeProgressState = WorktreeProgressOutcome;

/**
 * Progress happening outside the checkout since the previous check
 * (Issue #508) — today, a descendant process burning CPU.
 *
 * `unknown` means the probe could not answer and is never progress.
 */
export type ExternalProgressState = DescendantActivityOutcome;

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
  /**
   * External-work outcome since the previous check (Issue #508).
   *
   * Omitted when no external probe is wired — every caller before #508 — in
   * which case the decision reduces exactly to the tree rule it always was.
   */
  externalState?: ExternalProgressState;
  /** Extensions already granted on this run. */
  extensionsGranted: number;
  /**
   * Absolute epoch-ms past which no grant may move the deadline (Issue #421).
   *
   * The supervisor's wall-clock cap (`VIBE_RUN_MAX_SECONDS`) less the
   * shutdown reserve, resolved by `run_hard_cap.ts`. Undefined means the run
   * is uncapped — the CLI single-issue path, tests, and any host that
   * disabled the supervisor cap — and extensions behave exactly as they did
   * before this input existed.
   */
  ceilingMs?: number;
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
   * External-work probe over the agent's own process tree (Issue #508).
   *
   * Takes the agent's pid, which is only known once the child is spawned, so
   * the runner supplies it at call time. Same contract as `treeProbe`: it
   * must be bounded, and a rejection is read as `unknown`, which never earns
   * an extension. Absent — every caller before #508 — the decision reduces to
   * the tree rule exactly as it was.
   */
  externalProbe?: (agentPid: number) => Promise<ExternalProgressState>;
  /**
   * Where the wind-down notice goes when the run approaches the hard cap
   * (Issue #508).
   *
   * Injected so the runner writes no files itself: the runtime wiring points
   * it at the agent's checkout, and tests point it at an array. A sink that
   * throws is logged and ignored — telling the agent about its budget must
   * never decide whether the run lives.
   */
  onWindDown?: (notice: RunBudgetNotice) => Promise<void> | void;
  /**
   * Seconds of runway at or below which the wind-down notice is emitted
   * (Issue #508). Defaults to {@link DEFAULT_WIND_DOWN_SECONDS}.
   */
  windDownSeconds?: number;
  /**
   * Where each granted extension is reported (Issue #4297).
   *
   * Purely observational — the shutdown drain reads it to account for a
   * legitimately extended run as in-flight. A reporter that throws is logged
   * and ignored: telemetry must never decide whether a run lives.
   */
  onExtension?: RunDeadlineReporter;
  /**
   * Absolute epoch-ms ceiling for every grant on this run (Issue #421).
   *
   * Resolved once at run start from the supervisor's published cap
   * (`run_hard_cap.ts`). Absent means uncapped, which is what the CLI
   * single-issue path and the tests get.
   */
  ceilingMs?: number;
}

/** What the watchdog should do when the deadline expires. */
export type ProgressExtensionDecision =
  | { action: "extend"; newDeadlineMs: number; reason: string }
  | {
    action: "kill";
    reason: string;
    /**
     * Set when the kill is a scheduled release rather than a stall
     * (Issue #424, parent #397): the run was progressing and the
     * supervisor's hard cap simply left no runway. The runner carries this
     * to the failure reason so the issue comment says "cycle ended / hard
     * cap reached — WIP preserved" instead of blaming the issue for running
     * out of time. Absent means the run stalled inside its own budget: a
     * genuine timeout.
     */
    cause?: "hard-cap";
  };

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

/** An external-work verdict recorded by an interim check (Issue #508). */
export interface ExternalProgressSample {
  /** What that check saw. */
  outcome: ExternalProgressState;
  /** How long ago the check ran, in milliseconds. */
  ageMs: number;
}

/**
 * Fold an interim external sample into the verdict taken at the deadline
 * (Issue #508).
 *
 * The twin of {@link combineTreeEvidence}, and for the same reason: a
 * deadline landing moments after an interim check leaves the fresh probe a
 * near-zero window in which no descendant could plausibly have accumulated a
 * measurable second of CPU. Carrying the previous sample forward for one
 * check interval keeps the observed window a full interval wide.
 *
 * An `unknown` fresh reading is never overridden — an unmeasurable signal
 * must not earn an extension.
 *
 * @param fresh - The verdict probed at the deadline.
 * @param sample - The most recent interim sample, if any.
 * @param policy - Supplies the check interval that bounds a sample's life.
 * @returns The external state the decision should use.
 */
export function combineExternalEvidence(
  fresh: ExternalProgressState,
  sample: ExternalProgressSample | undefined,
  policy: ProgressExtensionPolicy,
): ExternalProgressState {
  if (fresh === "active") return fresh;
  if (fresh === "unknown") return fresh;
  const interval = progressCheckIntervalMs(policy);
  if (interval <= 0 || sample === undefined) return fresh;
  if (sample.outcome === "active" && sample.ageMs <= interval) return "active";
  return fresh;
}

/**
 * Decide whether an expired deadline may be extended.
 *
 * Pure: same inputs, same decision, no side effects.
 *
 * @param input - Clock, deadline and the progress signals.
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

  // The tree is one signal of several (Issue #508): an unchanged checkout is
  // a stall only when nothing is happening outside it either.
  const externalState = input.externalState;
  if (input.treeState !== "advanced" && externalState !== "active") {
    return {
      action: "kill",
      reason: externalState === undefined
        // No external probe wired — the pre-#508 wording, unchanged.
        ? `working tree unchanged despite tool activity ${idleSeconds}s ago`
        : `working tree unchanged and no descendant process doing work ` +
          `(external ${externalState}) despite tool activity ` +
          `${idleSeconds}s ago`,
    };
  }

  // From now, not from the original start: a run that stalls after this
  // grant dies within one increment of stalling.
  const grantedDeadlineMs = input.nowMs + policy.grantSeconds * 1000;
  const advancing = input.treeState === "advanced"
    ? "working tree advanced"
    : "a descendant process is doing work (working tree unchanged)";
  const progressing = `${advancing} and tool activity ${idleSeconds}s ago ` +
    `(within the ${policy.activityStallSeconds}s window)`;

  // The supervisor's cap bounds the wall clock (Issue #421). Applied last:
  // the two progress signals decide *whether* to extend, and the ceiling only
  // decides *how far*, so a stalled run is never rescued by having runway.
  if (input.ceilingMs !== undefined) {
    const runwayMs = input.ceilingMs - Math.max(input.nowMs, input.deadlineMs);
    if (runwayMs <= 0) {
      return {
        action: "kill",
        // A scheduled release, not a stall (Issue #424): both progress
        // signals held and only the wall clock stopped the run.
        cause: "hard-cap",
        reason: `run hard cap reached — no runway left before the supervisor ` +
          `terminates this run, so stopping now to preserve work in progress`,
      };
    }
    if (grantedDeadlineMs > input.ceilingMs) {
      return {
        action: "extend",
        newDeadlineMs: input.ceilingMs,
        reason: `${progressing} — grant clamped to the run hard cap: ` +
          `${seconds(runwayMs)}s of runway left, not the full ` +
          `${policy.grantSeconds}s`,
      };
    }
  }

  return {
    action: "extend",
    newDeadlineMs: grantedDeadlineMs,
    reason: progressing,
  };
}
