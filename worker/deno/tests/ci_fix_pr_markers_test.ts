/**
 * Tests for ci_fix_pr_markers.ts (Issue #1879).
 *
 * The reader half of the fleet-wide CI-fix record: it must collect what the
 * pull request says, and — just as importantly — never let a failed read
 * pass for "no attempts yet", which would hand every host a fresh budget.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  appendAttemptToComment,
  buildCapAttemptRows,
  describeAttemptOutcome,
  readPrCiFixMarkers,
} from "../lib/ci_fix_pr_markers.ts";
import { buildCiFixAttemptMarker } from "../lib/ci_fix_attempt_markers.ts";
import { buildAutoFixCapSummary } from "../lib/auto_fix_attempt_tracker.ts";
import type { GitHubComment, Logger } from "../types.ts";

const SIGNATURE = "a1b2c3d4e5f60718";
const HEAD = "b".repeat(40);

interface Recorded {
  errors: string[];
  warnings: string[];
}

function recordingLogger(recorded: Recorded): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: (message: string) => recorded.warnings.push(message),
    error: (message: string) => recorded.errors.push(message),
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

function comment(
  id: number,
  author: string,
  body: string,
): GitHubComment {
  return {
    id,
    author,
    body,
    createdAt: "2026-09-01T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

function attemptComment(
  id: number,
  author: string,
  attempt: number,
  diagnosis: string,
): GitHubComment {
  return comment(
    id,
    author,
    `${diagnosis}\n\n${
      buildCiFixAttemptMarker({
        signature: SIGNATURE,
        checkName: "build",
        head: HEAD,
        attempt,
        outcome: "pushed",
      })
    }`,
  );
}

Deno.test("readPrCiFixMarkers - collects the fleet's markers and reports the cap enforceable", async () => {
  const recorded: Recorded = { errors: [], warnings: [] };
  const state = await readPrCiFixMarkers({
    repo: "org/repo",
    prNumber: 77,
    getComments: () =>
      Promise.resolve([
        attemptComment(1, "stservice", 1, "missing import"),
        attemptComment(2, "VibeCoderST", 2, "wrong package"),
      ]),
    fleetLogins: ["stservice", "VibeCoderST"],
    logger: recordingLogger(recorded),
  });

  assertEquals(state.capEnforced, true);
  assertEquals(state.comments.length, 2);
  assertEquals(state.markers.attempts.get(SIGNATURE)?.length, 2);
  assertEquals(recorded.errors, []);
});

Deno.test("readPrCiFixMarkers - a failed comment read is reported as a read failure, not an empty budget", async () => {
  const recorded: Recorded = { errors: [], warnings: [] };
  const state = await readPrCiFixMarkers({
    repo: "org/repo",
    prNumber: 77,
    getComments: () => Promise.reject(new Error("gh: API rate limit")),
    fleetLogins: ["stservice"],
    logger: recordingLogger(recorded),
  });

  assertEquals(state.capEnforced, false);
  assertEquals(state.readFailed, true, "the caller must be able to stand down");
  assertEquals(state.comments, []);
  assertEquals(state.markers.attempts.size, 0);
  assertEquals(recorded.errors.length, 1);
  assertStringIncludes(recorded.errors[0] ?? "", "stands down");
});

Deno.test("readPrCiFixMarkers - an unresolved fleet is reported as unenforceable", async () => {
  const recorded: Recorded = { errors: [], warnings: [] };
  const state = await readPrCiFixMarkers({
    repo: "org/repo",
    prNumber: 77,
    getComments: () =>
      Promise.resolve([attemptComment(1, "stservice", 1, "missing import")]),
    fleetLogins: [],
    logger: recordingLogger(recorded),
  });

  assertEquals(state.capEnforced, false);
  assertEquals(
    state.readFailed,
    false,
    "a misconfigured fleet is not a transient read failure — the repair runs",
  );
  assertEquals(state.markers.attempts.size, 0);
  assertEquals(recorded.errors.length, 1);
  assertStringIncludes(recorded.errors[0] ?? "", "fleet login set is empty");
});

Deno.test("buildCapAttemptRows - renders the marker tally as summary rows", async () => {
  const state = await readPrCiFixMarkers({
    repo: "org/repo",
    prNumber: 77,
    getComments: () =>
      Promise.resolve([
        attemptComment(1, "stservice", 1, "missing import of Bar"),
        attemptComment(2, "stservice", 2, "wrong package for Bar"),
      ]),
    fleetLogins: ["stservice"],
    logger: recordingLogger({ errors: [], warnings: [] }),
  });

  const rows = buildCapAttemptRows(state.markers.attempts.get(SIGNATURE) ?? []);
  assertEquals(rows.map((r) => r.attempt), [1, 2]);
  assertEquals(rows[0]?.diagnosis, "missing import of Bar");

  const summary = buildAutoFixCapSummary({
    checkName: "build",
    signature: SIGNATURE,
    maxAttempts: 2,
    attempts: rows,
  });
  assertStringIncludes(summary, "missing import of Bar");
  assertStringIncludes(summary, "wrong package for Bar");
  assertStringIncludes(summary, "| 2 |");
});

Deno.test("describeAttemptOutcome - both outcomes read as prose", () => {
  assertStringIncludes(describeAttemptOutcome("pushed"), "pushed a fix");
  assertStringIncludes(describeAttemptOutcome("no-change"), "no change");
});

Deno.test("appendAttemptToComment - keeps the diagnosis and adds the new marker", () => {
  const marker = buildCiFixAttemptMarker({
    signature: SIGNATURE,
    checkName: "build",
    head: HEAD,
    attempt: 2,
    outcome: "no-change",
  });
  const updated = appendAttemptToComment(
    "the failure is in the base branch\n\n<!-- first marker -->\n",
    "_Attempt 2: unchanged._",
    marker,
  );

  assertStringIncludes(updated, "the failure is in the base branch");
  assertStringIncludes(updated, "<!-- first marker -->");
  assertStringIncludes(updated, "_Attempt 2: unchanged._");
  assert(updated.endsWith(marker), "the new marker closes the body");
});
