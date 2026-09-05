/**
 * Tests for stale_workflow_detector.ts — detection and handling of issues
 * stuck in workflow states for extended periods (Issue #1240).
 *
 * Issue #2031: the `needs-clarification` reminder/auto-close branch was
 * retired. Tests for `processStaleNeedsClarification`,
 * `buildClarificationReminderComment`, and `buildClarificationCloseComment`
 * were removed alongside the corresponding implementation — those code
 * paths no longer exist, so any test exercising them would fail to
 * type-check. The remaining branches (failed/failed-once diagnostics and
 * planning warnings) are still covered below.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildFailedDiagnosticComment,
  daysSince,
  hasAuthorCommentedSince,
  hasExistingStaleComment,
  processStaleFailed,
  processStalePlanning,
  scanForStaleWorkflowIssues,
  STALE_WORKFLOW_DEFAULTS,
  type StaleWorkflowConfig,
  type StaleWorkflowDeps,
} from "../lib/stale_workflow_detector.ts";
import type { GitHubComment, GitHubIssue } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: "Test issue",
    body: "Test body",
    labels: [],
    author: "testuser",
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * The fleet login `makeComment` defaults to (Issue #1124).
 *
 * A stale-diagnostic marker only suppresses the diagnostic when a fleet
 * account wrote it; the planted-marker case is asserted below.
 */
const FLEET_AUTHOR = "bot";

/** Author-verification inputs the fixtures pass instead of a config file. */
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] } as const;

function makeComment(overrides: Partial<GitHubComment> = {}): GitHubComment {
  return {
    id: 1,
    body: "Test comment",
    author: "bot",
    createdAt: "2026-01-01T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
    ...overrides,
  };
}

function defaultConfig(
  overrides: Partial<StaleWorkflowConfig> = {},
): StaleWorkflowConfig {
  return {
    repos: ["org/repo"],
    labels: {
      failed: "failed",
      failedOnce: "failed-once",
      planning: "planning",
    },
    thresholds: {
      failedDiagnosticDays: STALE_WORKFLOW_DEFAULTS.failedDiagnosticDays,
      planningWarningDays: STALE_WORKFLOW_DEFAULTS.planningWarningDays,
    },
    ...overrides,
  };
}

/** Fixed "now" at 2026-02-01T00:00:00Z. */
const FIXED_NOW_MS = new Date("2026-02-01T00:00:00Z").getTime();

function createTestDeps(
  overrides: Partial<StaleWorkflowDeps> = {},
): StaleWorkflowDeps & {
  logs: string[];
  postedComments: Array<{ repo: string; issueNumber: number; body: string }>;
  closedIssues: Array<{ repo: string; issueNumber: number }>;
} {
  const logs: string[] = [];
  const postedComments: Array<
    { repo: string; issueNumber: number; body: string }
  > = [];
  const closedIssues: Array<{ repo: string; issueNumber: number }> = [];

  return {
    logs,
    postedComments,
    closedIssues,
    listIssuesByLabel: () => Promise.resolve([]),
    getIssueComments: () => Promise.resolve([]),
    postComment: (repo, issueNumber, body) => {
      postedComments.push({ repo, issueNumber, body });
      return Promise.resolve();
    },
    closeIssue: (repo, issueNumber) => {
      closedIssues.push({ repo, issueNumber });
      return Promise.resolve();
    },
    log: (msg) => logs.push(msg),
    now: () => FIXED_NOW_MS,
    nowSeconds: () => Math.floor(FIXED_NOW_MS / 1000),
    shouldShutdown: () => false,
    sleep: () => Promise.resolve(),
    getRateLimitReset: () => Promise.resolve(Math.floor(FIXED_NOW_MS / 1000)),
    authorOptions: FLEET_OPTIONS,
    ...overrides,
  };
}

// ============================================================================
// daysSince
// ============================================================================

Deno.test("stale workflow - daysSince calculates correct days", () => {
  const now = new Date("2026-02-01T00:00:00Z").getTime();
  assertEquals(daysSince("2026-01-25T00:00:00Z", now), 7);
  assertEquals(daysSince("2026-01-01T00:00:00Z", now), 31);
  assertEquals(daysSince("2026-01-31T12:00:00Z", now), 0); // less than 1 day
});

Deno.test("stale workflow - daysSince handles invalid timestamp", () => {
  assertEquals(daysSince("not-a-date", Date.now()), 0);
});

Deno.test("stale workflow - daysSince returns 0 for future dates", () => {
  const now = new Date("2026-01-01T00:00:00Z").getTime();
  assertEquals(daysSince("2026-02-01T00:00:00Z", now), 0);
});

// ============================================================================
// hasExistingStaleComment
// ============================================================================

