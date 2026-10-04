/**
 * Tests for gated_head_guard.ts — standing down from a PR head that no
 * direct push can reach (Issue #1679).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assessGatedHead,
  buildGatedHeadComment,
  gatedHeadMarker,
  gatedHeadMarkerPrefix,
  guardGatedHead,
  isMilestoneHead,
  readLatestStandDownAtMs,
  resetGatedHeadReportsForTest,
  takeoverAtMs,
} from "../lib/gated_head_guard.ts";
import { CONFLICT_OWNER_CHECK_HOURS } from "../lib/merge_conflict_markers.ts";
import type { Logger } from "../types.ts";

const MILESTONE_HEAD = "milestone/4690-bug-sampler-enospc";

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

/** A `gh` stub answering the rules read and recording every call. */
function makeGh(
  responses: { rules?: unknown; comments?: unknown; throwOn?: string },
  calls: string[][] = [],
) {
  return {
    calls,
    run: (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      if (responses.throwOn && joined.includes(responses.throwOn)) {
        return Promise.reject(new Error("HTTP 500: upstream is unwell"));
      }
      if (joined.includes("rules/branches")) {
        return Promise.resolve(JSON.stringify(responses.rules ?? []));
      }
      if (joined.includes("pr view")) {
        return Promise.resolve(
          JSON.stringify({ comments: responses.comments ?? [] }),
        );
      }
      return Promise.resolve("");
    },
  };
}

// ---------------------------------------------------------------------------
// isMilestoneHead
// ---------------------------------------------------------------------------

Deno.test("isMilestoneHead - recognises a milestone collection branch", () => {
  assertEquals(isMilestoneHead(MILESTONE_HEAD), true);
  assertEquals(isMilestoneHead("issue-42-fix-bug"), false);
  assertEquals(isMilestoneHead("milestone/"), false);
  assertEquals(isMilestoneHead("feature/milestone/x"), false);
});

// ---------------------------------------------------------------------------
// assessGatedHead
// ---------------------------------------------------------------------------

Deno.test("assessGatedHead - a milestone head under required status checks is gated", async () => {
  const gh = makeGh({
    rules: [
      { type: "deletion" },
      { type: "required_status_checks", ruleset_id: 21835388 },
    ],
  });
  const assessment = await assessGatedHead("org/repo", MILESTONE_HEAD, gh.run);
  assertEquals(assessment.gated, true);
  assertEquals(assessment.ruleTypes, ["required_status_checks"]);
  assertStringIncludes(assessment.detail, "required_status_checks");
});

Deno.test("assessGatedHead - a pull_request rule also gates the head", async () => {
  const gh = makeGh({ rules: [{ type: "pull_request" }] });
  const assessment = await assessGatedHead("org/repo", MILESTONE_HEAD, gh.run);
  assertEquals(assessment.gated, true);
  assertEquals(assessment.ruleTypes, ["pull_request"]);
});

Deno.test("assessGatedHead - a milestone head with no gating rule is pushable", async () => {
  const gh = makeGh({ rules: [{ type: "deletion" }, { type: "creation" }] });
  const assessment = await assessGatedHead("org/repo", MILESTONE_HEAD, gh.run);
  assertEquals(assessment.gated, false);
  assertEquals(assessment.ruleTypes, []);
});

Deno.test("assessGatedHead - an ordinary feature head is never assessed", async () => {
  const gh = makeGh({ rules: [{ type: "required_status_checks" }] });
  const assessment = await assessGatedHead("org/repo", "issue-42-fix", gh.run);
  assertEquals(assessment.gated, false);
  assertEquals(gh.calls.length, 0, "no API call is made for a feature head");
});

Deno.test("assessGatedHead - an unreadable ruleset fails open, naming the failure", async () => {
  const gh = makeGh({ throwOn: "rules/branches" });
  const assessment = await assessGatedHead("org/repo", MILESTONE_HEAD, gh.run);
  assertEquals(assessment.gated, false);
  assertStringIncludes(assessment.detail, "unreadable");
});

// ---------------------------------------------------------------------------
// guardGatedHead
// ---------------------------------------------------------------------------

Deno.test("guardGatedHead - a gated head is reported on the PR exactly once per run", async () => {
  resetGatedHeadReportsForTest();
  const gh = makeGh({ rules: [{ type: "required_status_checks" }] });

  const first = await guardGatedHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    pass: "spelling fix",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });
  assertEquals(first.gated, true);

  const comments = gh.calls.filter((args) =>
    args[0] === "pr" && args[1] === "comment"
  );
  assertEquals(comments.length, 1);
  assertStringIncludes(
    comments[0]!.join(" "),
    gatedHeadMarkerPrefix(MILESTONE_HEAD),
  );

  // The CI-fix pass on the same PR in the same run stands down silently.
  const second = await guardGatedHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    pass: "CI fix",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });
  assertEquals(second.gated, true);
  assertEquals(
    gh.calls.filter((args) => args[0] === "pr" && args[1] === "comment").length,
    1,
    "the stand-down is recorded once per PR, not once per pass",
  );
});

