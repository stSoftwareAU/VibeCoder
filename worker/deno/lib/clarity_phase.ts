/**
 * Clarity phase library — label routing, complexity check, and clarity assessment.
 *
 * Migrates the business logic from work_on_issue_clarity_phase() in
 * issue_worker.sh to Deno TypeScript (Issue #1225). Handles the full
 * clarity phase flow:
 *   1. Label routing (refine, question, planning)
 *   2. Documentation label bypass
 *   3. Clarification round counting
 *   4. Complexity pre-check
 *   5. Clarity assessment via Claude
 *   6. Question posting and label management
 *
 * Returns a structured result so the shell wrapper only handles git
 * cleanup (checkout default branch, delete feature branch).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { expectedNoPrOutcome } from "./run_outcome.ts";
import { LABEL_DEFAULTS, OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import type { LabelManagerDeps } from "./label_types.ts";
import {
  countClarificationRounds,
  ghClientFromCommandFn,
  postClarifyingQuestions,
  validateClarifyingQuestions,
} from "./label_clarification.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import type { IssueComment } from "./issue_data.ts";
import { escalateToPlanning } from "./label_planning_escalation.ts";
import { detectComplexity } from "../commands/assess_clarity.ts";
import {
  type ClarityAssessmentDeps,
  runClarityAssessment,
} from "./clarity_assessment.ts";
import { runGhCommand } from "./github.ts";
import { buildWorkerFooter } from "./worker_identity.ts";
import { getRunId } from "./run_id.ts";
import { releaseClaim, unassignerFromGhCommand } from "./claim_release.ts";
import { defaultLogger } from "./logger.ts";
import { reportPhaseDegradation } from "./phase_run_stats.ts";
import {
  type PhaseAcceleratorClaudeDeps,
  preparePhaseAccelerators,
} from "./phase_accelerators.ts";
import type { GraftContextCollector } from "./graft_context.ts";
import type { WorkerConfig } from "../types.ts";
import {
  buildMaskedInstructionQuestions,
  findMaskedInstructions,
  MASKED_INSTRUCTION_QUESTION_MARKER,
} from "./masked_instructions.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for the clarity phase. */
export interface ClarityPhaseParams {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number. */
  issueNumber: number;
  /** Issue title. */
  issueTitle: string;
  /** Issue body/description. */
  issueBody: string;
  /** Comma-separated issue labels. */
  issueLabels: string;
  /** Issue comments text. */
  issueComments: string;
  /**
   * Boundary id whose per-comment trust headers inside `issueComments` are
   * genuine (Issue #3638). Passed to the assessment prompt so those headers
   * survive its sanitiser pass while forgeries stay degraded.
   */
  commentBoundaryId?: string;
  /**
   * The issue's comments with their authors (Issue #1263).
   *
   * `issueComments` above is the blob handed to the model; it carries no
   * authorship, so the clarification round limit — which retires the clarity
   * gate — cannot be counted from it. Supply these when the caller already
   * holds them; otherwise the phase reads them from GitHub itself.
   */
  issueCommentRows?: readonly IssueComment[];
  /** GitHub username of the worker. */
  githubUser: string;
  /** Working directory for the repo. */
  cwd?: string;
  /** Worker name for footer. */
  workerName?: string;
}

/** Label configuration for routing. */
export interface ClarityPhaseLabels {
  refineIssueLabel: string;
  planningLabel: string;
  questionLabel: string;
  documentationLabel: string;
  /** Label for worker-to-human escalation (Issue #2031). */
  needsHumanLabel: string;
}

/** Result of the clarity phase. */
export interface ClarityPhaseResult {
  /** Action for the shell wrapper. */
  action: "proceed" | "early_exit" | "failure";
  /** Human-readable reason for the action. */
  reason: string;
  /** Clarity status for the shell global _WOI_CLARITY_STATUS. */
  clarityStatus: "not_assessed" | "skipped" | "assessed_clear";
  /** Whether the shell should unassign the worker (for label routing). */
  shouldUnassign: boolean;
  /** Whether the shell should clean up the git branch. */
  shouldCleanupBranch: boolean;
}

