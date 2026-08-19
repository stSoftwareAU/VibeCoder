/**
 * Phase 2 — Clarity Assessment.
 *
 * Routes issues with special labels, enforces the clarification round
 * limit, runs the clarity heuristic, and posts clarifying questions
 * (with claim release) when the issue is too vague to implement.
 * Single responsibility: decide whether the issue is ready for Claude
 * to work on.
 *
 * Extracted from worker/deno/lib/issue_worker.ts (Issue #1527).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { analyseIssueClarity } from "../../commands/assess_clarity.ts";
import { LABEL_DEFAULTS } from "../config_defaults.ts";
import {
  countClarificationRounds,
  validateClarifyingQuestions,
} from "../label_clarification.ts";
import {
  buildDedupMarker,
  escalateToHuman,
} from "../needs_human_escalation.ts";

/**
 * The "what to do next" text shown when the worker asks for clarification
 * (Issue #2210). Embedded in the clarification comment and re-used as the
 * `escalateToHuman` next step.
 */
export const CLARIFICATION_NEXT_STEP =
  "Answer the questions above (reply to this comment or edit the issue), then " +
  "remove the `needs-human` label so the worker can continue. The worker will " +
  "otherwise resume after the maximum clarification rounds.";

/**
 * Release the worker's claim on an issue so a different priority handler
 * can pick it up on the next cycle. Without this, a clarity early-exit
 * leaves the issue assigned with a CLAIM_LOCK comment, no heartbeat, and
 * the heartbeat-recovery sweep only unassigns after 30 minutes — causing
 * the issue to loop through priority 2 every cycle (observed on FLEET#1626,
 * private-repo-17#1085).
 */