Deno.test("guardGatedHead - a PR that already carries the marker is not commented on again", async () => {
  resetGatedHeadReportsForTest();
  const gh = makeGh({
    rules: [{ type: "required_status_checks" }],
    comments: [{
      body: `${gatedHeadMarkerPrefix(MILESTONE_HEAD)} -->\nstood down`,
    }],
  });

  const assessment = await guardGatedHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    pass: "merge conflict",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });
  assertEquals(assessment.gated, true);
  assertEquals(
    gh.calls.some((args) => args[0] === "pr" && args[1] === "comment"),
    false,
    "an earlier run already recorded the stand-down",
  );
});

Deno.test("guardGatedHead - an unreadable comment thread posts nothing and says so", async () => {
  resetGatedHeadReportsForTest();
  const warnings: string[] = [];
  const logger = makeSilentLogger();
  logger.warn = (message: string) => warnings.push(message);
  const gh = makeGh({
    rules: [{ type: "required_status_checks" }],
    throwOn: "pr view",
  });

  const assessment = await guardGatedHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    pass: "spelling fix",
    logger,
    runGhCommand: gh.run,
  });
  assertEquals(assessment.gated, true);
  assertEquals(
    gh.calls.some((args) => args[0] === "pr" && args[1] === "comment"),
    false,
    "an unreadable thread must not become a duplicate comment",
  );
  assertEquals(
    warnings.some((w) =>
      w.includes("could not record") || w.includes("Could not record")
    ),
    true,
    "the failure to record is loud in the log",
  );
});

Deno.test("guardGatedHead - a pushable head is left alone", async () => {
  resetGatedHeadReportsForTest();
  const gh = makeGh({ rules: [] });
  const assessment = await guardGatedHead({
    repo: "org/repo",
    prNumber: 7,
    branchName: "issue-7-fix",
    pass: "spelling fix",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });
  assertEquals(assessment.gated, false);
  assertEquals(gh.calls.length, 0);
});

// ---------------------------------------------------------------------------
// buildGatedHeadComment
// ---------------------------------------------------------------------------

const GATED_ASSESSMENT = {
  gated: true as const,
  detail:
    `a ruleset applies required_status_checks to '${MILESTONE_HEAD}', so every direct push is refused (GH013)`,
  ruleTypes: ["required_status_checks"],
};

Deno.test("buildGatedHeadComment - names the branch, the rule and the way forward", () => {
  const standDownAtMs = Date.parse("2026-02-03T04:05:06.000Z");
  const body = buildGatedHeadComment(
    MILESTONE_HEAD,
    GATED_ASSESSMENT,
    standDownAtMs,
  );
  assertStringIncludes(body, gatedHeadMarker(MILESTONE_HEAD, standDownAtMs));
  assertStringIncludes(body, MILESTONE_HEAD);
  assertStringIncludes(body, "required_status_checks");
  assertStringIncludes(body, "pull request");
});

Deno.test("buildGatedHeadComment - names owner `conflict takeover` and the exact UTC takeover time", () => {
  const standDownAtMs = Date.parse("2026-02-03T04:05:06.000Z");
  const body = buildGatedHeadComment(
    MILESTONE_HEAD,
    GATED_ASSESSMENT,
    standDownAtMs,
  );
  assertStringIncludes(body, "**Owner:** `conflict takeover`");

  const match = /Takeover at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/
    .exec(body);
  assertEquals(match !== null, true);
  const expected = new Date(
    standDownAtMs + CONFLICT_OWNER_CHECK_HOURS * 3_600_000,
  ).toISOString();
  assertEquals(match![1], expected);

  assertStringIncludes(
    body,
    `at="${new Date(standDownAtMs).toISOString()}"`,
  );
});

Deno.test("buildGatedHeadComment - throws on a non-finite stand-down time", () => {
  assertThrows(() =>
    buildGatedHeadComment(MILESTONE_HEAD, GATED_ASSESSMENT, NaN)
  );
});

// ---------------------------------------------------------------------------
// takeoverAtMs (Issue #2997)
// ---------------------------------------------------------------------------

Deno.test("takeoverAtMs - adds CONFLICT_OWNER_CHECK_HOURS hours", () => {
  const standDownAtMs = Date.parse("2026-02-03T04:05:06.000Z");
  assertEquals(
    takeoverAtMs(standDownAtMs),
    standDownAtMs + CONFLICT_OWNER_CHECK_HOURS * 3_600_000,
  );
});

Deno.test("takeoverAtMs - throws on a non-finite stand-down time", () => {
  assertThrows(() => takeoverAtMs(NaN));
  assertThrows(() => takeoverAtMs(Infinity));
});