/** Dependencies for the clarity phase (injectable for testing). */
export interface ClarityPhaseDeps {
  /** gh CLI command runner. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Label manager dependencies. */
  labelManagerDeps?: LabelManagerDeps;
  /** Clarity assessment dependencies (for mocking Claude). */
  assessmentDeps?: ClarityAssessmentDeps;
  /** Max clarification rounds. */
  maxClarificationRounds?: number;
  /** Clarification timeout in seconds. */
  clarificationTimeout?: number;
  /** Clarification kill-after in seconds. */
  clarificationKillAfter?: number;
  /**
   * Fleet identity inputs for the clarification round count (Issue #1263).
   * Tests state the fleet instead of writing a config file.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  /**
   * Graft, CodeGraph and RTK for the assessment spawn (Issue #2569). Omitted,
   * the assessment runs unaccelerated in `params.cwd`.
   */
  accelerators?: {
    config: WorkerConfig;
    claude: PhaseAcceleratorClaudeDeps;
    collectGraftContext?: GraftContextCollector;
  };
}

// ---------------------------------------------------------------------------
// Label Parsing
// ---------------------------------------------------------------------------

/**
 * Parse comma-separated labels string into an array of lowercase labels.
 */
function parseLabels(labelsStr: string): string[] {
  if (!labelsStr.trim()) return [];
  return labelsStr.split(",").map((l) => l.trim().toLowerCase()).filter(
    Boolean,
  );
}

/**
 * Check if a label is present (case-insensitive).
 */
function hasLabel(labels: string[], target: string): boolean {
  return labels.includes(target.toLowerCase());
}

// ---------------------------------------------------------------------------
// Clarity Phase Execution
// ---------------------------------------------------------------------------

/**
 * Execute the full clarity phase for an issue.
 *
 * This replaces the work_on_issue_clarity_phase() shell function from
 * issue_worker.sh (Issue #1225). The function handles all business logic
 * and GitHub API operations. The calling shell wrapper only needs to
 * handle git cleanup based on the returned result.
 *
 * @param params - Phase parameters
 * @param labelConfig - Label names for routing
 * @param deps - Injectable dependencies
 * @returns Phase result indicating what action the shell should take
 */
