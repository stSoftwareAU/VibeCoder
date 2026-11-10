/**
 * A negative-result issue is handed to a human (Issue #4298, revised by Issue
 * #4911).
 *
 * A performance task whose benchmarks show no gain ends with a results comment
 * and the `negative-result` label, and no code change. The worker used to close
 * such an issue itself on the agent's own word, so a result that rested on
 * shared-host timings was retired without anyone checking it. The worker now
 * hands it to a human: it posts a `needs-human` escalation through the shared
 * helper, and the issue stays open but leaves the queue, because `needs-human`
 * is a blocking label, until someone decides. Labelled, it is handed off;
 * unlabelled, the ordinary no-change retry is untouched.
 *
 * The posted text names no VibeCoder issue number: it lands in the target
 * repository, where a bare `#N` links to an unrelated issue (Issue #4641). The
 * issue numbers for this change live in these comments and the logger only.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";
import {
  escalateToHuman,
  type EscalateToHumanDeps,
} from "./needs_human_escalation.ts";

/** The label a benchmark run applies when the change made no gain. */
export const NEGATIVE_RESULT_LABEL = "negative-result";

/** What the hand-off posts: a heading, the reason and the next step. */
export interface NegativeResultHandoff {
  heading: string;
  reason: string;
  nextStep: string;
}

/**
 * The hand-off text. It asserts no benchmark was run and no timing settled the
 * question: the evidence is whatever results earlier comments on the issue
 * record, and any shared-host timings in a legacy result are indicative only.
 */
export function buildNegativeResultHandoff(): NegativeResultHandoff {
  return {
    heading: "Negative result needs review",
    reason:
      `The run ended with the \`${NEGATIVE_RESULT_LABEL}\` label and no ` +
      "code change. The recorded negative-result evidence needs review before " +
      "the issue is closed. That evidence is the results recorded in earlier " +
      "comments on this issue, if there are any. Shared-host timings in a " +
      "legacy result, if present, are indicative only and do not settle the " +
      "issue.",
    nextStep: "Close the issue if the result stands, or remove `needs-human` " +
      `and \`${NEGATIVE_RESULT_LABEL}\`, then re-add \`work-on\` to send it back to the queue.`,
  };
}

/**
 * Hand the issue to a human when it carries {@link NEGATIVE_RESULT_LABEL}.
 *
 * Reads the labels fresh, because the run applied the label after the context
 * was built. The hand-off goes through `escalateToHuman`, so the label is only
 * added once the explanation is on the issue (Issue #2958). Best-effort: a read
 * or hand-off that fails is logged and reported as `false`, so the caller falls
 * through to its ordinary retry rather than losing the run's outcome.
 *
 * The issue is not closed here. The worker unassigns itself once the hand-off
 * lands, which leaves the queue; the human closes it or sends it back.
 *
 * @returns `true` when the issue was handed to a human.
 */
export async function handOffNegativeResultIssue(opts: {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  githubUser: string;
  needsHumanLabel: string;
  logger: Logger;
  deps?: EscalateToHumanDeps;
}): Promise<boolean> {
  const {
    ghClient,
    repo,
    issueNumber,
    githubUser,
    needsHumanLabel,
    logger,
    deps,
  } = opts;
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

  const handoff = buildNegativeResultHandoff();
  const outcome = await escalateToHuman({
    ghClient,
    repo,
    target: { kind: "issue", number: issueNumber },
    needsHumanLabel,
    reason: handoff.reason,
    nextStep: handoff.nextStep,
    heading: handoff.heading,
    dedupKey: `negative-result-handoff:${issueNumber}`,
    commentFirst: true,
    githubUser,
    logger,
    deps,
  });
  if (!outcome.ok) {
    logger.warn("Failed to hand the negative-result issue to a human", {
      repo,
      issueNumber,
      error: outcome.error.message,
    });
    return false;
  }
  if (!outcome.value.labelAdded) {
    logger.warn(
      "The negative-result hand-off added no needs-human label — retrying instead",
      { repo, issueNumber },
    );
    return false;
  }
  try {
    await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
  } catch (err) {
    logger.warn("Failed to unassign the handed-off negative-result issue", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info(
    "Negative result handed to a human for review (Issue #4298, Issue #4911)",
    { repo, issueNumber, dedupSkipped: outcome.value.dedupSkipped },
  );
  return true;
}
