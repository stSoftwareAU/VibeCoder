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
 *     C -->|"account state: rate limit,<br/>out of credit, interrupted,<br/>scheduled release, deadline-bound timeout<br/>host state: OOM, full disk,<br/>crash, missing tools, external kill"| T["transient:<br/>flat 600 s cooldown,<br/>no attempt consumed"]
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
 * Two groups, both of which would blame the issue for something that is not
 * the issue:
 *
 * - **Account state** — `usage-limit`, `interrupted` and `scheduled-release`
 *   are the three the issue names; `out-of-credit` is the same account-state
 *   bucket the classifier puts beside `usage-limit`, and permanently failing
 *   an issue because the account ran out of credit would blame the issue for
 *   the fleet's billing.
 * - **Host state** — a full disk, an OOM kill, a crashed worker, a tool
 *   missing from the image and an unexplained external kill are the host's
 *   fault. The run-outcome auto-filer (Issue #4329) already files those
 *   against the *worker*, so making them consume the issue's two attempts
 *   would permanently sideline a perfectly good issue after two host
 *   incidents.
 */
const TRANSIENT_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "usage-limit",
  "interrupted",
  "scheduled-release",
  "out-of-credit",
  "disk-full",
  "oom",
  "killed-unknown",
  "worker-crash",
  "missing-tools",
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

/** One finished coding run, as the main loop sees it. */
export interface CodingRunOutcomeSummary {
  success: boolean;
  /** A phase declared its own bounce (Issue #175) — not a failure. */
  expectedSkip: boolean;
  /** The terminal failure reason, when the run failed. */
  reason: string;
  /** A phase already stepped the ladder for this run (Issue #1949). */
  ladderApplied?: boolean;
}

/** What the main loop must do about a finished coding run. */
export interface CodingFailurePlan {
  /** Whether the caller must step the ladder itself. */
  applyLadder: boolean;
  /** Cooldown kind to record; absent for a success, a skip or a transient. */
  cooldownKind?: CooldownFailureKind;
  /** The classification, absent when the run did not terminally fail. */
  decision?: CodingFailureDecision;
}

/**
 * Decide what the main loop owes a finished coding run.
 *
 * Pure, so the wiring the reported defect lives in is testable without a
 * GitHub client or a worker configuration. A run whose ladder a phase
 * already stepped always counts as an attempt — the phase judged it worth a
 * step, so the cooldown must agree even when the run's *final* reason reads
 * as transient (a quality-gate failure followed by a rate-limited retry).
 */
export function planCodingFailure(
  run: CodingRunOutcomeSummary,
): CodingFailurePlan {
  if (run.success || run.expectedSkip) return { applyLadder: false };

  const decision = classifyCodingFailure(run.reason);
  if (run.ladderApplied) {
    return {
      applyLadder: false,
      cooldownKind: decision.cooldownKind ?? "non_transient",
      decision,
    };
  }

  return {
    applyLadder: decision.disposition === "ladder",
    ...(decision.cooldownKind ? { cooldownKind: decision.cooldownKind } : {}),
    decision,
  };
}

/** The hand-off copy for an issue that has used up its retries. */
export interface RepeatedFailureEscalation {
  heading: string;
  reason: string;
  nextStep: string;
}

/**
 * Wording for the `needs-human` hand-off after three consecutive ladder
 * failures inside the escalation window.
 *
 * A timeout keeps the Issue #4304 wording — the operator's next step really
 * is a budget or a split. Every other non-transient failure gets wording
 * that points at the per-attempt failure comments instead (Issue #1949),
 * because nothing about it says the run ran out of time.
 */
export function buildRepeatedFailureEscalation(
  failureKind: CooldownFailureKind,
  attempts: number,
): RepeatedFailureEscalation {
  if (failureKind === "timeout") {
    return {
      heading: "Repeated execute timeouts",
      reason: `This issue has now failed ${attempts} times in a row within ` +
        `48 h, the latest by timing out — each attempt burned a full agent ` +
        `run and produced no changes. The worker has stopped retrying ` +
        `(24 h escalating cooldown, Issue #4304).`,
      nextStep:
        "Split the issue into smaller pieces, raise its timeout budget, or " +
        "investigate why the agent cannot finish it (see the worker logs for " +
        "the per-attempt progress lines).",
    };
  }
  return {
    heading: "Repeated run failures",
    reason: `This issue has now failed ${attempts} times in a row within ` +
      `48 h for non-transient reasons — no pull request was raised by any ` +
      `attempt. The worker has stopped retrying (24 h escalating cooldown, ` +
      `Issue #1949).`,
    nextStep:
      "Review the per-attempt failure comments on this issue and either " +
      "clarify the requirements or close it — the worker will not re-claim " +
      "it until the failure labels are cleared.",
  };
}
