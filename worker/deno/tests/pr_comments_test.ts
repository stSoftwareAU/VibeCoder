/**
 * Tests for pr_comments.ts — PR comment management (Issue #915).
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  checkPrCommentHasFailedOnce,
  formatPrCommentToFix,
  handlePrCommentFailure,
  markCommentProcessed,
  markPrCommentAsFailedOnce,
  prReviewFailedOnceMarker,
  replyToComment,
  REVIEW_DISMISSAL_MESSAGES,
  type ReviewDismissalOutcome,
} from "../lib/pr_comments.ts";
import type {
  AbandonRestartOutcome,
  AbandonRestartRequest,
} from "../lib/conflict_abandon_restart.ts";

/** Helper to create a mock gh command function that records calls. */
function createMockGh(): {
  calls: string[][];
  fn: (args: string[]) => Promise<string>;
} {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  return { calls, fn };
}

/**
 * Find a recorded `gh api` call by inspecting argv contents rather than
 * positional indices. This decouples assertions from the exact argv layout
 * (Issue #2433) — what matters is that the right endpoint was targeted with
 * the right HTTP method, not which slot each token sits in.
 */
function findApiCall(
  calls: string[][],
  predicate: (argv: string[]) => boolean,
): string[] | undefined {
  return calls.find((c) => c[0] === "api" && predicate(c));
}

/**
 * Find a recorded `gh pr comment <prNumber>` reply call irrespective of
 * the order in which it was issued or the position of `--repo` / `--body`.
 */
function findPrReplyCall(
  calls: string[][],
  prNumber: number,
): string[] | undefined {
  return calls.find(
    (c) => c[0] === "pr" && c[1] === "comment" && c[2] === String(prNumber),
  );
}

// --- markCommentProcessed ---

Deno.test("pr_comments - markCommentProcessed adds eyes reaction for review comments", async () => {
  const { calls, fn } = createMockGh();
  const result = await markCommentProcessed(
    "owner/repo",
    "review",
    "123",
    undefined,
    "addressed",
    fn,
  );
  assertEquals(result.ok, true);
  const reaction = findApiCall(
    calls,
    (c) =>
      c.includes("POST") &&
      c.includes("repos/owner/repo/pulls/comments/123/reactions") &&
      c.includes("content=eyes"),
  );
  assert(
    reaction,
    "should POST a `content=eyes` reaction to the review comment's reactions endpoint",
  );
});

Deno.test("pr_comments - markCommentProcessed adds eyes reaction for issue comments", async () => {
  const { calls, fn } = createMockGh();
  const result = await markCommentProcessed(
    "owner/repo",
    "issue",
    "456",
    undefined,
    "addressed",
    fn,
  );
  assertEquals(result.ok, true);
  const reaction = findApiCall(
    calls,
    (c) =>
      c.includes("POST") &&
      c.includes("repos/owner/repo/issues/comments/456/reactions") &&
      c.includes("content=eyes"),
  );
  assert(
    reaction,
    "should POST a `content=eyes` reaction to the issue comment's reactions endpoint",
  );
});

Deno.test("pr_comments - markCommentProcessed dismisses PR review", async () => {
  const { calls, fn } = createMockGh();
  const result = await markCommentProcessed(
    "owner/repo",
    "pr_review",
    "789",
    42,
    "addressed",
    fn,
  );
  assertEquals(result.ok, true);
  const dismissal = findApiCall(
    calls,
    (c) =>
      c.includes("PUT") &&
      c.includes("repos/owner/repo/pulls/42/reviews/789/dismissals"),
  );
  assert(
    dismissal,
    "should PUT a dismissal on the PR review's dismissals endpoint",
  );
});

/** The `message=` argument of the PR review dismissal call, if one was made. */
function dismissalMessage(calls: string[][]): string | undefined {
  const call = findApiCall(
    calls,
    (c) =>
      c.includes("PUT") &&
      c.includes("repos/owner/repo/pulls/42/reviews/789/dismissals"),
  );
  return call?.find((a) => a.startsWith("message="));
}

