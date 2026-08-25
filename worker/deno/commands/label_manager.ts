/**
 * Label manager command for the Vibe Coder worker.
 *
 * Provides label management, failure handling, clarification workflows,
 * and planning escalation. Callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Sub-operations (--operation):
 *   - ensure-label: Create a label if it does not exist
 *   - check-failed-once: Check if an issue has the failed-once label
 *   - mark-failed-once: Mark an issue as having failed once
 *   - mark-failed: Mark an issue as permanently failed
 *   - handle-failure: Unified failure handler
 *   - handle-question-failure: Handle question answering failure
 *   - count-clarification-rounds: Count clarification comments
 *   - validate-clarifying-questions: Validate questions text
 *   - post-clarifying-questions: Post clarifying questions
 *   - escalate-to-planning: Escalate to planning mode
 *
 * Migrated from worker/shared/label_manager.sh and
 * worker/shared/question_failure.sh (Issue #911).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { buildWorkerFooter } from "../lib/worker_identity.ts";
import { getRunId } from "../lib/run_id.ts";
import { DEFAULT_LABEL_CONFIG, type LabelConfig } from "../lib/label_types.ts";
import { ensureLabelExists } from "../lib/label_operations.ts";
import {
  checkIssueHasFailedOnce,
  handleIssueFailure,
  markIssueAsFailed,
  markIssueAsFailedOnce,
} from "../lib/label_failure.ts";
import { handleQuestionFailure } from "../lib/label_question_failure.ts";
import {
  countClarificationRounds,
  postClarifyingQuestions,
  validateClarifyingQuestions,
} from "../lib/label_clarification.ts";
import { escalateToPlanning } from "../lib/label_planning_escalation.ts";

export const labelManagerCommand: Command = {
  name: "label-manager",
  description:
    "Label management, failure handling, and issue workflow operations",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");

    // Build label config from worker config
    // Issue #2031: needs-human replaces the retired needs-clarification handoff.
    const labels: LabelConfig = {
      failedLabel: config.failedLabel ?? DEFAULT_LABEL_CONFIG.failedLabel,
      failedOnceLabel: config.failedOnceLabel ??
        DEFAULT_LABEL_CONFIG.failedOnceLabel,
      needsHumanLabel: config.needsHumanLabel ??
        DEFAULT_LABEL_CONFIG.needsHumanLabel,
      planningLabel: config.planningLabel ?? DEFAULT_LABEL_CONFIG.planningLabel,
      questionLabel: config.questionLabel ?? DEFAULT_LABEL_CONFIG.questionLabel,
    };

    // Build worker footer
    const githubUser = String(args["github-user"] ?? "");
    const workerFooter = buildWorkerFooter({
      workerName: config.workerName,
      githubUser,
      runId: getRunId(),
    });

    switch (operation) {
      case "ensure-label": {
        const repo = String(args["repo"] ?? "");
        const labelName = String(args["label-name"] ?? "");
        // Issue #368: no `--colour` means "use the canonical table", not
        // "paint it red" — ensureLabelExists resolves both from
        // `label_definitions.ts`.
        const colour = args["colour"] ? String(args["colour"]) : undefined;
        const description = args["description"]
          ? String(args["description"])
          : undefined;

        if (!repo || !labelName) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --label-name",
          };
        }

        const result = await ensureLabelExists(
          repo,
          labelName,
          colour,
          description,
        );
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "check-failed-once": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);

        if (!repo || !issueNumber) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --issue-number",
          };
        }

        const hasFailed = await checkIssueHasFailedOnce(
          repo,
          issueNumber,
          labels.failedOnceLabel,
        );
        return {
          success: true,
          message: hasFailed ? "true" : "false",
          data: { hasFailedOnce: hasFailed },
        };
      }

      case "mark-failed-once": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const failureMessage = String(args["failure-message"] ?? "");
        const clarityStatus = String(args["clarity-status"] ?? "not_assessed");
        const diagnosticContext = String(args["diagnostic-context"] ?? "");

        if (!repo || !issueNumber || !githubUser) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --github-user",
          };
        }

        const result = await markIssueAsFailedOnce({
          repo,
          issueNumber,
          githubUser,
          failureMessage,
          clarityStatus: clarityStatus as
            | "assessed_clear"
            | "skipped"
            | "not_assessed",
          diagnosticContext,
          labels,
          workerFooter,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "mark-failed": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const failureMessage = String(args["failure-message"] ?? "");
        const clarityStatus = String(args["clarity-status"] ?? "not_assessed");
        const diagnosticContext = String(args["diagnostic-context"] ?? "");

        if (!repo || !issueNumber || !githubUser) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --github-user",
          };
        }

        const result = await markIssueAsFailed({
          repo,
          issueNumber,
          githubUser,
          failureMessage,
          clarityStatus: clarityStatus as
            | "assessed_clear"
            | "skipped"
            | "not_assessed",
          diagnosticContext,
          labels,
          workerFooter,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "handle-failure": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const failureMessage = String(args["failure-message"] ?? "");
        const clarityStatus = String(args["clarity-status"] ?? "not_assessed");
        const diagnosticContext = String(args["diagnostic-context"] ?? "");
        const maxInfraRetries = toNumber(args["max-infra-retries"], 5);

        if (!repo || !issueNumber || !githubUser) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --github-user",
          };
        }

        const result = await handleIssueFailure({
          repo,
          issueNumber,
          githubUser,
          failureMessage,
          clarityStatus: clarityStatus as
            | "assessed_clear"
            | "skipped"
            | "not_assessed",
          diagnosticContext,
          labels,
          workerFooter,
          maxInfraRetries,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        const data = result.value;
        return {
          success: true,
          message: data.markedAsFailed ? "FAILED" : "FAILED_ONCE",
          data,
        };
      }

      case "handle-question-failure": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const failureMessage = String(args["failure-message"] ?? "");

        if (!repo || !issueNumber || !githubUser) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --github-user",
          };
        }

        const result = await handleQuestionFailure({
          repo,
          issueNumber,
          githubUser,
          failureMessage,
          labels,
          workerFooter,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "count-clarification-rounds": {
        const issueComments = String(args["issue-comments"] ?? "");
        const count = countClarificationRounds(issueComments);
        return {
          success: true,
          message: String(count),
          data: { count },
        };
      }

      case "validate-clarifying-questions": {
        const questions = String(args["questions"] ?? "");
        const result = validateClarifyingQuestions(questions);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "VALID" };
      }

      case "post-clarifying-questions": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const questions = String(args["questions"] ?? "");

        if (!repo || !issueNumber || !githubUser || !questions) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --github-user, --questions",
          };
        }

        const result = await postClarifyingQuestions({
          repo,
          issueNumber,
          githubUser,
          clarifyingQuestions: questions,
          labels,
          workerFooter,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "escalate-to-planning": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const escalationReason = String(args["reason"] ?? "");

        if (!repo || !issueNumber || !githubUser) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --github-user",
          };
        }

        const result = await escalateToPlanning({
          repo,
          issueNumber,
          githubUser,
          escalationReason,
          labels,
          workerFooter,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      default:
        return {
          success: false,
          message: `Unknown label-manager operation: ${operation}`,
        };
    }
  },
};

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}