Deno.test("stale workflow - hasExistingStaleComment finds marker", async () => {
  const comments = [
    makeComment({ body: "<!-- vibe-coder-stale-workflow -->\nSome text" }),
  ];
  assertEquals(
    await hasExistingStaleComment(
      comments,
      "<!-- vibe-coder-stale-workflow -->",
      FLEET_OPTIONS,
      () => {},
    ),
    true,
  );
});

Deno.test("stale workflow - hasExistingStaleComment returns false when absent", async () => {
  const comments = [
    makeComment({ body: "Normal comment" }),
  ];
  assertEquals(
    await hasExistingStaleComment(
      comments,
      "<!-- vibe-coder-stale-workflow -->",
      FLEET_OPTIONS,
      () => {},
    ),
    false,
  );
});

Deno.test("stale workflow - hasExistingStaleComment handles empty array", async () => {
  assertEquals(
    await hasExistingStaleComment(
      [],
      "<!-- marker -->",
      FLEET_OPTIONS,
      () => {},
    ),
    false,
  );
});

Deno.test("stale workflow - a planted marker does not silence the diagnostic", async () => {
  // Issue #1124: the marker lives in a comment body anybody may write, and
  // a match suppresses the diagnostic. Only the fleet's own marker counts.
  const comments = [
    makeComment({
      body: "<!-- vibe-coder-stale-diagnostic -->",
      author: "drive-by-account",
    }),
  ];
  assertEquals(
    await hasExistingStaleComment(
      comments,
      "<!-- vibe-coder-stale-diagnostic -->",
      FLEET_OPTIONS,
      () => {},
    ),
    false,
  );
});

Deno.test("stale workflow - a sibling fleet account's marker still dedups", async () => {
  // The guard that stops the fix becoming "always post": cross-host
  // convergence depends on one host seeing another's marker.
  const comments = [
    makeComment({
      body: "<!-- vibe-coder-stale-diagnostic -->",
      author: "sibling-fleet-host",
    }),
  ];
  assertEquals(
    await hasExistingStaleComment(
      comments,
      "<!-- vibe-coder-stale-diagnostic -->",
      { fleetAuthors: [FLEET_AUTHOR, "sibling-fleet-host"] },
      () => {},
    ),
    true,
  );
});

Deno.test("stale workflow - an unresolvable fleet posts the diagnostic and logs", async () => {
  // The chosen fail direction, asserted: a second diagnostic comment is
  // noise; a suppressed one is a stale issue nobody hears about.
  const lines: string[] = [];
  const comments = [
    makeComment({ body: "<!-- vibe-coder-stale-diagnostic -->" }),
  ];
  assertEquals(
    await hasExistingStaleComment(
      comments,
      "<!-- vibe-coder-stale-diagnostic -->",
      { fleetAuthors: [] },
      (message) => lines.push(message),
    ),
    false,
  );
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "the diagnostic is posted");
});

// ============================================================================
// hasAuthorCommentedSince
// ============================================================================

Deno.test("stale workflow - hasAuthorCommentedSince detects author comment", () => {
  const comments = [
    makeComment({ author: "testuser", createdAt: "2026-01-15T00:00:00Z" }),
  ];
  const since = new Date("2026-01-10T00:00:00Z").getTime();
  assertEquals(hasAuthorCommentedSince(comments, "testuser", since), true);
});

Deno.test("stale workflow - hasAuthorCommentedSince ignores other authors", () => {
  const comments = [
    makeComment({ author: "otheruser", createdAt: "2026-01-15T00:00:00Z" }),
  ];
  const since = new Date("2026-01-10T00:00:00Z").getTime();
  assertEquals(hasAuthorCommentedSince(comments, "testuser", since), false);
});

Deno.test("stale workflow - hasAuthorCommentedSince ignores old comments", () => {
  const comments = [
    makeComment({ author: "testuser", createdAt: "2026-01-05T00:00:00Z" }),
  ];
  const since = new Date("2026-01-10T00:00:00Z").getTime();
  assertEquals(hasAuthorCommentedSince(comments, "testuser", since), false);
});

// ============================================================================
// Comment builders
// ============================================================================

Deno.test("stale workflow - buildFailedDiagnosticComment includes label and days", () => {
  const comment = buildFailedDiagnosticComment("failed", 5);
  assertStringIncludes(comment, "`failed`");
  assertStringIncludes(comment, "5 days");
  assertStringIncludes(comment, "<!-- vibe-coder-stale-diagnostic -->");
});

// ============================================================================
// processStaleFailed
// ============================================================================

