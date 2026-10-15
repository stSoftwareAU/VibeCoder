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
const REVIEW_COMMENT_ID = 4343;
const HOLD_TEXT = "Held: a pre-PR verifier finding survived the recovery turn.";

const RELEASABLE_BODY = `${prePrVerifierHeldMarkerLine(true)}\n${HOLD_TEXT}`;
const NOT_RELEASABLE_MARKER = prePrVerifierHeldMarkerLine(false);
const NON_RELEASABLE_BODY = `${NOT_RELEASABLE_MARKER}\n${HOLD_TEXT}`;

interface CommentFixture {
  login: string;
  body: string;
  /** Count of 👀 reactions on the comment. */
  eyes?: number;
  /** Count of 👍 reactions on the comment. */
  thumbs_up?: number;
}

/** What the fake gh serves for one PR. */
interface GhFixture {
  /** The PR's top-level issue comment, when there is one. */
  issue?: CommentFixture;
  /** The PR's inline review comment, when there is one. */
  review?: CommentFixture;
  /** Logins that left a 👀 on the issue comment. */
  eyesReactors?: string[];
}

/** One `info` call the scan made, with its structured context. */
interface InfoRecord {
  message: string;
  context: unknown;
}

function makeLogger(infos: InfoRecord[]): Logger {
  const noop = () => {};
  return {
    debug: noop,
    info: (message: string, context?: unknown) => {
      infos.push({ message, context });
    },
    warn: noop,
    error: noop,
    security: noop,
  } as unknown as Logger;
}

function commentEntry(
  comment: CommentFixture,
  id: number,
): Record<string, unknown> {
  return {
    login: comment.login,
    id,
    body: comment.body,
    thumbs_up: comment.thumbs_up ?? 0,
    eyes: comment.eyes ?? 0,
  };
}

/**
 * gh mock: one open PR with the fixture's comments. Every request to a
 * reactions endpoint is recorded in `reactionRequests`.
 */
function makeGh(
  fixture: GhFixture,
  reactionRequests: string[],
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/reactions")) reactionRequests.push(key);
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
      const entries = fixture.issue
        ? [commentEntry(fixture.issue, COMMENT_ID)]
        : [];
      return Promise.resolve(JSON.stringify(entries));
    }
    if (key.includes(`pulls/${PR_NUMBER}/comments`)) {
      const entries = fixture.review
        ? [commentEntry(fixture.review, REVIEW_COMMENT_ID)]
        : [];
      return Promise.resolve(JSON.stringify(entries));
    }
    if (key.includes(`issues/comments/${COMMENT_ID}/reactions`)) {
      return Promise.resolve(JSON.stringify(fixture.eyesReactors ?? []));
    }
    return Promise.resolve("[]");
  };
}

/** Scan options: nobody is an authorised commenter, so only the hold can act. */
function scanOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: Logger,
): PrScanOptions {
  return {
    githubUser: OWN,
    repos: ["org/repo"],
    logger,
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => false,
    ghCommandFn,
    prAuthors: [SIBLING],
  };
}

interface ScanRun {
  value: PrCommentToFix | null;
  infos: InfoRecord[];
  reactionRequests: string[];
}

async function scan(fixture: GhFixture): Promise<ScanRun> {
  const infos: InfoRecord[] = [];
  const reactionRequests: string[] = [];
  const result = await findPrCommentsToFix(
    scanOptions(makeGh(fixture, reactionRequests), makeLogger(infos)),
  );
  if (!result.ok) throw new Error("the PR-feedback scan must succeed");
  return { value: result.value, infos, reactionRequests };
}

/** The `trustReason` the scan logged for the comment it returned. */
function trustReasonOf(infos: InfoRecord[]): unknown {
  const found = infos.find((r) => r.message === "Found actionable PR comment");
  if (!found) throw new Error("the scan did not log the actionable comment");
  return (found.context as { trustReason?: unknown }).trustReason;
}

Deno.test("findPrCommentsToFix - a releasable verifier hold on the worker's own comment is actionable (Issue #3697)", async () => {
  const run = await scan({ issue: { login: OWN, body: RELEASABLE_BODY } });
  const value = run.value;
  assert(value, "the held-PR comment must be returned");
  assertEquals(value.prNumber, PR_NUMBER);
  assertEquals(value.commentId, String(COMMENT_ID));
  assertEquals(value.commentAuthor, OWN);
  assertEquals(value.releasesVerifierHold, true);
  assertEquals(
    trustReasonOf(run.infos),
    "verifier-hold",
    "the comment is actionable through the verifier-hold path",
  );
});

Deno.test("findPrCommentsToFix - a non-releasable verifier hold is actionable but does not release the hold (Issue #3697)", async () => {
  const run = await scan({ issue: { login: OWN, body: NON_RELEASABLE_BODY } });
  const value = run.value;
  assert(value, "the held-PR comment must be returned");
  assertEquals(value.commentId, String(COMMENT_ID));
  assert(
    value.releasesVerifierHold !== true,
    "a hold that is not releasable must not release the label",
  );
});

Deno.test("findPrCommentsToFix - the worker's own comment without the marker is still skipped (Issue #3697)", async () => {
  const run = await scan({
    issue: { login: OWN, body: `Ordinary progress note.\n${HOLD_TEXT}` },
  });
  assertEquals(run.value, null);
});

Deno.test("findPrCommentsToFix - a verifier hold from a sibling fleet author is actionable (Issue #3697)", async () => {
  const run = await scan({ issue: { login: SIBLING, body: RELEASABLE_BODY } });
  const value = run.value;
  assert(value, "a sibling fleet author's held-PR comment must be returned");
  assertEquals(value.commentAuthor, SIBLING);
  assertEquals(value.releasesVerifierHold, true);
  assertEquals(trustReasonOf(run.infos), "verifier-hold");
});

Deno.test("findPrCommentsToFix - a verifier-shaped comment from a non-fleet, non-authorised author is ignored (Issue #3697)", async () => {
  const run = await scan({ issue: { login: STRANGER, body: RELEASABLE_BODY } });
  assertEquals(run.value, null);
});

Deno.test("findPrCommentsToFix - the marker must open the worker's own comment to count (Issue #3697)", async () => {
  const run = await scan({
    issue: {
      login: OWN,
      body: `x\n${prePrVerifierHeldMarkerLine(true)}\n${HOLD_TEXT}`,
    },
  });
  assertEquals(run.value, null);
});

Deno.test("findPrCommentsToFix - a held-PR comment a fleet 👀 already marked processed is not acted on again (Issue #3697)", async () => {
  const run = await scan({
    issue: { login: OWN, body: RELEASABLE_BODY, eyes: 1 },
    eyesReactors: [SIBLING],
  });
  assertEquals(run.value, null);
});

Deno.test("findPrCommentsToFix - the worker's own inline review comment with the marker is not a held PR (Issue #3697)", async () => {
  const run = await scan({ review: { login: OWN, body: RELEASABLE_BODY } });
  assertEquals(
    run.value,
    null,
    "the verifier hold is read from top-level issue comments only",
  );
});

Deno.test("findPrCommentsToFix - a held PR comment with a thumbs-up makes no reactions call (Issue #3697)", async () => {
  const run = await scan({
    issue: { login: OWN, body: RELEASABLE_BODY, thumbs_up: 2 },
  });
  const value = run.value;
  assert(value, "the held-PR comment must still be returned");
  assertEquals(value.releasesVerifierHold, true);
  assertEquals(
    run.reactionRequests,
    [],
    "a held comment is trusted by its marker, so no reactors are looked up",
  );
});
