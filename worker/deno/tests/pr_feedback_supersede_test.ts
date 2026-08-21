/**
 * A PR-feedback comment a fleet push has already answered must not be claimed
 * (Issue #211).
 *
 * In the incident a sibling host pushed a CI fix at 04:55 for the failing check
 * a human had complained about at 04:49. Two minutes later this host claimed
 * that same comment, re-ran an agent over work already done, and ended by
 * asking the human to check the branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { isSupersededByFleetPush } from "../lib/pr_feedback_supersede.ts";
import { findPrCommentsToFix } from "../lib/pr_maintenance.ts";
import type { PrScanOptions } from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";

const REPO = "org/repo";
const PR_NUMBER = 557;
const BRANCH = "issue-556-fix";
const HEAD_SHA = "5827e605aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FLEET_HOST = "stservice";
const HUMAN = "nleck";

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

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

Deno.test("isSupersededByFleetPush - a later fleet push supersedes the comment", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: "2026-08-21T04:49:36Z",
      headCommit: {
        sha: HEAD_SHA,
        authorLogin: FLEET_HOST,
        committerLogin: null,
        committedAt: "2026-08-21T04:55:29Z",
      },
      fleetAuthors: ["vibe-bot", FLEET_HOST],
    }),
    true,
  );
});

Deno.test("isSupersededByFleetPush - an earlier fleet push does not supersede", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: "2026-08-21T04:59:00Z",
      headCommit: {
        sha: HEAD_SHA,
        authorLogin: FLEET_HOST,
        committerLogin: null,
        committedAt: "2026-08-21T04:55:29Z",
      },
      fleetAuthors: [FLEET_HOST],
    }),
    false,
  );
});

Deno.test("isSupersededByFleetPush - a later push by someone outside the fleet does not supersede", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: "2026-08-21T04:49:36Z",
      headCommit: {
        sha: HEAD_SHA,
        authorLogin: HUMAN,
        committerLogin: HUMAN,
        committedAt: "2026-08-21T04:55:29Z",
      },
      fleetAuthors: [FLEET_HOST],
    }),
    false,
  );
});

Deno.test("isSupersededByFleetPush - matches the fleet login case-insensitively", () => {
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: "2026-08-21T04:49:36Z",
      headCommit: {
        sha: HEAD_SHA,
        authorLogin: "STSERVICE",
        committerLogin: null,
        committedAt: "2026-08-21T04:55:29Z",
      },
      fleetAuthors: [FLEET_HOST],
    }),
    true,
  );
});

Deno.test("isSupersededByFleetPush - missing or unparseable data claims the comment", () => {
  // Unknown state must never silently swallow feedback.
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: undefined,
      headCommit: {
        sha: HEAD_SHA,
        authorLogin: FLEET_HOST,
        committerLogin: null,
        committedAt: "2026-08-21T04:55:29Z",
      },
      fleetAuthors: [FLEET_HOST],
    }),
    false,
  );
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: "2026-08-21T04:49:36Z",
      headCommit: null,
      fleetAuthors: [FLEET_HOST],
    }),
    false,
  );
  assertEquals(
    isSupersededByFleetPush({
      commentCreatedAt: "not-a-date",
      headCommit: {
        sha: HEAD_SHA,
        authorLogin: FLEET_HOST,
        committerLogin: null,
        committedAt: "2026-08-21T04:55:29Z",
      },
      fleetAuthors: [FLEET_HOST],
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Scan integration
// ---------------------------------------------------------------------------

function makeGh(
  commentCreatedAt: string,
  headCommitJson: string,
): (args: string[]) => Promise<string> {
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
          login: HUMAN,
          id: 5365332005,
          body: "Please fix the quality issues.",
          thumbs_up: 0,
          created_at: commentCreatedAt,
        },
      ]));
    }
    if (key.includes(`commits/${HEAD_SHA}`)) {
      return Promise.resolve(headCommitJson);
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
    isAuthorisedCommenter: (author: string) => author === HUMAN,
    ghCommandFn,
    prAuthors: [FLEET_HOST],
  };
}

const FLEET_HEAD_COMMIT = JSON.stringify({
  sha: HEAD_SHA,
  authorLogin: FLEET_HOST,
  committerLogin: FLEET_HOST,
  committedAt: "2026-08-21T04:55:29Z",
});

Deno.test("findPrCommentsToFix - does not claim a comment a fleet push already answered (Issue #211)", async () => {
  const result = await findPrCommentsToFix(
    makeScanOptions(makeGh("2026-08-21T04:49:36Z", FLEET_HEAD_COMMIT)),
  );
  assert(result.ok, "scan should succeed");
  assertEquals(
    result.value,
    null,
    "a comment superseded by a fleet push must not be claimed",
  );
});

Deno.test("findPrCommentsToFix - still claims a comment made after the fleet push (Issue #211)", async () => {
  const result = await findPrCommentsToFix(
    makeScanOptions(makeGh("2026-08-21T05:10:00Z", FLEET_HEAD_COMMIT)),
  );
  assert(result.ok, "scan should succeed");
  assert(result.value !== null, "fresh feedback must still be actionable");
  assertEquals(result.value.prNumber, PR_NUMBER);
  assertEquals(result.value.commentId, "5365332005");
});

Deno.test("findPrCommentsToFix - claims the comment when the head commit cannot be read (Issue #211)", async () => {
  const gh = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes(`commits/${HEAD_SHA}`)) {
      return Promise.reject(new Error("gh api failed"));
    }
    return makeGh("2026-08-21T04:49:36Z", FLEET_HEAD_COMMIT)(args);
  };
  const result = await findPrCommentsToFix(makeScanOptions(gh));
  assert(result.ok, "scan should succeed");
  assert(
    result.value !== null,
    "an unreadable head commit must not silently drop feedback",
  );
});
