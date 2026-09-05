/**
 * Shared types for the issue worker phase pipeline.
 *
 * These types flow between the orchestrator in issue_worker.ts and
 * the individual phase modules under lib/phases/. Keeping them in a
 * separate file avoids circular imports between the orchestrator and
 * each phase module (Issue #1527).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { RunOutcome } from "./run_outcome.ts";
import type { WorkerConfig } from "../types.ts";
import type { HeartbeatHandle } from "./heartbeat.ts";
import type { SessionResumeState } from "./session_resume.ts";
import type { GenericFinding } from "./baseline_gate.ts";
import type { BumpInfo } from "./bump_deps.ts";
import type { PhaseClaudeResult } from "./phase_run_stats.ts";
import type { MemoryPressureReading } from "./memory_pressure.ts";
import type { ExtensionTelemetry } from "./timeout_extension_telemetry.ts";
import type { PreservedWip } from "./preserved_wip_branch.ts";
// Lost in the 1f2c10e merge into this milestone branch, leaving `deno check`
// red on a type this file still uses (added by Issue #806).
import type { CallbackRunTelemetry } from "./run_callbacks.ts";

/** Data shared across phases within a single workOnIssue invocation. */
export interface IssueContext {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueLabels: string[];
  issueComments: string;
  /**
   * Boundary id whose per-comment headers inside `issueComments` are genuine
   * (Issue #3637). Set when `issueComments` came from
   * `prepareTrustAnnotatedComments`; absent for raw comment formatting. Prompt
   * builders use it to keep genuine trust headers intact through their own
   * sanitiser pass, so a forged header stays distinguishable.
   */
  commentBoundaryId?: string;
  githubUser: string;
  milestoneTitle?: string;
  /** Milestone number (API ID) for session branching (Issue #1322). */
  milestoneNumber?: number;
  config: WorkerConfig;
  /**
   * Epoch-millisecond deadline of the current run cycle (Issue #4254).
   * When set, the execute phase bounds its Claude timeout so a claim taken
   * late in the cycle cannot run a full `claudeTimeout` past the planned
   * shutdown — one stuck run used to stretch a 3 h 46 m cycle to 11 h 30 m.
   * Absent (tests, CLI single-issue runs): the configured timeout stands.
   */
  cycleDeadlineEpochMs?: number;
  /**
   * Epoch-millisecond deadline at which the dispatch watchdog will abandon the
   * handler running this issue (Issue #58). Set by the priority dispatcher from
   * the very budget the watchdog arms, so the two cannot drift. Consumed by
   * post-publication work (the Failure-Detection self-repair) to stop cleanly
   * and defer what it cannot finish, instead of being killed mid-way. Absent
   * (tests, CLI single-issue runs): that work is unbounded, as before.
   */
  handlerDeadlineEpochMs?: number;
  /**
   * Absolute host path of the operator's custom prompt template (Issue #848,
   * part of #843). Set when a `custom_label_prompts` label dispatched this
   * run: the execute phase builds the prompt from that file instead of the
   * built-in `prompts/issue/` template, with everything else — the untrusted
   * fences, the boundary-integrity instruction, the branch/commit/PR flow —
   * unchanged. Absent for every other route, which behaves exactly as before.
   */
  customPromptPath?: string;
  /** The custom label that dispatched this run, named in errors (Issue #848). */
  customPromptLabel?: string;
  /**
   * Stable id of the lane running this issue (Issue #923) — `s1`, `s2`, or
   * `serial`. The setup phase gives the lane its own git worktree off the
   * shared clone, so two slots working one repository never share a working
   * tree, `HEAD`, the index, a Claude session or resume state. Absent (CLI
   * single-issue runs, tests): the shared clone, exactly as before.
   */
  laneId?: string;
}

