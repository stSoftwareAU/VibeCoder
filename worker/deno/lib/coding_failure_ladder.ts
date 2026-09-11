/**
 * Terminal coding-run failure disposition (Issue #1949).
 *
 * The planning and question processors have always routed their failures
 * through `handleIssueFailure` — the `failed-once` → `failed` ladder that
 * writes a diagnostic comment and, on the second failure, takes the issue
 * out of discovery entirely. The ordinary *coding* path never did. Every
 * failure there recorded a flat 600 s cooldown and nothing else, so an
 * issue that failed in 40 seconds was fully eligible again six minutes
 * later and was re-claimed every cycle for ever: a weekly fleet review
 * found three findings in one repository claimed 82 times in seven days.
 *
 * This module is the single decision point that fixes it. It answers one
 * question about a terminal failure reason — *is this transient
 * infrastructure, or is it the issue?* — and applies the ladder when it is
 * the issue.
 *
 * ```mermaid
 * flowchart TD
 *     F["Coding run fails"] --> C{"classifyCodingFailure"}
 *     C -->|"rate limit / interrupted /<br/>scheduled release / out of credit /<br/>deadline-bound timeout"| T["transient:<br/>flat 600 s cooldown,<br/>no attempt consumed"]
 *     C -->|"anything else"| L["ladder:<br/>failed-once → failed<br/>+ escalating cooldown"]
 *     L --> L1["1st: failed-once,<br/>2 h cooldown, retried once"]
 *     L1 --> L2["2nd: failed,<br/>excluded from discovery"]
 * ```
 *
 * Pure classification (`classifyCodingFailure`) is separated from the side
 * effect (`applyCodingFailureLadder`) so the policy is testable without a
 * GitHub client.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { CooldownFailureKind } from "./cooldown_state.ts";
import {
  DEADLINE_BOUND_TIMEOUT_MARKER,
  detectFailureCategory,
  type FailureCategory,
  isTimeoutClassFailureReason,
} from "./failure_diagnosis.ts";
import { classifyRunFailure } from "./run_outcome_classifier.ts";
import type { handleIssueFailure } from "./label_failure.ts";
import type {
  HandleFailureOptions,
  HandleFailureResult,
  LabelConfig,
} from "./label_types.ts";

/** What a terminal coding-run failure earns. */
export type CodingFailureDisposition =
  /** Transient infrastructure — today's plain cooldown, no attempt consumed. */
  | "transient"
  /** The issue's own failure — `failed-once` → `failed` plus the ladder. */
  | "ladder";

/** The decision for one terminal coding-run failure. */
export interface CodingFailureDecision {
  disposition: CodingFailureDisposition;
  /** The diagnosed category the decision was taken from. */
  category: FailureCategory;
  /** The `run_outcome_classifier` class slug (`usage-limit`, `timeout`, …). */
  failureClass: string;
  /** Cooldown kind to record; `undefined` for a transient failure. */
  cooldownKind?: CooldownFailureKind;
  /** One short sentence naming the evidence that decided it. */
  rationale: string;
}

/**
 * The failure classes that are transient infrastructure, never the issue.
 *
 * `usage-limit`, `interrupted` and `scheduled-release` are the three the
 * issue names; `out-of-credit` is the same account-state bucket the
 * classifier puts beside `usage-limit`, and permanently failing an issue
 * because the account ran out of credit would blame the issue for the
 * fleet's billing.
 */
const TRANSIENT_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "usage-limit",
  "interrupted",
  "scheduled-release",
  "out-of-credit",
]);

/**
 * Decide what a terminal coding-run failure earns.
 *
 * `unknown` is deliberately NOT transient. The safe default for auto-filing
 * a worker defect is silence, but the safe default here is the opposite:
 * an unexplained failure that keeps happening is exactly the shape this
 * exists to stop, and the ladder still gives it a second attempt before the
 * issue leaves discovery.
 *
 * @param reason - The terminal failure reason the run produced.
 */
export function classifyCodingFailure(
  reason: string | undefined | null,
): CodingFailureDecision {
  const message = reason ?? "";
  const category = detectFailureCategory(message);
  const { failureClass, rationale } = classifyRunFailure(category, message);

  // A deadline-bound timeout (VibeCoder#174) is a handover, not a defeat:
  // the cycle ended with the WIP committed, so the next cycle resumes it.
  // Checked before the class table because its category is `timeout`.
  if (message.includes(DEADLINE_BOUND_TIMEOUT_MARKER)) {
    return {
      disposition: "transient",
      category,
      failureClass,
      rationale:
        "The run was bound by the cycle deadline with its work preserved (VibeCoder#174) — the next cycle resumes it.",
    };
  }

  if (TRANSIENT_FAILURE_CLASSES.has(failureClass)) {
    return { disposition: "transient", category, failureClass, rationale };
  }

  return {
    disposition: "ladder",
    category,
    failureClass,
    // A timeout keeps its own kind so the fleet telemetry and the
    // timeout-specific hand-off wording stay accurate (Issue #4304).
    cooldownKind: isTimeoutClassFailureReason(message)
      ? "timeout"
      : "non_transient",
    rationale,
  };
}

/** What to tell the ladder about a failed coding run. */
export interface CodingFailureLadderOptions {
  repo: string;
  issueNumber: number;
  githubUser: string;
  /** The terminal failure reason the run produced. */
  failureReason: string;
  /** The phase the run died at (`execute`, `quality_gate`, …), if known. */
  failurePhase?: string;
  /** Configured label names; defaults apply when absent. */
  labels?: LabelConfig;
}

/** Injection seam for {@link applyCodingFailureLadder}. */
export interface CodingFailureLadderDeps {
  handleIssueFailure: typeof handleIssueFailure;
}

/** What {@link applyCodingFailureLadder} did. */
export interface CodingFailureLadderOutcome {
  decision: CodingFailureDecision;
  /** The ladder's result; absent when the failure was transient or errored. */
  ladder?: HandleFailureResult;
  /**
   * Why the ladder could not be applied. The run has already failed and its
   * claim still has to be released, so the caller logs this rather than
   * throwing — but it is never discarded silently.
   */
  error?: Error;
}

/**
 * Apply the `failed-once` → `failed` ladder to a terminal coding failure.
 *
 * A transient failure returns without touching GitHub, so it keeps today's
 * plain cooldown and consumes no attempt.
 */
export async function applyCodingFailureLadder(
  options: CodingFailureLadderOptions,
  deps: CodingFailureLadderDeps,
): Promise<CodingFailureLadderOutcome> {
  const decision = classifyCodingFailure(options.failureReason);
  if (decision.disposition === "transient") return { decision };

  const diagnosticContext = [
    options.failurePhase ? `phase=${options.failurePhase}` : "",
    `failure_class=${decision.failureClass}`,
  ].filter((part) => part.length > 0).join(";");

  const failureOptions: HandleFailureOptions = {
    repo: options.repo,
    issueNumber: options.issueNumber,
    githubUser: options.githubUser,
    failureMessage: options.failureReason,
    diagnosticContext,
    ...(options.labels ? { labels: options.labels } : {}),
  };

  try {
    const result: Result<HandleFailureResult> = await deps.handleIssueFailure(
      failureOptions,
    );
    if (!result.ok) return { decision, error: result.error };
    return { decision, ladder: result.value };
  } catch (err) {
    return {
      decision,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
