/**
 * Tests for fleet-push supersession of PR feedback comments (Issue #211).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  fetchPrHeadCommit,
  isSupersededByFleetPush,
} from "../lib/pr_comment_supersession.ts";
import { findPrCommentsToFix } from "../lib/pr_maintenance.ts";
import type { PrScanOptions } from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";

const FLEET = ["vibe-bot", "stservice"];
const HUMAN_COMMENT_AT = "2026-08-21T04:49:36Z";

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
  } as unknown as Logger;
}

// ---------------------------------------------------------------------------
// isSupersededByFleetPush
// ---------------------------------------------------------------------------

Deno.test("isSupersededByFleetPush - a fleet push after the comment supersedes it", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: HUMAN_COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T04:55:29Z",
        authorLogin: "stservice",
        committerLogin: null,
      },
      fleetAuthors: FLEET,
    }),
    true,
  );
});

Deno.test("isSupersededByFleetPush - a fleet push before the comment does not supersede it", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: HUMAN_COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T04:40:00Z",
        authorLogin: "stservice",
        committerLogin: null,
      },
      fleetAuthors: FLEET,
    }),
    false,
  );
});

Deno.test("isSupersededByFleetPush - a human push never supersedes feedback", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: HUMAN_COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T05:00:00Z",
        authorLogin: "nleck",
        committerLogin: "nleck",
      },
      fleetAuthors: FLEET,
    }),
    false,
  );
});

Deno.test("isSupersededByFleetPush - matches a fleet login case-insensitively", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: HUMAN_COMMENT_AT,
      headCommit: {
        sha: "abc1234",
        committedAt: "2026-08-21T04:55:29Z",
        authorLogin: "StService",
        committerLogin: null,
      },
      fleetAuthors: FLEET,
    }),
    true,
  );
});

Deno.test("isSupersededByFleetPush - missing data never supersedes (fails closed)", () => {
  const head = {
    sha: "abc1234",
    committedAt: "2026-08-21T04:55:29Z",
    authorLogin: "stservice",
    committerLogin: null,
  };
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: undefined,
      headCommit: head,
      fleetAuthors: FLEET,
    }),
    false,
  );
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: HUMAN_COMMENT_AT,
      headCommit: null,
      fleetAuthors: FLEET,
    }),
    false,
  );
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: HUMAN_COMMENT_AT,
      headCommit: { ...head, committedAt: "not-a-date" },
      fleetAuthors: FLEET,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// fetchPrHeadCommit
// ---------------------------------------------------------------------------

Deno.test("fetchPrHeadCommit - reads the head commit's timestamp and logins", async () => {
  const info = await fetchPrHeadCommit(
    "org/repo",
    "sha557",
    () =>
      Promise.resolve(JSON.stringify({
        committedAt: "2026-08-21T04:55:29Z",
        authorLogin: "stservice",
        committerLogin: null,
      })),
  );
  assert(info);
  assertEquals(info.committedAt, "2026-08-21T04:55:29Z");
  assertEquals(info.authorLogin, "stservice");
  assertEquals(info.sha, "sha557");
});

Deno.test("fetchPrHeadCommit - returns null when the API call fails", async () => {
  const info = await fetchPrHeadCommit("org/repo", "sha557", () => {
    throw new Error("gh: 404");
  });
  assertEquals(info, null);
});

// ---------------------------------------------------------------------------
// findPrCommentsToFix — the scan must not claim a superseded comment
// ---------------------------------------------------------------------------

/** gh mock reproducing NEAT-AI-core #557: comment at 04:49, fleet push 04:55. */
function makeGh(headCommitJson: string): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: 557, headRefName: "issue-556-fix", headRefOid: "sha557" },
      ]));
    }
    if (key.includes("issues/557/comments")) {
      return Promise.resolve(JSON.stringify([
        {
          login: "nleck",
          id: 5365332005,
          body: "Please fix the quality issues.",
          thumbs_up: 0,
          created_at: HUMAN_COMMENT_AT,
        },
      ]));
    }
    if (key.includes("commits/sha557")) {
      return Promise.resolve(headCommitJson);
    }
    return Promise.resolve("[]");
  };
}

function scanOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
): PrScanOptions {
  return {
    githubUser: "vibe-bot",
    repos: ["org/repo"],
    logger: makeLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (author: string) => author === "nleck",
    ghCommandFn,
    prAuthors: FLEET,
  };
}

Deno.test("findPrCommentsToFix - does not claim a comment a fleet push already superseded (Issue #211)", async () => {
  const result = await findPrCommentsToFix(scanOptions(makeGh(JSON.stringify({
    committedAt: "2026-08-21T04:55:29Z",
    authorLogin: "stservice",
    committerLogin: null,
  }))));

  assert(result.ok);
  if (result.ok) {
    assertEquals(
      result.value,
      null,
      "a comment already addressed by a sibling's push must not be claimed",
    );
  }
});

Deno.test("findPrCommentsToFix - still claims a comment written after the fleet push (Issue #211)", async () => {
  const result = await findPrCommentsToFix(scanOptions(makeGh(JSON.stringify({
    committedAt: "2026-08-21T04:30:00Z",
    authorLogin: "stservice",
    committerLogin: null,
  }))));

  assert(result.ok);
  if (result.ok) {
    assert(result.value, "feedback newer than the last fleet push is actionable");
    assertEquals(result.value.prNumber, 557);
    assertEquals(result.value.commentId, "5365332005");
  }
});

Deno.test("findPrCommentsToFix - still claims a comment when a human made the last push (Issue #211)", async () => {
  const result = await findPrCommentsToFix(scanOptions(makeGh(JSON.stringify({
    committedAt: "2026-08-21T05:10:00Z",
    authorLogin: "nleck",
    committerLogin: "nleck",
  }))));

  assert(result.ok);
  if (result.ok) {
    assert(result.value, "a human push must never suppress feedback");
  }
});