// ---------------------------------------------------------------------------
// Injected clock (Issue #2997)
// ---------------------------------------------------------------------------

Deno.test("guardGatedHead - an injected nowMs posts owner `conflict takeover` and the takeover line", async () => {
  resetGatedHeadReportsForTest();
  const gh = makeGh({ rules: [{ type: "required_status_checks" }] });
  const standDownAtMs = Date.parse("2026-03-01T00:00:00.000Z");

  await guardGatedHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    pass: "spelling fix",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
    nowMs: () => standDownAtMs,
  });

  const comments = gh.calls.filter((args) =>
    args[0] === "pr" && args[1] === "comment"
  );
  assertEquals(comments.length, 1);
  const body = comments[0]![comments[0]!.indexOf("--body") + 1]!;
  assertStringIncludes(body, "**Owner:** `conflict takeover`");
  assertStringIncludes(
    body,
    new Date(takeoverAtMs(standDownAtMs)).toISOString(),
  );
});

// ---------------------------------------------------------------------------
// readLatestStandDownAtMs (Issue #2997)
// ---------------------------------------------------------------------------

function trustedBot(login: string): boolean {
  return login === "vibe-coder-bot";
}

Deno.test("readLatestStandDownAtMs - no stand-down markers returns undefined", () => {
  const comments = [
    {
      body: "just a comment",
      created_at: "2026-01-01T00:00:00Z",
      user: { login: "vibe-coder-bot" },
    },
  ];
  assertEquals(readLatestStandDownAtMs(comments, trustedBot), undefined);
});

Deno.test("readLatestStandDownAtMs - a comment with no user is ignored", () => {
  const comments = [
    {
      body: gatedHeadMarker(MILESTONE_HEAD, Date.parse("2026-01-01T00:00:00Z")),
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  assertEquals(readLatestStandDownAtMs(comments, trustedBot), undefined);
});

Deno.test("readLatestStandDownAtMs - returns the newest trusted marker's at=, not the last created_at", () => {
  // The older comment (by created_at) carries the *later* at=, proving the
  // reader uses the marker's own at= rather than just the newest created_at.
  const earlierCreated = "2026-01-01T00:00:00Z";
  const laterCreated = "2026-01-02T00:00:00Z";
  const earlierAt = Date.parse("2026-01-01T01:00:00.000Z");
  const laterAt = Date.parse("2026-01-05T00:00:00.000Z");

  const comments = [
    {
      body: gatedHeadMarker(MILESTONE_HEAD, laterAt),
      created_at: earlierCreated,
      user: { login: "vibe-coder-bot" },
    },
    {
      // A legacy milestone-head stand-down (retired by Issue #3031) is
      // still read.
      body: `<!-- vibe-milestone-head branch="${MILESTONE_HEAD}" at="${
        new Date(earlierAt).toISOString()
      }" -->`,
      created_at: laterCreated,
      user: { login: "vibe-coder-bot" },
    },
  ];

  assertEquals(readLatestStandDownAtMs(comments, trustedBot), laterAt);
});

Deno.test("readLatestStandDownAtMs - a legacy marker with no at= falls back to created_at", () => {
  const createdAt = "2026-01-03T00:00:00Z";
  const comments = [
    {
      body: `${gatedHeadMarkerPrefix(MILESTONE_HEAD)} -->`,
      created_at: createdAt,
      user: { login: "vibe-coder-bot" },
    },
  ];
  assertEquals(
    readLatestStandDownAtMs(comments, trustedBot),
    Date.parse(createdAt),
  );
});

Deno.test("readLatestStandDownAtMs - an untrusted author's marker is ignored even with a newer at=", () => {
  const comments = [
    {
      body: gatedHeadMarker(MILESTONE_HEAD, Date.parse("2026-01-01T00:00:00Z")),
      created_at: "2026-01-01T00:00:00Z",
      user: { login: "vibe-coder-bot" },
    },
    {
      body: gatedHeadMarker(
        MILESTONE_HEAD,
        Date.parse("2026-06-01T00:00:00Z"),
      ),
      created_at: "2026-06-01T00:00:00Z",
      user: { login: "some-outsider" },
    },
  ];
  assertEquals(
    readLatestStandDownAtMs(comments, trustedBot),
    Date.parse("2026-01-01T00:00:00Z"),
  );
});

Deno.test("readLatestStandDownAtMs - a parked marker with at= is recognised", () => {
  const standDownAtMs = Date.parse("2026-01-04T00:00:00.000Z");
  const comments = [
    {
      body: `<!-- vibe-merge-conflict-parked base="abc1234" at="${
        new Date(standDownAtMs).toISOString()
      }" -->`,
      created_at: "2026-01-04T00:00:00Z",
      user: { login: "vibe-coder-bot" },
    },
  ];
  assertEquals(readLatestStandDownAtMs(comments, trustedBot), standDownAtMs);
});