export async function runClarityPhase(
  params: ClarityPhaseParams,
  labelConfig: ClarityPhaseLabels = {
    refineIssueLabel: LABEL_DEFAULTS.refineIssueLabel,
    planningLabel: LABEL_DEFAULTS.planningLabel,
    questionLabel: LABEL_DEFAULTS.questionLabel,
    documentationLabel: LABEL_DEFAULTS.documentationLabel,
    needsHumanLabel: LABEL_DEFAULTS.needsHumanLabel,
  },
  deps: ClarityPhaseDeps = {},
): Promise<ClarityPhaseResult> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const maxClarificationRounds = deps.maxClarificationRounds ??
    OPERATIONAL_DEFAULTS.maxClarificationRounds;

  const labels = parseLabels(params.issueLabels);

  // -----------------------------------------------------------------------
  // 1. Label routing — redirect to the correct handler
  // -----------------------------------------------------------------------

  if (hasLabel(labels, labelConfig.refineIssueLabel)) {
    // Unassign the worker so refinement handler can pick up
    await releaseClaim(
      unassignerFromGhCommand(ghCommandFn),
      params.repo,
      params.issueNumber,
      params.githubUser,
      defaultLogger,
      {
        outcome: expectedNoPrOutcome(
          "clarity",
          "routed to refinement (refine-issue label)",
        ),
      },
    );
    return {
      action: "early_exit",
      reason: "refine_label_routing",
      clarityStatus: "not_assessed",
      shouldUnassign: false, // Already unassigned above
      shouldCleanupBranch: true,
    };
  }

  if (hasLabel(labels, labelConfig.planningLabel)) {
    // Planning label found after issue was selected for implementation —
    // remove stale label and proceed (Issue #1215, regression fix).
    await removeLabelSafe(
      ghCommandFn,
      params.repo,
      params.issueNumber,
      labelConfig.planningLabel,
    );
  }

  if (hasLabel(labels, labelConfig.questionLabel)) {
    // Unassign the worker so question handler can pick up
    await releaseClaim(
      unassignerFromGhCommand(ghCommandFn),
      params.repo,
      params.issueNumber,
      params.githubUser,
      defaultLogger,
      {
        outcome: expectedNoPrOutcome(
          "clarity",
          "routed to question answering (question label)",
        ),
      },
    );
    return {
      action: "early_exit",
      reason: "question_label_routing",
      clarityStatus: "not_assessed",
      shouldUnassign: false,
      shouldCleanupBranch: true,
    };
  }

  // -----------------------------------------------------------------------
  // 2. Determine whether to skip clarification
  // -----------------------------------------------------------------------

  let skipClarification = false;
  let clarityStatus: ClarityPhaseResult["clarityStatus"] = "not_assessed";

  if (hasLabel(labels, labelConfig.documentationLabel)) {
    skipClarification = true;
    clarityStatus = "skipped";
  }

  // Issue #1263: a round counts only when a fleet account posted it. The
  // rows come from the caller when it already holds them, and otherwise from
  // GitHub, whose comment list carries the one authenticated part of a
  // match. A read that fails leaves no attributable round, so the gate stays
  // on rather than being retired by text anyone can write.
  let commentRows = params.issueCommentRows;
  if (commentRows === undefined) {
    try {
      commentRows = await ghClientFromCommandFn(ghCommandFn).getIssueComments(
        params.repo,
        params.issueNumber,
      );
    } catch (err) {
      defaultLogger.warn(
        "[clarity-phase] could not read the issue comments — no " +
          "clarification round is counted and the clarity gate stays on",
        { error: err instanceof Error ? err.message : String(err) },
      );
      commentRows = [];
    }
  }
  const clarificationRound = await countClarificationRounds(commentRows, {
    issueNumber: params.issueNumber,
    repo: params.repo,
    githubUser: params.githubUser,
    dedupAuthors: deps.dedupAuthors,
    log: (message: string) => defaultLogger.warn(message),
  });

  if (clarificationRound >= maxClarificationRounds) {
    skipClarification = true;
    clarityStatus = "skipped";
  }

  // -----------------------------------------------------------------------
  // 2a. Masked instructions — ask, never guess (Issue #2390)
  // -----------------------------------------------------------------------
  //
  // A body whose instruction carries a mask placeholder cannot be followed:
  // fourteen audit issues read "Add `persist-credentials: ***REDACTED***`" and
  // were queued as ordinary work. An agent handed that can only guess, so the
  // value is asked for — deterministically, before any model is invoked, and
  // through the same `## Clarification Needed` route a model's own questions
  // take. The `documentation` bypass does not apply: that label waives a
  // judgement of clarity, and this is not a judgement. The round cap does, so
  // an issue released three times unanswered is not asked a fourth.
  const maskedInstructions = findMaskedInstructions(params.issueBody);
  if (
    maskedInstructions.length > 0 &&
    clarificationRound < maxClarificationRounds &&
    !maskedQuestionAnswered(commentRows, params.githubUser)
  ) {
    defaultLogger.warn(
      "[clarity-phase] [MASKED_INSTRUCTION] the issue's instructions carry a " +
        "mask placeholder — asking for the value instead of invoking the agent",
      {
        repo: params.repo,
        issueNumber: params.issueNumber,
        lines: maskedInstructions.map((h) => h.line).join(","),
      },
    );
    const postResult = await postClarifyingQuestions(
      {
        repo: params.repo,
        issueNumber: params.issueNumber,
        githubUser: params.githubUser,
        clarifyingQuestions: `${MASKED_INSTRUCTION_QUESTION_MARKER}\n` +
          buildMaskedInstructionQuestions(maskedInstructions),
        workerFooter: buildWorkerFooter({
          workerName: params.workerName ?? "",
          githubUser: params.githubUser,
          runId: getRunId(),
        }),
      },
      deps.labelManagerDeps ?? { ghCommandFn },
    );
    if (postResult.ok) {
      return {
        action: "early_exit",
        reason: "waiting_for_clarification",
        clarityStatus: "not_assessed",
        shouldUnassign: false, // postClarifyingQuestions already unassigns
        shouldCleanupBranch: true,
      };
    }
    // Could not ask. Guessing is the one outcome this gate exists to stop, so
    // the run fails loudly rather than proceeding on a masked instruction.
    return {
      action: "failure",
      reason: `masked_instruction_question_failed: ${postResult.error.message}`,
      clarityStatus: "not_assessed",
      shouldUnassign: true,
      shouldCleanupBranch: true,
    };
  }

  // -----------------------------------------------------------------------
  // 3. Complexity pre-check (Issue #557)
  // -----------------------------------------------------------------------

  if (!skipClarification) {
    const complexity = detectComplexity(params.issueBody);

    if (complexity.isComplex) {
      const workerFooter = buildWorkerFooter({
        workerName: params.workerName ?? "",
        githubUser: params.githubUser,
        runId: getRunId(),
      });

      const escalationResult = await escalateToPlanning(
        {
          repo: params.repo,
          issueNumber: params.issueNumber,
          githubUser: params.githubUser,
          escalationReason:
            "Detected as too complex by semantic/structural heuristics",
          workerFooter,
        },
        deps.labelManagerDeps ?? { ghCommandFn },
      );

      if (!escalationResult.ok) {
        // Escalation failed — proceed with implementation rather than blocking
        console.warn(
          `[clarity-phase] Escalation to planning failed: ${escalationResult.error.message} — proceeding anyway`,
        );
      } else {
        return {
          action: "early_exit",
          reason: "too_complex",
          clarityStatus: "not_assessed",
          shouldUnassign: false, // escalateToPlanning already unassigns
          shouldCleanupBranch: true,
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // 4. Run clarity assessment
  // -----------------------------------------------------------------------

  if (!skipClarification) {
    // Issue #2569: one Graft, CodeGraph and RTK preparation per assessment.
    const accel = deps.accelerators
      ? await preparePhaseAccelerators({
        config: deps.accelerators.config,
        repo: params.repo,
        issueNumber: params.issueNumber,
        issueTitle: params.issueTitle,
        issueBody: params.issueBody,
        claude: deps.accelerators.claude,
        logger: defaultLogger,
        collectGraftContext: deps.accelerators.collectGraftContext,
      })
      : undefined;
    const assessmentResult = await runClarityAssessment(
      {
        params: {
          issueTitle: params.issueTitle,
          issueBody: params.issueBody,
          issueLabels: params.issueLabels,
          issueComments: params.issueComments,
          commentBoundaryId: params.commentBoundaryId,
          clarificationRound,
        },
        timeoutSeconds: deps.clarificationTimeout ??
          OPERATIONAL_DEFAULTS.clarificationTimeout,
        killAfterSeconds: deps.clarificationKillAfter ??
          OPERATIONAL_DEFAULTS.clarificationKillAfter,
        // The MCP config is written under cwd, so an accelerated run spawns
        // in the worker's work dir.
        cwd: deps.accelerators?.config.workDir ?? params.cwd,
        transformPrompt: accel?.applyPrompt,
        spawnOptions: accel?.spawnOptions(),
      },
      deps.assessmentDeps,
    );
    await accel?.afterSpawn();

    if (assessmentResult.status === "failed") {
      return {
        action: "failure",
        reason: `clarity_assessment_failed: ${assessmentResult.reason}`,
        clarityStatus: "not_assessed",
        shouldUnassign: false,
        shouldCleanupBranch: true,
      };
    }

    accel?.recordSuccess(assessmentResult.degradation?.runStats);

    // Issue #3232: clarification routes through a Fable-preferring
    // planning-shaped phase, so surface a silent Fable→Opus substitution the
    // same way planning and grill-me do — post a stats comment and apply
    // `degraded-model` to the issue ONLY on a degraded round (explicit
    // pre-flight flag, served-model mismatch, or rate-limit fallback). Healthy
    // rounds stay quiet. Non-fatal: never blocks the clarity flow. The comment
    // is posted via `gh issue comment` since this phase has no GitHubClient.
    if (assessmentResult.degradation) {
      try {
        await reportPhaseDegradation({
          ...accel?.report(),
          phase: "clarification",
          repo: params.repo,
          issueNumber: params.issueNumber,
          claudeResult: assessmentResult.degradation,
          postComment: async (r, i, b) => {
            await ghCommandFn([
              "issue",
              "comment",
              String(i),
              "--repo",
              r,
              "--body",
              b,
            ]);
          },
          runGhCommand: ghCommandFn,
          logger: defaultLogger,
        });
      } catch (err) {
        defaultLogger.warn(
          "Clarification degraded-model detection failed (non-fatal)",
          {
            repo: params.repo,
            issueNumber: params.issueNumber,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    if (assessmentResult.status === "unclear") {
      // Defence-in-depth: re-validate questions before posting (Issue #410)
      const validation = validateClarifyingQuestions(
        assessmentResult.questions,
      );
      if (!validation.ok) {
        // Invalid questions — treat as clear
        clarityStatus = "assessed_clear";
      } else {
        // Post clarifying questions
        const workerFooter = buildWorkerFooter({
          workerName: params.workerName ?? "",
          githubUser: params.githubUser,
          runId: getRunId(),
        });

        const postResult = await postClarifyingQuestions(
          {
            repo: params.repo,
            issueNumber: params.issueNumber,
            githubUser: params.githubUser,
            clarifyingQuestions: assessmentResult.questions,
            workerFooter,
          },
          deps.labelManagerDeps ?? { ghCommandFn },
        );

        if (postResult.ok) {
          return {
            action: "early_exit",
            reason: "waiting_for_clarification",
            clarityStatus: "not_assessed",
            shouldUnassign: false, // postClarifyingQuestions already unassigns
            shouldCleanupBranch: true,
          };
        }

        // Posting failed — proceed with implementation (Issue #389)
        clarityStatus = "assessed_clear";
      }
    } else {
      // Assessment returned clear
      clarityStatus = "assessed_clear";
    }
  }

  return {
    action: "proceed",
    reason: "clear",
    clarityStatus,
    shouldUnassign: false,
    shouldCleanupBranch: false,
  };
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Has anyone replied since the worker last asked for a masked value?
 *
 * Only a question **this worker's account** posted counts — the marker is
 * text anyone can write, the author is not (the Issue #1263 rule). A reply is
 * any later comment from a different account: the agent reads the comments,
 * so the answer reaches it whether or not the body was also edited.
 */
function maskedQuestionAnswered(
  comments: readonly IssueComment[],
  githubUser: string,
): boolean {
  let asked = -1;
  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    if (
      comment?.author === githubUser &&
      comment.body.includes(MASKED_INSTRUCTION_QUESTION_MARKER)
    ) asked = i;
  }
  if (asked < 0) return false;
  return comments.slice(asked + 1).some((c) => c.author !== githubUser);
}

/**
 * Remove a label from an issue (best-effort, non-fatal).
 */
async function removeLabelSafe(
  ghCommandFn: (args: string[]) => Promise<string>,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-label",
      label,
    ]);
  } catch {
    // Best-effort — non-fatal if label removal fails
  }
}
