/**
 * A `pr_review` claim is a lease, not a dismissal (Issue #3383): the scan
 * must not surface a CHANGES_REQUESTED review that a fleet host still holds
 * a live claim lease on, but must surface one whose lease has lapsed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  findPrCommentsToFix,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import { PR_REVIEW_CLAIM_LEASE_MS } from "../lib/pr_review_claim_lease.ts";
import type { Logger } from "../types.ts";

interface Captured {
  logger: Logger;
  infos: string[];
  warns: string[];
}

function makeCapturingLogger(): Captured {
  const infos: string[] = [];
  const warns: string[] = [];
  const noop = () => {};
  return {
    infos,
    warns,
    logger: {
      info: (msg: string) => infos.push(msg),
      warn: (msg: string) => warns.push(msg),
      error: noop,
      debug: noop,
      security: noop,
      skipReason: noop,
      timing: noop,
      scanSummary: noop,
      workerSummary: noop,
    },
  };
}

const REVIEW_ID = 700;

const CHANGES_REQUESTED = {
  login: "maintainer",
  id: REVIEW_ID,
  body: "Please rename the helper.",
  state: "CHANGES_REQUESTED",
  submitted_at: "2026-09-01T00:00:00Z",
  commit_id: "shaA",
};

/** Build a claim comment row for the paginated comments read. */
function claimRow(
  id: number,
  worker: string,
  author: string,
  updatedAt: string,
  extraBody = "",
): unknown {
  const createdAt = updatedAt;
  return {
    id,
    body: `<!-- PR_COMMENT_CLAIM:${worker}:${REVIEW_ID} -->\n` +
      `Claiming PR feedback comment ${REVIEW_ID} for worker \`${worker}\`.\n` +
      `<!-- PR_COMMENT_CLAIM_LEASE:${createdAt} -->${extraBody}`,
    created_at: createdAt,
    updated_at: updatedAt,
    author,
  };
}

/**
 * One PR at head `shaA` whose only review is `CHANGES_REQUESTED`, with a
 * paginated comments thread of `commentRows` (an array, or a raw string for
 * a deliberately-broken read).
 */
function makeGh(
  commentRows: unknown[] | string,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: 42, headRefName: "issue-42-fix", headRefOid: "shaA" },
      ]));
    }
    if (key.includes("pulls/42/reviews")) {
      return Promise.resolve(JSON.stringify([CHANGES_REQUESTED]));
    }
    if (key.includes("issues/42/comments")) {
      if (typeof commentRows === "string") {
        return Promise.reject(new Error(commentRows));
      }
      return Promise.resolve(JSON.stringify(commentRows));
    }
    return Promise.resolve("[]");
  };
}

function options(
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: Logger,
): PrScanOptions {
  return {
    githubUser: "testbot",
    repos: ["org/repo"],
    logger,
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (login: string) => login === "maintainer",
    ghCommandFn,
  };
}

Deno.test("findPrCommentsToFix - a live fleet lease claim hides the review and the skip is logged (Issue #3383)", async () => {
  const { logger, infos } = makeCapturingLogger();
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
  const result = await findPrCommentsToFix(
    options(makeGh([claimRow(1, "testbot", "testbot", oneMinAgo)]), logger),
  );

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
  assertEquals(
    infos.some((m) =>
      m.includes(String(REVIEW_ID)) && m.includes("live claim")
    ),
    true,
    `expected an INFO skip line, got: ${infos.join(" | ")}`,
  );
});

Deno.test("findPrCommentsToFix - a lapsed lease is actionable again, even with a failed-once marker left behind (Issue #3383)", async () => {
  const { logger } = makeCapturingLogger();
  const lapsed = new Date(Date.now() - PR_REVIEW_CLAIM_LEASE_MS - 60_000)
    .toISOString();
  const failedOnceMarker = {
    id: 2,
    body: `<!-- PR_REVIEW_FAILED_ONCE:${REVIEW_ID} -->`,
    created_at: lapsed,
    updated_at: lapsed,
    author: "testbot",
  };
  const result = await findPrCommentsToFix(
    options(
      makeGh([claimRow(1, "testbot", "testbot", lapsed), failedOnceMarker]),
      logger,
    ),
  );

  assertEquals(result.ok, true);
  if (!result.ok || !result.value) throw new Error("expected the review");
  assertEquals(result.value.commentType, "pr_review");
  assertEquals(result.value.commentId, String(REVIEW_ID));
});

Deno.test("findPrCommentsToFix - a live lease posted by a stranger does not hide the review (Issue #3383)", async () => {
  const { logger } = makeCapturingLogger();
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
  const result = await findPrCommentsToFix(
    options(makeGh([claimRow(1, "attacker", "attacker", oneMinAgo)]), logger),
  );

  assertEquals(result.ok, true);
  if (!result.ok || !result.value) throw new Error("expected the review");
  assertEquals(result.value.commentType, "pr_review");
  assertEquals(result.value.commentId, String(REVIEW_ID));
});

Deno.test("findPrCommentsToFix - no claim comments leaves the review actionable (Issue #3383)", async () => {
  const { logger } = makeCapturingLogger();
  const result = await findPrCommentsToFix(options(makeGh([]), logger));

  assertEquals(result.ok, true);
  if (!result.ok || !result.value) throw new Error("expected the review");
  assertEquals(result.value.commentType, "pr_review");
  assertEquals(result.value.commentId, String(REVIEW_ID));
});

Deno.test("findPrCommentsToFix - an unreadable comments thread leaves the review actionable and warns (Issue #3383)", async () => {
  const { logger, warns } = makeCapturingLogger();
  const result = await findPrCommentsToFix(
    options(makeGh("comments read failed"), logger),
  );

  assertEquals(result.ok, true);
  if (!result.ok || !result.value) throw new Error("expected the review");
  assertEquals(result.value.commentType, "pr_review");
  assertEquals(result.value.commentId, String(REVIEW_ID));
  assertEquals(
    warns.some((m) => m.includes(String(REVIEW_ID))),
    true,
    `expected a warning, got: ${warns.join(" | ")}`,
  );
});