async function releaseClaimForRouting(
  ctx: IssueContext,
  deps: WorkerDeps,
  routingReason: string,
): Promise<void> {
  const { repo, issueNumber, githubUser } = ctx;
  try {
    const ghClient = deps.github.createClient(deps.logger);
    await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
  } catch (err) {
    deps.logger.warn("Failed to release claim while routing", {
      repo,
      issueNumber,
      routingReason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function workOnIssueClarityPhase(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const {
    repo,
    issueNumber,
    issueLabels,
    issueBody,
    issueTitle,
    issueComments,
    githubUser,
    config,
  } = ctx;
  const logger = deps.logger;

  // Label routing — special labels cause early exit. The worker still holds
  // the claim at this point (setup phase claimed it), so we must unassign
  // before returning so the corresponding priority handler (refinement /
  // question / planning) can pick the issue up on the next cycle.
  if (issueLabels.includes(config.refineIssueLabel)) {
    logger.info("Issue has refine label, routing to refinement", {
      repo,
      issueNumber,
    });
    await releaseClaimForRouting(ctx, deps, "refine_label_routing");
    return { status: "early_exit", reason: "refine_label_routing" };
  }
  if (issueLabels.includes(config.questionLabel)) {
    logger.info("Issue has question label, routing to question handler", {
      repo,
      issueNumber,
    });
    await releaseClaimForRouting(ctx, deps, "question_label_routing");
    return { status: "early_exit", reason: "question_label_routing" };
  }
  if (issueLabels.includes(config.planningLabel)) {
    // The issue finder already excludes planning-labelled issues, so if we
    // got here the label was added between the find and the fetch (e.g. by
    // a previous churn escalation cycle). Remove it and proceed with
    // implementation rather than bouncing the issue indefinitely.
    // Issue #345, Issue #1215: Regression — the Deno migration lost the
    // actual label removal that the bash version performed.
    logger.info(
      "Planning label found after issue was selected for implementation — removing stale label and proceeding",
    );
    try {
      const ghClient = deps.github.createClient(logger);
      await ghClient.removeLabel(repo, issueNumber, config.planningLabel);
    } catch (err) {
      logger.warn("Failed to remove stale planning label (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Documentation label bypass (Issue #1190): simple tasks skip clarity assessment
  const lowerLabels = issueLabels.map((l) => l.toLowerCase());
  if (lowerLabels.includes(LABEL_DEFAULTS.documentationLabel.toLowerCase())) {
    logger.info("Documentation label found, bypassing clarity assessment");
    state.clarityStatus = "skipped";
    return { status: "continue" };
  }

  // Check clarification round limit
  const clarificationRounds = countClarificationRounds(issueComments);
  if (clarificationRounds >= config.maxClarificationRounds) {
    logger.info(
      "Max clarification rounds reached, proceeding with implementation",
      {
        rounds: clarificationRounds,
        max: config.maxClarificationRounds,
      },
    );
    state.clarityStatus = "skipped";
    return { status: "continue" };
  }

  // Complexity pre-check (Issue #557). Previously this just returned
  // Complexity pre-check removed — checkboxes and numbered lists indicate
  // a well-defined issue, not a complex one. Let Claude assess complexity
  // during implementation and handle it via the clarification phase.

  // Clarity assessment
  const clarity = analyseIssueClarity(issueTitle, issueBody, issueLabels);
  if (clarity.isClear) {
    state.clarityStatus = "assessed_clear";
    logger.info("Issue is clear, proceeding with implementation");
    return { status: "continue" };
  }

  // Issue is unclear — validate and post clarifying questions
  if (clarity.questions.length > 0) {
    const questionsText = clarity.questions.map((q) => `- ${q}`).join("\n");
    const validation = validateClarifyingQuestions(questionsText);
    if (!validation.ok) {
      // Defence-in-depth (Issue #410): if questions invalid, treat as clear
      logger.warn("Clarifying questions failed validation, treating as clear", {
        reason: validation.error.message,
      });
      state.clarityStatus = "assessed_clear";
      return { status: "continue" };
    }

    // Post clarifying questions, label the issue, and unassign so the
    // worker releases its claim while waiting on a human response.
    // Otherwise the issue would loop through priority 2 until the 30-min
    // heartbeat-recovery sweep unassigns it.
    //
    // Issue #1215: Each operation is independent — a label-add failure must
    // not prevent the unassign, matching the bash version's resilience.
    const ghClient = deps.github.createClient(logger);
    // The clarification comment states the questions AND the next step, and
    // carries a dedup marker so the shared escalation helper recognises it
    // and skips posting a duplicate (Issue #2210).
    const dedupKey = `clarification-${issueNumber}`;
    const commentBody = `## Clarification Needed\n\n${questionsText}\n\n` +
      `**Next step:** ${CLARIFICATION_NEXT_STEP}\n\n${
        buildDedupMarker(dedupKey)
      }`;
    try {
      await ghClient.postComment(repo, issueNumber, commentBody);
    } catch (err) {
      // If the comment fails, we cannot communicate the questions — fall
      // back to proceeding with implementation.
      logger.warn(
        "Failed to post clarifying questions, proceeding with implementation",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      state.clarityStatus = "assessed_clear";
      return { status: "continue" };
    }
    // Issue #2031: clarification handoff signal is needs-human.
    // Issue #2210: route the label add through the shared helper. The
    // `dedupKey` matches the marker above, so the helper recognises the
    // just-posted clarification comment and adds the label without
    // duplicating the comment.
    await escalateToHuman({
      ghClient,
      repo,
      target: { kind: "issue", number: issueNumber },
      needsHumanLabel: config.needsHumanLabel,
      heading: "Clarification Needed",
      reason: "The issue is too vague to implement without more information.",
      nextStep: CLARIFICATION_NEXT_STEP,
      dedupKey,
      githubUser,
      deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
      logger,
    });
    try {
      await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
    } catch (err) {
      logger.warn(
        "Failed to unassign worker during clarification (non-fatal)",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    logger.info("Posted clarification request and released claim", {
      repo,
      issueNumber,
    });

    return { status: "early_exit", reason: "waiting_for_clarification" };
  }

  // No questions generated but unclear — proceed anyway
  state.clarityStatus = "assessed_clear";
  return { status: "continue" };
}
