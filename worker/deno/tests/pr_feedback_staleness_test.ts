/**
 * Feedback superseded by a fleet push (Issue #211).
 *
 * A fleet sibling claimed the failing CI check on NEAT-AI-core #557 at 04:55
 * and pushed a fix; this host claimed the 04:49 "please fix the quality issues"
 * comment at 04:57 — feedback that push had already addressed — and burnt a
 * whole agent run on it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  fetchHeadCommitInfo,
  FLEET_PUSH_COOL_OFF_MS,
  isSupersededByFleetPush,
} from "../lib/pr_feedback_staleness.ts";
import { findPrCommentsToFix, type PrScanOptions } from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";

const FLEET = ["vibe-bot", "stservice"];
const COMMENT_AT = "2026-08-21T04:49:36Z";
const PUSH_AT = "2026-08-21T04:55:29Z";
const NOW = Date.parse("2026-08-21T04:57:13Z");

// ---------------------------------------------------------------------------
// isSupersededByFleetPush
// ---------------------------------------------------------------------------

Deno.test("isSupersededByFleetPush - defers when a sibling pushed after the comment", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        authorLogin: "stservice",
        committerLogin: null,
        committedAt: PUSH_AT,
      },
      fleetAuthors: FLEET,
      now: NOW,
    }),
    true,
  );
});

Deno.test("isSupersededByFleetPush - a push before the comment supersedes nothing", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: PUSH_AT,
      headCommit: {
        authorLogin: "stservice",
        committerLogin: null,
        committedAt: COMMENT_AT,
      },
      fleetAuthors: FLEET,
      now: NOW,
    }),
    false,
  );
});

Deno.test("isSupersededByFleetPush - a human's push never suppresses feedback", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        authorLogin: "nleck",
        committerLogin: "nleck",
        committedAt: PUSH_AT,
      },
      fleetAuthors: FLEET,
      now: NOW,
    }),
    false,
  );
});

Deno.test("isSupersededByFleetPush - the deferral expires with the cool-off window", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        authorLogin: "stservice",
        committerLogin: null,
        committedAt: PUSH_AT,
      },
      fleetAuthors: FLEET,
      now: Date.parse(PUSH_AT) + FLEET_PUSH_COOL_OFF_MS + 1,
    }),
    false,
    "unaddressed feedback must be reconsidered once the window passes",
  );
});

Deno.test("isSupersededByFleetPush - an unreadable head commit defers nothing", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: COMMENT_AT,
      headCommit: null,
      fleetAuthors: FLEET,
      now: NOW,
    }),
    false,
  );
});

Deno.test("isSupersededByFleetPush - matches the fleet login case-insensitively", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: COMMENT_AT,
      headCommit: {
        authorLogin: "StService",
        committerLogin: null,
        committedAt: PUSH_AT,
      },
      fleetAuthors: FLEET,
      now: NOW,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// fetchHeadCommitInfo
// ---------------------------------------------------------------------------

Deno.test("fetchHeadCommitInfo - reads the commit provenance", async () => {
  const info = await fetchHeadCommitInfo(
    "org/repo",
    "abc123",
    () =>
      Promise.resolve(JSON.stringify({
        authorLogin: "stservice",
        committerLogin: "web-flow",
        committedAt: PUSH_AT,
      })),
  );
  assertEquals(info?.authorLogin, "stservice");
  assertEquals(info?.committerLogin, "web-flow");
  assertEquals(info?.committedAt, PUSH_AT);
});

Deno.test("fetchHeadCommitInfo - returns null when the API call fails", async () => {
  const info = await fetchHeadCommitInfo("org/repo", "abc123", () => {
    throw new Error("gh exploded");
  });
  assertEquals(info, null);
});

// ---------------------------------------------------------------------------
// findPrCommentsToFix — the scan must not claim superseded feedback
// ---------------------------------------------------------------------------

const REPO = "org/repo";
const PR_NUMBER = 557;
const BRANCH = "issue-556-fix";
const HEAD_SHA = "5827e605deadbeef";

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

/** gh mock: one authorised comment, and a head commit pushed by `pusher`. */
function makeGh(pusher: string, pushedAt: string) {
  return (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: PR_NUMBER, headRefName: BRANCH, headRefOid: HEAD_SHA },
      ]));
    }
    if (key.includes(`issues/${PR_NUMBER}/comments`)) {
      return Promise.resolve(JSON.stringify([
        {
          login: "nleck",
          id: 5365332005,
          body: "Please fix the quality issues.",
          thumbs_up: 0,
          created_at: COMMENT_AT,
        },
      ]));
    }
    if (key.includes(`commits/${HEAD_SHA}`)) {
      return Promise.resolve(JSON.stringify({
        authorLogin: pusher,
        committerLogin: pusher,
        committedAt: pushedAt,
      }));
    }
    return Promise.resolve("[]");
  };
}

function makeScanOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
): PrScanOptions {
  return {
    githubUser: "vibe-bot",
    repos: [REPO],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (author: string) => author === "nleck",
    ghCommandFn,
    prAuthors: ["stservice"],
  };
}

Deno.test("findPrCommentsToFix - does not claim a comment a fleet push superseded", async () => {
  const recentPush = new Date(Date.now() - 2 * 60_000).toISOString();
  const commentBeforeThat = new Date(Date.now() - 8 * 60_000).toISOString();
  const gh = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes(`issues/${PR_NUMBER}/comments`)) {
      return Promise.resolve(JSON.stringify([
        {
          login: "nleck",
          id: 5365332005,
          body: "Please fix the quality issues.",
          thumbs_up: 0,
          created_at: commentBeforeThat,
        },
      ]));
    }
    return makeGh("stservice", recentPush)(args);
  };

  const result = await findPrCommentsToFix(makeScanOptions(gh));
  assert(result.ok, "scan should succeed");
  assertEquals(
    result.value,
    null,
    "feedback a sibling's push already addressed must not be claimed",
  );
});

Deno.test("findPrCommentsToFix - still claims a comment when no fleet push followed it", async () => {
  const oldPush = new Date(Date.now() - 90 * 60_000).toISOString();
  const comment = new Date(Date.now() - 30 * 60_000).toISOString();
  const gh = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes(`issues/${PR_NUMBER}/comments`)) {
      return Promise.resolve(JSON.stringify([
        {
          login: "nleck",
          id: 5365332005,
          body: "Please fix the quality issues.",
          thumbs_up: 0,
          created_at: comment,
        },
      ]));
    }
    return makeGh("stservice", oldPush)(args);
  };

  const result = await findPrCommentsToFix(makeScanOptions(gh));
  assert(result.ok, "scan should succeed");
  assert(result.value !== null, "unaddressed feedback must still be claimed");
  assertEquals(result.value.commentId, "5365332005");
  assertEquals(result.value.prNumber, PR_NUMBER);
});
