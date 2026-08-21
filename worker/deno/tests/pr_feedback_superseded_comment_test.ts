/**
 * A PR-feedback comment a fleet push has already superseded must not be
 * claimed (Issue #211).
 *
 * The incident: nleck commented "Please fix the quality issues" at 04:49Z; a
 * sibling fleet host claimed the failing check and pushed a fix at 04:55Z;
 * this host claimed the same 04:49 comment at 04:57Z and burned a full agent
 * run redoing work that had already landed. When a fleet author has pushed to
 * the PR since the comment, and that push is still inside the cool-off window,
 * the comment is left for the next scan to re-evaluate rather than claimed on
 * the spot. Once the window passes the comment is actionable again.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  findPrCommentsToFix,
  isSupersededByFleetPush,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";

const REPO = "stSoftwareAU/NEAT-AI-core";
const PR_NUMBER = 557;
const BRANCH = "issue-556-quality";
const HUMAN = "nleck";
const FLEET_SIBLING = "stservice";
const HOST_USER = "vibe-bot";
const HEAD_SHA = "5827e605aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

interface Fixture {
  /** ISO timestamp of the human's comment. */
  commentCreatedAt: string;
  /** Who pushed the PR head commit and when, or null when it is unreadable. */
  headCommit: { login: string; date: string } | null;
}

function makeGh(fixture: Fixture): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const key = args.join(" ");

    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: PR_NUMBER, headRefName: BRANCH, headRefOid: HEAD_SHA },
      ]));
    }

    if (key.includes(`commits/${HEAD_SHA}`)) {
      const head = fixture.headCommit;
      if (head === null) return Promise.resolve("null");
      return Promise.resolve(JSON.stringify({
        sha: HEAD_SHA,
        authorLogin: head.login,
        committerLogin: head.login,
        committedAt: head.date,
      }));
    }

    if (key.includes(`issues/${PR_NUMBER}/comments`)) {
      return Promise.resolve(JSON.stringify([
        {
          login: HUMAN,
          id: 5365332005,
          body: "Please fix the quality issues.",
          thumbs_up: 0,
          created_at: fixture.commentCreatedAt,
        },
      ]));
    }

    return Promise.resolve("[]");
  };
}

function makeScanOptions(fixture: Fixture): PrScanOptions {
  return {
    githubUser: HOST_USER,
    repos: [REPO],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (author: string) => author === HUMAN,
    ghCommandFn: makeGh(fixture),
    prAuthors: [FLEET_SIBLING],
  };
}

Deno.test("findPrCommentsToFix - skips a comment a sibling fleet push already superseded (Issue #211)", async () => {
  const result = await findPrCommentsToFix(makeScanOptions({
    commentCreatedAt: minutesAgo(8),
    headCommit: { login: FLEET_SIBLING, date: minutesAgo(2) },
  }));

  assert(result.ok);
  assertEquals(
    result.value,
    null,
    "a comment a fleet host has already pushed against must not be claimed",
  );
});

Deno.test("findPrCommentsToFix - claims a comment posted after the last fleet push (Issue #211)", async () => {
  const result = await findPrCommentsToFix(makeScanOptions({
    commentCreatedAt: minutesAgo(2),
    headCommit: { login: FLEET_SIBLING, date: minutesAgo(20) },
  }));

  assert(result.ok);
  assert(result.value !== null, "expected the comment to be actionable");
  assertEquals(result.value.prNumber, PR_NUMBER);
  assertEquals(result.value.commentId, "5365332005");
});

Deno.test("findPrCommentsToFix - claims a comment a human push (not a fleet push) followed (Issue #211)", async () => {
  const result = await findPrCommentsToFix(makeScanOptions({
    commentCreatedAt: minutesAgo(8),
    headCommit: { login: HUMAN, date: minutesAgo(2) },
  }));

  assert(result.ok);
  assert(
    result.value !== null,
    "only a fleet push supersedes a comment — a human push does not",
  );
});

Deno.test("findPrCommentsToFix - reclaims a comment a stale fleet push never addressed (Issue #211)", async () => {
  // The skip is a de-duplication window, not a permanent veto: once the
  // sibling's push is old and the comment is still unactioned, it becomes
  // actionable again rather than starving forever.
  const result = await findPrCommentsToFix(makeScanOptions({
    commentCreatedAt: minutesAgo(300),
    headCommit: { login: FLEET_SIBLING, date: minutesAgo(200) },
  }));

  assert(result.ok);
  assert(
    result.value !== null,
    "an old fleet push must not suppress the comment forever",
  );
});

Deno.test("isSupersededByFleetPush - only within the de-duplication window", () => {
  const now = Date.parse("2026-08-21T05:00:00Z");
  const comment = "2026-08-21T04:49:36Z";
  const check = (
    commentCreatedAt: string | undefined,
    pushedAt: string | null,
    at = now,
  ) =>
    isSupersededByFleetPush({
      commentCreatedAt,
      headCommit: pushedAt === null ? null : {
        sha: HEAD_SHA,
        authorLogin: FLEET_SIBLING,
        committerLogin: null,
        committedAt: pushedAt,
      },
      fleetAuthors: [HOST_USER, FLEET_SIBLING],
      now: at,
    });

  assertEquals(
    check(comment, "2026-08-21T04:55:29Z"),
    true,
    "a fleet push two minutes ago supersedes the comment",
  );
  assertEquals(
    check(comment, "2026-08-21T04:40:00Z"),
    false,
    "a push made before the comment cannot have addressed it",
  );
  assertEquals(
    check(comment, null),
    false,
    "no fleet push means nothing to supersede it",
  );
  assertEquals(
    check(undefined, "2026-08-21T04:55:29Z"),
    false,
    "an undated comment is never treated as superseded",
  );
  assertEquals(
    check(comment, "2026-08-21T04:52:00Z", Date.parse("2026-08-21T08:00:00Z")),
    false,
    "outside the window the comment becomes actionable again",
  );
});
