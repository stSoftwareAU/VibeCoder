/**
 * A CHANGES_REQUESTED review is superseded only by a real fleet fix commit
 * (Issue #2702).
 *
 * On stSoftwareAU/GRQ#5032 the owner requested changes at 06:47. A fleet host
 * then merged `Develop` into the PR branch through the update-branch call
 * (07:18) and a github-actions version bump followed (07:19). The scan skipped
 * every review whose `commit_id` was not the current head, so a review nobody
 * had answered could never be reached again.
 *
 * The commit shapes below are the ones GitHub reported for that PR: the base
 * merge is authored by the fleet account, committed by `web-flow`, and has two
 * parents; the bump is authored and committed by `github-actions[bot]`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CommitProvenance,
  isReviewSupersededByFleetFix,
} from "../lib/pr_feedback_supersede.ts";
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
  parentCount: 1,
};

/** `Develop` merged in by a fleet host through the update-branch call. */
const BASE_MERGE: CommitProvenance = {
  authorLogin: "stservice",
  committerLogin: "web-flow",
  committedAt: "2026-09-27T07:18:10Z",
  parentCount: 2,
};

/** The github-actions version bump that followed the merge. */
const BOT_BUMP: CommitProvenance = {
  authorLogin: "github-actions[bot]",
  committerLogin: "github-actions[bot]",
  committedAt: "2026-09-27T07:19:19Z",
  parentCount: 1,
};

/** A fleet commit that actually answers the review. */
const FLEET_FIX_AFTER_REVIEW: CommitProvenance = {
  authorLogin: "VibeCoderST",
  committerLogin: "VibeCoderST",
  committedAt: "2026-09-27T07:30:00Z",
  parentCount: 1,
};

function makeSilentLogger(infos: string[] = []): Logger {
  const noop = () => {};
  return {
    info: (message: string) => {
      infos.push(message);
    },
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

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

Deno.test("isReviewSupersededByFleetFix - a base merge and a bot bump leave the review actionable", () => {
  assertEquals(
    isReviewSupersededByFleetFix({
      reviewSubmittedAt: REVIEW_SUBMITTED_AT,
      commits: [EARLIER_FLEET_FIX, BASE_MERGE, BOT_BUMP],
      fleetAuthors: FLEET,
    }),
    false,
  );
});

Deno.test("isReviewSupersededByFleetFix - a fleet fix after the review supersedes it", () => {
  assertEquals(
    isReviewSupersededByFleetFix({
      reviewSubmittedAt: REVIEW_SUBMITTED_AT,
      commits: [
        EARLIER_FLEET_FIX,
        BASE_MERGE,
        BOT_BUMP,
        FLEET_FIX_AFTER_REVIEW,
      ],
      fleetAuthors: FLEET,
    }),
    true,
  );
});

Deno.test("isReviewSupersededByFleetFix - a fleet fix from before the review does not supersede it", () => {
  assertEquals(
    isReviewSupersededByFleetFix({
      reviewSubmittedAt: REVIEW_SUBMITTED_AT,
      commits: [EARLIER_FLEET_FIX],
      fleetAuthors: FLEET,
    }),
    false,
  );
});

Deno.test("isReviewSupersededByFleetFix - a human's push is not the fleet answering the review", () => {
  assertEquals(
    isReviewSupersededByFleetFix({
      reviewSubmittedAt: REVIEW_SUBMITTED_AT,
      commits: [{
        ...FLEET_FIX_AFTER_REVIEW,
        authorLogin: OWNER,
        committerLogin: OWNER,
      }],
      fleetAuthors: FLEET,
    }),
    false,
  );
});

Deno.test("isReviewSupersededByFleetFix - unknown data fails closed to actionable", () => {
  for (
    const input of [
      { reviewSubmittedAt: undefined, commits: [FLEET_FIX_AFTER_REVIEW] },
      { reviewSubmittedAt: "not a date", commits: [FLEET_FIX_AFTER_REVIEW] },
      { reviewSubmittedAt: REVIEW_SUBMITTED_AT, commits: null },
      {
        reviewSubmittedAt: REVIEW_SUBMITTED_AT,
        commits: [{ ...FLEET_FIX_AFTER_REVIEW, committedAt: null }],
      },
    ]
  ) {
    assertEquals(
      isReviewSupersededByFleetFix({ ...input, fleetAuthors: FLEET }),
      false,
      JSON.stringify(input),
    );
  }
});

// ---------------------------------------------------------------------------
// Composition: the scan itself (findPrCommentsToFix)
// ---------------------------------------------------------------------------

/**
 * One PR whose only feedback is the owner's CHANGES_REQUESTED review, on a
 * commit that is no longer the head, followed by `commits`.
 */
function makeScanOptions(
  commits: readonly CommitProvenance[] | "unreadable",
  calls: string[],
  infos: string[] = [],
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
        commit_id: reviewCommitId,
        submitted_at: REVIEW_SUBMITTED_AT,
      }]));
    }
    if (key.includes(`pulls/${PR_NUMBER}/commits`)) {
      if (commits === "unreadable") return Promise.reject(new Error("502"));
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
    logger: makeSilentLogger(infos),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (login: string) => login === OWNER,
    prAuthors: FLEET,
    ghCommandFn,
  };
}

Deno.test("findPrCommentsToFix - a review followed only by a base merge and a bot bump stays actionable (Issue #2702)", async () => {
  const calls: string[] = [];
  const result = await findPrCommentsToFix(
    makeScanOptions([EARLIER_FLEET_FIX, BASE_MERGE, BOT_BUMP], calls),
  );

  assert(result.ok);
  assertEquals(result.value?.commentType, "pr_review");
  assertEquals(result.value?.commentId, String(REVIEW_ID));
  assertEquals(
    calls.filter((call) => call.includes(`pulls/${PR_NUMBER}/commits`)).length,
    1,
    "the commit history is read once",
  );
});

Deno.test("findPrCommentsToFix - a review followed by a real fleet fix is superseded, and the skip is logged at info (Issue #2702)", async () => {
  const calls: string[] = [];
  const infos: string[] = [];
  const result = await findPrCommentsToFix(
    makeScanOptions(
      [BASE_MERGE, FLEET_FIX_AFTER_REVIEW, BOT_BUMP],
      calls,
      infos,
    ),
  );

  assert(result.ok);
  assertEquals(result.value, null);
  assert(
    infos.some((message) => message.includes("CHANGES_REQUESTED review")),
    `expected an info-level skip line, got: ${JSON.stringify(infos)}`,
  );
});

Deno.test("findPrCommentsToFix - a review on the current head is actionable without reading the history (Issue #2702)", async () => {
  const calls: string[] = [];
  const result = await findPrCommentsToFix(
    makeScanOptions([], calls, [], HEAD_SHA),
  );

  assert(result.ok);
  assertEquals(result.value?.commentId, String(REVIEW_ID));
  assertEquals(
    calls.filter((call) => call.includes(`pulls/${PR_NUMBER}/commits`)),
    [],
  );
});

Deno.test("findPrCommentsToFix - an unreadable history never drops the review (Issue #2702)", async () => {
  const result = await findPrCommentsToFix(
    makeScanOptions("unreadable", []),
  );

  assert(result.ok);
  assertEquals(result.value?.commentId, String(REVIEW_ID));
});
