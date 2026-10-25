/**
 * Close a performance issue the run recorded as a negative result (Issue
 * #4298).
 *
 * The coding guidelines' benchmark discipline ends a run with no gain in a
 * results comment and the `negative-result` label, and no code change. The
 * agent cannot close the issue itself — the `gh` guard refuses lifecycle verbs
 * on the issue it is working — and the close used to be left to a human, so
 * the approved issue sat open and was retried every cycle. The worker closes
 * it instead: the label is the run's own record that the work is finished.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";

/** The label a benchmark run applies when the change made no gain. */
export const NEGATIVE_RESULT_LABEL = "negative-result";

/** The close comment, naming why the worker closed the issue. */
export function buildNegativeResultCloseComment(): string {
  return "## Closed: negative result\n\nThis run benchmarked the change and " +
    `found no gain, so it recorded the results above and applied ` +
    `\`${NEGATIVE_RESULT_LABEL}\`. The worker closes the issue on that ` +
    "record rather than re-running it (Issue #4298).";
}

/**
 * Close the issue when it carries {@link NEGATIVE_RESULT_LABEL}.
 *
 * Reads the labels fresh, because the run applied the label after the
 * context was built. Best-effort: a read or close that fails is logged and
 * reported as `false`, so the caller falls through to its ordinary retry
 * rather than losing the run's outcome.
 *
 * @returns `true` when the issue was closed.
 */
export async function closeNegativeResultIssue(opts: {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  githubUser: string;
  logger: Logger;
}): Promise<boolean> {
  const { ghClient, repo, issueNumber, logger } = opts;
  let labels: string[];
  try {
    labels = (await ghClient.getIssue(repo, issueNumber)).labels ?? [];
  } catch (err) {
    logger.warn("Could not read the labels for the negative-result check", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!labels.includes(NEGATIVE_RESULT_LABEL)) return false;
  try {
    await ghClient.closeIssue(
      repo,
      issueNumber,
      buildNegativeResultCloseComment(),
    );
  } catch (err) {
    logger.warn("Failed to close the negative-result issue", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  try {
    await ghClient.unassignIssue(repo, issueNumber, [opts.githubUser]);
  } catch (err) {
    logger.warn("Failed to unassign the closed negative-result issue", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info("Negative result recorded — closed the issue (Issue #4298)", {
    repo,
    issueNumber,
  });
  return true;
}
