/**
 * An approved issue is never handed back (Issue #4227).
 *
 * `work-on` is the owner's approval to complete the issue (DESIGN-PRINCIPLES:
 * "An assigned issue is completed, never handed back"). A run that ends with
 * no PR — it changed nothing, it declared a hand-off the worker cannot honour,
 * or its time deferrals ran out — has not finished the issue. That is a Vibe
 * Coder failure to retry, not a decision for a human. It used to be handed
 * off as "analysis-only" with `needs-human`, and the issue then sat until a
 * person re-approved it.
 *
 * This posts one "not finished" comment carrying the agent's last output, so
 * the next run's prompt sees what was tried. It then returns a `no_changes`
 * failure, which walks the normal `failed-once` ladder with its escalating
 * cooldown (#4158). `work-on` and `top-priority` stay. Only an issue whose
 * author declared it analysis-only (`<!-- analysis-only -->`) is still handed
 * off.
 *
 * ```mermaid
 * flowchart LR
 *     R["Run ends with no PR"] --> C["Not finished comment<br/>(last output)"]
 *     C --> F["no_changes failure:<br/>failed-once, cooldown"]
 *     F --> N["Next run resumes the issue"]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";
import type { PhaseResult } from "./issue_worker_types.ts";
import {
  type FailureDiagnosticContext,
  formatDetailedFailureMessage,
} from "./failure_message.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Heading of the comment a retried run leaves on the issue. */
export const UNFINISHED_RETRY_HEADING = "## Not finished — retrying";

/** Longest slice of the agent's output quoted back to the next run. */
const MAX_OUTPUT_CHARS = 3000;

/** Options for {@link retryUnfinishedIssue}. */
export interface RetryUnfinishedIssueOptions {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  /** One sentence: why this run stopped without delivering the issue. */
  why: string;
  /** The agent's output, quoted for the next run (redacted here). */
  agentOutput: string;
  diagnostics: FailureDiagnosticContext;
  logger: Logger;
}

/**
 * The comment the next run reads: what stopped this one, what it said, and
 * that the issue is still to be completed.
 */
export function buildUnfinishedRetryComment(
  why: string,
  agentOutput: string,
): string {
  const output = redactSecrets(agentOutput).trim().slice(-MAX_OUTPUT_CHARS);
  return [
    UNFINISHED_RETRY_HEADING,
    "",
    `This issue is approved, so it is completed, not handed back. This run stopped without a PR: ${why}`,
    "",
    "**Next run:** finish the issue. Every acceptance criterion must be met " +
    "before a PR is raised. If the issue is genuinely too large for one PR, " +
    'end with the `<!-- vibe-needs-planning reason="…" -->` marker so it is ' +
    "split into sub-issues. Do not file a follow-up issue or ask a human to " +
    "take over.",
    ...(output
      ? [
        "",
        "<details>",
        "<summary>Last run's output</summary>",
        "",
        "```",
        output,
        "```",
        "",
        "</details>",
      ]
      : []),
  ].join("\n");
}

/**
 * Leave the "not finished" comment and fail the run so it is retried.
 *
 * The comment is best-effort: a GitHub error is logged and the run still
 * fails into the retry ladder, never into a hand-off.
 */
export async function retryUnfinishedIssue(
  options: RetryUnfinishedIssueOptions,
): Promise<PhaseResult> {
  const { ghClient, repo, issueNumber, why, agentOutput, logger } = options;
  logger.warn(
    "Approved issue not finished — retrying, not handing it to a human " +
      "(Issue #4227)",
    { repo, issueNumber, why },
  );
  try {
    await ghClient.postComment(
      repo,
      issueNumber,
      buildUnfinishedRetryComment(why, agentOutput),
    );
  } catch (err) {
    logger.warn("Failed to post the not-finished comment", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    category: "no_changes",
    status: "failure",
    reason: formatDetailedFailureMessage(
      // "without making any changes" is the wording `detectFailureCategory`
      // reads as `no_changes`, so the ladder classifies the retry correctly.
      `Not finished — ${why}. The run ended without making any changes that ` +
        `deliver the issue; retrying the approved issue (Issue #4227)`,
      options.diagnostics,
    ),
  };
}