Deno.test("stale workflow - processStaleFailed posts diagnostic for stale failed issue", async () => {
  const fiveDaysAgo = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000)
    .toISOString();
  const issue = makeIssue({ number: 50, updatedAt: fiveDaysAgo });

  const deps = createTestDeps({
    listIssuesByLabel: (_repo, label) => {
      if (label === "failed") return Promise.resolve([issue]);
      return Promise.resolve([]);
    },
    getIssueComments: () => Promise.resolve([]),
  });

  const config = defaultConfig();
  const results = await processStaleFailed("org/repo", config, deps);

  assertEquals(results.length, 1);
  assertEquals(results[0]!.action, "diagnostic");
  assertEquals(results[0]!.label, "failed");
  assertEquals(deps.postedComments.length, 1);
  assertStringIncludes(deps.postedComments[0]!.body, "`failed`");
});

Deno.test("stale workflow - processStaleFailed skips fresh issues", async () => {
  const oneDayAgo = new Date(FIXED_NOW_MS - 1 * 24 * 60 * 60 * 1000)
    .toISOString();
  const issue = makeIssue({ number: 51, updatedAt: oneDayAgo });

  const deps = createTestDeps({
    listIssuesByLabel: () => Promise.resolve([issue]),
    getIssueComments: () => Promise.resolve([]),
  });

  const config = defaultConfig();
  const results = await processStaleFailed("org/repo", config, deps);

  assertEquals(results.length, 0);
});

Deno.test("stale workflow - processStaleFailed skips when diagnostic already posted", async () => {
  const fiveDaysAgo = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000)
    .toISOString();
  const issue = makeIssue({ number: 52, updatedAt: fiveDaysAgo });

  const deps = createTestDeps({
    listIssuesByLabel: (_repo, label) => {
      if (label === "failed") return Promise.resolve([issue]);
      return Promise.resolve([]);
    },
    getIssueComments: () =>
      Promise.resolve([
        makeComment({
          body: "<!-- vibe-coder-stale-diagnostic -->\nAlready diagnosed",
        }),
      ]),
  });

  const config = defaultConfig();
  const results = await processStaleFailed("org/repo", config, deps);

  assertEquals(results.length, 0);
});

Deno.test("stale workflow - processStaleFailed checks both failed and failed-once", async () => {
  const fiveDaysAgo = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000)
    .toISOString();
  const failedIssue = makeIssue({ number: 53, updatedAt: fiveDaysAgo });
  const failedOnceIssue = makeIssue({ number: 54, updatedAt: fiveDaysAgo });

  const deps = createTestDeps({
    listIssuesByLabel: (_repo, label) => {
      if (label === "failed") return Promise.resolve([failedIssue]);
      if (label === "failed-once") return Promise.resolve([failedOnceIssue]);
      return Promise.resolve([]);
    },
    getIssueComments: () => Promise.resolve([]),
  });

  const config = defaultConfig();
  const results = await processStaleFailed("org/repo", config, deps);

  assertEquals(results.length, 2);
  assertEquals(results[0]!.label, "failed");
  assertEquals(results[1]!.label, "failed-once");
});

// ============================================================================
// processStalePlanning
// ============================================================================

Deno.test("stale workflow - processStalePlanning logs warning for stale planning issue", async () => {
  const fiveDaysAgo = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000)
    .toISOString();
  const issue = makeIssue({ number: 60, updatedAt: fiveDaysAgo });

  const deps = createTestDeps({
    listIssuesByLabel: () => Promise.resolve([issue]),
  });

  const config = defaultConfig();
  const results = await processStalePlanning("org/repo", config, deps);

  assertEquals(results.length, 1);
  assertEquals(results[0]!.action, "warning");
  assertEquals(deps.logs.some((l) => l.includes("WARNING")), true);
  // No comments posted — warning only
  assertEquals(deps.postedComments.length, 0);
});

Deno.test("stale workflow - processStalePlanning skips fresh issues", async () => {
  const oneDayAgo = new Date(FIXED_NOW_MS - 1 * 24 * 60 * 60 * 1000)
    .toISOString();
  const issue = makeIssue({ number: 61, updatedAt: oneDayAgo });

  const deps = createTestDeps({
    listIssuesByLabel: () => Promise.resolve([issue]),
  });

  const config = defaultConfig();
  const results = await processStalePlanning("org/repo", config, deps);

  assertEquals(results.length, 0);
});

// ============================================================================
// scanForStaleWorkflowIssues (integration)
// ============================================================================

Deno.test("stale workflow - scanForStaleWorkflowIssues scans all repos", async () => {
  const fiveDaysAgo = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000)
    .toISOString();
  const issue = makeIssue({ number: 70, updatedAt: fiveDaysAgo });

  const deps = createTestDeps({
    listIssuesByLabel: (_repo, label) => {
      if (label === "failed") return Promise.resolve([issue]);
      return Promise.resolve([]);
    },
    getIssueComments: () => Promise.resolve([]),
  });

  const config = defaultConfig({ repos: ["org/repo1", "org/repo2"] });
  const result = await scanForStaleWorkflowIssues(config, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.scanned, 2);
    assertEquals(result.value.actioned, 2); // One diagnostic per repo
  }
});