/** Mutable state set by early phases, consumed by later phases. */
export interface PhaseState {
  branchName: string;
  baseBranch: string;
  defaultBranch: string;
  milestoneBranch?: string;
  repoPath: string;
  clarityStatus: "not_assessed" | "skipped" | "assessed_clear";
  claudeOutput: string;
  executeStartTime: number;
  baselineQualityPassed: boolean;
  baselineQualityOutput: string;
  /**
   * Check-agnostic diffable findings captured during the baseline quality
   * check (Issue #2604). Populated by `workOnIssueBaselineQuality` and
   * consumed by the post-Claude quality gate to compute a generic
   * baseline-aware bypass across mermaid, markdownlint, and the docs
   * prompt-version check. `undefined` when baseline capture was not
   * attempted; an empty array when no diffable findings were present.
   */
  baselineGateFindings?: GenericFinding[];
  /**
   * Seconds the baseline quality gate took on this repository this run
   * (Issue #1138). The execute phase quotes it in the agent's quality
   * instructions, so the agent can weigh the gate against the run budget it
   * has left instead of against a fleet-wide assumption. `undefined` when the
   * gate did not actually run — a reused baseline or a gate that errored has
   * no duration to report.
   */
  baselineQualityDurationSeconds?: number;
  /**
   * Outcome of the per-repo `bump-deps.sh` phase (Issue #1613). Set by
   * `workOnIssueBumpDeps`. Consumed by the quality-gate audit (which
   * may flip the status to `rejected_by_audit`) and by the completion
   * phase, which posts a PR comment when the bump was rejected.
   */
  bumpInfo?: BumpInfo;
  heartbeatHandle?: HeartbeatHandle;
  /** Session resume state for CLI-level session continuity (Issue #1324). */
  sessionResumeState?: SessionResumeState;
  /**
   * True when setup resumed the issue branch from a prior attempt's WIP
   * checkpoint (Issue #4170). The execute phase tells the agent prior
   * progress exists so it continues rather than restarting.
   */
  resumedFromCheckpoint?: boolean;
  /**
   * Handover the interrupted run committed to the resumed branch (Issue #771),
   * as read from the checked-out tree by the setup phase. The execute phase
   * splices it into the prompt; absent when the branch carries no handover
   * file, which is every branch preserved before #769 shipped.
   */
  handoverNote?: string;
  /**
   * HEAD SHA captured immediately before the agent ran (Issue #148).
   *
   * The completion phase compares it with the branch tip to answer "did this
   * run advance the branch?" — a resumed claim that adds nothing must not
   * raise a PR from an earlier run's WIP commits alone. Absent when Claude
   * never ran or the capture failed; the gate then fails open.
   */
  executeStartHeadSha?: string;
  /**
   * Per-phase in-process infrastructure retry counter (Issue #1550).
   *
   * Tracks how many times each phase has already been retried in-process for
   * an infrastructure-category failure within the current workOnIssue
   * invocation. Each phase is capped at one retry — see `infra_retry.ts`.
   */
  infraRetryCounts?: Record<string, number>;
  /**
   * Memory-pressure reading taken when the execute run was SIGKILLed
   * (Issue #4374). Set by the killed branch of the execute phase for the
   * most recent attempt; the #1550 retry wrapper refuses to retry a kill
   * whose reading is `high` — the retry re-runs the same workload into the
   * same memory. Cleared at the start of each attempt.
   */
  lastKillMemoryPressure?: MemoryPressureReading;
  /**
   * What the re-armable deadline did to the execute run (Issue #768). Set by
   * the timeout branch of the execute phase, and carried onto the run outcome
   * so the claim-release comment names the extensions granted and why the
   * last check was refused. Absent when the progress extension was not
   * active for the run.
   */
  extensionTelemetry?: ExtensionTelemetry;
  /**
   * Completed Claude invocations from the execute phase (Issue #3756).
   *
   * A `work-on` issue is auto-closed by its merged PR with no worker attached,
   * so the cost/model stats comment is posted at PR-raise time instead. The
   * execute phase records each invocation here (there can be more than one —
   * the #1550 infrastructure retry re-runs it) and the completion phase posts
   * the aggregate. Absent when Claude never ran.
   */
  claudeRunStats?: PhaseClaudeResult[];
  /**
   * The PR this run raised or recovered (Issue #4325): set by the
   * completion phase so the run outcome can name it at claim release.
   */
  prUrl?: string;
  prNumber?: number;
  /**
   * Where an interrupted run's work was preserved (Issue #770). Set by
   * `preserveRunWip` only when the work is genuinely on the pushed branch, and
   * read at claim release so the comment names that branch (and the handover
   * file on it) instead of a generic "WIP preserved".
   */
  preservedWip?: PreservedWip;
  /**
   * Short facts to state on the claim-release comment (Issue #210) —
   * currently a follow-up reference the agent named that does not exist.
   * Attached to whatever outcome the run produced, so a human sees the
   * mistake even on a run that raised a PR.
   */
  releaseNotes?: string[];
}

/**
 * Record an execute-phase Claude invocation on the phase state for the
 * end-of-issue cost/model stats comment (Issue #3756).
 *
 * Copies only the stats-bearing fields so the (potentially large) Claude output
 * is not retained for the lifetime of the run.
 */