const EXPECTED_DISMISSAL_MESSAGES: Record<ReviewDismissalOutcome, string> = {
  addressed: "message=Changes have been addressed by the automated worker.",
  permanently_failed:
    "message=Not addressed after two automated attempts — see the PR thread.",
  rebuttal:
    "message=Answered with a rebuttal — no code change was made. See the PR thread.",
  handed_off:
    "message=Not addressed — handed off to a follow-up issue. See the PR thread.",
};

for (
  const outcome of Object.keys(EXPECTED_DISMISSAL_MESSAGES) as Array<
    ReviewDismissalOutcome
  >
) {
  Deno.test(`pr_comments - markCommentProcessed dismisses a PR review with the '${outcome}' message (Issue #3409)`, async () => {
    const { calls, fn } = createMockGh();
    const result = await markCommentProcessed(
      "owner/repo",
      "pr_review",
      "789",
      42,
      outcome,
      fn,
    );
    assertEquals(result.ok, true);
    assertEquals(dismissalMessage(calls), EXPECTED_DISMISSAL_MESSAGES[outcome]);
  });
}

Deno.test("pr_comments - only the 'addressed' dismissal claims the changes were made (Issue #3409)", () => {
  for (const [outcome, message] of Object.entries(REVIEW_DISMISSAL_MESSAGES)) {
    assertEquals(
      message.includes("Changes have been addressed"),
      outcome === "addressed",
      `outcome '${outcome}'`,
    );
  }
});

// --- replyToComment ---

Deno.test("pr_comments - replyToComment posts comment on PR", async () => {
  const { calls, fn } = createMockGh();
  const result = await replyToComment("owner/repo", 42, "Test message", fn);
  assertEquals(result.ok, true);
  const reply = findPrReplyCall(calls, 42);
  assert(reply, "should issue `gh pr comment 42` targeting PR #42");
  // The reply must carry the body and the repo, but not in a specific order.
  assert(
    reply!.includes("--repo") && reply!.includes("owner/repo"),
    "reply should pass --repo owner/repo",
  );
  assert(
    reply!.includes("--body") && reply!.includes("Test message"),
    "reply should pass --body with the supplied message",
  );
});

Deno.test("pr_comments - replyToComment returns error on failure", async () => {
  const fn = async (): Promise<string> => {
    throw new Error("API error");
  };
  const result = await replyToComment("owner/repo", 42, "Test", fn);
  assertEquals(result.ok, false);
});

// --- checkPrCommentHasFailedOnce ---

Deno.test("pr_comments - checkPrCommentHasFailedOnce returns true for a fleet reaction", async () => {
  // Issue #1249: the reaction is resolved to its reactor, so the stub returns
  // the reactions list rather than a bare count.
  const fn = async (_args: string[]): Promise<string> =>
    JSON.stringify(["vibe-bot"]);
  const result = await checkPrCommentHasFailedOnce(
    "owner/repo",
    "review",
    "123",
    fn,
    ["vibe-bot"],
  );
  assertEquals(result, true);
});

Deno.test("pr_comments - checkPrCommentHasFailedOnce returns false when nobody reacted", async () => {
  const fn = async (_args: string[]): Promise<string> => "[]";
  const result = await checkPrCommentHasFailedOnce(
    "owner/repo",
    "review",
    "123",
    fn,
    ["vibe-bot"],
  );
  assertEquals(result, false);
});

Deno.test("pr_comments - checkPrCommentHasFailedOnce returns false on API error", async () => {
  const fn = async (): Promise<string> => {
    throw new Error("not found");
  };
  const result = await checkPrCommentHasFailedOnce(
    "owner/repo",
    "review",
    "123",
    fn,
    ["vibe-bot"],
  );
  assertEquals(result, false);
});

Deno.test("pr_comments - checkPrCommentHasFailedOnce for pr_review without prNumber returns false and makes no gh call", async () => {
  const { calls, fn } = createMockGh();
  const result = await checkPrCommentHasFailedOnce(
    "owner/repo",
    "pr_review",
    "789",
    fn,
    ["vibe-bot"],
    // prNumber omitted deliberately — the marker lives on the PR thread, and
    // without a PR number there is nowhere to read it from.
  );
  assertEquals(result, false);
  assertEquals(calls.length, 0, "should make no gh call at all");
});

// --- markPrCommentAsFailedOnce ---

