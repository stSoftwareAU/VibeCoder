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
  | { status: "early_exit"; reason: string }
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
}
