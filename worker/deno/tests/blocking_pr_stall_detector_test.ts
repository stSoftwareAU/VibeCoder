/**
 * Tests for blocking_pr_stall_detector.ts — the stall watchdog over PRs
 * that block queued `work-on` issues (Issue #4025).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AUTO_FIX_CAP_MARKER_PREFIX,
  BLOCKING_PR_STALL_NEXT_STEP,
  BLOCKING_PR_STALL_WITHDRAWAL_MARKER,
  type BlockingPrObservation,
  blockingPrStallMarker,
  buildBlockingPrStallNextStep,
  buildBlockingPrStallReason,
  DEFAULT_BLOCKING_PR_STALL_THRESHOLD_SECONDS,
  describeStallSummary,
  detectBlockingPrStall,
  escalateBlockingPrStall,
  findBlockingPrObservations,
  isMergeConflictLaneOwned,
  resolveBlockingPrStallThresholdSeconds,
  scanBlockingPrStalls,
  withdrawBlockingPrStallEscalation,
} from "../lib/blocking_pr_stall_detector.ts";
import { buildDedupMarker } from "../lib/needs_human_escalation.ts";
import { MERGE_CONFLICT_LABEL } from "../lib/pr_merge_conflict_scan.ts";
import type { Logger } from "../types.ts";

const REPO = "owner/repo";
const NOW = Date.parse("2026-08-11T20:00:00Z") / 1000;
const THRESHOLD = 7200; // 2h

/** Silent logger for tests. */
const noop = () => {};
const logger: Logger = {
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

function observation(
  overrides: Partial<BlockingPrObservation> = {},
): BlockingPrObservation {
  return {
    repo: REPO,
    prNumber: 103,
    blockedIssues: [93, 94],
    failingChecks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Red-CI signal
// ---------------------------------------------------------------------------

Deno.test("red CI past threshold on blocking PR trips detector", () => {
  const stall = detectBlockingPrStall(
    observation({
      failingChecks: [{ name: "quality", completedAt: "2026-08-11T12:07:00Z" }],
      lastFleetPushAt: "2026-08-11T12:00:00Z",
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assert(stall, "expected a stall");
  assertEquals(stall.signals.map((s) => s.reason), ["red-ci"]);
  assertEquals(stall.blockedIssues, [93, 94]);
  assertStringIncludes(stall.signals[0]!.detail, "quality");
});

Deno.test("red CI inside the threshold does not trip", () => {
  const stall = detectBlockingPrStall(
    observation({
      failingChecks: [{ name: "quality", completedAt: "2026-08-11T19:00:00Z" }],
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("push newer than failing run does not trip", () => {
  const stall = detectBlockingPrStall(
    observation({
      failingChecks: [{ name: "quality", completedAt: "2026-08-11T12:07:00Z" }],
      lastFleetPushAt: "2026-08-11T12:30:00Z",
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

// ---------------------------------------------------------------------------
// Unanswered-authorised-comment signal
// ---------------------------------------------------------------------------

Deno.test("unanswered authorised comment past threshold trips", () => {
  const stall = detectBlockingPrStall(
    observation({
      lastAuthorisedCommentAt: "2026-08-11T16:36:00Z",
      lastFleetReplyAt: "2026-08-11T10:00:00Z",
      lastFleetPushAt: "2026-08-11T12:00:00Z",
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assert(stall, "expected a stall");
  assertEquals(stall.signals.map((s) => s.reason), ["unanswered-comment"]);
});

Deno.test("answered authorised comment does not trip", () => {
  const stall = detectBlockingPrStall(
    observation({
      lastAuthorisedCommentAt: "2026-08-11T16:36:00Z",
      lastFleetReplyAt: "2026-08-11T16:40:00Z",
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("a push after the authorised comment counts as an answer", () => {
  const stall = detectBlockingPrStall(
    observation({
      lastAuthorisedCommentAt: "2026-08-11T16:36:00Z",
      lastFleetPushAt: "2026-08-11T16:50:00Z",
      // Issue #1082: this fixture is also green and unmerged, which the new
      // third signal would trip on. Arming auto-merge says the PR is already
      // on its way, isolating the comment rule this test is about.
      autoMergeEnabled: true,
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("both signals trip together on a red, unanswered PR", () => {
  const stall = detectBlockingPrStall(
    observation({
      failingChecks: [{ name: "quality", completedAt: "2026-08-11T12:07:00Z" }],
      lastAuthorisedCommentAt: "2026-08-11T16:36:00Z",
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assert(stall, "expected a stall");
  assertEquals(stall.signals.map((s) => s.reason), [
    "red-ci",
    "unanswered-comment",
  ]);
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

Deno.test("PR blocking no work-on issue never trips", () => {
  const stall = detectBlockingPrStall(
    observation({
      blockedIssues: [],
      failingChecks: [{ name: "quality", completedAt: "2026-08-10T00:00:00Z" }],
      lastAuthorisedCommentAt: "2026-08-10T00:00:00Z",
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

// ---------------------------------------------------------------------------
// Threshold resolution
// ---------------------------------------------------------------------------

Deno.test("threshold resolves per-repo override then global default", () => {
  assertEquals(
    resolveBlockingPrStallThresholdSeconds({}, REPO),
    DEFAULT_BLOCKING_PR_STALL_THRESHOLD_SECONDS,
  );

  assertEquals(
    resolveBlockingPrStallThresholdSeconds(
      { blockingPrStallThresholdSeconds: 900 },
      REPO,
    ),
    900,
  );

  assertEquals(
    resolveBlockingPrStallThresholdSeconds({
      blockingPrStallThresholdSeconds: 900,
      repoConfig: { [REPO]: { blockingPrStallThresholdSeconds: 300 } },
    }, REPO),
    300,
  );

  // Override applies to its own repo only.
  assertEquals(
    resolveBlockingPrStallThresholdSeconds({
      blockingPrStallThresholdSeconds: 900,
      repoConfig: { "other/repo": { blockingPrStallThresholdSeconds: 300 } },
    }, REPO),
    900,
  );

  // Invalid values fall back — override to global, global to the default.
  assertEquals(
    resolveBlockingPrStallThresholdSeconds({
      blockingPrStallThresholdSeconds: 900,
      repoConfig: { [REPO]: { blockingPrStallThresholdSeconds: -5 } },
    }, REPO),
    900,
  );
  assertEquals(
    resolveBlockingPrStallThresholdSeconds(
      { blockingPrStallThresholdSeconds: 1.5 },
      REPO,
    ),
    DEFAULT_BLOCKING_PR_STALL_THRESHOLD_SECONDS,
  );
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/**
 * Build a gh stub over a mutable comment thread, mirroring the argument
 * shapes `createGhEscalationClient` and `issueCommentsContainMarker` use.
 * Every write (label add, comment POST) is recorded in `writes`.
 */
/** The fleet login the escalation stub writes its own comments as. */
const FLEET_LOGIN = "vibe-coder-bot";

/** Fleet identity the marker-author check is given instead of a config. */
const FLEET_DEDUP = { fleetAuthors: [FLEET_LOGIN] };

function buildEscalationGh(
  comments: string[],
  writes: string[][],
  commentAuthor: string = FLEET_LOGIN,
): (args: string[]) => Promise<string> {
  const listing = () =>
    JSON.stringify(
      comments.map((body, i) => ({
        id: i + 1,
        body,
        created_at: "2026-08-11T18:00:00Z",
        user: { login: commentAuthor },
      })),
    );

  return (args: string[]) => {
    if (args[0] === "api" && args[1] !== "-X") {
      const path = args[1] ?? "";
      // Paged marker lookup — page 1 carries the whole (short) thread.
      if (path.includes("/comments?")) {
        return Promise.resolve(path.includes("page=1") ? listing() : "[]");
      }
      if (path.endsWith("/comments")) return Promise.resolve(listing());
    }

    writes.push(args);

    if (args[0] === "api" && args[1] === "-X") {
      const path = args[3] ?? "";
      if (path.endsWith("/comments")) {
        const field = args[5] ?? "";
        comments.push(field.replace(/^body=/, ""));
      }
      return Promise.resolve("{}");
    }

    return Promise.resolve("{}");
  };
}

function redCiStall() {
  return {
    repo: REPO,
    prNumber: 103,
    blockedIssues: [93, 94],
    signals: [
      {
        reason: "red-ci" as const,
        stalledSeconds: 28380,
        detail: "checks failing for 7 hours with no new push (quality)",
      },
    ],
  };
}

Deno.test("escalation comment posted at most once per PR per stall reason", async () => {
  const comments: string[] = [];
  const writes: string[][] = [];
  const gh = buildEscalationGh(comments, writes);
  const deps = {
    ghCommandFn: gh,
    needsHumanLabel: "needs-human",
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    dedupAuthors: FLEET_DEDUP,
    logger,
  };

  const first = await escalateBlockingPrStall(redCiStall(), deps);
  assert(first.ok);
  assertEquals(first.value.postedReasons, ["red-ci"]);

  const second = await escalateBlockingPrStall(redCiStall(), deps);
  assert(second.ok);
  assertEquals(second.value.postedReasons, []);

  const posted = comments.filter((c) =>
    c.includes(blockingPrStallMarker("red-ci"))
  );
  assertEquals(posted.length, 1, "exactly one comment for the red-ci reason");
  assertStringIncludes(posted[0]!, "#93, #94");
});

Deno.test("an auto-fix-cap marker planted by an outsider does not suppress the escalation (Issue #1216)", async () => {
  // A PR comment is text any GitHub account may write, and this marker
  // suppresses the whole stall escalation for the PR. Trusting the body alone
  // let one planted comment silence the watchdog on that PR for good.
  const writes: string[][] = [];
  const comments: string[] = [];
  const gh = buildEscalationGh(comments, writes, "drive-by-attacker");
  comments.push(
    `## Automatic fix attempts exhausted\n\n${
      buildDedupMarker("auto-fix-cap:deadbeefdeadbeef")
    }`,
  );

  const result = await escalateBlockingPrStall(redCiStall(), {
    ghCommandFn: gh,
    needsHumanLabel: "needs-human",
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    dedupAuthors: FLEET_DEDUP,
    logger,
  });

  assert(result.ok);
  assertEquals(result.value.suppressedByAutoFixCap, false);
  assertEquals(result.value.postedReasons, ["red-ci"]);
});

Deno.test("escalation is suppressed when the auto-fix cap has already escalated", async () => {
  const comments = [
    `## Automatic fix attempts exhausted\n\n${
      buildDedupMarker("auto-fix-cap:deadbeefdeadbeef")
    }`,
  ];
  const writes: string[][] = [];
  const gh = buildEscalationGh(comments, writes);

  const result = await escalateBlockingPrStall(redCiStall(), {
    ghCommandFn: gh,
    needsHumanLabel: "needs-human",
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    dedupAuthors: FLEET_DEDUP,
    logger,
  });

  assert(result.ok);
  assertEquals(result.value.suppressedByAutoFixCap, true);
  assertEquals(result.value.postedReasons, []);
  assertEquals(writes.length, 0, "no label or comment writes when suppressed");
});

Deno.test("auto-fix cap marker prefix matches the escalation helper's marker", () => {
  assert(
    buildDedupMarker("auto-fix-cap:deadbeefdeadbeef").startsWith(
      AUTO_FIX_CAP_MARKER_PREFIX,
    ),
    "AUTO_FIX_CAP_MARKER_PREFIX has drifted from buildDedupMarker()",
  );
});

// ---------------------------------------------------------------------------
// Observation gathering + end-to-end scan
// ---------------------------------------------------------------------------

interface ScanFixture {
  /** Open issues returned by `gh issue list`. */
  issues: Array<
    { number: number; labels: string[]; milestone?: string }
  >;
  /** Open fleet PRs returned by `gh pr list --author`. */
  prs: Array<
    { number: number; baseRefName: string; headRefName: string }
  >;
  /** `gh pr view` payload keyed by PR number. */
  views: Record<number, unknown>;
}

function buildScanGh(
  fixture: ScanFixture,
  comments: string[],
  writes: string[][],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(
        fixture.issues.map((i) => ({
          number: i.number,
          title: `Issue ${i.number}`,
          url: `https://github.com/${REPO}/issues/${i.number}`,
          assignees: [],
          labels: i.labels.map((name) => ({ name })),
          createdAt: "2026-08-01T00:00:00Z",
          author: { login: "human" },
          milestone: i.milestone ? { title: i.milestone } : null,
        })),
      ));
    }
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(
        fixture.prs.map((p) => ({
          number: p.number,
          title: `PR ${p.number}`,
          baseRefName: p.baseRefName,
          headRefName: p.headRefName,
        })),
      ));
    }
    if (args[0] === "pr" && args[1] === "view") {
      const number = Number(args[2]);
      return Promise.resolve(JSON.stringify(fixture.views[number] ?? {}));
    }
    return buildEscalationGh(comments, writes)(args);
  };
}

const STALLED_VIEW = {
  comments: [
    {
      author: { login: "nigel" },
      createdAt: "2026-08-11T16:36:00Z",
      body: "Any progress?",
    },
    {
      author: { login: "vibe-coder" },
      createdAt: "2026-08-11T11:00:00Z",
      body: "Working on it",
    },
  ],
  commits: [
    { oid: "aaa", committedDate: "2026-08-11T11:30:00Z" },
    { oid: "bbb", committedDate: "2026-08-11T12:00:00Z" },
  ],
  statusCheckRollup: [
    {
      name: "quality",
      status: "COMPLETED",
      conclusion: "FAILURE",
      completedAt: "2026-08-11T12:07:00Z",
    },
    {
      name: "lint",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      completedAt: "2026-08-11T12:05:00Z",
    },
  ],
};

Deno.test("observation gathering maps blocked work-on issues onto the blocking PR", async () => {
  const fixture: ScanFixture = {
    issues: [
      { number: 93, labels: ["work-on"] },
      { number: 94, labels: ["work-on"] },
      { number: 95, labels: ["enhancement"] },
    ],
    prs: [{ number: 103, baseRefName: "Develop", headRefName: "issue-93" }],
    views: { 103: STALLED_VIEW },
  };
  const gh = buildScanGh(fixture, [], []);

  const observations = await findBlockingPrObservations({
    repos: [REPO],
    workOnLabel: "work-on",
    fleetAuthors: ["vibe-coder"],
    authorisedCommenters: ["nigel"],
    ghCommandFn: gh,
  });

  assertEquals(observations.length, 1);
  const obs = observations[0]!;
  assertEquals(obs.prNumber, 103);
  assertEquals(obs.blockedIssues, [93, 94]);
  assertEquals(obs.failingChecks, [{
    name: "quality",
    completedAt: "2026-08-11T12:07:00Z",
  }]);
  assertEquals(obs.lastFleetPushAt, "2026-08-11T12:00:00Z");
  assertEquals(obs.lastAuthorisedCommentAt, "2026-08-11T16:36:00Z");
  assertEquals(obs.lastFleetReplyAt, "2026-08-11T11:00:00Z");
});

Deno.test("scan escalates a stalled blocking PR once and reports it", async () => {
  const fixture: ScanFixture = {
    issues: [
      { number: 93, labels: ["work-on"] },
      { number: 94, labels: ["work-on"] },
    ],
    prs: [{ number: 103, baseRefName: "Develop", headRefName: "issue-93" }],
    views: { 103: STALLED_VIEW },
  };
  const comments: string[] = [];
  const writes: string[][] = [];
  const gh = buildScanGh(fixture, comments, writes);

  const scanOptions = {
    repos: [REPO],
    workOnLabel: "work-on",
    fleetAuthors: ["vibe-coder"],
    authorisedCommenters: ["nigel"],
    ghCommandFn: gh,
    config: { blockingPrStallThresholdSeconds: THRESHOLD },
    needsHumanLabel: "needs-human",
    githubUser: "vibe-coder",
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    dedupAuthors: FLEET_DEDUP,
    logger,
    nowSeconds: () => NOW,
  };

  const first = await scanBlockingPrStalls(scanOptions);
  assert(first.ok);
  assertEquals(first.value.length, 1);
  assertEquals(first.value[0]!.signals.map((s) => s.reason), [
    "red-ci",
    "unanswered-comment",
  ]);
  assertEquals(comments.length, 2, "one comment per stall reason");

  // A second iteration inside the same stall must not add more comments.
  const second = await scanBlockingPrStalls(scanOptions);
  assert(second.ok);
  assertEquals(second.value.length, 1);
  assertEquals(comments.length, 2, "marker dedup holds across iterations");
});

Deno.test("scan ignores an open PR that blocks no work-on issue", async () => {
  const fixture: ScanFixture = {
    issues: [{ number: 95, labels: ["enhancement"] }],
    prs: [{ number: 103, baseRefName: "Develop", headRefName: "issue-95" }],
    views: { 103: STALLED_VIEW },
  };
  const comments: string[] = [];
  const writes: string[][] = [];
  const gh = buildScanGh(fixture, comments, writes);

  const result = await scanBlockingPrStalls({
    repos: [REPO],
    workOnLabel: "work-on",
    fleetAuthors: ["vibe-coder"],
    authorisedCommenters: ["nigel"],
    ghCommandFn: gh,
    config: {},
    needsHumanLabel: "needs-human",
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    dedupAuthors: FLEET_DEDUP,
    logger,
    nowSeconds: () => NOW,
  });

  assert(result.ok);
  assertEquals(result.value, []);
  assertEquals(comments.length, 0);
  assertEquals(writes.length, 0);
});

// ---------------------------------------------------------------------------
// A mechanical stall is work, not a decision (Issue #569). VibeCoder #549 was
// escalated here for a two-hour-old semgrep failure — which the CI-fix lane
// exists to repair — and the `needs-human` that followed then locked the PR
// out of the merge-conflict lane, which skips any PR carrying that label.
// ---------------------------------------------------------------------------

Deno.test("escalateBlockingPrStall - files the stall as work and never applies needs-human", async () => {
  const comments: string[] = [];
  const writes: string[][] = [];
  const filed: { prNumber: number; summary: string }[] = [];

  const result = await escalateBlockingPrStall(redCiStall(), {
    ghCommandFn: buildEscalationGh(comments, writes),
    needsHumanLabel: "needs-human",
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    escalateWork: (escalation) => {
      filed.push({
        prNumber: escalation.prNumber,
        summary: escalation.summary,
      });
      return Promise.resolve({
        ok: true as const,
        value: { issueNumber: 601, filed: true },
      });
    },
    logger,
  });

  assert(result.ok, "the escalation must not fail");
  // The blockage went to the work queue…
  assertEquals(filed.length, 1);
  assertEquals(filed[0]?.prNumber, 103);
  assertStringIncludes(filed[0]?.summary ?? "", "CI is red");

  // …and `needs-human` — the cross-subsystem veto that strands a PR in every
  // OTHER lane — was never applied.
  const labelWrites = writes
    .filter((args) => (args[3] ?? "").endsWith("/labels"))
    .flat()
    .filter((arg) => arg.startsWith("labels[]="))
    .map((arg) => arg.slice("labels[]=".length));

  assertEquals(
    labelWrites.includes("needs-human"),
    false,
    `a mechanical stall must not veto the other lanes: ${
      labelWrites.join(", ")
    }`,
  );
  // The PR still carries a marker, so the queue stays visible on the artefact.
  assertEquals(
    labelWrites,
    ["escalated"],
    "the PR gets the non-vetoing marker and nothing else",
  );
});

// ---------------------------------------------------------------------------
// Green-but-unmerged signal (Issue #1082) — the shape that froze GRQ-GTC for
// five days: nothing red, nothing unanswered, nothing landing.
// ---------------------------------------------------------------------------

Deno.test("a green blocking PR with no auto-merge trips past the threshold", () => {
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      autoMergeEnabled: false,
      checkCounts: { total: 12, pending: 0 },
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assert(stall, "expected a stall");
  assertEquals(stall.signals.map((s) => s.reason), ["unmerged-green"]);
  assertEquals(stall.blockedIssues, [93, 94]);
  assertStringIncludes(stall.signals[0]!.detail, "no auto-merge armed");
});

Deno.test("a green blocking PR inside the threshold does not trip", () => {
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-11T19:30:00Z",
      lastFleetPushAt: "2026-08-11T19:30:00Z",
      checkCounts: { total: 12, pending: 0 },
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("an armed auto-merge is not a stall — the PR is already on its way", () => {
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      autoMergeEnabled: true,
      checkCounts: { total: 12, pending: 0 },
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("a red PR reports red-ci only, never green-but-unmerged as well", () => {
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      failingChecks: [{ name: "quality", completedAt: "2026-08-11T12:07:00Z" }],
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assert(stall);
  assertEquals(stall.signals.map((s) => s.reason), ["red-ci"]);
});

Deno.test("a PR whose checks failed recently is not reported as green", () => {
  // Red 10 minutes ago on a PR opened five days ago: the red-CI signal has
  // not matured, and calling that PR "green but unmerged" would be a lie.
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      failingChecks: [{ name: "quality", completedAt: "2026-08-11T19:50:00Z" }],
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("a green PR blocking nothing is out of scope", () => {
  const stall = detectBlockingPrStall(
    observation({
      blockedIssues: [],
      createdAt: "2026-08-06T05:46:00Z",
      checkCounts: { total: 12, pending: 0 },
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("the green-but-unmerged escalation names the PR and the blocked count", () => {
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      checkCounts: { total: 12, pending: 0 },
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assert(stall);
  const reason = buildBlockingPrStallReason(stall, stall.signals[0]!);
  assertStringIncludes(reason, `${REPO}#103`);
  assertStringIncludes(reason, "blocking 2 `work-on` issues");
  assertStringIncludes(reason, "#93, #94");
  assertStringIncludes(
    describeStallSummary("unmerged-green"),
    "green but is not being merged",
  );
});

Deno.test("a green-but-unmerged stall escalates exactly once", async () => {
  const comments: string[] = [];
  const writes: string[][] = [];
  const gh = buildEscalationGh(comments, writes);
  const stall = {
    repo: REPO,
    prNumber: 305,
    blockedIssues: [93],
    signals: [
      {
        reason: "unmerged-green" as const,
        stalledSeconds: 432000,
        detail: "been open and green for 120 hours with no auto-merge armed" +
          " and no merge",
      },
    ],
  };
  const deps = {
    ghCommandFn: gh,
    needsHumanLabel: "needs-human",
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    escalateWork: () =>
      Promise.resolve({
        ok: true as const,
        value: { issueNumber: 900, filed: true },
      }),
    dedupAuthors: FLEET_DEDUP,
    logger,
  };

  const first = await escalateBlockingPrStall(stall, deps);
  assert(first.ok);
  assertEquals(first.value.postedReasons, ["unmerged-green"]);

  const second = await escalateBlockingPrStall(stall, deps);
  assert(second.ok);
  assertEquals(second.value.postedReasons, []);

  const posted = comments.filter((c) =>
    c.includes(blockingPrStallMarker("unmerged-green"))
  );
  assertEquals(posted.length, 1, "exactly one comment for the stalled repo");
  assertStringIncludes(posted[0]!, `${REPO}#305`);
});

Deno.test("a PR that merges inside the threshold is never escalated", async () => {
  // A merged PR is not open, so the observation gatherer never sees it — the
  // scan finds no blocking PR at all and nothing is escalated.
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("issue list")) return Promise.resolve("[]");
    if (joined.includes("pr list")) return Promise.resolve("[]");
    throw new Error(`Unexpected gh command: ${joined}`);
  };

  const result = await scanBlockingPrStalls({
    repos: [REPO],
    workOnLabel: "work-on",
    fleetAuthors: ["VibeCoderST"],
    authorisedCommenters: ["nleck"],
    ghCommandFn: gh,
    config: { blockingPrStallThresholdSeconds: THRESHOLD },
    needsHumanLabel: "needs-human",
    logger,
    nowSeconds: () => NOW,
  });

  assert(result.ok);
  assertEquals(result.value, []);
});

Deno.test("a head with checks still running is not called green", () => {
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      checkCounts: { total: 12, pending: 1 },
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("a head with no checks at all is not called green", () => {
  // "Zero checks is not passed" (docs/MERGE.md, Issue #3705) — the watchdog
  // must not claim green for a head nothing verified.
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      checkCounts: { total: 0, pending: 0 },
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("checks that were never read are not called green", () => {
  const stall = detectBlockingPrStall(
    observation({ createdAt: "2026-08-06T05:46:00Z" }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("a draft PR is not reported as a stalled repository", () => {
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      checkCounts: { total: 12, pending: 0 },
      isDraft: true,
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

// ---------------------------------------------------------------------------
// Merge-conflict lane ownership (Issue #1213).
//
// NEAT-AI-Ockham#119 was escalated as "green and unmerged … or close it",
// entered the merge-conflict lane three minutes later, and was closed by hand
// ten minutes after that — inside the ladder's cooldown, before rung 1 ever
// ran. A PR the ladder owns is not green-but-unmerged, and nothing the
// watchdog says about it may invite a close.
// ---------------------------------------------------------------------------

Deno.test("a CONFLICTING blocking PR is never reported as green but unmerged", () => {
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      checkCounts: { total: 12, pending: 0 },
      mergeable: "CONFLICTING",
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("the merge-conflict label alone takes a PR out of the green lane", () => {
  const stall = detectBlockingPrStall(
    observation({
      createdAt: "2026-08-06T05:46:00Z",
      checkCounts: { total: 12, pending: 0 },
      labels: [MERGE_CONFLICT_LABEL],
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assertEquals(stall, null);
});

Deno.test("a red CONFLICTING PR still trips, and is marked lane-owned", () => {
  const stall = detectBlockingPrStall(
    observation({
      failingChecks: [{ name: "quality", completedAt: "2026-08-11T12:07:00Z" }],
      mergeable: "CONFLICTING",
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assert(stall, "a red PR is still a fact worth reporting");
  assertEquals(stall.signals.map((s) => s.reason), ["red-ci"]);
  assertEquals(stall.mergeConflictLaneOwned, true);
});

Deno.test("a PR outside the lane keeps the original next step", () => {
  const stall = detectBlockingPrStall(
    observation({
      failingChecks: [{ name: "quality", completedAt: "2026-08-11T12:07:00Z" }],
      mergeable: "MERGEABLE",
    }),
    { thresholdSeconds: THRESHOLD, nowSeconds: NOW },
  );

  assert(stall);
  assertEquals(stall.mergeConflictLaneOwned, false);
  assertEquals(
    buildBlockingPrStallNextStep(stall),
    BLOCKING_PR_STALL_NEXT_STEP,
  );
});

Deno.test("a lane-owned stall's next step never invites a close", () => {
  const nextStep = buildBlockingPrStallNextStep({
    mergeConflictLaneOwned: true,
  });

  assertStringIncludes(nextStep, "merge-conflict ladder");
  assertEquals(
    nextStep.includes("close it"),
    false,
    `the ladder owns the close decision: ${nextStep}`,
  );
});

Deno.test("the escalation comment on a lane-owned PR omits the close invitation", async () => {
  const comments: string[] = [];
  const writes: string[][] = [];
  const stall = {
    ...redCiStall(),
    mergeConflictLaneOwned: true,
  };

  const result = await escalateBlockingPrStall(stall, {
    ghCommandFn: buildEscalationGh(comments, writes),
    needsHumanLabel: "needs-human",
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    escalateWork: () =>
      Promise.resolve({
        ok: true as const,
        value: { issueNumber: 900, filed: true },
      }),
    logger,
  });

  assert(result.ok);
  assertEquals(result.value.postedReasons, ["red-ci"]);
  const posted = comments.at(-1) ?? "";
  assertStringIncludes(posted, "merge-conflict ladder");
  assertEquals(
    posted.includes("close it"),
    false,
    `the watchdog must not ask a human to close a laddered PR: ${posted}`,
  );
});

Deno.test("observation gathering reads the PR's mergeability and labels", async () => {
  const fixture: ScanFixture = {
    issues: [{ number: 109, labels: ["work-on"] }],
    prs: [{ number: 119, baseRefName: "Develop", headRefName: "issue-109" }],
    views: {
      119: {
        ...STALLED_VIEW,
        mergeable: "CONFLICTING",
        labels: [{ name: MERGE_CONFLICT_LABEL }, { name: "escalated" }],
      },
    },
  };

  const observations = await findBlockingPrObservations({
    repos: [REPO],
    workOnLabel: "work-on",
    fleetAuthors: ["vibe-coder"],
    authorisedCommenters: ["nigel"],
    ghCommandFn: buildScanGh(fixture, [], []),
  });

  assertEquals(observations.length, 1);
  assertEquals(observations[0]!.mergeable, "CONFLICTING");
  assertEquals(observations[0]!.labels, [MERGE_CONFLICT_LABEL, "escalated"]);
});

Deno.test("a live unmerged-green escalation is withdrawn once the PR enters the lane", async () => {
  const comments = [
    `## Blocking PR has stalled\n\n**Next step:** ${BLOCKING_PR_STALL_NEXT_STEP}\n\n${
      blockingPrStallMarker("unmerged-green")
    }`,
  ];
  const writes: string[][] = [];
  const gh = buildEscalationGh(comments, writes);
  const obs = observation({
    prNumber: 119,
    mergeable: "CONFLICTING",
    labels: [MERGE_CONFLICT_LABEL],
  });

  const first = await withdrawBlockingPrStallEscalation(obs, {
    ghCommandFn: gh,
    logger,
  });
  assert(first.ok);
  assertEquals(first.value.withdrawnReasons, ["unmerged-green"]);

  const retraction = comments.at(-1) ?? "";
  assertStringIncludes(retraction, BLOCKING_PR_STALL_WITHDRAWAL_MARKER);
  assertStringIncludes(retraction, "merge-conflict ladder");
  assertEquals(
    retraction.includes("close it"),
    false,
    `a retraction must not repeat the instruction it withdraws: ${retraction}`,
  );

  // Second pass: the retraction is deduped by its own marker.
  const second = await withdrawBlockingPrStallEscalation(obs, {
    ghCommandFn: gh,
    logger,
  });
  assert(second.ok);
  assertEquals(second.value.withdrawnReasons, []);
  assertEquals(
    comments.filter((c) => c.includes(BLOCKING_PR_STALL_WITHDRAWAL_MARKER))
      .length,
    1,
    "exactly one retraction per PR",
  );
});

Deno.test("nothing is withdrawn when no stall escalation is live", async () => {
  const comments: string[] = [];
  const writes: string[][] = [];

  const result = await withdrawBlockingPrStallEscalation(
    observation({ mergeable: "CONFLICTING", labels: [MERGE_CONFLICT_LABEL] }),
    { ghCommandFn: buildEscalationGh(comments, writes), logger },
  );

  assert(result.ok);
  assertEquals(result.value.withdrawnReasons, []);
  assertEquals(writes.length, 0, "no comment when there is nothing to retract");
});

Deno.test("nothing is withdrawn on a PR the merge-conflict lane does not own", async () => {
  const comments = [
    `## Blocking PR has stalled\n\n${blockingPrStallMarker("unmerged-green")}`,
  ];
  const writes: string[][] = [];

  const result = await withdrawBlockingPrStallEscalation(
    observation({ mergeable: "MERGEABLE" }),
    { ghCommandFn: buildEscalationGh(comments, writes), logger },
  );

  assert(result.ok);
  assertEquals(result.value.withdrawnReasons, []);
  assertEquals(writes.length, 0);
});

Deno.test("the scan withdraws the live escalation on a PR that entered the lane", async () => {
  const fixture: ScanFixture = {
    issues: [{ number: 109, labels: ["work-on"] }],
    prs: [{ number: 119, baseRefName: "Develop", headRefName: "issue-109" }],
    views: {
      119: {
        comments: [],
        commits: [{ oid: "aaa", committedDate: "2026-08-06T05:46:00Z" }],
        statusCheckRollup: [
          {
            name: "quality",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            completedAt: "2026-08-06T06:00:00Z",
          },
        ],
        createdAt: "2026-08-06T05:46:00Z",
        autoMergeRequest: null,
        isDraft: false,
        mergeable: "CONFLICTING",
        labels: [{ name: MERGE_CONFLICT_LABEL }],
      },
    },
  };
  const comments = [
    `## Blocking PR has stalled\n\n**Next step:** ${BLOCKING_PR_STALL_NEXT_STEP}\n\n${
      blockingPrStallMarker("unmerged-green")
    }`,
  ];
  const writes: string[][] = [];

  const scanOptions = {
    repos: [REPO],
    workOnLabel: "work-on",
    fleetAuthors: ["vibe-coder"],
    authorisedCommenters: ["nigel"],
    ghCommandFn: buildScanGh(fixture, comments, writes),
    config: { blockingPrStallThresholdSeconds: THRESHOLD },
    needsHumanLabel: "needs-human",
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    logger,
    nowSeconds: () => NOW,
  };

  const result = await scanBlockingPrStalls(scanOptions);
  assert(result.ok);
  assertEquals(result.value, [], "a laddered PR is not a green stall");
  assertEquals(
    comments.filter((c) => c.includes(BLOCKING_PR_STALL_WITHDRAWAL_MARKER))
      .length,
    1,
    "the live escalation is retracted exactly once",
  );

  await scanBlockingPrStalls(scanOptions);
  assertEquals(
    comments.filter((c) => c.includes(BLOCKING_PR_STALL_WITHDRAWAL_MARKER))
      .length,
    1,
    "the retraction is not repeated on the next iteration",
  );
});

Deno.test("lane ownership tolerates unknown, absent and empty state", () => {
  assertEquals(isMergeConflictLaneOwned({}), false);
  assertEquals(isMergeConflictLaneOwned({ mergeable: "UNKNOWN" }), false);
  assertEquals(isMergeConflictLaneOwned({ labels: [] }), false);
  assertEquals(isMergeConflictLaneOwned({ mergeable: " conflicting " }), true);
  assertEquals(
    isMergeConflictLaneOwned({ labels: ["escalated", MERGE_CONFLICT_LABEL] }),
    true,
  );
});

Deno.test("a withdrawal that cannot read the thread fails loud", async () => {
  const result = await withdrawBlockingPrStallEscalation(
    observation({ mergeable: "CONFLICTING" }),
    {
      ghCommandFn: () => Promise.reject(new Error("gh api: 502 Bad Gateway")),
      logger,
    },
  );

  assert(!result.ok, "an unreadable thread must not report a clean no-op");
  assertStringIncludes(result.error.message, "502 Bad Gateway");
  assertStringIncludes(result.error.message, `${REPO}#103`);
});

Deno.test("a withdrawal whose comment cannot be posted fails loud", async () => {
  const comments = [
    `## Blocking PR has stalled\n\n${blockingPrStallMarker("unmerged-green")}`,
  ];
  const writes: string[][] = [];
  const read = buildEscalationGh(comments, writes);

  const result = await withdrawBlockingPrStallEscalation(
    observation({ mergeable: "CONFLICTING" }),
    {
      ghCommandFn: (args: string[]) => {
        // Both the REST POST and the `gh issue comment` fallback refuse.
        if (args.includes("-X") || args[0] === "issue") {
          return Promise.reject(new Error("gh: comment refused"));
        }
        return read(args);
      },
      logger,
    },
  );

  assert(!result.ok, "a dropped retraction must not report success");
  assertStringIncludes(result.error.message, "comment refused");
});
