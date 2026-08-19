/**
 * Shared types for the label management modules.
 *
 * These types are consumed by label_cache.ts, label_operations.ts,
 * label_failure.ts, label_question_failure.ts, label_clarification.ts,
 * and label_planning_escalation.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { ClarityStatus, FailureCategory } from "./failure_diagnosis.ts";
import type { TimelineCache } from "./timeline_cache.ts";
import type { GitHubClient, Logger } from "../types.ts";

/** Injectable dependencies for testability. */
export interface LabelManagerDeps {
  /** gh CLI command runner. Defaults to runGhCommand. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * GitHub client used by `escalateToHuman` (Issue #2210). When omitted, a
   * lightweight client backed by `ghCommandFn` is constructed, so existing
   * `ghCommandFn`-only callers keep working.
   */
  ghClient?: GitHubClient;
  /** Logger for escalation diagnostics (Issue #2210). Defaults to a console logger. */
  logger?: Logger;
  /** Cache directory for label lists. */
  cacheDir?: string;
  /** Cache TTL in seconds. */
  cacheTtlSeconds?: number;
  /**
   * Optional issue-timeline cache (Issue #1673). When supplied, the
   * cached timeline entry for `(repo, issueNumber)` is invalidated
   * after a successful label add so subsequent label-author checks
   * see the new "labeled" event without stale cache hits.
   */
  timelineCache?: TimelineCache;
}

/** Label configuration. */
export interface LabelConfig {
  failedLabel: string;
  failedOnceLabel: string;
  /**
   * Worker-to-human handoff label (Issue #2031). Replaces the retired
   * `needsClarificationLabel`. The clarification flow now marks issues
   * with `needs-human` when the worker cannot proceed without input.
   */
  needsHumanLabel: string;
  planningLabel: string;
  questionLabel: string;
}

/** Default label configuration. */
export const DEFAULT_LABEL_CONFIG: LabelConfig = {
  failedLabel: "failed",
  failedOnceLabel: "failed-once",
  needsHumanLabel: "needs-human",
  planningLabel: "planning",
  questionLabel: "question",
};

/** Options for marking an issue as failed. */
export interface FailureOptions {
  repo: string;
  issueNumber: number;
  githubUser: string;
  failureMessage: string;
  clarityStatus?: ClarityStatus;
  diagnosticContext?: string;
  labels?: LabelConfig;
  workerFooter?: string;
}

/** Options for the unified failure handler. */
export interface HandleFailureOptions extends FailureOptions {
  maxInfraRetries?: number;
}

/** Result of handle_issue_failure — reports actions taken (caller handles git). */
export interface HandleFailureResult {
  markedAsFailed: boolean;
  markedAsFailedOnce: boolean;
  failureCategory: FailureCategory;
  isInfrastructure: boolean;
}

/** Options for handling question failure. */
export interface QuestionFailureOptions {
  repo: string;
  issueNumber: number;
  githubUser: string;
  failureMessage: string;
  labels?: LabelConfig;
  workerFooter?: string;
}

/** Options for posting clarifying questions. */
export interface ClarificationOptions {
  repo: string;
  issueNumber: number;
  githubUser: string;
  clarifyingQuestions: string;
  labels?: LabelConfig;
  workerFooter?: string;
}

/** Options for escalating to planning. */
export interface EscalationOptions {
  repo: string;
  issueNumber: number;
  githubUser: string;
  escalationReason?: string;
  labels?: LabelConfig;
  workerFooter?: string;
}
