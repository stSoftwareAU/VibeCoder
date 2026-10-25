/**
 * Phase 2 — Clarity Assessment.
 *
 * Routes issues with special labels and runs the clarity heuristic. An
 * approved issue is never handed back to a human (Issue #4298): when the
 * heuristic finds it vague, the run proceeds and the agent states the
 * assumptions it made, as the issue prompt instructs. Single responsibility:
 * route the issue to the handler its labels name, or let Claude work on it.
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
    return {
      category: "unknown",
      status: "early_exit",
      reason: "refine_label_routing",
    };
  }
  if (issueLabels.includes(config.questionLabel)) {
    logger.info("Issue has question label, routing to question handler", {
      repo,
      issueNumber,
    });
    await releaseClaimForRouting(ctx, deps, "question_label_routing");
    return {
      category: "unknown",
      status: "early_exit",
      reason: "question_label_routing",
    };
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

  // Scope alone does not identify missing information (Issue #4147). The
  // heuristic also counts clear numbered requirements as "too_complex";
  // leave decomposition to implementation instead of asking a human whether
  // to split an already-approved assignment. Genuine clarity questions remain.
  const clarity = analyseIssueClarity(issueTitle, issueBody, issueLabels);
  if (clarity.isClear || clarity.reason === "too_complex") {
    state.clarityStatus = "assessed_clear";
    logger.info("Issue is clear, proceeding with implementation");
    return { status: "continue" };
  }

  // Issue #4298: an approved issue is never handed back to a human. The
  // clarifying questions used to be posted with `needs-human` and the claim
  // released; the round cap then proceeded anyway after three rounds. The
  // first round now does what the cap did: proceed, with the agent stating
  // the assumptions it made in its PR summary (`prompts/issue/prompt.md`).
  logger.info(
    "Issue looks unclear — proceeding with stated assumptions (Issue #4298)",
    { repo, issueNumber, reason: clarity.reason, questions: clarity.questions },
  );
  state.clarityStatus = "skipped";
  return { status: "continue" };
}
