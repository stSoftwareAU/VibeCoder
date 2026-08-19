/**
 * GitHub label management and issue failure handling for the Vibe Coder worker.
 *
 * This module is now a barrel re-export over focused sub-modules (Issue #1528):
 *   - `label_types.ts`               — shared types and default config
 *   - `label_cache.ts`               — per-repo label cache (Issue #333)
 *   - `label_operations.ts`          — add label / ensure label exists
 *   - `label_failure.ts`             — failed-once / failed marking + handler
 *   - `label_question_failure.ts`    — question answering failure path
 *   - `label_clarification.ts`       — clarification workflow
 *   - `label_planning_escalation.ts` — planning escalation detection + post
 *
 * External callers may continue to import from this file; new code should
 * prefer importing from the specific sub-module.
 *
 * Migrated from worker/shared/label_manager.sh and worker/shared/question_failure.sh
 * (Issue #911).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

// Re-export types from failure diagnosis (kept for API compatibility).
export type { ClarityStatus, FailureCategory } from "./failure_diagnosis.ts";

// Shared label manager types and default configuration.
export type {
  ClarificationOptions,
  EscalationOptions,
  FailureOptions,
  HandleFailureOptions,
  HandleFailureResult,
  LabelConfig,
  LabelManagerDeps,
  QuestionFailureOptions,
} from "./label_types.ts";
export { DEFAULT_LABEL_CONFIG } from "./label_types.ts";

// Label cache (Issue #333).
export {
  labelCacheFilePath,
  labelCacheInvalidate,
  labelCacheIsValid,
} from "./label_cache.ts";

// Label add/ensure operations (Issue #976; Issue #1961 adds ensureIdleTaskLabel).
export {
  addLabelToIssue,
  ensureIdleTaskLabel,
  ensureLabelExists,
} from "./label_operations.ts";

// Issue failure marking and unified handler.
export {
  checkIssueHasFailedOnce,
  handleIssueFailure,
  markIssueAsFailed,
  markIssueAsFailedOnce,
} from "./label_failure.ts";

// Question answering failure path (Issue #663).
export {
  buildQuestionFailureComment,
  getQuestionFailureReason,
  handleQuestionFailure,
} from "./label_question_failure.ts";

// Clarification workflow (Issue #107, Issue #190).
export {
  countClarificationRounds,
  postClarifyingQuestions,
  validateClarifyingQuestions,
} from "./label_clarification.ts";

// Planning escalation (Issues #557, #977, #1476).
export {
  checkAndHealPlanningEscalation,
  detectPlanningEscalationInComments,
  escalateToPlanning,
  PLANNING_ESCALATION_HEADINGS,
} from "./label_planning_escalation.ts";