Deno.test("stale workflow - scanForStaleWorkflowIssues returns empty for no stale issues", async () => {
  const deps = createTestDeps({
    listIssuesByLabel: () => Promise.resolve([]),
  });

  const config = defaultConfig();
  const result = await scanForStaleWorkflowIssues(config, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.scanned, 1);
    assertEquals(result.value.actioned, 0);
  }
});

Deno.test("stale workflow - scanForStaleWorkflowIssues handles API errors gracefully", async () => {
  const deps = createTestDeps({
    listIssuesByLabel: () => Promise.reject(new Error("API error")),
  });

  const config = defaultConfig();
  const result = await scanForStaleWorkflowIssues(config, deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.actioned, 0);
  }
});

// ============================================================================
// Custom thresholds
// ============================================================================

Deno.test("stale workflow - respects custom failedDiagnosticDays threshold", async () => {
  // With threshold of 1 day, a 2-day-old failed issue should get a diagnostic
  const twoDaysAgo = new Date(FIXED_NOW_MS - 2 * 24 * 60 * 60 * 1000)
    .toISOString();
  const issue = makeIssue({ number: 80, updatedAt: twoDaysAgo });

  const deps = createTestDeps({
    listIssuesByLabel: (_repo, label) => {
      if (label === "failed") return Promise.resolve([issue]);
      return Promise.resolve([]);
    },
    getIssueComments: () => Promise.resolve([]),
  });

  const config = defaultConfig({
    thresholds: {
      failedDiagnosticDays: 1,
      planningWarningDays: 1,
    },
  });

  const results = await processStaleFailed("org/repo", config, deps);

  assertEquals(results.length, 1);
  assertEquals(results[0]!.action, "diagnostic");
});

// ============================================================================
// Batched comment fetch (Issue #1842)
// ============================================================================

Deno.test("stale workflow - processStaleFailed uses batched comments per label scan", async () => {
  // Two candidates per label → expect the batch helper called once
  // per label scan (twice in total) with the surviving candidates.
  const fiveDaysAgo = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000)
    .toISOString();
  const failedIssues = [
    makeIssue({ number: 601, updatedAt: fiveDaysAgo }),
    makeIssue({ number: 602, updatedAt: fiveDaysAgo }),
  ];
  const failedOnceIssues = [
    makeIssue({ number: 701, updatedAt: fiveDaysAgo }),
  ];
  const batchCalls: number[][] = [];
  const deps = createTestDeps({
    listIssuesByLabel: (_repo, label) => {
      if (label === "failed") return Promise.resolve(failedIssues);
      if (label === "failed-once") return Promise.resolve(failedOnceIssues);
      return Promise.resolve([]);
    },
    getIssueComments: () => Promise.resolve([]),
    getIssueCommentsBatch: (_repo, numbers) => {
      batchCalls.push([...numbers]);
      return Promise.resolve(
        new Map(numbers.map((n) => [n, [] as GitHubComment[]])),
      );
    },
  });

  const config = defaultConfig();
  const results = await processStaleFailed("org/repo", config, deps);

  assertEquals(results.length, 3);
  assertEquals(batchCalls, [[601, 602], [701]]);
});

Deno.test("stale workflow - processStaleFailed batch is not invoked when no candidates", async () => {
  const oneDayAgo = new Date(FIXED_NOW_MS - 1 * 24 * 60 * 60 * 1000)
    .toISOString();
  const issues = [makeIssue({ number: 801, updatedAt: oneDayAgo })];
  let batchCalls = 0;
  const deps = createTestDeps({
    listIssuesByLabel: () => Promise.resolve(issues),
    getIssueCommentsBatch: () => {
      batchCalls++;
      return Promise.resolve(new Map());
    },
  });

  const config = defaultConfig();
  const results = await processStaleFailed("org/repo", config, deps);

  assertEquals(results.length, 0);
  assertEquals(batchCalls, 0);
});

// ============================================================================
// STALE_WORKFLOW_DEFAULTS
// ============================================================================

Deno.test("stale workflow - defaults have sensible values (Issue #2031)", () => {
  // Issue #2031: needs-clarification reminder/close thresholds retired.
  assertEquals(STALE_WORKFLOW_DEFAULTS.failedDiagnosticDays, 3);
  assertEquals(STALE_WORKFLOW_DEFAULTS.planningWarningDays, 2);
});