Deno.test("pr_comments - markPrCommentAsFailedOnce adds confused reaction and replies", async () => {
  const { calls, fn } = createMockGh();
  await markPrCommentAsFailedOnce(
    "owner/repo",
    42,
    "review",
    "123",
    "Something broke",
    fn,
  );
  // Observable behaviour: a `confused` reaction was POSTed against the review
  // comment, and a reply was posted on PR #42. Order between the two does not
  // matter for correctness, so do not assert on it.
  const reaction = findApiCall(
    calls,
    (c) =>
      c.includes("POST") &&
      c.includes("repos/owner/repo/pulls/comments/123/reactions") &&
      c.includes("content=confused"),
  );
  assert(
    reaction,
    "should POST a `content=confused` reaction to the review comment",
  );
  const reply = findPrReplyCall(calls, 42);
  assert(reply, "should post a reply on PR #42");
});

Deno.test("pr_comments - markPrCommentAsFailedOnce for issue still adds confused reaction and replies", async () => {
  const { calls, fn } = createMockGh();
  await markPrCommentAsFailedOnce(
    "owner/repo",
    42,
    "issue",
    "123",
    "Something broke",
    fn,
  );
  const reaction = findApiCall(
    calls,
    (c) =>
      c.includes("POST") &&
      c.includes("repos/owner/repo/issues/comments/123/reactions") &&
      c.includes("content=confused"),
  );
  assert(
    reaction,
    "should POST a `content=confused` reaction to the issue comment",
  );
  const reply = findPrReplyCall(calls, 42);
  assert(reply, "should post a reply on PR #42");
});

Deno.test("pr_comments - markPrCommentAsFailedOnce for pr_review never touches reactions, and the reply carries the marker", async () => {
  const { calls, fn } = createMockGh();
  await markPrCommentAsFailedOnce(
    "owner/repo",
    42,
    "pr_review",
    "789",
    "Something broke",
    fn,
  );
  // A review has no `reactions` endpoint of its own (Issue #3383): a
  // `confused` reaction would land on the wrong resource, so none is made.
  const anyReactionCall = calls.some((c) =>
    c.some((a) => a.includes("/reactions"))
  );
  assertFalse(
    anyReactionCall,
    "should make no reaction call at all for a pr_review",
  );
  const reply = findPrReplyCall(calls, 42);
  assert(reply, "should post a reply on PR #42");
  assert(
    reply!.some((a) => a.includes(prReviewFailedOnceMarker("789"))),
    "reply body should carry the pr_review failed-once marker",
  );
});

Deno.test("pr_comments - markPrCommentAsFailedOnce tells a pr_review reader the review stays undismissed (Issue #3383)", async () => {
  const review = createMockGh();
  await markPrCommentAsFailedOnce(
    "owner/repo",
    42,
    "pr_review",
    "789",
    "Something broke",
    review.fn,
  );
  const reviewReply = findPrReplyCall(review.calls, 42)?.join(" ") ?? "";
  assert(
    reviewReply.includes("the review is left undismissed"),
    "a pr_review reply should say the review still requests changes",
  );
  assertFalse(
    reviewReply.includes("confused reaction added"),
    "a pr_review reply must not claim a reaction it never made",
  );

  const comment = createMockGh();
  await markPrCommentAsFailedOnce(
    "owner/repo",
    42,
    "issue",
    "123",
    "Something broke",
    comment.fn,
  );
  const commentReply = findPrReplyCall(comment.calls, 42)?.join(" ") ?? "";
  assert(
    commentReply.includes("confused reaction added"),
    "an issue-comment reply should still name the confused reaction",
  );
});

Deno.test("pr_comments - handlePrCommentFailure calls failedOnce for first failure", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    // Since Issue #1249 the failed-once marker is resolved to its reactor,
    // so the stub answers the reactions listing rather than a count.
    if (
      args.includes("--jq") &&
      args.some((a) => a.includes('select(.content == "confused")'))
    ) {
      return "[]"; // Nobody has marked it failed yet
    }
    return "";
  };
  await handlePrCommentFailure(
    "owner/repo",
    42,
    "review",
    "123",
    "Error occurred",
    fn,
    // Stated rather than resolved from the host's config, so the test does
    // not read whatever fleet the machine happens to have configured.
    ["vibe-bot"],
  );
  // Should have added confused reaction (first failure path)
  const reactionCalls = calls.filter((c) =>
    c.some((a) => a.includes("reactions"))
  );
  assertEquals(reactionCalls.length > 0, true);
});