export function recordClaudeRunStats(
  state: PhaseState,
  result: PhaseClaudeResult,
): void {
  const entry: PhaseClaudeResult = {
    ...(result.runStats ? { runStats: result.runStats } : {}),
    ...(result.fallbackModel ? { fallbackModel: result.fallbackModel } : {}),
    ...(result.preflightDegraded
      ? {
        preflightDegraded: true,
        ...(result.preflightDegradedReason
          ? { preflightDegradedReason: result.preflightDegradedReason }
          : {}),
      }
      : {}),
    // Extension telemetry (Issue #4298) — the per-issue stats comment reports
    // how often the re-armable deadline fired.
    ...(result.extensions ? { extensions: result.extensions } : {}),
  };
  state.claudeRunStats = [...(state.claudeRunStats ?? []), entry];
}

/** Result code from a phase function. */
export type PhaseResult =
  | { status: "continue" }
  | {
    status: "early_exit";
    reason: string;
    /**
     * The phase ended the run without resolving the issue and without
     * failing (Issue #175) — a bounce. The orchestrator reports it as
     * {@link WorkOnIssueResult.expectedSkip} so the main loop cools the
     * issue down instead of counting it as a processed issue.
     */
    expectedSkip?: boolean;
    /**
     * Outcome the phase determined for itself (Issue #218) — used by the
     * superseded-by-a-merged-PR stop, whose outcome cannot be derived from
     * `success`/`reason` alone. The orchestrator carries it through to the
     * claim-release comment unchanged; absent, the outcome is derived as
     * before.
     */
    outcome?: RunOutcome;
    /**
     * The phase stopped because the claim was **refused** (Issue #1193), so
     * this run holds nothing to release. The fleet shares one GitHub login,
     * so releasing anyway strips the winner's assignee and clears its live
     * heartbeat marker. The orchestrator carries it out on
     * {@link WorkOnIssueResult.claimNotHeld}.
     */
    claimNotHeld?: true;
  }
  | { status: "failure"; reason: string };

/** Result of the full workOnIssue orchestration. */
export interface WorkOnIssueResult {
  success: boolean;
  phase: string;
  reason: string;
  timings: Record<string, number>;
  /**
   * What the run achieved — PR link, failure diagnosis, or a deliberate
   * no-PR — for the claim-release comment (Issue #4325, part of #4291).
   */
  outcome?: RunOutcome;
  /**
   * The run neither resolved the issue nor failed (Issue #175): a
   * deliberate bounce, such as a merged-PR pre-check that cannot close the
   * issue because the merge never landed. The main loop treats it as a
   * skip — cooldown recorded, no failure tracking, not counted in
   * `WORKER_SUMMARY` — so one unresolvable issue cannot livelock the pool.
   */
  expectedSkip?: boolean;
  /**
   * Token and cost telemetry summed across the run's agent invocations
   * (Issue #806), for the post-run callback context. Absent when no
   * invocation reported usage the worker could parse.
   */
  telemetry?: CallbackRunTelemetry;
  /**
   * The setup phase was refused the claim (Issue #1193): another host holds
   * the issue, so this run has nothing to release. The main loop passes it
   * to `releaseIssueClaim`, which then releases nothing — without it the
   * refused host unassigns the **winner** (one shared login) and clears the
   * winner's heartbeat marker, leaving a live run claimable by a third host.
   */
  claimNotHeld?: boolean;
}

/**
 * Whether a work result is a skip rather than a failure (Issue #175).
 *
 * A skip cools the issue down and is left out of the processed-issue count,
 * but never trips failure tracking or the circuit breaker. Two shapes qualify:
 *
 * - a phase that declared its own bounce via {@link WorkOnIssueResult.expectedSkip}
 *   — the merged-PR pre-check that cannot close an issue whose merge never
 *   landed; and
 * - the setup phase's claim rejections, which mean another worker holds the
 *   issue (or the claim churned) rather than that anything went wrong.
 */
export function isExpectedSkipResult(
  result: Pick<WorkOnIssueResult, "success" | "phase" | "reason"> & {
    expectedSkip?: boolean;
  },
): boolean {
  if (result.success) return false;
  if (result.expectedSkip === true) return true;
  return result.phase === "setup" &&
    (result.reason.startsWith("Issue not available:") ||
      result.reason === "claim_churn_escalation");
}
