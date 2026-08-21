/**
 * Fleet-push supersession tests (Issue #211).
 *
 * The 04:49 review comment on NEAT-AI-core#557 was claimed at 04:57 although a
 * sibling fleet host had pushed a fix for the same failing check at 04:55.
 * A comment a fleet push has already answered must not be claimed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  fetchPrHeadCommit,
  isCommentSuperseded,
} from "../lib/pr_comment_supersession.ts";

const FLEET = ["VibeCoderST", "stservice", "Vibecoderbot"];
const COMMENT_AT = "2026-08-21T04:49:36Z";

// ---------------------------------------------------------------------------
// isCommentSuperseded
// ---------------------------------------------------------------------------

Deno.test("isCommentSuperseded - true when a fleet host pushed after the comment", () => {
  assertEquals(
    isCommentSuperseded({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T04:55:29Z",
        authorLogin: "stservice",
      },
      fleetAuthors: FLEET,
    }),
    true,
  );
});

Deno.test("isCommentSuperseded - login comparison ignores case", () => {
  assertEquals(
    isCommentSuperseded({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T04:55:29Z",
        authorLogin: "StService",
      },
      fleetAuthors: FLEET,
    }),
    true,
  );
});

Deno.test("isCommentSuperseded - false when the fleet push predates the comment", () => {
  assertEquals(
    isCommentSuperseded({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T04:40:00Z",
        authorLogin: "stservice",
      },
      fleetAuthors: FLEET,
    }),
    false,
  );
});

Deno.test("isCommentSuperseded - false when a human pushed the head", () => {
  assertEquals(
    isCommentSuperseded({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T04:55:29Z",
        authorLogin: "nleck",
      },
      fleetAuthors: FLEET,
    }),
    false,
  );
});

Deno.test("isCommentSuperseded - fails open on missing or unusable evidence", () => {
  // No head commit at all.
  assertEquals(
    isCommentSuperseded({
      commentCreatedAt: COMMENT_AT,
      headCommit: null,
      fleetAuthors: FLEET,
    }),
    false,
  );
  // Unattributed commit author.
  assertEquals(
    isCommentSuperseded({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T04:55:29Z",
        authorLogin: null,
      },
      fleetAuthors: FLEET,
    }),
    false,
  );
  // Missing comment timestamp.
  assertEquals(
    isCommentSuperseded({
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T04:55:29Z",
        authorLogin: "stservice",
      },
      fleetAuthors: FLEET,
    }),
    false,
  );
  // Unparseable push timestamp.
  assertEquals(
    isCommentSuperseded({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "not-a-date",
        authorLogin: "stservice",
      },
      fleetAuthors: FLEET,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// fetchPrHeadCommit
// ---------------------------------------------------------------------------

Deno.test("fetchPrHeadCommit - parses the head commit author and date", async () => {
  const calls: string[][] = [];
  const commit = await fetchPrHeadCommit(
    "stSoftwareAU/NEAT-AI-core",
    "5827e605deadbeef",
    (args) => {
      calls.push(args);
      return Promise.resolve(
        JSON.stringify({
          sha: "5827e605deadbeef",
          committedAt: "2026-08-21T04:55:29Z",
          authorLogin: "stservice",
        }),
      );
    },
  );

  assertEquals(commit, {
    sha: "5827e605deadbeef",
    committedAt: "2026-08-21T04:55:29Z",
    authorLogin: "stservice",
  });
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0]![1],
    "repos/stSoftwareAU/NEAT-AI-core/commits/5827e605deadbeef",
  );
});

Deno.test("fetchPrHeadCommit - returns null when the API call fails", async () => {
  const commit = await fetchPrHeadCommit(
    "owner/repo",
    "abc123",
    () => Promise.reject(new Error("gh api failed")),
  );
  assertEquals(commit, null);
});

Deno.test("fetchPrHeadCommit - returns null without a head SHA", async () => {
  let called = false;
  const commit = await fetchPrHeadCommit("owner/repo", "", () => {
    called = true;
    return Promise.resolve("{}");
  });
  assertEquals(commit, null);
  assertEquals(called, false, "no API call without a SHA");
});
