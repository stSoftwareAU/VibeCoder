/**
 * Tests for the pre-PR verifier held-PR comment as an actionable PR-feedback
 * comment (Issue #3697). A held PR's comment is read by the scan when it is
 * the worker's own or a fleet author's, and its body opens with the marker.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { findPrCommentsToFix } from "../lib/pr_maintenance.ts";
import type { PrScanOptions } from "../lib/pr_maintenance.ts";
import type { PrCommentToFix } from "../lib/pr_comments.ts";
import { prePrVerifierHeldMarkerLine } from "../lib/pre_pr_verifier_hold.ts";
import type { Logger } from "../types.ts";

const OWN = "testbot";
const SIBLING = "sibling-bot";
const STRANGER = "stranger";
const PR_NUMBER = 10;
const COMMENT_ID = 4242;
const HOLD_TEXT = "Held: a pre-PR verifier finding survived the recovery turn.";

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
  } as unknown as Logger;
}

interface CommentFixture {
  login: string;
  body: string;
  /** Count of 👀 reactions on the comment. */
  eyes?: number;
}

/**
 * gh mock: one open PR with one top-level issue comment. `eyesReactors` are
 * the logins that left a 👀 on that comment.
 */
function makeGh(
  comment: CommentFixture,
  eyesReactors: string[] = [],
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: PR_NUMBER,
          headRefName: "issue-10-fix",
          headRefOid: "abc123",
        },
      ]));
    }
    if (key.includes(`issues/${PR_NUMBER}/comments`)) {
      return Promise.resolve(JSON.stringify([
        {
          login: comment.login,
          id: COMMENT_ID,
          body: comment.body,
          thumbs_up: 0,
          eyes: comment.eyes ?? 0,
        },
      ]));
    }
    if (key.includes(`issues/comments/${COMMENT_ID}/reactions`)) {
      return Promise.resolve(JSON.stringify(eyesReactors));
    }
    return Promise.resolve("[]");
  };
}

/** Scan options: nobody is an authorised commenter, so only the hold can act. */
function scanOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
): PrScanOptions {
  return {
    githubUser: OWN,
    repos: ["org/repo"],
    logger: makeLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => false,
    ghCommandFn,
    prAuthors: [SIBLING],
  };
}

async function scanFor(
  comment: CommentFixture,
  eyesReactors: string[] = [],
): Promise<PrCommentToFix | null> {
  const result = await findPrCommentsToFix(
    scanOptions(makeGh(comment, eyesReactors)),
  );
  if (!result.ok) throw new Error("the PR-feedback scan must succeed");
  return result.value;
}

const RELEASABLE_BODY = `${prePrVerifierHeldMarkerLine(true)}\n${HOLD_TEXT}`;
const NOT_RELEASABLE_MARKER = prePrVerifierHeldMarkerLine(false);
const NON_RELEASABLE_BODY = `${NOT_RELEASABLE_MARKER}\n${HOLD_TEXT}`;

Deno.test("findPrCommentsToFix - a releasable verifier hold on the worker's own comment is actionable (Issue #3697)", async () => {
  const value = await scanFor({ login: OWN, body: RELEASABLE_BODY });
  assert(value, "the held-PR comment must be returned");
  assertEquals(value.prNumber, PR_NUMBER);
  assertEquals(value.commentId, String(COMMENT_ID));
  assertEquals(value.commentAuthor, OWN);
  assertEquals(value.releasesVerifierHold, true);
});

Deno.test("findPrCommentsToFix - a non-releasable verifier hold is actionable but does not release the hold (Issue #3697)", async () => {
  const value = await scanFor({ login: OWN, body: NON_RELEASABLE_BODY });
  assert(value, "the held-PR comment must be returned");
  assertEquals(value.commentId, String(COMMENT_ID));
  assert(
    value.releasesVerifierHold !== true,
    "a hold that is not releasable must not release the label",
  );
});

Deno.test("findPrCommentsToFix - the worker's own comment without the marker is still skipped (Issue #3697)", async () => {
  const value = await scanFor({
    login: OWN,
    body: `Ordinary progress note.\n${HOLD_TEXT}`,
  });
  assertEquals(value, null);
});

Deno.test("findPrCommentsToFix - a verifier hold from a sibling fleet author is actionable (Issue #3697)", async () => {
  const value = await scanFor({ login: SIBLING, body: RELEASABLE_BODY });
  assert(value, "a sibling fleet author's held-PR comment must be returned");
  assertEquals(value.commentAuthor, SIBLING);
  assertEquals(value.releasesVerifierHold, true);
});

Deno.test("findPrCommentsToFix - a verifier-shaped comment from a non-fleet, non-authorised author is ignored (Issue #3697)", async () => {
  const value = await scanFor({ login: STRANGER, body: RELEASABLE_BODY });
  assertEquals(value, null);
});

Deno.test("findPrCommentsToFix - the marker must open the worker's own comment to count (Issue #3697)", async () => {
  const value = await scanFor({
    login: OWN,
    body: `x\n${prePrVerifierHeldMarkerLine(true)}\n${HOLD_TEXT}`,
  });
  assertEquals(value, null);
});

Deno.test("findPrCommentsToFix - a held-PR comment a fleet 👀 already marked processed is not acted on again (Issue #3697)", async () => {
  const value = await scanFor(
    { login: OWN, body: RELEASABLE_BODY, eyes: 1 },
    [SIBLING],
  );
  assertEquals(value, null);
});