/** Build a `gh` stub that answers the paginated marker-comment read. */
function createMarkerMockGh(
  markerPayload: () => string,
): { calls: string[][]; fn: (args: string[]) => Promise<string> } {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.some((a) => a.includes("/issues/42/comments"))) {
      return markerPayload();
    }
    return "";
  };
  return { calls, fn };
}

Deno.test("pr_comments - handlePrCommentFailure pr_review first failure: reply carries the marker, no dismissal, no reaction", async () => {
  const { calls, fn } = createMarkerMockGh(() => "[]");
  await handlePrCommentFailure(
    "owner/repo",
    42,
    "pr_review",
    "789",
    "Error occurred",
    fn,
    ["vibe-bot"],
  );
  const reply = findPrReplyCall(calls, 42);
  assert(reply, "should post a reply on PR #42");
  assert(
    reply!.some((a) => a.includes(prReviewFailedOnceMarker("789"))),
    "reply should carry the pr_review failed-once marker",
  );
  assertFalse(
    calls.some((c) => c.some((a) => a.includes("/dismissals"))),
    "first failure must not dismiss the review",
  );
  assertFalse(
    calls.some((c) => c.some((a) => a.includes("/reactions"))),
    "first failure must make no reaction call for a pr_review",
  );
});

Deno.test("pr_comments - handlePrCommentFailure pr_review: marker authored by a stranger is treated as first failure", async () => {
  const markerRow = JSON.stringify([{
    id: 1,
    body: prReviewFailedOnceMarker("789"),
    created_at: "2026-01-01T00:00:00Z",
    author: "a-stranger",
  }]);
  const { calls, fn } = createMarkerMockGh(() => markerRow);
  await handlePrCommentFailure(
    "owner/repo",
    42,
    "pr_review",
    "789",
    "Error occurred",
    fn,
    ["vibe-bot"],
  );
  assertFalse(
    calls.some((c) => c.some((a) => a.includes("/dismissals"))),
    "a stranger's marker must not count as the fleet's own",
  );
});

Deno.test("pr_comments - handlePrCommentFailure pr_review: marker for a different review id is treated as first failure", async () => {
  const markerRow = JSON.stringify([{
    id: 1,
    body: prReviewFailedOnceMarker("999"),
    created_at: "2026-01-01T00:00:00Z",
    author: "vibe-bot",
  }]);
  const { calls, fn } = createMarkerMockGh(() => markerRow);
  await handlePrCommentFailure(
    "owner/repo",
    42,
    "pr_review",
    "789",
    "Error occurred",
    fn,
    ["vibe-bot"],
  );
  assertFalse(
    calls.some((c) => c.some((a) => a.includes("/dismissals"))),
    "a different review's marker must not count towards this review",
  );
});

Deno.test("pr_comments - handlePrCommentFailure pr_review: a marker read that throws is treated as first failure, without throwing", async () => {
  const fn = async (args: string[]): Promise<string> => {
    if (args.some((a) => a.includes("/issues/42/comments"))) {
      throw new Error("API unreachable");
    }
    return "";
  };
  const calls: string[][] = [];
  const wrappedFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return await fn(args);
  };
  await handlePrCommentFailure(
    "owner/repo",
    42,
    "pr_review",
    "789",
    "Error occurred",
    wrappedFn,
    ["vibe-bot"],
  );
  assertFalse(
    calls.some((c) => c.some((a) => a.includes("/dismissals"))),
    "an unreadable marker thread must not be treated as a second failure",
  );
});

// --- second failure: abandon and redo (Issue #4304) ---

/**
 * A `gh` stub for a second failure: the failed-once marker is already there
 * (a fleet `confused` reaction, or the pr_review marker comment), and the PR
 * names its branches.
 */
