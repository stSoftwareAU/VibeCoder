/**
 * Tests for the time-gated deferral (Issue #2873).
 *
 * An analysis-only run whose data does not exist yet should be parked until
 * a time, not escalated to `needs-human`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDeferralExhaustedComment,
  buildTimeDeferralLine,
  deferIssueUntil,
  detectTimeDeferral,
  isIssueTimeDeferred,
  isTimeDeferred,
  MAX_DEFERRAL_HORIZON_MS,
  MAX_TIME_DEFERRALS,
  parseTimeDeferralUntil,
  priorTimeDeferrals,
  TIME_DEFERRAL_MARKER,
  TIME_DEFERRAL_RECORD_MARKER,
  type TimeDeferralRequest,
} from "../lib/time_deferral.ts";
import { upsertWorkerRecordLine } from "../lib/worker_record_block.ts";
import type { GitHubClient, GitHubIssue, Logger } from "../types.ts";

const NOW = Date.parse("2026-09-30T00:00:00Z");

function marker(attrs: string): string {
  return `<!-- ${TIME_DEFERRAL_MARKER} ${attrs} -->`;
}

// --- detectTimeDeferral ------------------------------------------------

Deno.test("detectTimeDeferral - valid, Z offset", () => {
  const output = marker(
    `until="2026-10-07T00:00:00Z" reason="Upstream export has not run yet"`,
  );
  const result = detectTimeDeferral(output, NOW);
  assertEquals(result?.kind, "valid");
  const request = (result as { kind: "valid"; request: TimeDeferralRequest })
    .request;
  assertEquals(request.until, "2026-10-07T00:00:00Z");
  assertEquals(request.untilMs, Date.parse("2026-10-07T00:00:00Z"));
  assertEquals(request.reason, "Upstream export has not run yet");
});

Deno.test("detectTimeDeferral - valid, +10:00 offset canonicalised to UTC", () => {
  const output = marker(
    `until="2026-10-07T10:00:00+10:00" reason="waiting on the batch job"`,
  );
  const result = detectTimeDeferral(output, NOW);
  assertEquals(result?.kind, "valid");
  const request = (result as { kind: "valid"; request: TimeDeferralRequest })
    .request;
  assertEquals(request.until, "2026-10-07T00:00:00Z");
});

Deno.test("detectTimeDeferral - no marker returns undefined", () => {
  assertEquals(detectTimeDeferral("Nothing to see here.", NOW), undefined);
});

Deno.test("detectTimeDeferral - invalid: in the past", () => {
  const output = marker(
    `until="2020-01-01T00:00:00Z" reason="stale"`,
  );
  const result = detectTimeDeferral(output, NOW);
  assertEquals(result?.kind, "invalid");
});

Deno.test("detectTimeDeferral - invalid: exactly now", () => {
  const output = marker(
    `until="2026-09-30T00:00:00Z" reason="right now"`,
  );
  const result = detectTimeDeferral(output, NOW);
  assertEquals(result?.kind, "invalid");
});

Deno.test("detectTimeDeferral - invalid: beyond the horizon", () => {
  const beyond = new Date(NOW + MAX_DEFERRAL_HORIZON_MS + 60_000)
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  const output = marker(`until="${beyond}" reason="too far out"`);
  const result = detectTimeDeferral(output, NOW);
  assertEquals(result?.kind, "invalid");
});

Deno.test("detectTimeDeferral - invalid: date-only", () => {
  const output = marker(`until="2026-10-07" reason="no time component"`);
  const result = detectTimeDeferral(output, NOW);
  assertEquals(result?.kind, "invalid");
});

Deno.test("detectTimeDeferral - invalid: garbage", () => {
  const output = marker(`until="not-a-date" reason="garbage"`);
  const result = detectTimeDeferral(output, NOW);
  assertEquals(result?.kind, "invalid");
});

Deno.test("detectTimeDeferral - invalid: missing reason", () => {
  const output = marker(`until="2026-10-07T00:00:00Z"`);
  const result = detectTimeDeferral(output, NOW);
  assertEquals(result?.kind, "invalid");
});

Deno.test("detectTimeDeferral - invalid: placeholder until", () => {
  const output = marker(`until="<ISO-8601>" reason="placeholder"`);
  const result = detectTimeDeferral(output, NOW);
  assertEquals(result?.kind, "invalid");
});

// --- isTimeDeferred / parseTimeDeferralUntil ----------------------------

Deno.test("isTimeDeferred - true before the time, false after", () => {
  const body = upsertWorkerRecordLine(
    "Body.",
    buildTimeDeferralLine("2026-10-07T00:00:00Z"),
  );
  assert(isTimeDeferred(body, Date.parse("2026-10-06T00:00:00Z")));
  assert(!isTimeDeferred(body, Date.parse("2026-10-08T00:00:00Z")));
  assert(!isTimeDeferred(body, Date.parse("2026-10-07T00:00:00Z")));
});

Deno.test("isTimeDeferred - false without a record block", () => {
  assert(!isTimeDeferred("Plain body, no block at all.", NOW));
});

Deno.test("isTimeDeferred - a user-typed line outside the block never defers", () => {
  const body = "Deferred until 2099-01-01T00:00:00Z\n\nSome other text.";
  assertEquals(parseTimeDeferralUntil(body), undefined);
  assert(!isTimeDeferred(body, NOW));
});

// --- isIssueTimeDeferred ---------------------------------------------------

Deno.test("isIssueTimeDeferred - true while the deferral is in the future", async () => {
  const body = upsertWorkerRecordLine(
    "Body.",
    buildTimeDeferralLine("2026-10-07T00:00:00Z"),
  );
  const fetcher = { getIssueBody: () => Promise.resolve(body) };
  const result = await isIssueTimeDeferred(
    fetcher,
    "owner/repo",
    42,
    Date.parse("2026-10-06T00:00:00Z"),
  );
  assert(result);
});

Deno.test("isIssueTimeDeferred - false once the deferral time has passed", async () => {
  const body = upsertWorkerRecordLine(
    "Body.",
    buildTimeDeferralLine("2026-10-07T00:00:00Z"),
  );
  const fetcher = { getIssueBody: () => Promise.resolve(body) };
  const result = await isIssueTimeDeferred(
    fetcher,
    "owner/repo",
    42,
    Date.parse("2026-10-08T00:00:00Z"),
  );
  assert(!result);
});

Deno.test("isIssueTimeDeferred - a getIssueBody failure fails loud, not deferred", async () => {
  const fetcher = {
    getIssueBody: () => Promise.reject(new Error("network down")),
  };
  const messages: string[] = [];
  const result = await isIssueTimeDeferred(
    fetcher,
    "owner/repo",
    42,
    NOW,
    (message) => messages.push(message),
  );
  assert(!result);
  assertEquals(messages.length, 1);
  assertStringIncludes(messages[0]!, "owner/repo#42");
  assertStringIncludes(messages[0]!, "network down");
});

// --- priorTimeDeferrals --------------------------------------------------

Deno.test("priorTimeDeferrals - counts park comments oldest first", () => {
  const comments = [
    `## Deferred until 2026-10-07T00:00:00Z\n<!-- ${TIME_DEFERRAL_RECORD_MARKER} until="2026-10-07T00:00:00Z" -->`,
    `## Deferred until 2026-11-01T00:00:00Z\n<!-- ${TIME_DEFERRAL_RECORD_MARKER} until="2026-11-01T00:00:00Z" -->`,
  ].join("\n\n");
  assertEquals(priorTimeDeferrals(comments), [
    "2026-10-07T00:00:00Z",
    "2026-11-01T00:00:00Z",
  ]);
});

Deno.test("priorTimeDeferrals - empty when there is no history", () => {
  assertEquals(priorTimeDeferrals(""), []);
  assertEquals(priorTimeDeferrals("Plain chatter, no markers."), []);
});

// --- deferIssueUntil ------------------------------------------------------

interface StubCalls {
  postComment: string[];
  editIssue: Array<{ title?: string; body?: string }>;
  addLabel: string[];
  unassignIssue: number;
}

function makeCalls(): StubCalls {
  return { postComment: [], editIssue: [], addLabel: [], unassignIssue: 0 };
}

function makeClient(
  calls: StubCalls,
  body = "Original body.",
  failEditIssue = false,
): GitHubClient {
  const issue: GitHubIssue = {
    number: 42,
    title: "Analyse the export once it lands",
    body,
    labels: ["work-on"],
    author: "human",
    assignees: ["testbot"],
    createdAt: "",
    updatedAt: "",
  };
  return {
    getIssue: () => Promise.resolve(issue),
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_r, _i, label) => {
      calls.addLabel.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_r, _i, b) => {
      calls.postComment.push(b);
      return Promise.resolve(undefined);
    },
    editIssue: (_r, _i, updates) => {
      if (failEditIssue) return Promise.reject(new Error("edit failed"));
      calls.editIssue.push(updates);
      return Promise.resolve();
    },
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => {
      calls.unassignIssue++;
      return Promise.resolve();
    },
    closeIssue: () => Promise.resolve(),
  };
}

function makeLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  return {
    info: () => {},
    warn: () => {},
    error: (message: string) => {
      errors.push(message);
    },
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
    errors,
  };
}

const REQUEST: TimeDeferralRequest = {
  until: "2026-10-07T00:00:00Z",
  untilMs: Date.parse("2026-10-07T00:00:00Z"),
  reason: "Upstream export has not run yet",
};

Deno.test("deferIssueUntil - posts a comment and records the body line", async () => {
  const calls = makeCalls();
  const logger = makeLogger();
  const result = await deferIssueUntil({
    ghClient: makeClient(calls),
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "testbot",
    request: REQUEST,
    priorCount: 0,
    logger,
  });

  assertEquals(calls.postComment.length, 1);
  assertStringIncludes(calls.postComment[0]!, "## Deferred until");
  assertStringIncludes(
    calls.postComment[0]!,
    `<!-- ${TIME_DEFERRAL_RECORD_MARKER} until="2026-10-07T00:00:00Z" -->`,
  );
  assertStringIncludes(calls.postComment[0]!, "Deferral 1 of");

  assertEquals(calls.editIssue.length, 1);
  assertStringIncludes(
    calls.editIssue[0]?.body ?? "",
    "Deferred until 2026-10-07T00:00:00Z",
  );

  assertEquals(calls.addLabel, []);
  assertEquals(calls.unassignIssue, 1);

  assertEquals(result.recorded, true);
  assertEquals(result.outcome.kind, "no_pr_expected");
  assertEquals(
    (result.outcome as { summary?: string }).summary,
    "deferred until 2026-10-07T00:00:00Z",
  );
});

Deno.test("deferIssueUntil - replaces an older Deferred-until line", async () => {
  const calls = makeCalls();
  const existingBody = upsertWorkerRecordLine(
    "Original body.",
    buildTimeDeferralLine("2026-09-01T00:00:00Z"),
  );
  await deferIssueUntil({
    ghClient: makeClient(calls, existingBody),
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "testbot",
    request: REQUEST,
    priorCount: 1,
    logger: makeLogger(),
  });

  const newBody = calls.editIssue[0]?.body ?? "";
  assertEquals(
    newBody.split("Deferred until").length - 1,
    1,
    "only one Deferred-until line should remain",
  );
  assertStringIncludes(newBody, "Deferred until 2026-10-07T00:00:00Z");
});

Deno.test("deferIssueUntil - a failed body edit is logged and not reported recorded", async () => {
  const calls = makeCalls();
  const logger = makeLogger();
  const result = await deferIssueUntil({
    ghClient: makeClient(calls, "Original body.", true),
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "testbot",
    request: REQUEST,
    priorCount: 0,
    logger,
  });

  assertEquals(result.recorded, false);
  assertEquals(calls.editIssue.length, 0);
  assertEquals(calls.unassignIssue, 1);
  assert(
    logger.errors.some((m) => m.includes("Failed to record")),
    "the body-edit failure must be logged loudly",
  );
});

// --- buildDeferralExhaustedComment ---------------------------------------

Deno.test("buildDeferralExhaustedComment - lists prior deferrals and the latest reason", () => {
  const comment = buildDeferralExhaustedComment(
    ["2026-10-07T00:00:00Z", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"],
    REQUEST,
  );
  assertStringIncludes(comment, "## Deferral limit reached");
  assertStringIncludes(comment, "2026-10-07T00:00:00Z");
  assertStringIncludes(comment, "2026-11-01T00:00:00Z");
  assertStringIncludes(comment, "2026-12-01T00:00:00Z");
  assertStringIncludes(comment, "Upstream export has not run yet");
});

Deno.test("MAX_TIME_DEFERRALS and MAX_DEFERRAL_HORIZON_MS are sane bounds", () => {
  assertEquals(MAX_TIME_DEFERRALS, 3);
  assertEquals(MAX_DEFERRAL_HORIZON_MS, 30 * 24 * 60 * 60 * 1000);
});
