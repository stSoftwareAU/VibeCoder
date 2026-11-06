/**
 * Feedback scan: a marker-only top-level comment is never actionable
 * (Issue #4673).
 *
 * The review-fleet-prs skill posts a claim whose whole body is one hidden
 * `<!-- vibe-review-claim … -->` marker, as an authorised App. The worker
 * must skip it before spending a model run, and the scan must carry on to a
 * later comment that has visible text. The verifier-hold lane, whose marker
 * is followed by visible text, must still be answered.
 *
 * Modelled on the "e2e #1860 path A" scan in
 * `pr_feedback_trusted_bot_e2e_test.ts`: a mock `gh` drives
 * `findPrCommentsToFix` through `fetchPrComments`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  findPrCommentsToFix,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const REPO = "org/repo";
const PR_NUMBER = 4673;
const BRANCH = "issue-4673-fix";
const HEAD_SHA = "sha4673";
const GITHUB_USER = "vibe-bot";
const CLAIM_AUTHOR = "review-fleet-app[bot]";
const FLEET_PEER = "fleet-peer";

const CLAIM_MARKER =
  "<!-- vibe-review-claim sha=abc host=h expires=2026-11-01T22:00:00Z -->";
const VISIBLE_REQUEST = "Please fix the lint error.";

interface CapturedLogger {
  logger: Logger;
  infoMessages: string[];
}

function makeCapturingLogger(): CapturedLogger {
  const noop = () => {};
  const infoMessages: string[] = [];
  const logger: Logger = {
    info: (message: string) => {
      infoMessages.push(message);
    },
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, infoMessages };
}

/**
 * Mock `gh`: the PR list, an empty review-comment list, and the supplied
 * top-level comments on the issue-comments endpoint (read with `--jq`).
 */
function makeMockGh(
  issueCommentsJson: string,
  reviewCommentsJson = "[]",
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: PR_NUMBER, headRefName: BRANCH, headRefOid: HEAD_SHA },
      ]));
    }
    if (
      key.includes(`issues/${PR_NUMBER}/comments`) && args.includes("--jq")
    ) {
      return Promise.resolve(issueCommentsJson);
    }
    if (key.includes(`pulls/${PR_NUMBER}/comments`)) {
      return Promise.resolve(reviewCommentsJson);
    }
    return Promise.resolve("[]");
  };
}

function scanOptions(
  issueCommentsJson: string,
  logger: Logger,
  overrides: Partial<PrScanOptions> = {},
  reviewCommentsJson = "[]",
): PrScanOptions {
  return {
    githubUser: GITHUB_USER,
    repos: [REPO],
    logger,
    isRepoAllowed: () => true,
    // The claim is posted by an authorised App, so authorisation alone
    // would make it actionable without the #4673 skip.
    isAuthorisedCommenter: (author) => author === CLAIM_AUTHOR,
    ghCommandFn: makeMockGh(issueCommentsJson, reviewCommentsJson),
    ...overrides,
  };
}

function issueComment(login: string, id: number, body: string): unknown {
  return { login, id, body, thumbs_up: 0, eyes: 0 };
}

Deno.test(
  "marker-only claim from an authorised App is skipped, not actioned (Issue #4673 case i)",
  async () => {
    const { logger } = makeCapturingLogger();
    const issueCommentsJson = JSON.stringify([
      issueComment(CLAIM_AUTHOR, 101, CLAIM_MARKER),
    ]);

    const result = await findPrCommentsToFix(
      scanOptions(issueCommentsJson, logger),
    );
    assert(result.ok, "scan should succeed");
    assertEquals(result.value, null);
  },
);

Deno.test(
  "marker followed by visible text is still actioned, with the full body (Issue #4673 case ii)",
  async () => {
    const { logger } = makeCapturingLogger();
    const body = `${CLAIM_MARKER}\n${VISIBLE_REQUEST}`;
    const issueCommentsJson = JSON.stringify([
      issueComment(CLAIM_AUTHOR, 102, body),
    ]);

    const result = await findPrCommentsToFix(
      scanOptions(issueCommentsJson, logger),
    );
    assert(result.ok, "scan should succeed");
    assert(result.value !== null, "expected an actionable comment");
    assertEquals(result.value.commentType, "issue");
    assertEquals(result.value.prNumber, PR_NUMBER);
    assertEquals(result.value.commentId, "102");
    assertEquals(atob(result.value.encodedBody), body);
  },
);

Deno.test(
  "marker-only comment first, then a later authorised comment with visible text: the scan continues past the skip (Issue #4673 case iii)",
  async () => {
    const { logger } = makeCapturingLogger();
    const issueCommentsJson = JSON.stringify([
      issueComment(CLAIM_AUTHOR, 103, CLAIM_MARKER),
      issueComment("alice", 104, VISIBLE_REQUEST),
    ]);

    const result = await findPrCommentsToFix(
      scanOptions(issueCommentsJson, logger, {
        isAuthorisedCommenter: (author) =>
          author === CLAIM_AUTHOR || author === "alice",
      }),
    );
    assert(result.ok, "scan should succeed");
    assert(
      result.value !== null,
      "expected the later comment to be actionable",
    );
    assertEquals(result.value.commentId, "104");
    assertEquals(result.value.commentAuthor, "alice");
  },
);

Deno.test(
  "marker-only skip is logged at INFO with 'no visible text' (Issue #4673 case iv)",
  async () => {
    const { logger, infoMessages } = makeCapturingLogger();
    const issueCommentsJson = JSON.stringify([
      issueComment(CLAIM_AUTHOR, 101, CLAIM_MARKER),
    ]);

    const result = await findPrCommentsToFix(
      scanOptions(issueCommentsJson, logger),
    );
    assert(result.ok, "scan should succeed");
    const skips = infoMessages.filter((message) =>
      message.includes("no visible text")
    );
    assertEquals(skips.length, 1);
    assert(
      skips[0]!.includes("Skipping PR comment 101 on org/repo#4673"),
      `unexpected skip message: ${skips[0]}`,
    );
  },
);

Deno.test(
  "verifier-hold comment from a fleet author with visible text is still actioned (Issue #4673 case v)",
  async () => {
    const { logger } = makeCapturingLogger();
    const body = "<!-- vibe-pre-pr-verifier-hold -->\nFix rounding";
    const issueCommentsJson = JSON.stringify([
      issueComment(FLEET_PEER, 105, body),
    ]);

    const result = await findPrCommentsToFix(
      scanOptions(issueCommentsJson, logger, {
        prAuthors: [FLEET_PEER],
        isAuthorisedCommenter: () => false,
      }),
    );
    assert(result.ok, "scan should succeed");
    assert(
      result.value !== null,
      "expected the verifier hold to be actionable",
    );
    assertEquals(result.value.commentId, "105");
  },
);

Deno.test(
  "marker-only line-level review comment is still actioned: the skip is for issue comments only (Issue #4673 case vi)",
  async () => {
    const { logger, infoMessages } = makeCapturingLogger();
    const reviewCommentsJson = JSON.stringify([
      issueComment(CLAIM_AUTHOR, 106, CLAIM_MARKER),
    ]);

    const result = await findPrCommentsToFix(
      scanOptions("[]", logger, {}, reviewCommentsJson),
    );
    assert(result.ok, "scan should succeed");
    assert(
      result.value !== null,
      "expected the review comment to be actionable",
    );
    assertEquals(result.value.commentType, "review");
    assertEquals(result.value.commentId, "106");
    assertEquals(
      infoMessages.filter((message) => message.includes("no visible text"))
        .length,
      0,
    );
  },
);
