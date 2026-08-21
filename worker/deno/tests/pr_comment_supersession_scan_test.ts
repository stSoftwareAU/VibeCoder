/**
 * Scan-level supersession tests (Issue #211).
 *
 * `findPrCommentsToFix` must not hand a PR-feedback comment to an agent when a
 * sibling fleet host has already pushed to that PR since the comment was
 * written — that duplicated run is what collided on NEAT-AI-core#557.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  findPrCommentsToFix,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";

const REPO = "stSoftwareAU/NEAT-AI-core";
const HEAD_SHA = "5827e605deadbeefcafe";
const COMMENT_AT = "2026-08-21T04:49:36Z";

const noop = () => {};
const silentLogger: Logger = {
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

/**
 * gh stub serving one PR with one authorised issue comment, plus a head commit
 * pushed by `headAuthor` at `headCommittedAt`.
 */
function ghStub(headAuthor: string, headCommittedAt: string) {
  return (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(
        JSON.stringify([
          { number: 557, headRefName: "issue-556-fix", headRefOid: HEAD_SHA },
        ]),
      );
    }
    if (key.includes(`/issues/557/comments`)) {
      return Promise.resolve(
        JSON.stringify([
          {
            login: "nleck",
            id: 5365332005,
            body: "Please fix the quality issues.",
            thumbs_up: 0,
            created_at: COMMENT_AT,
          },
        ]),
      );
    }
    if (key.includes(`/commits/${HEAD_SHA}`)) {
      return Promise.resolve(
        JSON.stringify({
          sha: HEAD_SHA,
          committedAt: headCommittedAt,
          authorLogin: headAuthor,
        }),
      );
    }
    return Promise.resolve("[]");
  };
}

function scanOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
): PrScanOptions {
  return {
    githubUser: "VibeCoderST",
    prAuthors: ["stservice"],
    repos: [REPO],
    logger: silentLogger,
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (author: string) => author === "nleck",
    ghCommandFn,
  };
}

Deno.test("findPrCommentsToFix - skips a comment a sibling fleet push already answered", async () => {
  const result = await findPrCommentsToFix(
    scanOptions(ghStub("stservice", "2026-08-21T04:55:29Z")),
  );

  assert(result.ok);
  assertEquals(
    result.value,
    null,
    "the superseded comment must not be claimed",
  );
});

Deno.test("findPrCommentsToFix - still claims a comment when only a human pushed since", async () => {
  const result = await findPrCommentsToFix(
    scanOptions(ghStub("nleck", "2026-08-21T04:55:29Z")),
  );

  assert(result.ok);
  assert(result.value !== null, "a human push must not suppress feedback");
  assertEquals(result.value.prNumber, 557);
});

Deno.test("findPrCommentsToFix - still claims a comment written after the fleet push", async () => {
  const result = await findPrCommentsToFix(
    scanOptions(ghStub("stservice", "2026-08-21T04:40:00Z")),
  );

  assert(result.ok);
  assert(
    result.value !== null,
    "feedback newer than the push is still actionable",
  );
  assertEquals(result.value.commentId, "5365332005");
});