function secondFailureGh(): {
  calls: string[][];
  fn: (args: string[]) => Promise<string>;
} {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (
      args.includes("--jq") &&
      args.some((a) => a.includes('select(.content == "confused")'))
    ) {
      return JSON.stringify(["vibe-bot"]);
    }
    if (args.some((a) => a.includes("/issues/42/comments"))) {
      return JSON.stringify([{
        id: 1,
        body: `${prReviewFailedOnceMarker("789")}\nsome text`,
        created_at: "2026-01-01T00:00:00Z",
        author: "vibe-bot",
      }]);
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({ headRefName: "issue-7-x", baseRefName: "main" });
    }
    return "";
  };
  return { calls, fn };
}

function recordingAbandon(
  outcome: AbandonRestartOutcome,
): {
  requests: AbandonRestartRequest[];
  fn: (request: AbandonRestartRequest) => Promise<AbandonRestartOutcome>;
} {
  const requests: AbandonRestartRequest[] = [];
  return {
    requests,
    fn: (request) => {
      requests.push(request);
      return Promise.resolve(outcome);
    },
  };
}

for (const commentType of ["review", "pr_review"] as const) {
  const id = commentType === "pr_review" ? "789" : "123";

  Deno.test(`pr_comments - a ${commentType} that fails twice closes the PR and redoes its issue, never "will not retry" (Issue #4304)`, async () => {
    const { calls, fn } = secondFailureGh();
    const abandon = recordingAbandon({
      outcome: "abandoned",
      issueNumber: 7,
      label: { kept: "work-on" },
    });
    await handlePrCommentFailure(
      "owner/repo",
      42,
      commentType,
      id,
      "Error again",
      fn,
      ["vibe-bot"],
      abandon.fn,
    );
    assertEquals(abandon.requests.length, 1);
    const request = abandon.requests[0]!;
    assertEquals(request.prNumber, 42);
    assertEquals(request.branchName, "issue-7-x");
    assertEquals(request.baseBranch, "main");
    assertEquals(request.reason?.kind, "stalled");
    // Marked processed so the closed PR's comment is not picked up again.
    const marked = commentType === "pr_review"
      ? calls.some((c) => c.some((a) => a.includes("/dismissals")))
      : calls.some((c) => c.some((a) => a === "content=eyes"));
    assert(marked, "the comment is marked processed once the PR is closed");
    const replies = calls.filter((c) => c[0] === "pr" && c[1] === "comment")
      .map((c) => c.join(" "));
    assertFalse(
      replies.some((r) =>
        r.includes("will not retry") || r.includes("clarified requirements")
      ),
      `no hand-back reply; got ${JSON.stringify(replies)}`,
    );
  });

  Deno.test(`pr_comments - a ${commentType} whose restart is declined stays unmarked for the next cycle (Issue #4304)`, async () => {
    const { calls, fn } = secondFailureGh();
    const abandon = recordingAbandon({
      outcome: "declined",
      reason: { kind: "other-open-pr", issueNumber: 7, prUrl: "u" },
    });
    await handlePrCommentFailure(
      "owner/repo",
      42,
      commentType,
      id,
      "Error again",
      fn,
      ["vibe-bot"],
      abandon.fn,
    );
    assertEquals(abandon.requests.length, 1);
    assertFalse(calls.some((c) => c.some((a) => a.includes("/dismissals"))));
    assertFalse(calls.some((c) => c.some((a) => a === "content=eyes")));
  });
}

Deno.test("pr_comments - the first-failure reply says what happens next without asking anyone to intervene (Issue #4304)", async () => {
  for (const commentType of ["review", "pr_review"] as const) {
    const { calls, fn } = createMockGh();
    await markPrCommentAsFailedOnce(
      "owner/repo",
      42,
      commentType,
      "123",
      "Something broke",
      fn,
    );
    const reply = findPrReplyCall(calls, 42)?.join(" ") ?? "";
    assertFalse(reply.toLowerCase().includes("manual intervention"), reply);
    assert(reply.includes("its issue redone"), reply);
  }
});

// --- formatPrCommentToFix ---

Deno.test("pr_comments - formatPrCommentToFix returns pipe-delimited string", () => {
  const result = formatPrCommentToFix({
    repo: "owner/repo",
    prNumber: 42,
    branchName: "fix-branch",
    commentType: "review",
    commentId: "123",
    encodedBody: "base64body",
  });
  assertEquals(result, "owner/repo|42|fix-branch|review|123|base64body");
});
