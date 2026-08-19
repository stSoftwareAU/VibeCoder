/**
 * Clarity phase command for the Vibe Coder worker (Issue #1225).
 *
 * Wraps the full clarity phase flow: label routing, complexity detection,
 * clarity assessment via Claude, and question posting. Callable from shell
 * via deno_bridge.sh.
 *
 * Arguments:
 *   --repo          Repository in "owner/repo" format
 *   --issue-number  Issue number
 *   --title         Issue title
 *   --body          Issue body/description
 *   --labels        Comma-separated issue labels
 *   --comments      Issue comments text
 *   --github-user   GitHub username of the worker
 *
 * Output: JSON with the phase result:
 *   { action, reason, clarityStatus, shouldCleanupBranch }
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { LABEL_DEFAULTS } from "../lib/config_defaults.ts";
import {
  type ClarityPhaseResult,
  runClarityPhase,
} from "../lib/clarity_phase.ts";

export const clarityPhaseCommand: Command = {
  name: "clarity-phase",
  description:
    "Issue clarity phase — label routing, complexity check, and Claude-based assessment (Issue #1225)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<ClarityPhaseResult>> {
    const repo = String(args["repo"] ?? "");
    const issueNumberRaw = args["issue-number"];
    const issueTitle = String(args["title"] ?? "");
    const issueBody = String(args["body"] ?? "");
    const issueLabels = String(args["labels"] ?? "");
    const issueComments = String(args["comments"] ?? "");
    // Genuine per-comment trust-header nonce, when the caller formatted the
    // comments with prepareTrustAnnotatedComments (Issue #3638).
    const commentBoundaryId = args["comment-boundary-id"]
      ? String(args["comment-boundary-id"])
      : undefined;
    const githubUser = String(args["github-user"] ?? "");

    // Validate required arguments
    if (!repo) {
      return { success: false, message: "Missing required argument: --repo" };
    }
    const issueNumber = typeof issueNumberRaw === "number"
      ? issueNumberRaw
      : parseInt(String(issueNumberRaw ?? "0"), 10);
    if (!issueNumber || issueNumber <= 0) {
      return {
        success: false,
        message: "Missing or invalid argument: --issue-number",
      };
    }
    if (!githubUser) {
      return {
        success: false,
        message: "Missing required argument: --github-user",
      };
    }

    const result = await runClarityPhase(
      {
        repo,
        issueNumber,
        issueTitle,
        issueBody,
        issueLabels,
        issueComments,
        commentBoundaryId,
        githubUser,
        workerName: config.workerName,
      },
      {
        refineIssueLabel: config.refineIssueLabel ??
          LABEL_DEFAULTS.refineIssueLabel,
        planningLabel: config.planningLabel ?? LABEL_DEFAULTS.planningLabel,
        questionLabel: config.questionLabel ?? LABEL_DEFAULTS.questionLabel,
        documentationLabel: LABEL_DEFAULTS.documentationLabel,
        // Issue #2031: needs-human replaces the retired needs-clarification handoff.
        needsHumanLabel: config.needsHumanLabel ??
          LABEL_DEFAULTS.needsHumanLabel,
      },
      {
        maxClarificationRounds: config.maxClarificationRounds,
        clarificationTimeout: config.clarificationTimeout,
        clarificationKillAfter: config.clarificationKillAfter,
      },
    );

    // Output JSON for shell parsing
    return {
      success: result.action !== "failure",
      message: JSON.stringify(result),
      data: result,
    };
  },
};
