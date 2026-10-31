/**
 * A CHANGES_REQUESTED review is never superseded by a fleet commit (Issues
 * #2702, #4510).
 *
 * Issue #2702 made a real fleet fix commit after a review supersede it. On
 * NEAT-AI-Discovery#2443 that rule wrongly retired a review: a CI-fix pass
 * pushed a single-parent fleet commit after the owner's review (Issue #4510).
 * A CI-fix pass never answers a review, so the rule is gone. A review is now
 * retired only by dismissal (the processed marker, Issue #3383) or by the
 * reviewer's own later review (Issue #2697), and held while a pr_review claim
 * lease is live.
 *
 * The base-merge and bot-bump shapes below are the ones GitHub reported for
 * stSoftwareAU/GRQ#5032 (Issue #2702): the base merge is authored by the fleet
 * account and committed by `web-flow`; the bump is authored and committed by
 * `github-actions[bot]`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import type { CommitProvenance } from "../lib/pr_feedback_supersede.ts";
import { findPrCommentsToFix } from "../lib/pr_maintenance.ts";
import type { PrScanOptions } from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";

const REPO = "org/repo";
const PR_NUMBER = 5032;
const BRANCH = "issue-5009-domain-observations";
const REVIEWED_SHA = "90a3c712f78629aeabfd1e79cd47e70c8fedb428";
const HEAD_SHA = "2d93ae7a134df55d07bb5fd406f1212b51780672";
const OWNER = "nleck";
const FLEET = ["VibeCoderST", "stservice"];
const REVIEW_ID = 5329190250;
const REVIEW_SUBMITTED_AT = "2026-09-27T06:47:59Z";

/** The fix the fleet pushed before the review was written. */
const EARLIER_FLEET_FIX: CommitProvenance = {
  authorLogin: "VibeCoderST",
  committerLogin: "VibeCoderST",
  committedAt: "2026-09-27T06:16:50Z",
};

/** `Develop` merged in by a fleet host through the update-branch call. */
const BASE_MERGE: CommitProvenance = {
  authorLogin: "stservice",
  committerLogin: "web-flow",
  committedAt: "2026-09-27T07:18:10Z",
};

/** The github-actions version bump that followed the merge. */
const BOT_BUMP: CommitProvenance = {
  authorLogin: "github-actions[bot]",
  committerLogin: "github-actions[bot]",
  committedAt: "2026-09-27T07:19:19Z",
};

/**
 * A single-parent fleet CI-fix commit pushed after the review. It has the
 * shape of NEAT-AI-Discovery#2443 commit 68b68f41, which wrongly superseded a
 * CHANGES_REQUESTED review before Issue #4510.
 */
const CI_FIX_AFTER_REVIEW: CommitProvenance = {
  authorLogin: "VibeCoderST",
  committerLogin: "VibeCoderST",
  committedAt: "2026-09-27T07:30:00Z",
};

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** The gh calls that read the PR's commit history. */
function commitHistoryReads(calls: readonly string[]): string[] {
  return calls.filter((call) => call.includes(`pulls/${PR_NUMBER}/commits`));
}

/**
 * One PR whose only feedback is the owner's CHANGES_REQUESTED review, on a
 * commit that is no longer the head. The mocked history `commits` is served
 * if read, so a test can assert the scan never reads it.
 */
function makeScanOptions(
  commits: readonly CommitProvenance[],
  calls: string[],
  reviewCommitId = REVIEWED_SHA,
): PrScanOptions {
  const ghCommandFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    calls.push(key);
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: PR_NUMBER, headRefName: BRANCH, headRefOid: HEAD_SHA },
      ]));
    }
    if (key.includes(`pulls/${PR_NUMBER}/reviews`)) {
      return Promise.resolve(JSON.stringify([{
        login: OWNER,
        id: REVIEW_ID,
        body: "Please drop the unrelated churn.",
        state: "CHANGES_REQUESTED",
        commit_id: reviewCommitId,
        submitted_at: REVIEW_SUBMITTED_AT,
      }]));
    }
    if (key.includes(`pulls/${PR_NUMBER}/commits`)) {
      // `gh api --paginate --jq '.[] | {…}'` prints one object per line.
      return Promise.resolve(
        commits.map((commit, i) => JSON.stringify({ sha: `c${i}`, ...commit }))
          .join("\n"),
      );
    }
    return Promise.resolve("[]");
  };
  return {
    githubUser: "VibeCoderST",
    repos: [REPO],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (login: string) => login === OWNER,
    prAuthors: FLEET,
    ghCommandFn,
  };
}

Deno.test("findPrCommentsToFix - a single-parent fleet CI-fix commit after the review leaves it actionable and the history unread (Issue #4510)", async () => {
  const calls: string[] = [];
  const result = await findPrCommentsToFix(
    makeScanOptions(
      [EARLIER_FLEET_FIX, BASE_MERGE, BOT_BUMP, CI_FIX_AFTER_REVIEW],
      calls,
    ),
  );

  assert(result.ok);
  assertEquals(result.value?.commentType, "pr_review");
  assertEquals(result.value?.commentId, String(REVIEW_ID));
  assertEquals(
    commitHistoryReads(calls),
    [],
    "the commit history is never read",
  );
});

Deno.test("findPrCommentsToFix - a review followed only by a base merge and a bot bump stays actionable and the history unread (Issues #2702, #4510)", async () => {
  const calls: string[] = [];
  const result = await findPrCommentsToFix(
    makeScanOptions([EARLIER_FLEET_FIX, BASE_MERGE, BOT_BUMP], calls),
  );

  assert(result.ok);
  assertEquals(result.value?.commentType, "pr_review");
  assertEquals(result.value?.commentId, String(REVIEW_ID));
  assertEquals(
    commitHistoryReads(calls),
    [],
    "the commit history is never read",
  );
});

Deno.test("findPrCommentsToFix - a review on the current head is actionable without reading the history (Issues #2702, #4510)", async () => {
  const calls: string[] = [];
  const result = await findPrCommentsToFix(
    makeScanOptions([], calls, HEAD_SHA),
  );

  assert(result.ok);
  assertEquals(result.value?.commentId, String(REVIEW_ID));
  assertEquals(commitHistoryReads(calls), []);
});
