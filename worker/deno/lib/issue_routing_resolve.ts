import { sameRepo } from "./issue_routing_classifier.ts";
import { requireWriteAccess } from "./issue_routing_github.ts";
import {
  isRepoFastFailureIssue,
  isRepoFastFailureTallyIssue,
} from "./repo_fast_failure_issue.ts";
import type { Gh, IssueRoutingContext } from "./issue_routing_types.ts";
import type { Logger } from "../types.ts";

/**
 * Close a wrong-repository duplicate in favour of the correct issue.
 *
 * Strict order: verify the correct issue, check the wrong one is not a
 * diagnostic, check permission, comment on both, and only then close. Any
 * earlier failure throws with nothing closed. Nothing is deleted and no
 * label or assignee is touched.
 *
 * A dry run performs the same reads and permission checks and stops just
 * before the first write, so it reports what a live run would refuse.
 */
export async function resolveWrongRepoDuplicate(args: {
  wrong: { repo: string; number: number };
  correct: { repo: string; number: number };
  ctx: IssueRoutingContext;
  gh: Gh;
  logger: Logger;
}): Promise<{ closedWrong: boolean; reason: string }> {
  const { wrong, correct, ctx, gh, logger } = args;
  const wrongText = `${wrong.repo}#${wrong.number}`;
  const correctText = `${correct.repo}#${correct.number}`;

  // 1. The correct issue must exist.
  let correctRaw: string;
  try {
    correctRaw = await gh([
      "issue",
      "view",
      String(correct.number),
      "--repo",
      correct.repo,
      "--json",
      "number,state",
    ]);
  } catch (err) {
    throw new Error(
      `Correct issue ${correctText} could not be verified; ${wrongText} ` +
        `left open: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  let correctView: { number?: number };
  try {
    correctView = JSON.parse(correctRaw) as { number?: number };
  } catch (err) {
    throw new Error(
      `Malformed JSON from gh issue view (${correctText}): ${err}`,
      {
        cause: err,
      },
    );
  }
  if (correctView.number !== correct.number) {
    throw new Error(`Correct issue ${correctText} not found; nothing closed`);
  }

  // 2. A diagnostic is never closed (#2592).
  let wrongRaw: string;
  try {
    wrongRaw = await gh([
      "issue",
      "view",
      String(wrong.number),
      "--repo",
      wrong.repo,
      "--json",
      "body,state",
    ]);
  } catch (err) {
    throw new Error(
      `Could not read ${wrongText}; nothing closed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  let wrongView: { body?: string; state?: string };
  try {
    wrongView = JSON.parse(wrongRaw) as { body?: string; state?: string };
  } catch (err) {
    throw new Error(
      `Malformed JSON from gh issue view (${wrongText}): ${err}`,
      {
        cause: err,
      },
    );
  }
  const wrongBody = wrongView.body ?? "";
  if (
    isRepoFastFailureIssue(wrongBody, wrong.repo) ||
    isRepoFastFailureTallyIssue(wrongBody, wrong.repo)
  ) {
    return {
      closedWrong: false,
      reason: `${wrongText} carries a fast-failure marker: repo-scoped ` +
        "diagnostic exception (#2592), not closed",
    };
  }
  if ((wrongView.state ?? "").toUpperCase() === "CLOSED") {
    return { closedWrong: false, reason: `${wrongText} is already closed` };
  }

  // 3. Permission before any write.
  await requireWriteAccess(wrong.repo, ctx, gh);
  if (!sameRepo(correct.repo, wrong.repo)) {
    await requireWriteAccess(correct.repo, ctx, gh);
  }

  // 4. A dry run stops here, before the first write.
  if (ctx.dryRun) {
    return {
      closedWrong: false,
      reason: `dry-run: would link and close ${wrongText} in favour of ` +
        correctText,
    };
  }

  // 5. Link both, then close the wrong one last.
  await gh([
    "issue",
    "comment",
    String(correct.number),
    "--repo",
    correct.repo,
    "--body",
    `Duplicate filed in the wrong repository: ${wrongText}. This is the ` +
    "owning issue.",
  ]);
  await gh([
    "issue",
    "comment",
    String(wrong.number),
    "--repo",
    wrong.repo,
    "--body",
    `Filed in the wrong repository. Tracked in ${correctText}.`,
  ]);
  await gh([
    "issue",
    "close",
    String(wrong.number),
    "--repo",
    wrong.repo,
    "--comment",
    `Closing as a wrong-repository duplicate of ${correctText}.`,
    "--reason",
    "not planned",
  ]);
  logger.info(`Issue routing: closed ${wrongText} in favour of ${correctText}`);
  return {
    closedWrong: true,
    reason: `closed ${wrongText} as a wrong-repository duplicate of ` +
      correctText,
  };
}
