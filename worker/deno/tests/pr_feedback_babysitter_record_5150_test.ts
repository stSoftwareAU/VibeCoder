/**
 * Feedback scan: the fleet PR babysitter's attempt record is never
 * actionable (Issue #5150).
 *
 * The babysitter records each repair as a top-level comment: one visible
 * line plus a `vibe-babysitter-attempt` marker. The worker must not spend a
 * pr_feedback run on it, while a human posting the same text, a quoted
 * marker inside other text, and any later ordinary comment stay actionable.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  findPrCommentsToFix,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import {
  buildBabysitterAttemptMarker,
  buildBabysitterAttemptRecordBody,
  isBabysitterAttemptRecord,
} from "../lib/babysitter_retry_state.ts";
import type { Logger } from "../types.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const REPO = "org/repo";
const PR_NUMBER = 5150;
const BRANCH = "issue-5150-fix";
const HEAD_SHA = "sha5150";
const GITHUB_USER = "vibe-bot";
const APP_AUTHOR = "fleet-pr-babysitter[bot]";
const FLEET_ACCOUNT = "fleet-peer";

// The real comment body observed on VibeCoder#5106, as a literal.
const MARKER =
  '<!-- vibe-babysitter-attempt signature="c9f80fe32a69743d" check="merge conflict" head="052f6568b09bc5912f249cc32abc0433dea7f471" attempt="1" outcome="pushed" -->';
const RECORD_BODY =
  'Babysitter repair recorded.\n\n<!-- vibe-babysitter-attempt signature="c9f80fe32a69743d" check="merge conflict" head="052f6568b09bc5912f249cc32abc0433dea7f471" attempt="1" outcome="pushed" -->';
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
    // The App is an authorised commenter, so authorisation alone would make
    // the record actionable without the #5150 skip.
    isAuthorisedCommenter: (author) =>
      author === APP_AUTHOR || author === FLEET_ACCOUNT || author === "alice",
    ghCommandFn: makeMockGh(issueCommentsJson, reviewCommentsJson),
    ...overrides,
  };
}

function issueComment(login: string, id: number, body: string): unknown {
  return { login, id, body, thumbs_up: 0, eyes: 0 };
}

async function scan(
  comments: unknown[],
  overrides: Partial<PrScanOptions> = {},
) {
  const { logger, infoMessages } = makeCapturingLogger();
  const result = await findPrCommentsToFix(
    scanOptions(JSON.stringify(comments), logger, overrides),
  );
  assert(result.ok, "scan should succeed");
  return { value: result.value, infoMessages };
}

Deno.test("attempt record from the babysitter App is not returned (Issue #5150)", async () => {
  const { value } = await scan([issueComment(APP_AUTHOR, 201, RECORD_BODY)]);
  assertEquals(value, null);
});

Deno.test("attempt record from a fleet account is not returned (Issue #5150)", async () => {
  const { value } = await scan([
    issueComment(FLEET_ACCOUNT, 202, RECORD_BODY),
  ], { prAuthors: [FLEET_ACCOUNT] });
  assertEquals(value, null);
});

Deno.test("record then an ordinary authorised comment: the ordinary comment is returned (Issue #5150)", async () => {
  const { value } = await scan([
    issueComment(APP_AUTHOR, 203, RECORD_BODY),
    issueComment("alice", 204, VISIBLE_REQUEST),
  ]);
  assert(value !== null, "expected the ordinary comment");
  assertEquals(value.commentId, "204");
  assertEquals(value.commentAuthor, "alice");
});

Deno.test("the same record body from an authorised human is still returned (Issue #5150)", async () => {
  const { value } = await scan([issueComment("alice", 205, RECORD_BODY)]);
  assert(value !== null, "expected the human's comment");
  assertEquals(value.commentId, "205");
});

Deno.test("a marker quoted inside other text from an App is still returned (Issue #5150)", async () => {
  const cases: Record<string, string> = {
    "leading text":
      `Please re-run the check; the last record was:\n\n${RECORD_BODY}`,
    "trailing text": `${RECORD_BODY}\n\nAlso please fix the lint error.`,
    "code span": `Babysitter repair recorded.\n\n\`${MARKER}\``,
  };
  let id = 300;
  for (const [name, body] of Object.entries(cases)) {
    const { value } = await scan([issueComment(APP_AUTHOR, ++id, body)]);
    assert(value !== null, `case "${name}" should be returned`);
    assertEquals(value.commentId, String(id), `case "${name}"`);
  }
});

Deno.test("the skip is logged at INFO once (Issue #5150)", async () => {
  const { infoMessages } = await scan([
    issueComment(APP_AUTHOR, 206, RECORD_BODY),
  ]);
  const skips = infoMessages.filter((message) =>
    message.includes("babysitter's attempt record")
  );
  assertEquals(skips.length, 1);
  assert(
    skips[0]!.includes("Skipping PR comment 206 on org/repo#5150"),
    `unexpected skip message: ${skips[0]}`,
  );
});

Deno.test("isBabysitterAttemptRecord: accepts the record and rejects look-alikes (Issue #5150)", () => {
  assert(isBabysitterAttemptRecord(RECORD_BODY), "#5106 literal");
  assert(
    isBabysitterAttemptRecord(RECORD_BODY.replaceAll("\n", "\r\n")),
    "CRLF line endings",
  );
  assert(isBabysitterAttemptRecord(`${RECORD_BODY}\n`), "trailing newline");
  const built = buildBabysitterAttemptMarker(
    "org/repo",
    7,
    "merge conflict",
    "052f6568b09bc5912f249cc32abc0433dea7f471",
    2,
    "no-change",
  ).marker;
  assert(
    isBabysitterAttemptRecord(buildBabysitterAttemptRecordBody(built)),
    "builder output",
  );

  const line = "Babysitter repair recorded.";
  const noSignature = MARKER.replace(' signature="c9f80fe32a69743d"', "");
  const rejected: Record<string, string> = {
    "marker only": MARKER,
    "record line, no marker": `${line}\n\n`,
    "ci-fix marker": `${line}\n\n${
      MARKER.replace("vibe-babysitter-attempt", "vibe-ci-fix-attempt")
    }`,
    "marker name with suffix": `${line}\n\n${
      MARKER.replace("vibe-babysitter-attempt", "vibe-babysitter-attempt-x")
    }`,
    "two markers": `${line}\n\n${MARKER}\n${MARKER}`,
    "extra text after marker": `${RECORD_BODY}\n\nmore`,
    "no full stop": RECORD_BODY.replace("recorded.", "recorded"),
    "leading text": `Hi\n${RECORD_BODY}`,
    "missing signature": `${line}\n\n${noSignature}`,
    "unclosed hostile input": `${line}\n\n<!-- vibe-babysitter-attempt ${
      " ".repeat(100_000)
    }`,
  };
  for (const [name, body] of Object.entries(rejected)) {
    assertEquals(isBabysitterAttemptRecord(body), false, name);
  }
});
