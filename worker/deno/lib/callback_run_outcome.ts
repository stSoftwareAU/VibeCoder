/**
 * The structured run outcome published to post-run callbacks (Issue #1947).
 *
 * A callback consumer used to receive one outcome fact — `result`, and the
 * `exitCode` derived from it. A fleet archive built on that could only count
 * "failures": a run that raised a PR and then lost the push, a quality gate
 * that went red, a deliberate hand-back and a sub-minute claim refusal all
 * arrived as `failure`, and only a transcript could tell them apart.
 *
 * The worker already knows the difference at that point — {@link RunOutcome}
 * carries the six-way `kind` the release comment renders, the
 * {@link FailureCategory} the diagnosis produced, the phase that terminated
 * the run and the PR number when one exists. This module narrows those facts
 * to the small, stable summary the callback contract publishes.
 *
 * ```mermaid
 * flowchart LR
 *     O["RunOutcome<br/>(release comment)"] --> S["summariseRunOutcome"]
 *     F["result + phase + message<br/>(the loop's own facts)"] --> S
 *     S --> C["context.outcome<br/>kind / category / phase /<br/>failureClass / prNumber"]
 * ```
 *
 * Pure: no `Deno.*`, no network, no clock. Every member is **omitted when the
 * run could not supply it**, exactly as the rest of the callback context
 * behaves, so `"category" in outcome` is a truthful test rather than a value a
 * hook has to second-guess.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { FailureCategory } from "./failure_diagnosis.ts";
import { detectFailureCategory } from "./failure_diagnosis.ts";
import type { RunOutcome } from "./run_outcome.ts";
import { classifyRunFailure } from "./run_outcome_classifier.ts";

/** The six-way outcome label, as {@link RunOutcome} spells it. */
export type CallbackOutcomeKind = RunOutcome["kind"];

/**
 * What a run achieved, as a callback consumer sees it.
 *
 * Deliberately narrower than {@link RunOutcome}: the facts an archive counts
 * by, and nothing a hook would have to parse prose out of.
 */
export interface CallbackRunOutcome {
  /** What the run achieved — `pr`, `no_pr`, `no_pr_expected`, … */
  kind: CallbackOutcomeKind;
  /** Diagnosed failure category; present only for a `no_pr` failure. */
  category?: FailureCategory;
  /** Phase that terminated the run, when one is known. */
  phase?: string;
  /** Classifier slug for a failure (`usage-limit`, `agent-outcome`, …). */
  failureClass?: string;
  /** PR the run is attached to, when one exists. */
  prNumber?: number;
}

/**
 * Phase named for a failure the pipeline never got far enough to phase itself
 * — a claim rejected, a setup step refused before any outcome was computed.
 */
export const PRE_RUN_FAILURE_PHASE = "claim";

/** What the callback layer knows about one terminal run. */
export interface RunOutcomeSummarySource {
  /** The run's own result — the one fact always known. */
  result: "success" | "failure";
  /** What the run computed, when it computed one. */
  outcome?: RunOutcome;
  /**
   * Phase that terminated the run, from the loop's own bookkeeping. Used when
   * the outcome names no phase of its own (a `pr` outcome whose later step
   * failed), and as the phase of a failure that produced no outcome at all.
   */
  phase?: string;
  /** Raw failure message, for a failure that produced no outcome. */
  message?: string;
}

/** Drop the members the run could not supply. */
function compact(outcome: CallbackRunOutcome): CallbackRunOutcome {
  return Object.fromEntries(
    Object.entries(outcome).filter(([, value]) => value !== undefined),
  ) as unknown as CallbackRunOutcome;
}

/** The classifier's slug for a diagnosed failure. */
function failureClassFor(category: FailureCategory, message: string): string {
  return classifyRunFailure(category, message).failureClass;
}

/**
 * Narrow one terminal run to the outcome block the callback contract
 * publishes.
 *
 * - a run with an outcome → that outcome's `kind`, plus whichever of
 *   `category`, `phase`, `failureClass` and `prNumber` it actually carries;
 * - a **failure** with no computed outcome — a claim rejected, a setup step
 *   refused before the pipeline ran — → `no_pr` with the message diagnosed,
 *   so a sub-minute refusal is distinguishable from an agent run rather than
 *   vanishing into a bare `result: "failure"`;
 * - a success with no computed outcome → `undefined`, because nothing is
 *   known beyond `result` and a guess would be worse than an omission.
 */
export function summariseRunOutcome(
  source: RunOutcomeSummarySource,
): CallbackRunOutcome | undefined {
  const outcome = source.outcome;
  if (!outcome) {
    if (source.result === "success") return undefined;
    const message = source.message ?? "";
    const category = detectFailureCategory(message);
    return compact({
      kind: "no_pr",
      category,
      phase: source.phase ?? PRE_RUN_FAILURE_PHASE,
      failureClass: failureClassFor(category, message),
    });
  }

  switch (outcome.kind) {
    case "pr":
      // The `pr` outcome names no phase of its own: it is the PR that matters.
      // A run that raised a PR and then lost a later step still failed
      // somewhere, so the loop's phase is published when it has one.
      return compact({
        kind: "pr",
        phase: source.phase,
        prNumber: outcome.prNumber,
      });
    case "no_pr":
      return compact({
        kind: "no_pr",
        category: outcome.category,
        phase: outcome.phase,
        failureClass: failureClassFor(outcome.category, outcome.message),
      });
    case "no_pr_expected":
      return compact({ kind: "no_pr_expected", phase: outcome.phase });
    case "superseded":
      return compact({
        kind: "superseded",
        phase: outcome.phase,
        prNumber: outcome.prNumber,
      });
    case "summary_incomplete":
      return compact({
        kind: "summary_incomplete",
        phase: outcome.phase,
        prNumber: outcome.prNumber,
      });
    case "claim_stale":
      return compact({
        kind: "claim_stale",
        phase: outcome.phase,
        prNumber: outcome.prNumber,
      });
  }
}
