/**
 * Tests for milestone completion detection and tracking issue creation.
 *
 * Issue #1106: Milestone completion issue creation regression.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  buildMilestoneSummaryBody,
  checkAndHandleMilestoneCompletions,
  checkMilestoneComplete,
  classifyClosedIssues,
  classifyMilestoneFinalPrs,
  closeGitHubMilestone,
  getOpenMilestoneTrackers,
  hasExistingMilestoneSummaryPr,
  hasExistingMilestoneTrackingIssue,
  hasNothingToMerge,
  isMilestoneTrackingTitle,
  isMilestoneYoung,
  isSummaryPrMerged,
  type MilestoneCompletionDeps,
  selectDuplicateTrackersToClose,
} from "../lib/milestone_completion.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { MILESTONE_TRACKING_MARKER } from "../lib/milestone_tracker_identity.ts";
import { _resetBaseProtectionMemo } from "../lib/pr_auto_merge.ts";
import { partialRollupMarker } from "../lib/milestone_partial_rollup.ts";
import { rollbackCloseComment as rollbackCloseCommentForTest } from "../lib/milestone_rollback_requeue.ts";

/**
 * Issue #1246: a tracking-shaped title is only a candidate — the fleet's own
 * tracker is proved by the body marker plus the author, so these fixtures
 * state the fleet ("bot", the login every tracker fixture here uses) rather
 * than writing a config file.
 */
const VERIFICATION = { authorOptions: { fleetAuthors: ["bot"] } };

// ============================================================================
// checkMilestoneComplete
// ============================================================================

Deno.test("checkMilestoneComplete - returns true when no open issues remain", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return "[]";
    }
    return "[]";
  };

  const result = await checkMilestoneComplete(
    "owner/repo",
    "v1.0",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, true);
  }
});

Deno.test("checkMilestoneComplete - returns false when open issues exist", async () => {
  // Issue #1786: checkMilestoneComplete now reads through `fetchAllIssues`
  // for the open-state list, so the stub returns the richer shape with
  // milestone embedded — matching the issues_all cache projection.
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return JSON.stringify([
        {
          number: 42,
          title: "Open issue",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "v1.0" },
          author: { login: "alice" },
          url: "u",
        },
      ]);
    }
    return "[]";
  };

  const result = await checkMilestoneComplete(
    "owner/repo",
    "v1.0",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("checkMilestoneComplete - returns error on gh failure", async () => {
  const ghFn = async (_args: string[]): Promise<string> => {
    throw new Error("API error");
  };

  const result = await checkMilestoneComplete(
    "owner/repo",
    "v1.0",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, false);
});

// ============================================================================
// hasExistingMilestoneSummaryPr
// ============================================================================

Deno.test("hasExistingMilestoneSummaryPr - returns PR number when found", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        {
          number: 100,
          title: "Milestone: v1.0",
          headRefName: "milestone/v1-0",
        },
      ]);
    }
    return "[]";
  };

  const result = await hasExistingMilestoneSummaryPr(
    "owner/repo",
    "v1.0",
    "milestone/v1-0",
    ghFn,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 100);
  }
});

Deno.test("hasExistingMilestoneSummaryPr - returns null when no PR exists", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([]);
    }
    return "[]";
  };

  const result = await hasExistingMilestoneSummaryPr(
    "owner/repo",
    "v1.0",
    "milestone/v1-0",
    ghFn,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

Deno.test("hasExistingMilestoneSummaryPr - filters by headRefName", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        {
          number: 100,
          title: "Milestone: v2.0",
          headRefName: "milestone/v2-0",
        },
      ]);
    }
    return "[]";
  };

  const result = await hasExistingMilestoneSummaryPr(
    "owner/repo",
    "v1.0",
    "milestone/v1-0",
    ghFn,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

// ============================================================================
// hasExistingMilestoneTrackingIssue
// ============================================================================

Deno.test("hasExistingMilestoneTrackingIssue - returns issue number when found", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--milestone 1")) {
      return JSON.stringify([
        {
          number: 200,
          title: "Merge milestone 'v1.0' to main",
          body: MILESTONE_TRACKING_MARKER,
          author: { login: "bot" },
        },
      ]);
    }
    return "[]";
  };

  const result = await hasExistingMilestoneTrackingIssue(
    "owner/repo",
    "v1.0",
    1,
    "main",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 200);
  }
});

Deno.test("hasExistingMilestoneTrackingIssue - returns null when not found", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list")) {
      return JSON.stringify([]);
    }
    return "[]";
  };

  const result = await hasExistingMilestoneTrackingIssue(
    "owner/repo",
    "v1.0",
    1,
    "main",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

// Issue #2753: regression — an existing tracker must be reused even when the
// default branch resolves differently between runs. The field accumulated
// duplicate "... to Develop" trackers because the old exact-title match
// (which appended the *current* run's default branch) missed them. This test
// fails against the unfixed exact-match code (returns null → caller files a
// duplicate) and passes after the shape-based match.
Deno.test("hasExistingMilestoneTrackingIssue - reuses tracker despite default-branch drift", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--milestone 3")) {
      // Existing tracker was filed when the default branch was "Develop".
      return JSON.stringify([
        {
          number: 250,
          title: "Merge milestone 'Milestone 3' to Develop",
          body: MILESTONE_TRACKING_MARKER,
          author: { login: "bot" },
        },
      ]);
    }
    return "[]";
  };

  // Current run resolves the default branch as "main" — the old exact match
  // would build "... to main" and miss the existing "... to Develop" tracker.
  const result = await hasExistingMilestoneTrackingIssue(
    "owner/repo",
    "Milestone 3",
    3,
    "main",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 250);
  }
});

Deno.test("hasExistingMilestoneTrackingIssue - reuses tracker after milestone rename", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--milestone 4")) {
      // Tracker filed under the old milestone title; milestone since renamed.
      return JSON.stringify([
        {
          number: 260,
          title: "Merge milestone 'Milestone 4 (old)' to main",
          body: MILESTONE_TRACKING_MARKER,
          author: { login: "bot" },
        },
      ]);
    }
    return "[]";
  };

  const result = await hasExistingMilestoneTrackingIssue(
    "owner/repo",
    "Milestone 4 (new name)",
    4,
    "main",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 260);
  }
});

Deno.test("hasExistingMilestoneTrackingIssue - returns canonical lowest-numbered duplicate", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--milestone 5")) {
      return JSON.stringify([
        {
          number: 410,
          title: "Merge milestone 'M5' to Develop",
          body: MILESTONE_TRACKING_MARKER,
          author: { login: "bot" },
        },
        {
          number: 401,
          title: "Merge milestone 'M5' to Develop",
          body: MILESTONE_TRACKING_MARKER,
          author: { login: "bot" },
        },
        { number: 420, title: "Some unrelated milestone issue" },
      ]);
    }
    return "[]";
  };

  const result = await hasExistingMilestoneTrackingIssue(
    "owner/repo",
    "M5",
    5,
    "Develop",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 401);
  }
});

// ============================================================================
// isMilestoneTrackingTitle (Issue #2753)
// ============================================================================

Deno.test("isMilestoneTrackingTitle - matches the tracking-issue shape", () => {
  assertEquals(
    isMilestoneTrackingTitle("Merge milestone 'v1.0' to main"),
    true,
  );
  assertEquals(
    isMilestoneTrackingTitle(
      "Merge milestone 'Milestone 3 — phase 2' to Develop",
    ),
    true,
  );
  // Whitespace drift is tolerated.
  assertEquals(
    isMilestoneTrackingTitle("  Merge milestone 'X' to main  "),
    true,
  );
});

Deno.test("isMilestoneTrackingTitle - rejects non-tracking titles", () => {
  assertEquals(isMilestoneTrackingTitle("Add login page"), false);
  assertEquals(isMilestoneTrackingTitle("Merge milestone to main"), false);
  assertEquals(isMilestoneTrackingTitle("Merge milestone '' to main"), false);
  assertEquals(isMilestoneTrackingTitle("Merge milestone 'v1.0' to "), false);
});

// ============================================================================
// selectDuplicateTrackersToClose (Issue #2753)
// ============================================================================

Deno.test("selectDuplicateTrackersToClose - selects N-1 duplicates, keeps canonical", () => {
  const selection = selectDuplicateTrackersToClose([410, 401, 433]);
  assertEquals(selection.keep, 401);
  assertEquals(selection.close, [410, 433]);
});

Deno.test("selectDuplicateTrackersToClose - no-op for a single tracker", () => {
  const selection = selectDuplicateTrackersToClose([401]);
  assertEquals(selection.keep, 401);
  assertEquals(selection.close, []);
});

Deno.test("selectDuplicateTrackersToClose - no-op for no trackers", () => {
  const selection = selectDuplicateTrackersToClose([]);
  assertEquals(selection.keep, null);
  assertEquals(selection.close, []);
});

Deno.test("selectDuplicateTrackersToClose - de-duplicates repeated numbers", () => {
  const selection = selectDuplicateTrackersToClose([410, 401, 401, 410]);
  assertEquals(selection.keep, 401);
  assertEquals(selection.close, [410]);
});

// ============================================================================
// buildMilestoneSummaryBody
// ============================================================================

Deno.test("buildMilestoneSummaryBody - includes milestone title and issues", () => {
  const closedIssues = [
    { number: 10, title: "Add login" },
    { number: 11, title: "Add signup" },
  ];

  const body = buildMilestoneSummaryBody("v1.0", "main", closedIssues);
  assertStringIncludes(body, "v1.0");
  assertStringIncludes(body, "#10");
  assertStringIncludes(body, "#11");
  assertStringIncludes(body, "Add login");
  assertStringIncludes(body, "main");
});

Deno.test("buildMilestoneSummaryBody - includes tracking issue Closes reference", () => {
  const body = buildMilestoneSummaryBody("v1.0", "main", [], 42);
  assertStringIncludes(body, "Closes #42");
});

Deno.test("buildMilestoneSummaryBody - omits Closes when no tracking issue", () => {
  const body = buildMilestoneSummaryBody("v1.0", "main", []);
  assertEquals(body.includes("Closes"), false);
});

// Issue #3014 / #3223: extraSections is appended, byte-identical output otherwise.
Deno.test("buildMilestoneSummaryBody - unchanged when extraSections omitted", () => {
  const closedIssues = [{ number: 10, title: "Add login" }];
  const withoutParam = buildMilestoneSummaryBody("v1.0", "main", closedIssues);
  const withUndefined = buildMilestoneSummaryBody(
    "v1.0",
    "main",
    closedIssues,
    undefined,
    undefined,
  );
  assertEquals(withoutParam, withUndefined);
});

Deno.test("buildMilestoneSummaryBody - places extraSections before Review notes", () => {
  const closedIssues = [{ number: 10, title: "Add login" }];
  const note =
    "### ⏸️ Held: pending dependencies\n\n- #1 depends on #2 (still open)";
  const body = buildMilestoneSummaryBody(
    "v1.0",
    "main",
    closedIssues,
    undefined,
    note,
  );
  const issuesIdx = body.indexOf("### Issues addressed");
  const noteIdx = body.indexOf("Held: pending dependencies");
  const reviewIdx = body.indexOf("### Review notes");
  assertEquals(issuesIdx >= 0 && noteIdx > issuesIdx, true);
  assertEquals(noteIdx >= 0 && reviewIdx > noteIdx, true);
});

Deno.test("buildMilestoneSummaryBody - flags rather than claims issues with a claimProblem (Issue #3476)", () => {
  const body = buildMilestoneSummaryBody("v1.0", "main", [
    { number: 1, title: "Claimed" },
    { number: 2, title: "Sync only", claimProblem: "sync-pr-only" },
    { number: 3, title: "Reopened", claimProblem: "predates-reopen" },
  ]);

  // The claimed issue is listed under Issues addressed.
  assertEquals(body.includes("### Issues addressed\n- #1: Claimed"), true);
  // The flagged issues are listed with a reason, not claimed.
  assertEquals(
    body.includes(
      "- #2: Sync only (no fleet-titled merged PR — possibly a milestone sync PR)",
    ),
    true,
  );
  assertEquals(
    body.includes("- #3: Reopened (merged PR predates a later reopen)"),
    true,
  );
  assertEquals(body.includes("### Flagged — not claimed"), true);
});

Deno.test("classifyClosedIssues - flags sync-pr-only and predates-reopen, claims otherwise (Issue #3476)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    // Timeline read: issues 3 and 4 have a reopen; 1 and 2 have none.
    if (
      args[0] === "api" && typeof args[1] === "string" &&
      args[1].includes("/timeline")
    ) {
      const m = args[1].match(/issues\/(\d+)\/timeline/);
      const num = m ? Number(m[1]) : 0;
      if (num === 3 || num === 4) {
        return JSON.stringify([{
          event: "reopened",
          actor: { login: "nleck" },
          created_at: "2026-10-05T18:00:00Z",
        }]);
      }
      return "[]";
    }
    // Merged-PR title search: issues 2, 3 and 4 have one; 1 has none.
    if (args[0] === "pr" && args[1] === "list") {
      const searchIdx = args.indexOf("--search");
      const search = searchIdx >= 0 ? args[searchIdx + 1] ?? "" : "";
      const m = search.match(/\(#(\d+)\)/);
      const num = m ? Number(m[1]) : 0;
      if (num === 1) return "[]";
      const mergedAt = num === 4
        ? "2026-10-06T00:00:00Z"
        : "2026-10-05T00:00:00Z";
      return JSON.stringify([{
        number: 5,
        title: `Fix (#${num})`,
        baseRefName: "main",
        headRefName: "h",
        mergedAt,
      }]);
    }
    return "[]";
  };

  const result = await classifyClosedIssues(
    "org/repo",
    [
      { number: 1, title: "Sync only" },
      { number: 2, title: "Clean merge" },
      { number: 3, title: "Reopened after merge" },
      { number: 4, title: "Re-merged after reopen" },
    ],
    ghFn,
  );

  assertEquals(result[0]?.claimProblem, "sync-pr-only");
  assertEquals(result[1]?.claimProblem, undefined);
  assertEquals(result[2]?.claimProblem, "predates-reopen");
  assertEquals(result[3]?.claimProblem, undefined);
});

Deno.test("classifyClosedIssues - flags an issue whose timeline cannot be read rather than claiming it (PR #3640 review)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (
      args[0] === "api" && typeof args[1] === "string" &&
      args[1].includes("/timeline")
    ) {
      throw new Error("HTTP 502: Bad Gateway");
    }
    if (args[0] === "pr" && args[1] === "list") {
      // A clean, fleet-titled merge: claimable were the timeline readable.
      return JSON.stringify([{
        number: 5,
        title: "Fix (#1)",
        baseRefName: "main",
        headRefName: "h",
        mergedAt: "2026-10-05T00:00:00Z",
      }]);
    }
    return "[]";
  };

  const result = await classifyClosedIssues(
    "org/repo",
    [{ number: 1, title: "Unreadable timeline" }],
    ghFn,
  );
  assertEquals(result[0]?.claimProblem, "timeline-unreadable");

  const body = buildMilestoneSummaryBody("v1", "main", result);
  assertStringIncludes(body, "### Flagged — not claimed");
  assertStringIncludes(
    body,
    "- #1: Unreadable timeline (issue timeline could not be read",
  );
  assertEquals(body.includes("### Issues addressed\n- #1"), false);
});

// ============================================================================
// checkAndHandleMilestoneCompletions (main orchestration)
// ============================================================================

/**
 * Serve the two fresh authoritative open-children reads added in Issue #3908:
 * `GET repos/<repo>/milestones/<n>` and
 * `GET repos/<repo>/issues?milestone=<n>&state=open`.
 *
 * Returns null when `key` is neither, so a stub can fall through to its own
 * branches. Defaults describe a milestone GitHub agrees is complete. The
 * milestone-close PATCH (`api -X PATCH .../milestones/<n> -f state=closed`)
 * does not match — only the bare GET does.
 */
function authoritativeStub(
  key: string,
  openIssues = 0,
  children: unknown[] = [],
): string | null {
  if (key.includes("/issues?milestone=")) return JSON.stringify(children);
  if (/api repos\/[^ ]+\/milestones\/\d+$/.test(key)) {
    return JSON.stringify({ open_issues: openIssues });
  }
  return null;
}

function createMockDeps(
  overrides: Partial<MilestoneCompletionDeps> = {},
): MilestoneCompletionDeps {
  return {
    repos: ["owner/repo"],
    ghCommandFn: async (_args: string[]) => "[]",
    log: (_msg: string) => {},
    authorOptions: { fleetAuthors: ["bot"] },
    ...overrides,
  };
}

Deno.test("checkAndHandleMilestoneCompletions - creates tracking issue and summary PR for complete milestone", async () => {
  const createdIssues: { title: string; body: string }[] = [];
  const createdPrs: { title: string; head: string; base: string }[] = [];
  const closedIssueNumbers: number[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    // List milestones for repo
    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([
        { title: "v1.0", number: 1 },
      ]);
    }

    // Get default branch
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }

    // List open issues for milestone — none (milestone complete)
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }

    // Issue #1908: closed issues are fetched as a single batch
    // (`--state closed` without `--milestone`); milestone metadata is
    // included on each issue so callers can filter locally.
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Add login", milestone: { title: "v1.0" } },
      ]);
    }

    // Search for existing tracking issue — none
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }

    // List PRs (all states) — none
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }

    // Check if milestone branch exists
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }

    // Create tracking issue
    if (key.includes("issue create")) {
      const titleIdx = args.indexOf("--title");
      const bodyIdx = args.indexOf("--body");
      if (titleIdx >= 0 && bodyIdx >= 0) {
        createdIssues.push({
          title: args[titleIdx + 1]!,
          body: args[bodyIdx + 1]!,
        });
      }
      return "https://github.com/owner/repo/issues/300";
    }

    // Create PR
    if (key.includes("pr create")) {
      const titleIdx = args.indexOf("--title");
      const headIdx = args.indexOf("--head");
      const baseIdx = args.indexOf("--base");
      if (titleIdx >= 0 && headIdx >= 0 && baseIdx >= 0) {
        createdPrs.push({
          title: args[titleIdx + 1]!,
          head: args[headIdx + 1]!,
          base: args[baseIdx + 1]!,
        });
      }
      return "https://github.com/owner/repo/pull/301";
    }

    // Close tracking issue (Issue #1133)
    if (key.includes("issue close")) {
      const issueNumStr = args.find((a) => /^\d+$/.test(a));
      if (issueNumStr) closedIssueNumbers.push(Number(issueNumStr));
      return "";
    }

    return "[]";
  };

  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 1);
  }

  // Tracking issue should have been created
  assertEquals(createdIssues.length, 1);
  assertStringIncludes(createdIssues[0]!.title, "Merge milestone");
  assertStringIncludes(createdIssues[0]!.title, "v1.0");

  // Issue #1134: Tracking issue body must contain the milestone tracking marker
  assertStringIncludes(
    createdIssues[0]!.body,
    "<!-- milestone-tracking-issue",
  );

  // Summary PR should have been created
  assertEquals(createdPrs.length, 1);
  assertStringIncludes(createdPrs[0]!.title, "Milestone: v1.0");
  assertEquals(createdPrs[0]!.head, "milestone/v1-0");
  assertEquals(createdPrs[0]!.base, "main");

  // Issue #1133: Tracking issue should have been closed immediately
  assertEquals(closedIssueNumbers.length, 1);
  assertEquals(closedIssueNumbers[0], 300);
});

// Issue #3014: the summary PR body states declared dependencies that have
// not merged yet, so the hold the merge gate enforces is explained.
Deno.test("checkAndHandleMilestoneCompletions - summary PR body holds on a pending declared dependency", async () => {
  const createdPrs: {
    title: string;
    head: string;
    base: string;
    body: string;
  }[] = [];
  const logs: string[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");

    // Issue #3014: the milestone's member issues (`--paginate`, `state=all`)
    // — matched before the generic authoritativeStub below, which also
    // matches on "/issues?milestone=".
    if (
      key.includes("--paginate") &&
      key.includes("issues?milestone=1&state=all")
    ) {
      return JSON.stringify([{ number: 10, body: "Depends on #20" }]);
    }
    // The declared dependency issue — still open.
    if (key.includes("api repos/owner/repo/issues/20")) {
      return JSON.stringify({ state: "open" });
    }

    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Add login", milestone: { title: "v1.0" } },
      ]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      return "https://github.com/owner/repo/issues/300";
    }
    if (key.includes("pr create")) {
      const titleIdx = args.indexOf("--title");
      const headIdx = args.indexOf("--head");
      const baseIdx = args.indexOf("--base");
      const bodyIdx = args.indexOf("--body");
      if (titleIdx >= 0 && headIdx >= 0 && baseIdx >= 0 && bodyIdx >= 0) {
        createdPrs.push({
          title: args[titleIdx + 1]!,
          head: args[headIdx + 1]!,
          base: args[baseIdx + 1]!,
          body: args[bodyIdx + 1]!,
        });
      }
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) return "";
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(createdPrs.length, 1);
  assertStringIncludes(createdPrs[0]!.body, "Held: pending dependencies");
  assertStringIncludes(createdPrs[0]!.body, "#10 depends on #20");
  assertEquals(
    logs.some((msg) =>
      msg.includes("WARNING") && msg.includes("declared dependencies") &&
      msg.includes("Issue #3014")
    ),
    true,
  );
});

// Issue #3014: a lookup failure must never block PR creation — it only
// swaps in a note, since the merge gate re-checks before merging.
Deno.test("checkAndHandleMilestoneCompletions - summary PR body notes unverifiable dependencies when the lookup fails", async () => {
  const createdPrs: { body: string }[] = [];
  const logs: string[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");

    if (
      key.includes("--paginate") &&
      key.includes("issues?milestone=1&state=all")
    ) {
      throw new Error("gh api rate limited");
    }

    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Add login", milestone: { title: "v1.0" } },
      ]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      return "https://github.com/owner/repo/issues/300";
    }
    if (key.includes("pr create")) {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) createdPrs.push({ body: args[bodyIdx + 1]! });
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) return "";
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(createdPrs.length, 1);
  assertStringIncludes(
    createdPrs[0]!.body,
    "Declared dependencies not verified",
  );
  assertEquals(
    logs.some((msg) =>
      msg.includes("WARNING") &&
      msg.includes("could not verify declared dependencies") &&
      msg.includes("Issue #3014")
    ),
    true,
  );
});

// Issue #3223: the summary PR body also lists added Markdown lines that
// name an issue closed as not planned.
Deno.test("checkAndHandleMilestoneCompletions - summary PR body cites a doc line naming a not-planned issue", async () => {
  const createdPrs: { body: string }[] = [];
  const logs: string[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");

    if (
      key.includes("--paginate") &&
      key.includes("issues?milestone=1&state=all")
    ) {
      return JSON.stringify([
        {
          number: 10,
          title: "Dropped feature",
          state: "closed",
          state_reason: "not_planned",
          body: "",
        },
      ]);
    }

    // hasNothingToMerge's ahead_by probe — distinct from the not-planned
    // module's plain compare call below (no --jq).
    if (key.includes("/compare/") && key.includes("--jq")) {
      return "5";
    }
    if (key.includes("/compare/")) {
      return JSON.stringify({
        files: [
          {
            filename: "docs/runbook.md",
            status: "modified",
            patch: "@@ -1,0 +1,1 @@\n+see #10 for the runbook",
          },
        ],
      });
    }

    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Dropped feature", milestone: { title: "v1.0" } },
      ]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      return "https://github.com/owner/repo/issues/300";
    }
    if (key.includes("pr create")) {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) createdPrs.push({ body: args[bodyIdx + 1]! });
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) return "";
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(createdPrs.length, 1);
  assertStringIncludes(
    createdPrs[0]!.body,
    "Docs cite issues closed as not planned",
  );
  assertStringIncludes(createdPrs[0]!.body, "#10");
  assertEquals(
    logs.some((msg) => msg.includes("WARNING") && msg.includes("Issue #3223")),
    true,
  );
});

// Issue #3223: a failed compare call never blocks PR creation — it only
// swaps in the "not checked" note.
Deno.test("checkAndHandleMilestoneCompletions - summary PR body notes the not-planned scan could not run when compare fails", async () => {
  const createdPrs: { body: string }[] = [];
  const logs: string[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");

    if (
      key.includes("--paginate") &&
      key.includes("issues?milestone=1&state=all")
    ) {
      return JSON.stringify([
        {
          number: 10,
          title: "Dropped feature",
          state: "closed",
          state_reason: "not_planned",
          body: "",
        },
      ]);
    }

    if (key.includes("/compare/") && key.includes("--jq")) {
      return "5";
    }
    if (key.includes("/compare/")) {
      throw new Error("compare API unavailable");
    }

    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Dropped feature", milestone: { title: "v1.0" } },
      ]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      return "https://github.com/owner/repo/issues/300";
    }
    if (key.includes("pr create")) {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) createdPrs.push({ body: args[bodyIdx + 1]! });
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) return "";
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(createdPrs.length, 1);
  assertStringIncludes(
    createdPrs[0]!.body,
    "Docs not checked for issues closed as not planned",
  );
  assertEquals(
    logs.some((msg) =>
      msg.includes("WARNING") &&
      msg.includes("could not check milestone") &&
      msg.includes("Issue #3223")
    ),
    true,
  );
});

// Issue #3223: a candidate exists but the only Markdown file in the compare
// diff lacks `patch` — the PR body must still carry the "not checked" note
// (not silently say nothing was found).
Deno.test("checkAndHandleMilestoneCompletions - summary PR body notes an unchecked Markdown file with no patch", async () => {
  const createdPrs: { body: string }[] = [];
  const logs: string[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");

    if (
      key.includes("--paginate") &&
      key.includes("issues?milestone=1&state=all")
    ) {
      return JSON.stringify([
        {
          number: 10,
          title: "Dropped feature",
          state: "closed",
          state_reason: "not_planned",
          body: "",
        },
      ]);
    }

    if (key.includes("/compare/") && key.includes("--jq")) {
      return "5";
    }
    if (key.includes("/compare/")) {
      return JSON.stringify({
        files: [
          { filename: "docs/big.md", status: "modified" },
        ],
      });
    }

    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Dropped feature", milestone: { title: "v1.0" } },
      ]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      return "https://github.com/owner/repo/issues/300";
    }
    if (key.includes("pr create")) {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) createdPrs.push({ body: args[bodyIdx + 1]! });
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) return "";
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(createdPrs.length, 1);
  assertStringIncludes(
    createdPrs[0]!.body,
    "Docs not checked for issues closed as not planned",
  );
  assertStringIncludes(createdPrs[0]!.body, "docs/big.md");
});

// Issue #3223: a clean scan — every issue closed completed, no declared
// dependency pending — must leave the not-planned section out entirely, and
// must never call the compare API (there are no not-planned candidates to
// look for in the diff).
Deno.test("checkAndHandleMilestoneCompletions - summary PR body omits not-planned section on a clean scan", async () => {
  const createdPrs: { body: string }[] = [];
  const logs: string[] = [];
  let compareCalls = 0;

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");

    if (
      key.includes("--paginate") &&
      key.includes("issues?milestone=1&state=all")
    ) {
      return JSON.stringify([
        {
          number: 10,
          title: "Add login",
          state: "closed",
          state_reason: "completed",
          body: "",
        },
      ]);
    }

    // hasNothingToMerge's ahead_by probe (`--jq`) always runs, independently
    // of the not-planned scan — only the plain compare call below (used by
    // `findNotPlannedDocReferences` to fetch the diff) must stay unused,
    // since there are no not-planned candidates for it to look for.
    if (key.includes("/compare/") && key.includes("--jq")) {
      return "5";
    }
    if (key.includes("/compare/")) {
      compareCalls++;
      return JSON.stringify({ files: [] });
    }

    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Add login", milestone: { title: "v1.0" } },
      ]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      return "https://github.com/owner/repo/issues/300";
    }
    if (key.includes("pr create")) {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) createdPrs.push({ body: args[bodyIdx + 1]! });
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) return "";
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(createdPrs.length, 1);
  assertEquals(
    createdPrs[0]!.body.includes("closed as not planned"),
    false,
  );
  assertEquals(compareCalls, 0);
});

// Issue #3014 / #3223: a pending declared dependency and a not-planned doc
// reference can both apply to the same summary PR. The hold section must
// come first, separated from the not-planned section by exactly one blank
// line.
Deno.test("checkAndHandleMilestoneCompletions - summary PR body holds and cites a not-planned issue together", async () => {
  const createdPrs: { body: string }[] = [];
  const logs: string[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");

    if (
      key.includes("--paginate") &&
      key.includes("issues?milestone=1&state=all")
    ) {
      return JSON.stringify([
        { number: 10, title: "Add login", body: "Depends on #20" },
        {
          number: 11,
          title: "Dropped feature",
          state: "closed",
          state_reason: "not_planned",
          body: "",
        },
      ]);
    }
    // The declared dependency issue — still open.
    if (key.includes("api repos/owner/repo/issues/20")) {
      return JSON.stringify({ state: "open" });
    }

    if (key.includes("/compare/") && key.includes("--jq")) {
      return "5";
    }
    if (key.includes("/compare/")) {
      return JSON.stringify({
        files: [
          {
            filename: "docs/runbook.md",
            status: "modified",
            patch: "@@ -1,0 +1,1 @@\n+see #11 for the runbook",
          },
        ],
      });
    }

    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Add login", milestone: { title: "v1.0" } },
        {
          number: 11,
          title: "Dropped feature",
          milestone: { title: "v1.0" },
        },
      ]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      return "https://github.com/owner/repo/issues/300";
    }
    if (key.includes("pr create")) {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) createdPrs.push({ body: args[bodyIdx + 1]! });
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) return "";
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(createdPrs.length, 1);
  const body = createdPrs[0]!.body;
  assertStringIncludes(body, "Held: pending dependencies");
  assertStringIncludes(body, "### ⚠️ Docs cite issues closed as not planned");
  const holdIdx = body.indexOf("Held: pending dependencies");
  const notPlannedIdx = body.indexOf(
    "### ⚠️ Docs cite issues closed as not planned",
  );
  assertEquals(holdIdx >= 0 && notPlannedIdx > holdIdx, true);
  assertStringIncludes(
    body,
    "#10 depends on #20 (still open)\n\n### ⚠️ Docs cite issues closed as not planned",
  );
});

Deno.test("checkAndHandleMilestoneCompletions - reuses existing tracker with drifted default branch (no duplicate)", async () => {
  // Issue #2753: regression for the field bypass. A tracker filed when the
  // default branch was "Develop" must be reused this run (default branch
  // "main") rather than re-filed. Fails against the unfixed exact-title match.
  const createdIssues: string[] = [];
  const closedIssueNumbers: number[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "Milestone 3", number: 3 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    // Milestone complete — no open issues.
    if (key.includes("issue list") && key.includes("--state open")) {
      return "[]";
    }
    // Closed issues exist (milestone was worked on).
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 50, title: "Done work", milestone: { title: "Milestone 3" } },
      ]);
    }
    // All-state milestone lookup returns the existing "to Develop" tracker.
    if (key.includes("issue list") && key.includes("--state all")) {
      return JSON.stringify([
        {
          number: 250,
          title: "Merge milestone 'Milestone 3' to Develop",
          body: MILESTONE_TRACKING_MARKER,
          author: { login: "bot" },
        },
      ]);
    }
    if (key.includes("pr list")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/")) {
      return JSON.stringify({ name: "milestone/milestone-3" });
    }
    if (key.includes("issue create")) {
      const titleIdx = args.indexOf("--title");
      createdIssues.push(titleIdx >= 0 ? args[titleIdx + 1]! : "");
      return "https://github.com/owner/repo/issues/999";
    }
    if (key.includes("pr create")) {
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) {
      const num = args.find((a) => /^\d+$/.test(a));
      if (num) closedIssueNumbers.push(Number(num));
      return "";
    }
    return "[]";
  };

  const deps = createMockDeps({ ghCommandFn: ghFn });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  // No duplicate tracker filed — the existing #250 was reused.
  assertEquals(createdIssues.length, 0);
  // The reused tracker is the one closed after the summary PR is created.
  assertEquals(closedIssueNumbers.includes(250), true);
});

Deno.test("checkAndHandleMilestoneCompletions - skips incomplete milestones", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    // Open issues remain — milestone not complete
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return JSON.stringify([{ number: 99 }]);
    }
    return "[]";
  };

  const deps = createMockDeps({ ghCommandFn: ghFn });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 0);
  }
});

Deno.test("checkAndHandleMilestoneCompletions - skips when summary PR already exists", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    // Summary PR already exists
    if (key.includes("pr list") && key.includes("--state all")) {
      return JSON.stringify([
        { number: 50, title: "Milestone: v1.0", headRefName: "milestone/v1-0" },
      ]);
    }
    return "[]";
  };

  const deps = createMockDeps({ ghCommandFn: ghFn });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 0);
  }
});

Deno.test("checkAndHandleMilestoneCompletions - skips when milestone branch does not exist", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    // Search tracking issues — none
    if (key.includes("issue list") && key.includes("--state all")) {
      return "[]";
    }
    // Branch does not exist
    if (key.includes("api") && key.includes("/branches/milestone")) {
      throw new Error("Not found");
    }
    return "[]";
  };

  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 0);
  }
});

Deno.test("checkAndHandleMilestoneCompletions - returns ok with zero when no repos", async () => {
  const deps = createMockDeps({ repos: [] });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 0);
  }
});

// ============================================================================
// Issue #2060 — security-scan idle-task milestone gate
// ============================================================================

// Issue #2125 retired idle-task milestones entirely — the security-scan
// merge-gate tests from Issue #2060 (`skips merge PR ... no source-code
// changes`, `still raises merge PR ... real source change`) no longer
// have reachable preconditions and were removed alongside the gate.
// The new behaviour is covered by the auto-close / skip-with-open-issues
// tests further down (Issue #2125 section).

// ============================================================================
// Issue #1509 — defaultBranchFn injection
// ============================================================================

Deno.test("checkAndHandleMilestoneCompletions - uses injected defaultBranchFn instead of gh api", async () => {
  const ghCalls: string[] = [];
  let defaultBranchCalls = 0;

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    ghCalls.push(key);

    // If the injected defaultBranchFn is honoured, we should never see
    // the repos/<repo> --jq .default_branch call go through ghCommandFn.
    if (key.includes("api repos/owner/repo --jq .default_branch")) {
      throw new Error("direct gh api default_branch call should not occur");
    }

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      return JSON.stringify([{ number: 99 }]); // milestone incomplete — short circuits
    }
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    defaultBranchFn: (repo: string) => {
      defaultBranchCalls++;
      return Promise.resolve({
        ok: true as const,
        value: `branch-for-${repo}`,
      });
    },
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  assertEquals(defaultBranchCalls, 1);
});

Deno.test("checkAndHandleMilestoneCompletions - skips repo when defaultBranchFn errors", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("api") && key.includes("/milestones")) {
      // Should never reach here — resolver error must short-circuit.
      throw new Error("should not query milestones when default branch fails");
    }
    return "[]";
  };

  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: ghFn,
    defaultBranchFn: () =>
      Promise.resolve({ ok: false as const, error: new Error("boom") }),
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 0);
  }
  const warned = logs.some((l) =>
    l.includes("Could not determine default branch for owner/repo")
  );
  assertEquals(warned, true);
});

Deno.test("checkAndHandleMilestoneCompletions - reuses existing tracking issue", async () => {
  const createdIssues: string[] = [];
  const createdPrs: { title: string }[] = [];
  const closedIssueNumbers: number[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 10,
        title: "Add login",
        milestone: { title: "v1.0" },
      }]);
    }
    // Existing tracking issue
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return JSON.stringify([
        {
          number: 200,
          title: "Merge milestone 'v1.0' to main",
          body: MILESTONE_TRACKING_MARKER,
          author: { login: "bot" },
        },
      ]);
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      createdIssues.push(args.join(" "));
      return "https://github.com/owner/repo/issues/999";
    }
    if (key.includes("pr create")) {
      const titleIdx = args.indexOf("--title");
      if (titleIdx >= 0) {
        createdPrs.push({ title: args[titleIdx + 1]! });
      }
      return "https://github.com/owner/repo/pull/301";
    }
    // Close tracking issue (Issue #1133)
    if (key.includes("issue close")) {
      const issueNumStr = args.find((a) => /^\d+$/.test(a));
      if (issueNumStr) closedIssueNumbers.push(Number(issueNumStr));
      return "";
    }
    return "[]";
  };

  const deps = createMockDeps({ ghCommandFn: ghFn });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 1);
  }

  // Should NOT create a new tracking issue
  assertEquals(createdIssues.length, 0);
  // Should still create the summary PR
  assertEquals(createdPrs.length, 1);
  // Issue #1133: Existing tracking issue should be closed after PR creation
  assertEquals(closedIssueNumbers.length, 1);
  assertEquals(closedIssueNumbers[0], 200);
});

Deno.test("checkAndHandleMilestoneCompletions - skips milestones with no issues at all", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "empty-milestone", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    // No open issues
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    // No closed issues either — empty milestone
    if (key.includes("issue list") && key.includes("--state closed")) {
      return "[]";
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/empty-milestone" });
    }
    return "[]";
  };

  const deps = createMockDeps({ ghCommandFn: ghFn });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Empty milestones (no closed issues) should be skipped
    assertEquals(result.value.summaryPrsCreated, 0);
  }
});

// ============================================================================
// Issue #1133: Tracking issue closure after summary PR creation
// ============================================================================

Deno.test("Issue #1133 - tracking issue closed immediately after summary PR created", async () => {
  const closedIssueNumbers: number[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v2.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 10,
        title: "Feature A",
        milestone: { title: "v2.0" },
      }]);
    }
    // Existing tracking issue
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return JSON.stringify([{
        number: 500,
        title: "Merge milestone 'v2.0' to main",
        body: MILESTONE_TRACKING_MARKER,
        author: { login: "bot" },
      }]);
    }
    // No existing summary PR
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    // Branch exists
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v2-0" });
    }
    // Create PR succeeds
    if (key.includes("pr create")) {
      return "https://github.com/owner/repo/pull/501";
    }
    // Close tracking issue
    if (key.includes("issue close")) {
      const issueNumStr = args.find((a) => /^\d+$/.test(a));
      if (issueNumStr) closedIssueNumbers.push(Number(issueNumStr));
      return "";
    }
    return "[]";
  };

  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 1);
  }

  // Tracking issue #500 should have been closed
  assertEquals(closedIssueNumbers.length, 1);
  assertEquals(closedIssueNumbers[0], 500);

  // Verify the closure was logged
  const closeLog = logs.find((l) =>
    l.includes("Closed milestone tracking issue #500")
  );
  assertEquals(closeLog !== undefined, true);
});

Deno.test("Issue #1133 - tracking issue closed when summary PR already exists", async () => {
  const closedIssueNumbers: number[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v3.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 20,
        title: "Feature B",
        milestone: { title: "v3.0" },
      }]);
    }
    // Existing tracking issue
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return JSON.stringify([{
        number: 600,
        title: "Merge milestone 'v3.0' to main",
        body: MILESTONE_TRACKING_MARKER,
        author: { login: "bot" },
      }]);
    }
    // Summary PR already exists
    if (key.includes("pr list") && key.includes("--state all")) {
      return JSON.stringify([
        {
          number: 601,
          title: "Milestone: v3.0",
          headRefName: "milestone/v3-0",
        },
      ]);
    }
    // Close tracking issue
    if (key.includes("issue close")) {
      const issueNumStr = args.find((a) => /^\d+$/.test(a));
      if (issueNumStr) closedIssueNumbers.push(Number(issueNumStr));
      return "";
    }
    return "[]";
  };

  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    // PR was not newly created (already existed)
    assertEquals(result.value.summaryPrsCreated, 0);
  }

  // Tracking issue #600 should still be closed (idempotent re-run)
  assertEquals(closedIssueNumbers.length, 1);
  assertEquals(closedIssueNumbers[0], 600);
});

/** `gh pr view --json state,body,headRefName,isCrossRepository` for #601. */
function livePrView(
  overrides: Partial<{
    state: string;
    body: string;
    headRefName: string;
    isCrossRepository: boolean;
  }> = {},
): string {
  return JSON.stringify({
    state: "OPEN",
    body: "stale body",
    headRefName: "milestone/v3-0",
    isCrossRepository: false,
    ...overrides,
  });
}

Deno.test("checkAndHandleMilestoneCompletions - refreshes the existing summary PR body with freshly classified closed issues (Issue #3476)", async () => {
  const editedBodies: string[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr view")) return livePrView();
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v3.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    // The milestone's own tracker is closed in the scan that raised the
    // summary PR, so it sits in the closed list on every later scan.
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 20,
        title: "Feature B",
        milestone: { title: "v3.0" },
      }, {
        number: 600,
        title: "Merge milestone 'v3.0' to main",
        milestone: { title: "v3.0" },
      }]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return JSON.stringify([{
        number: 600,
        title: "Merge milestone 'v3.0' to main",
        body: MILESTONE_TRACKING_MARKER,
        author: { login: "bot" },
      }]);
    }
    // Summary PR already exists
    if (key.includes("pr list") && key.includes("--state all")) {
      return JSON.stringify([
        {
          number: 601,
          title: "Milestone: v3.0",
          headRefName: "milestone/v3-0",
        },
      ]);
    }
    // Issue #3476: the completion scan refreshes the existing PR's body.
    if (key.includes("pr edit")) {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) editedBodies.push(args[bodyIdx + 1]!);
      return "";
    }
    if (key.includes("issue close")) {
      return "";
    }
    return "[]";
  };

  const result = await checkAndHandleMilestoneCompletions(
    createMockDeps({ ghCommandFn: ghFn }),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    // The PR was not newly created — its body was refreshed instead.
    assertEquals(result.value.summaryPrsCreated, 0);
  }

  // The freshly classified closed issue (no fleet-titled merged PR) is
  // flagged rather than claimed, so a reopened/never-delivered issue cannot
  // ride the rollup body into the milestone close.
  assertEquals(editedBodies.length, 1);
  assertStringIncludes(editedBodies[0]!, "### Flagged — not claimed");
  assertStringIncludes(
    editedBodies[0]!,
    "- #20: Feature B (no fleet-titled merged PR — possibly a milestone sync PR)",
  );
  assertEquals(
    editedBodies[0]!.includes("### Issues addressed\n- #20"),
    false,
    "the flagged issue must not appear under Issues addressed",
  );
  // The fleet's own closed tracker is neither addressed nor flagged: it is
  // referenced only by the `Closes #600` line (PR #3640 review).
  assertEquals(
    editedBodies[0]!.includes("- #600:"),
    false,
    "the closed tracking issue must not be listed as a sub-issue",
  );
  assertStringIncludes(editedBodies[0]!, "Closes #600");
});

/**
 * Scenario for a summary PR (#601) that is still OPEN while issue #21, listed
 * in its body when it was raised, has reopened. `openChildren` selects whether
 * the cached open list (first `continue`) or only the authoritative GitHub
 * read (second `continue`) sees the reopened issue.
 */
function reopenedListedIssueGhFn(
  editedBodies: string[],
  seesReopenedInCachedList: boolean,
  liveBody: () => string = () => "stale body",
  liveState = "OPEN",
): (args: string[]) => Promise<string> {
  const reopened = { number: 21, title: "Reopened feature" };
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr view")) {
      return livePrView({ state: liveState, body: liveBody() });
    }
    const authoritative = authoritativeStub(key, 1, [reopened]);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v3.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    // The cached open list is the repo-wide `fetchAllIssues` batch, so it
    // carries the milestone title on each row.
    if (key.includes("issue list") && key.includes("--state open")) {
      return JSON.stringify(
        seesReopenedInCachedList
          ? [{
            ...reopened,
            assignees: [],
            labels: [],
            createdAt: "2024-01-01T00:00:00Z",
            milestone: { title: "v3.0" },
            author: { login: "alice" },
            url: "u",
          }]
          : [],
      );
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 20,
        title: "Feature B",
        milestone: { title: "v3.0" },
      }]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return JSON.stringify([{
        number: 600,
        title: "Merge milestone 'v3.0' to main",
        body: MILESTONE_TRACKING_MARKER,
        author: { login: "bot" },
      }]);
    }
    if (args.includes("/timeline") || key.includes("/timeline")) return "[]";
    if (key.includes("pr list") && key.includes("--state all")) {
      return JSON.stringify([{
        number: 601,
        title: "Milestone: v3.0",
        state: liveState,
        headRefName: "milestone/v3-0",
        isCrossRepository: false,
      }]);
    }
    if (key.includes("pr list") && key.includes("in:title")) {
      return JSON.stringify([{
        number: 5,
        title: "Fix (#20)",
        baseRefName: "milestone/v3-0",
        headRefName: "h",
        mergedAt: "2026-10-05T00:00:00Z",
      }]);
    }
    if (key.includes("pr edit")) {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) editedBodies.push(args[bodyIdx + 1]!);
      return "";
    }
    return "[]";
  };
}

for (const cached of [true, false]) {
  Deno.test(
    `checkAndHandleMilestoneCompletions - refreshes an open summary PR body when a listed issue reopens (${
      cached ? "cached open list" : "authoritative open count"
    } sees it) (PR #3640 review)`,
    async () => {
      const editedBodies: string[] = [];
      const writes: string[] = [];
      const inner = reopenedListedIssueGhFn(editedBodies, cached);
      const ghFn = async (args: string[]): Promise<string> => {
        const key = args.join(" ");
        if (
          key.includes("pr create") || key.includes("issue create") ||
          key.includes("issue close") || key.includes("-X PATCH")
        ) {
          writes.push(key);
        }
        return await inner(args);
      };

      const result = await checkAndHandleMilestoneCompletions(
        createMockDeps({ ghCommandFn: ghFn }),
      );
      assertEquals(result.ok, true);
      if (result.ok) assertEquals(result.value.summaryPrsCreated, 0);

      // The milestone is not complete: no new PR, tracker or milestone close.
      assertEquals(writes, []);
      // ...yet the open summary PR's body is rebuilt from the still-closed
      // issues, so the reopened #21 is no longer claimed.
      assertEquals(editedBodies.length, 1);
      assertStringIncludes(editedBodies[0]!, "### Issues addressed\n- #20:");
      assertEquals(editedBodies[0]!.includes("#21"), false);
      assertEquals(editedBodies[0]!.includes("- #600:"), false);
      assertStringIncludes(editedBodies[0]!, "Closes #600");
    },
  );
}

Deno.test("checkAndHandleMilestoneCompletions - an incomplete milestone does not publish an empty body over a summary PR when the closed list reads empty (PR #3640 review)", async () => {
  const editedBodies: string[] = [];
  const inner = reopenedListedIssueGhFn(editedBodies, true);
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    // A failed or empty closed-issue read — indistinguishable from "none".
    if (key.includes("issue list") && key.includes("--state closed")) {
      return "[]";
    }
    return await inner(args);
  };
  const result = await checkAndHandleMilestoneCompletions(
    createMockDeps({ ghCommandFn: ghFn }),
  );
  assertEquals(result.ok, true);
  assertEquals(editedBodies, []);
});

Deno.test("checkAndHandleMilestoneCompletions - an incomplete milestone with only a non-open summary PR makes no live read, title search or timeline read (PR #3640 review)", async () => {
  for (const state of ["CLOSED", "MERGED"]) {
    const editedBodies: string[] = [];
    const calls: string[] = [];
    const inner = reopenedListedIssueGhFn(
      editedBodies,
      true,
      () => "stale body",
      state,
    );
    const result = await checkAndHandleMilestoneCompletions(
      createMockDeps({
        ghCommandFn: (args: string[]) => {
          calls.push(args.join(" "));
          return inner(args);
        },
      }),
    );
    assertEquals(result.ok, true);
    assertEquals(editedBodies, []);
    // The cached all-state list already says the PR is not open, so nothing is
    // classified and the PR is never read live.
    assertEquals(calls.filter((c) => c.includes("pr view")), [], state);
    assertEquals(calls.filter((c) => c.includes("in:title")), [], state);
    assertEquals(calls.filter((c) => c.includes("/timeline")), [], state);
  }
});

Deno.test("checkAndHandleMilestoneCompletions - a cached all-state row with no state is still read live before any edit (PR #3640 review)", async () => {
  await withTempCache(async (cache) => {
    const editedBodies: string[] = [];
    const calls: string[] = [];
    const inner = reopenedListedIssueGhFn(editedBodies, true);
    // A cache entry written before `state` joined the row.
    await cache.write("owner/repo", "prs_all_branch_milestone/v3-0", [{
      number: 601,
      title: "Milestone: v3.0",
      headRefName: "milestone/v3-0",
    }]);
    const result = await checkAndHandleMilestoneCompletions(
      createMockDeps({
        ghCommandFn: (args: string[]) => {
          calls.push(args.join(" "));
          return inner(args);
        },
        cache,
      }),
    );
    assertEquals(result.ok, true);
    assertEquals(calls.filter((c) => c.includes("pr view")).length >= 1, true);
    assertEquals(editedBodies.length, 1);
  });
});

/**
 * A completed milestone (nothing open) whose rollup PR #601 already exists.
 * `live` models GitHub: `pr edit` rewrites its body, and `pr view` reads it
 * back, so a second scan sees what the first one published.
 */
function completedMilestoneWithRollupGhFn(
  live: {
    state: string;
    body: string;
    headRefName?: string;
    isCrossRepository?: boolean;
    /** Fail the uncached final-PR classification (it reads `state`). */
    classifyFails?: boolean;
  },
  calls: string[],
  updatedAt = "2026-10-05T00:00:00Z",
) {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    calls.push(key);
    if (key.includes("pr view")) {
      return livePrView({
        state: live.state,
        body: live.body,
        ...(live.headRefName !== undefined
          ? { headRefName: live.headRefName }
          : {}),
        ...(live.isCrossRepository !== undefined
          ? { isCrossRepository: live.isCrossRepository }
          : {}),
      });
    }
    if (key.includes("pr edit")) {
      live.body = args[args.indexOf("--body") + 1]!;
      return "";
    }
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;
    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v3.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 20,
        title: "Feature B",
        milestone: { title: "v3.0" },
        updatedAt,
      }]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("/timeline")) return "[]";
    if (
      live.classifyFails && key.includes("pr list") &&
      key.includes("isCrossRepository")
    ) {
      throw new Error("HTTP 502: Bad Gateway");
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return JSON.stringify([{
        number: 601,
        title: "Milestone: v3.0",
        state: live.state,
        headRefName: "milestone/v3-0",
        isCrossRepository: false,
      }]);
    }
    if (key.includes("pr list") && key.includes("in:title")) {
      return JSON.stringify([{
        number: 5,
        title: "Fix (#20)",
        baseRefName: "milestone/v3-0",
        headRefName: "h",
        mergedAt: "2026-10-05T00:00:00Z",
      }]);
    }
    return "[]";
  };
}

async function withTempCache<T>(
  fn: (cache: IssueCache) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rollup-refresh-" });
  try {
    return await fn(new IssueCache(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("checkAndHandleMilestoneCompletions - a second scan with unchanged GitHub state does not edit the summary PR or re-read the timelines (PR #3640 review)", async () => {
  await withTempCache(async (cache) => {
    const live = { state: "OPEN", body: "stale body" };
    const calls: string[] = [];
    const deps = createMockDeps({
      ghCommandFn: completedMilestoneWithRollupGhFn(live, calls),
      cache,
    });

    await checkAndHandleMilestoneCompletions(deps);
    const edits = (list: string[]) =>
      list.filter((c) => c.includes("pr edit")).length;
    const timelines = (list: string[]) =>
      list.filter((c) => c.includes("/timeline")).length;
    const paginated = (list: string[]) =>
      list.filter((c) => c.includes("--paginate")).length;
    // First scan: the stale body is replaced and the timeline is read.
    assertEquals(edits(calls), 1);
    assertEquals(timelines(calls), 1);
    assertStringIncludes(live.body, "vibe-rollup-fingerprint");
    const firstScan = calls.length;
    const firstPaginated = paginated(calls);

    await checkAndHandleMilestoneCompletions(deps);
    const secondScan = calls.slice(firstScan);
    assertEquals(edits(secondScan), 0, "unchanged state must not be rewritten");
    assertEquals(timelines(secondScan), 0, "the verdict is served from cache");
    // The dependency and not-planned reads belong to a body build; they are
    // skipped when the live body already carries the current fingerprint.
    assert(
      paginated(secondScan) < firstPaginated,
      `second scan re-read the milestone issues for the body: ${
        secondScan.filter((c) => c.includes("--paginate")).join(" | ")
      }`,
    );
  });
});

Deno.test("checkAndHandleMilestoneCompletions - a changed classification rewrites the body once, then the next scan leaves it (PR #3640 review)", async () => {
  await withTempCache(async (cache) => {
    const live = { state: "OPEN", body: "stale body" };
    const calls: string[] = [];
    let updatedAt = "2026-10-05T00:00:00Z";
    const inner = completedMilestoneWithRollupGhFn(live, calls);
    // Issue #20 is reopened and re-closed with no PR after the reopen.
    let reopened = false;
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("issue list") && key.includes("--state closed")) {
        return JSON.stringify([{
          number: 20,
          title: "Feature B",
          milestone: { title: "v3.0" },
          updatedAt,
        }]);
      }
      if (reopened && key.includes("/timeline")) {
        calls.push(key);
        return JSON.stringify([{
          event: "reopened",
          actor: { login: "nleck" },
          created_at: "2026-10-06T00:00:00Z",
        }]);
      }
      return await inner(args);
    };
    const deps = createMockDeps({ ghCommandFn: ghFn, cache });
    const edits = () => calls.filter((c) => c.includes("pr edit")).length;

    await checkAndHandleMilestoneCompletions(deps);
    assertEquals(edits(), 1);
    assertStringIncludes(live.body, "### Issues addressed\n- #20:");

    // GitHub reports a newer updatedAt and the closed list is re-read.
    reopened = true;
    updatedAt = "2026-10-07T00:00:00Z";
    await cache.invalidate("owner/repo", "issues_closed_all");
    await checkAndHandleMilestoneCompletions(deps);
    assertEquals(edits(), 2);
    assertStringIncludes(live.body, "predates a later reopen");

    await checkAndHandleMilestoneCompletions(deps);
    assertEquals(edits(), 2, "the third scan has nothing new to publish");
  });
});

for (
  const [label, live] of [
    ["merged", { state: "MERGED", classifyFails: true }],
    ["closed", { state: "CLOSED", classifyFails: true }],
    ["a fork's", { state: "OPEN", isCrossRepository: true }],
    ["headed by another branch", { state: "OPEN", headRefName: "other" }],
  ] as const
) {
  Deno.test(`checkAndHandleMilestoneCompletions - an existing summary PR that is ${label} is not edited on the exists path (PR #3640 review)`, async () => {
    const calls: string[] = [];
    const result = await checkAndHandleMilestoneCompletions(
      createMockDeps({
        ghCommandFn: completedMilestoneWithRollupGhFn(
          { body: "stale body", ...live },
          calls,
        ),
      }),
    );
    assertEquals(result.ok, true);
    assertEquals(calls.filter((c) => c.includes("pr edit")), []);
  });
}

Deno.test("checkAndHandleMilestoneCompletions - an unreadable live summary PR is not edited and the fault is logged (PR #3640 review)", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const inner = completedMilestoneWithRollupGhFn(
    { state: "OPEN", body: "stale body" },
    calls,
  );
  const ghFn = async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("pr view 601")) {
      calls.push(args.join(" "));
      throw new Error("HTTP 502: Bad Gateway");
    }
    return await inner(args);
  };
  await checkAndHandleMilestoneCompletions(
    createMockDeps({ ghCommandFn: ghFn, log: (m) => logs.push(m) }),
  );
  assertEquals(calls.filter((c) => c.includes("pr edit")), []);
  assert(
    logs.some((l) =>
      l.includes("could not read summary PR #601") && l.includes("502")
    ),
    `expected the read fault to be logged: ${logs.join(" | ")}`,
  );
});

Deno.test("checkAndHandleMilestoneCompletions - an incomplete milestone's second scan with unchanged state does not edit the summary PR (PR #3640 review)", async () => {
  const editedBodies: string[] = [];
  let liveBody = "stale body";
  const inner = reopenedListedIssueGhFn(editedBodies, true, () => liveBody);
  const deps = createMockDeps({
    ghCommandFn: async (args: string[]) => {
      const out = await inner(args);
      if (args.includes("edit")) liveBody = editedBodies.at(-1)!;
      return out;
    },
  });
  await checkAndHandleMilestoneCompletions(deps);
  assertEquals(editedBodies.length, 1);
  await checkAndHandleMilestoneCompletions(deps);
  assertEquals(editedBodies.length, 1);
});

Deno.test("checkAndHandleMilestoneCompletions - an incomplete milestone with no summary PR makes no uncached PR read (PR #3640 review)", async () => {
  const calls: string[] = [];
  const inner = reopenedListedIssueGhFn([], true);
  await checkAndHandleMilestoneCompletions(createMockDeps({
    ghCommandFn: async (args: string[]) => {
      const key = args.join(" ");
      calls.push(key);
      if (key.includes("pr list") && key.includes("--state all")) return "[]";
      return await inner(args);
    },
  }));
  assertEquals(calls.filter((c) => c.includes("pr view")), []);
  assertEquals(calls.filter((c) => c.includes("pr edit")), []);
  assertEquals(
    calls.filter((c) => c.includes("/timeline")),
    [],
    "no candidate PR: no sub-issue is classified",
  );
});

/** A gh stub: every issue has one clean merged PR; timelines are counted. */
function claimableGhFn(counter: { timelineReads: number }) {
  return async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("/timeline")) {
      counter.timelineReads++;
      return "[]";
    }
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([{
        number: 5,
        title: "Fix (#1)",
        baseRefName: "main",
        headRefName: "h",
        mergedAt: "2026-10-05T00:00:00Z",
      }]);
    }
    return "[]";
  };
}

Deno.test("classifyClosedIssues - serves an unchanged issue's verdict from cache and re-reads when updatedAt moves (PR #3640 review)", async () => {
  await withTempCache(async (cache) => {
    const counter = { timelineReads: 0 };
    const ghFn = claimableGhFn(counter);
    const issue = (updatedAt?: string) => [{
      number: 1,
      title: "Clean",
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    }];
    const run = (updatedAt?: string) =>
      classifyClosedIssues("org/repo", issue(updatedAt), ghFn, cache);

    assertEquals(
      (await run("2026-10-05T00:00:00Z"))[0]?.claimProblem,
      undefined,
    );
    assertEquals(counter.timelineReads, 1);
    await run("2026-10-05T00:00:00Z");
    assertEquals(counter.timelineReads, 1, "same updatedAt: served from cache");
    await run("2026-10-06T00:00:00Z");
    assertEquals(counter.timelineReads, 2, "a newer updatedAt must miss");

    // An old-shape closed-batch row has no updatedAt: never cached, never read.
    await run();
    await run();
    assertEquals(counter.timelineReads, 4, "no updatedAt: classified live");
  });
});

Deno.test("classifyClosedIssues - serves a cached predates-reopen verdict for the same updatedAt (PR #3640 review)", async () => {
  await withTempCache(async (cache) => {
    let timelineReads = 0;
    const inner = claimableGhFn({ timelineReads: 0 });
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.join(" ").includes("/timeline")) {
        timelineReads++;
        return JSON.stringify([{
          event: "reopened",
          actor: { login: "nleck" },
          created_at: "2026-10-06T00:00:00Z",
        }]);
      }
      return await inner(args);
    };
    const issues = [{
      number: 1,
      title: "Reopened",
      updatedAt: "2026-10-07T00:00:00Z",
    }];
    for (let i = 0; i < 2; i++) {
      const out = await classifyClosedIssues("org/repo", issues, ghFn, cache);
      assertEquals(out[0]?.claimProblem, "predates-reopen");
    }
    assertEquals(timelineReads, 1);
  });
});

Deno.test("classifyClosedIssues - an issue with no merged PR is flagged without paging its timeline (PR #3640 review)", async () => {
  await withTempCache(async (cache) => {
    let timelineReads = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.join(" ").includes("/timeline")) {
        timelineReads++;
        return "[]";
      }
      return "[]";
    };
    const out = await classifyClosedIssues(
      "org/repo",
      [{ number: 1, title: "Sync", updatedAt: "2026-10-05T00:00:00Z" }],
      ghFn,
      cache,
    );
    assertEquals(out[0]?.claimProblem, "sync-pr-only");
    assertEquals(timelineReads, 0);
  });
});

Deno.test("classifyClosedIssues - a failed merged-PR read is retried, not pinned as sync-pr-only (PR #3640 review)", async () => {
  await withTempCache(async (cache) => {
    let healthy = false;
    const counter = { timelineReads: 0 };
    const inner = claimableGhFn(counter);
    const ghFn = async (args: string[]): Promise<string> => {
      if (!healthy && args[0] === "pr") throw new Error("HTTP 502");
      return await inner(args);
    };
    const issues = [{
      number: 1,
      title: "T",
      updatedAt: "2026-10-05T00:00:00Z",
    }];
    const bad = await classifyClosedIssues("org/repo", issues, ghFn, cache);
    assertEquals(bad[0]?.claimProblem, "sync-pr-only");
    healthy = true;
    const good = await classifyClosedIssues("org/repo", issues, ghFn, cache);
    assertEquals(good[0]?.claimProblem, undefined);
  });
});

Deno.test("classifyClosedIssues - never caches an unreadable timeline (PR #3640 review)", async () => {
  await withTempCache(async (cache) => {
    let timelineReads = 0;
    const inner = claimableGhFn({ timelineReads: 0 });
    const ghFn = async (args: string[]): Promise<string> => {
      if (args.join(" ").includes("/timeline")) {
        timelineReads++;
        throw new Error("HTTP 502: Bad Gateway");
      }
      return await inner(args);
    };
    const issues = [{
      number: 1,
      title: "T",
      updatedAt: "2026-10-05T00:00:00Z",
    }];
    const first = await classifyClosedIssues("org/repo", issues, ghFn, cache);
    assertEquals(first[0]?.claimProblem, "timeline-unreadable");
    await classifyClosedIssues("org/repo", issues, ghFn, cache);
    assertEquals(timelineReads, 2);
  });
});

// ============================================================================
// Issue #1210: isSummaryPrMerged
// ============================================================================

Deno.test("isSummaryPrMerged - returns true when PR state is MERGED", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr view") && key.includes("--json state")) {
      return JSON.stringify({ state: "MERGED" });
    }
    return "{}";
  };

  const result = await isSummaryPrMerged("owner/repo", 50, ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, true);
  }
});

Deno.test("isSummaryPrMerged - returns false when PR state is OPEN", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr view") && key.includes("--json state")) {
      return JSON.stringify({ state: "OPEN" });
    }
    return "{}";
  };

  const result = await isSummaryPrMerged("owner/repo", 50, ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("isSummaryPrMerged - returns false when PR state is CLOSED", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr view") && key.includes("--json state")) {
      return JSON.stringify({ state: "CLOSED" });
    }
    return "{}";
  };

  const result = await isSummaryPrMerged("owner/repo", 50, ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("isSummaryPrMerged - returns error on gh failure", async () => {
  const ghFn = async (_args: string[]): Promise<string> => {
    throw new Error("API error");
  };

  const result = await isSummaryPrMerged("owner/repo", 50, ghFn);
  assertEquals(result.ok, false);
});

// ============================================================================
// Issue #1210: closeGitHubMilestone
// ============================================================================

Deno.test("closeGitHubMilestone - calls PATCH API with correct milestone number", async () => {
  const apiCalls: string[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    apiCalls.push(args.join(" "));
    return "{}";
  };

  const logs: string[] = [];
  await closeGitHubMilestone("owner/repo", 5, ghFn, (msg) => logs.push(msg));

  assertEquals(apiCalls.length, 1);
  const call = apiCalls[0]!;
  assertEquals(call.includes("api"), true);
  assertEquals(call.includes("-X"), true);
  assertEquals(call.includes("PATCH"), true);
  assertEquals(call.includes("repos/owner/repo/milestones/5"), true);
  assertEquals(call.includes("state=closed"), true);

  // Verify closure was logged
  const closeLog = logs.find((l) => l.includes("Closed GitHub milestone #5"));
  assertEquals(closeLog !== undefined, true);
});

Deno.test("closeGitHubMilestone - logs warning on failure without throwing", async () => {
  const ghFn = async (_args: string[]): Promise<string> => {
    throw new Error("Forbidden");
  };

  const logs: string[] = [];
  await closeGitHubMilestone("owner/repo", 5, ghFn, (msg) => logs.push(msg));

  const warningLog = logs.find((l) =>
    l.includes("WARNING") && l.includes("Failed to close milestone")
  );
  assertEquals(warningLog !== undefined, true);
});

// ============================================================================
// Issue #1210: Milestone closure after summary PR merge (integration)
// ============================================================================

Deno.test("Issue #1210 - milestone closed when summary PR is merged", async () => {
  const closedMilestones: { repo: string; number: number }[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (
      key.includes("api") && key.includes("/milestones") &&
      !key.includes("PATCH")
    ) {
      return JSON.stringify([{ title: "Better Discovery", number: 7 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 10,
        title: "Improve search",
        milestone: { title: "Better Discovery" },
      }]);
    }
    // Existing tracking issue
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return JSON.stringify([{
        number: 1068,
        title: "Merge milestone 'Better Discovery' to main",
        body: MILESTONE_TRACKING_MARKER,
        author: { login: "bot" },
      }]);
    }
    // Summary PR already exists
    if (key.includes("pr list") && key.includes("--state all")) {
      return JSON.stringify([
        {
          number: 1069,
          title: "Milestone: Better Discovery",
          headRefName: "milestone/better-discovery",
        },
      ]);
    }
    // PR is merged
    if (
      key.includes("pr view") && key.includes("1069") &&
      key.includes("--json state")
    ) {
      return JSON.stringify({ state: "MERGED" });
    }
    // Close milestone via PATCH API
    if (
      key.includes("api") && key.includes("PATCH") &&
      key.includes("/milestones/")
    ) {
      const match = key.match(/milestones\/(\d+)/);
      if (match) {
        closedMilestones.push({ repo: "owner/repo", number: Number(match[1]) });
      }
      return "{}";
    }
    // Close tracking issue
    if (key.includes("issue close")) {
      return "";
    }
    return "[]";
  };

  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  // Milestone #7 should have been closed
  assertEquals(closedMilestones.length, 1);
  assertEquals(closedMilestones[0]!.number, 7);

  // Verify closure was logged
  const closeLog = logs.find((l) => l.includes("Closed GitHub milestone #7"));
  assertEquals(closeLog !== undefined, true);
});

Deno.test("Issue #1210 - milestone NOT closed when summary PR is still open", async () => {
  const closedMilestones: { repo: string; number: number }[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (
      key.includes("api") && key.includes("/milestones") &&
      !key.includes("PATCH")
    ) {
      return JSON.stringify([{ title: "v5.0", number: 3 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 10,
        title: "Feature X",
        milestone: { title: "v5.0" },
      }]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return JSON.stringify([{
        number: 800,
        title: "Merge milestone 'v5.0' to main",
        body: MILESTONE_TRACKING_MARKER,
        author: { login: "bot" },
      }]);
    }
    // Summary PR already exists
    if (key.includes("pr list") && key.includes("--state all")) {
      return JSON.stringify([
        {
          number: 801,
          title: "Milestone: v5.0",
          headRefName: "milestone/v5-0",
        },
      ]);
    }
    // PR is still open — NOT merged
    if (
      key.includes("pr view") && key.includes("801") &&
      key.includes("--json state")
    ) {
      return JSON.stringify({ state: "OPEN" });
    }
    // Close milestone — should NOT be called
    if (
      key.includes("api") && key.includes("PATCH") &&
      key.includes("/milestones/")
    ) {
      const match = key.match(/milestones\/(\d+)/);
      if (match) {
        closedMilestones.push({ repo: "owner/repo", number: Number(match[1]) });
      }
      return "{}";
    }
    if (key.includes("issue close")) {
      return "";
    }
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (_msg) => {},
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  // Milestone should NOT have been closed — PR not yet merged
  assertEquals(closedMilestones.length, 0);
});

Deno.test("Issue #1210 - milestone NOT closed when summary PR was just created", async () => {
  const closedMilestones: { repo: string; number: number }[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (
      key.includes("api") && key.includes("/milestones") &&
      !key.includes("PATCH")
    ) {
      return JSON.stringify([{ title: "v6.0", number: 4 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (
      key.includes("issue list") && key.includes("--state open") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 10,
        title: "Feature Y",
        milestone: { title: "v6.0" },
      }]);
    }
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return "[]";
    }
    // No existing summary PR
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    // Branch exists
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v6-0" });
    }
    // Create tracking issue
    if (key.includes("issue create")) {
      return "https://github.com/owner/repo/issues/900";
    }
    // Create PR — just created, not merged
    if (key.includes("pr create")) {
      return "https://github.com/owner/repo/pull/901";
    }
    // Close milestone — should NOT be called
    if (
      key.includes("api") && key.includes("PATCH") &&
      key.includes("/milestones/")
    ) {
      const match = key.match(/milestones\/(\d+)/);
      if (match) {
        closedMilestones.push({ repo: "owner/repo", number: Number(match[1]) });
      }
      return "{}";
    }
    if (key.includes("issue close")) {
      return "";
    }
    return "[]";
  };

  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (_msg) => {},
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  // Milestone should NOT have been closed — PR was just created, not merged
  assertEquals(closedMilestones.length, 0);
});

// Issue #3214: this test previously used a *missing branch* to force the
// summary-PR failure. That path is now handled by the nothing-to-merge branch
// (the milestone is closed directly), so the scenario was rewritten to a
// genuine `pr create` failure with a branch that exists and has commits ahead.
// The #1133 invariant — a tracker is left open when the summary PR genuinely
// fails to be created — is preserved and still asserted here.
Deno.test("Issue #1133 - tracking issue left open when summary PR creation fails", async () => {
  const closedIssueNumbers: number[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.endsWith("/milestones")) {
      return JSON.stringify([{ title: "v4.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([{
        number: 30,
        title: "Feature C",
        milestone: { title: "v4.0" },
      }]);
    }
    // Existing tracking issue
    if (
      key.includes("issue list") && key.includes("--state all") &&
      key.includes("--milestone")
    ) {
      return JSON.stringify([{
        number: 700,
        title: "Merge milestone 'v4.0' to main",
        body: MILESTONE_TRACKING_MARKER,
        author: { login: "bot" },
      }]);
    }
    // No existing summary PR
    if (key.includes("pr list") && key.includes("--state all")) {
      return "[]";
    }
    // Branch exists...
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v4-0" });
    }
    // ...and has commits ahead of the default branch (something to merge).
    if (key.includes("api") && key.includes("/compare/")) {
      return "5";
    }
    // But the summary PR genuinely fails to be created.
    if (key.includes("pr create")) {
      throw new Error("pr create failed");
    }
    // Close tracking issue — should NOT be called
    if (key.includes("issue close")) {
      const issueNumStr = args.find((a) => /^\d+$/.test(a));
      if (issueNumStr) closedIssueNumbers.push(Number(issueNumStr));
      return "";
    }
    return "[]";
  };

  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: ghFn,
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 0);
  }

  // Tracking issue should NOT have been closed — left open for manual intervention
  assertEquals(closedIssueNumbers.length, 0);
});

// ============================================================================
// Issue #2125: idle-task milestones are retired — completion sync must skip
// them (no tracking issue, no summary PR) and auto-close empty legacy
// milestones so they stop logging on every cycle.
// ============================================================================

Deno.test(
  "checkAndHandleMilestoneCompletions - auto-closes empty idle-task milestone and skips PR/tracking (Issue #2125)",
  async () => {
    const patchCalls: string[][] = [];
    const createdIssues: string[][] = [];
    const createdPrs: string[][] = [];

    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      const authoritative = authoritativeStub(key);
      if (authoritative !== null) return authoritative;

      // List milestones — one idle-task milestone with zero open issues.
      if (key.includes("api") && key.endsWith("/milestones")) {
        return JSON.stringify([
          {
            title: "idle-task: security-scan",
            number: 20,
            open_issues: 0,
            closed_issues: 4,
            state: "open",
          },
        ]);
      }

      // Close-milestone PATCH call.
      if (args[0] === "api" && args.includes("-X") && args.includes("PATCH")) {
        patchCalls.push([...args]);
        return "{}";
      }

      // Catch any unexpected work the sync might attempt.
      if (key.includes("issue create")) {
        createdIssues.push([...args]);
        return "https://github.com/owner/repo/issues/999";
      }
      if (key.includes("pr create")) {
        createdPrs.push([...args]);
        return "https://github.com/owner/repo/pull/999";
      }
      return "[]";
    };

    const logs: string[] = [];
    const deps = createMockDeps({
      ghCommandFn: ghFn,
      log: (msg) => logs.push(msg),
    });

    const result = await checkAndHandleMilestoneCompletions(deps);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.summaryPrsCreated, 0);

    // The milestone must have been auto-closed.
    assertEquals(patchCalls.length, 1);
    const patch = patchCalls[0]!;
    assertEquals(patch.includes("repos/owner/repo/milestones/20"), true);
    assertEquals(patch.includes("state=closed"), true);

    // No tracking issue, no summary PR.
    assertEquals(createdIssues.length, 0);
    assertEquals(createdPrs.length, 0);

    // One log line confirming the retirement.
    const closingLog = logs.find((l) =>
      l.includes("Closing legacy idle-task milestone")
    );
    assertEquals(closingLog !== undefined, true);
  },
);

Deno.test(
  "checkAndHandleMilestoneCompletions - skips idle-task milestone with open issues without closing (Issue #2125)",
  async () => {
    const patchCalls: string[][] = [];
    const createdIssues: string[][] = [];
    const createdPrs: string[][] = [];

    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      const authoritative = authoritativeStub(key);
      if (authoritative !== null) return authoritative;

      if (key.includes("api") && key.endsWith("/milestones")) {
        return JSON.stringify([
          {
            title: "idle-task: security-scan",
            number: 7,
            open_issues: 2,
            closed_issues: 1,
            state: "open",
          },
        ]);
      }
      if (args[0] === "api" && args.includes("-X") && args.includes("PATCH")) {
        patchCalls.push([...args]);
        return "{}";
      }
      if (key.includes("issue create")) {
        createdIssues.push([...args]);
        return "x";
      }
      if (key.includes("pr create")) {
        createdPrs.push([...args]);
        return "x";
      }
      return "[]";
    };

    const logs: string[] = [];
    const deps = createMockDeps({
      ghCommandFn: ghFn,
      log: (msg) => logs.push(msg),
    });

    await checkAndHandleMilestoneCompletions(deps);

    // No closure attempted — open issues remain.
    assertEquals(patchCalls.length, 0);
    // No PR/tracking work attempted.
    assertEquals(createdIssues.length, 0);
    assertEquals(createdPrs.length, 0);

    // One info log line confirming the skip.
    const skipLog = logs.find((l) =>
      l.includes("Skipping idle-task milestone") && l.includes("2 open issue")
    );
    assertEquals(skipLog !== undefined, true);
  },
);

Deno.test(
  "checkAndHandleMilestoneCompletions - non-idle-task milestones still progress normally after Issue #2125",
  async () => {
    // Regression guard: the new idle-task guard must NOT short-circuit
    // ordinary milestones. A regular `v2.0` milestone with one closed
    // issue and an existing remote branch should reach the tracking
    // issue / summary PR creation path as before.
    const createdIssues: { title: string }[] = [];
    const createdPrs: { title: string }[] = [];

    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      const authoritative = authoritativeStub(key);
      if (authoritative !== null) return authoritative;

      if (key.includes("api") && key.endsWith("/milestones")) {
        return JSON.stringify([
          {
            title: "v2.0",
            number: 3,
            open_issues: 0,
            closed_issues: 1,
            state: "open",
          },
        ]);
      }
      if (key.includes("api repos/") && key.includes(".default_branch")) {
        return "main";
      }
      if (
        key.includes("issue list") && key.includes("--state open") &&
        key.includes("--milestone")
      ) {
        return "[]";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        return JSON.stringify([
          { number: 11, title: "real work", milestone: { title: "v2.0" } },
        ]);
      }
      if (
        key.includes("issue list") && key.includes("--state all") &&
        key.includes("--milestone")
      ) {
        return "[]";
      }
      if (key.includes("pr list") && key.includes("--state all")) {
        return "[]";
      }
      if (key.includes("api") && key.includes("/branches/milestone")) {
        return JSON.stringify({ name: "milestone/v2-0" });
      }
      if (key.includes("issue create")) {
        const titleIdx = args.indexOf("--title");
        createdIssues.push({ title: args[titleIdx + 1] ?? "" });
        return "https://github.com/owner/repo/issues/300";
      }
      if (key.includes("pr create")) {
        const titleIdx = args.indexOf("--title");
        createdPrs.push({ title: args[titleIdx + 1] ?? "" });
        return "https://github.com/owner/repo/pull/301";
      }
      if (key.includes("issue close")) {
        return "";
      }
      return "[]";
    };

    const deps = createMockDeps({ ghCommandFn: ghFn });
    const result = await checkAndHandleMilestoneCompletions(deps);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.summaryPrsCreated, 1);
    assertEquals(createdIssues.length, 1);
    assertEquals(createdPrs.length, 1);
  },
);

// ============================================================================
// Issue #3214: milestone-completion deadlock — the tracking issue must not
// block its own milestone from closing.
// ============================================================================

// --- checkMilestoneComplete ignores tracking-shaped issues -----------------

Deno.test("checkMilestoneComplete - ignores an open tracking issue (Issue #3214)", async () => {
  // The only open issue in the milestone is its own tracker. Before the fix
  // this counted as an open issue → milestone never complete (the deadlock).
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return JSON.stringify([
        {
          number: 1508,
          title: "Merge milestone 'scan' to Develop",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "scan" },
          author: { login: "bot" },
          url: "u",
          body: MILESTONE_TRACKING_MARKER,
        },
      ]);
    }
    return "[]";
  };

  const result = await checkMilestoneComplete(
    "owner/repo",
    "scan",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, true);
});

Deno.test("checkMilestoneComplete - still false when a real issue is open beside a tracker (Issue #3214)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return JSON.stringify([
        {
          number: 1508,
          title: "Merge milestone 'scan' to Develop",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "scan" },
          author: { login: "bot" },
          url: "u",
          body: MILESTONE_TRACKING_MARKER,
        },
        {
          number: 42,
          title: "Real open work",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "scan" },
          author: { login: "alice" },
          url: "u",
        },
      ]);
    }
    return "[]";
  };

  const result = await checkMilestoneComplete(
    "owner/repo",
    "scan",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, false);
});

// --- getOpenMilestoneTrackers ----------------------------------------------

Deno.test("getOpenMilestoneTrackers - returns only tracking-shaped open issues, ascending (Issue #3214)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return JSON.stringify([
        {
          number: 377,
          title: "Merge milestone 'Milestone 3' to Develop",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "Milestone 3" },
          author: { login: "bot" },
          url: "u",
          body: MILESTONE_TRACKING_MARKER,
        },
        {
          number: 369,
          title: "Merge milestone 'Milestone 3' to main",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "Milestone 3" },
          author: { login: "bot" },
          url: "u",
          body: MILESTONE_TRACKING_MARKER,
        },
        {
          number: 400,
          title: "Ordinary open work",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "Milestone 3" },
          author: { login: "alice" },
          url: "u",
        },
      ]);
    }
    return "[]";
  };

  const trackers = await getOpenMilestoneTrackers(
    "owner/repo",
    "Milestone 3",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(trackers, [369, 377]);
});

// --- hasNothingToMerge -----------------------------------------------------

Deno.test("hasNothingToMerge - true when the milestone branch is missing (Issue #3214)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/branches/")) throw new Error("Not found");
    return "[]";
  };
  assertEquals(
    await hasNothingToMerge("owner/repo", "milestone/scan", "main", ghFn),
    true,
  );
});

Deno.test("hasNothingToMerge - true when the branch is 0 commits ahead (Issue #3214)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/branches/")) return "milestone/scan";
    if (key.includes("/compare/")) return "0";
    return "[]";
  };
  assertEquals(
    await hasNothingToMerge("owner/repo", "milestone/scan", "main", ghFn),
    true,
  );
});

Deno.test("hasNothingToMerge - false when the branch has commits ahead (Issue #3214)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/branches/")) return "milestone/scan";
    if (key.includes("/compare/")) return "31";
    return "[]";
  };
  assertEquals(
    await hasNothingToMerge("owner/repo", "milestone/scan", "main", ghFn),
    false,
  );
});

Deno.test("hasNothingToMerge - false (fail safe) when the compare call fails (Issue #3214)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/branches/")) return "milestone/scan";
    if (key.includes("/compare/")) throw new Error("compare boom");
    return "[]";
  };
  assertEquals(
    await hasNothingToMerge("owner/repo", "milestone/scan", "main", ghFn),
    false,
  );
});

// --- Integration: deadlock / no-branch self-heal ---------------------------

Deno.test("checkAndHandleMilestoneCompletions - self-heals a deadlocked issue-only milestone (Issue #3214)", async () => {
  // Shape: milestone 'scan' has closed work, NO milestone branch, and one open
  // tracker filed inside it. Before the fix the tracker blocked completeness
  // forever. After the fix the tracker is excluded, nothing-to-merge is
  // detected, the tracker is closed and the milestone is closed directly.
  const createdIssues: string[] = [];
  const createdPrs: string[] = [];
  const closedIssueNumbers: number[] = [];
  const closedMilestones: number[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (args[0] === "api" && args.includes("-X") && args.includes("PATCH")) {
      const match = key.match(/milestones\/(\d+)/);
      if (match) closedMilestones.push(Number(match[1]));
      return "{}";
    }
    if (key.includes("api") && key.endsWith("/milestones")) {
      return JSON.stringify([{ title: "scan", number: 5, open_issues: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "Develop";
    }
    // Open issues (shared cache) — only the tracker is open.
    if (key.includes("issue list") && key.includes("--state open")) {
      return JSON.stringify([
        {
          number: 1508,
          title: "Merge milestone 'scan' to Develop",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "scan" },
          author: { login: "bot" },
          url: "u",
          body: MILESTONE_TRACKING_MARKER,
        },
      ]);
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 100, title: "did work", milestone: { title: "scan" } },
      ]);
    }
    // No milestone branch exists.
    if (key.includes("api") && key.includes("/branches/")) {
      throw new Error("Not found");
    }
    if (key.includes("issue create")) {
      createdIssues.push(key);
      return "https://github.com/owner/repo/issues/999";
    }
    if (key.includes("pr create")) {
      createdPrs.push(key);
      return "https://github.com/owner/repo/pull/999";
    }
    if (key.includes("issue close")) {
      const num = args.find((a) => /^\d+$/.test(a));
      if (num) closedIssueNumbers.push(Number(num));
      return "";
    }
    return "[]";
  };

  const logs: string[] = [];
  const deps = createMockDeps({ ghCommandFn: ghFn, log: (m) => logs.push(m) });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.summaryPrsCreated, 0);

  // Tracker closed, milestone closed, and no new tracker/PR filed.
  assertEquals(closedIssueNumbers.includes(1508), true);
  assertEquals(closedMilestones.includes(5), true);
  assertEquals(createdIssues.length, 0);
  assertEquals(createdPrs.length, 0);

  const healLog = logs.find((l) =>
    l.includes("nothing to merge") && l.includes("scan")
  );
  assertEquals(healLog !== undefined, true);
});

// --- Integration: duplicate-tracker self-heal ------------------------------

Deno.test("checkAndHandleMilestoneCompletions - closes duplicate trackers each pass (Issue #3214)", async () => {
  // Two open trackers for the same milestone (a duplicate pair). The canonical
  // (lowest) one is kept; the duplicate is closed. Branch exists with commits
  // ahead so the normal flow otherwise proceeds.
  const closedIssueNumbers: number[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.endsWith("/milestones")) {
      return JSON.stringify([{ title: "Milestone 3", number: 3 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      return JSON.stringify([
        {
          number: 369,
          title: "Merge milestone 'Milestone 3' to main",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "Milestone 3" },
          author: { login: "bot" },
          url: "u",
          body: MILESTONE_TRACKING_MARKER,
        },
        {
          number: 377,
          title: "Merge milestone 'Milestone 3' to Develop",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "Milestone 3" },
          author: { login: "bot" },
          url: "u",
          body: MILESTONE_TRACKING_MARKER,
        },
      ]);
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 50, title: "work", milestone: { title: "Milestone 3" } },
      ]);
    }
    // Existing canonical tracker via the milestone-keyed all-state lookup.
    if (key.includes("issue list") && key.includes("--state all")) {
      return JSON.stringify([
        {
          number: 369,
          title: "Merge milestone 'Milestone 3' to main",
          body: MILESTONE_TRACKING_MARKER,
          author: { login: "bot" },
        },
      ]);
    }
    if (key.includes("api") && key.includes("/branches/")) {
      return JSON.stringify({ name: "milestone/milestone-3" });
    }
    if (key.includes("api") && key.includes("/compare/")) {
      return "12";
    }
    if (key.includes("pr list")) return "[]";
    if (key.includes("pr create")) {
      return "https://github.com/owner/repo/pull/999";
    }
    if (key.includes("issue close")) {
      const num = args.find((a) => /^\d+$/.test(a));
      if (num) closedIssueNumbers.push(Number(num));
      return "";
    }
    return "[]";
  };

  const deps = createMockDeps({ ghCommandFn: ghFn });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  // The duplicate #377 is closed by the self-heal. The canonical #369 is also
  // closed after the summary PR is created (existing #1133 behaviour).
  assertEquals(closedIssueNumbers.includes(377), true);
  assertEquals(closedIssueNumbers.includes(369), true);
});

// --- Integration: premature-tracker disposal -------------------------------

Deno.test("checkAndHandleMilestoneCompletions - closes a premature tracker when the milestone is not complete (Issue #3214)", async () => {
  // A tracker was filed when the milestone momentarily hit 0 open; new real
  // issues were then added, so the milestone is NOT complete. The stale
  // tracker must be closed and no PR/tracker work attempted.
  const closedIssueNumbers: number[] = [];
  const createdIssues: string[] = [];

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.endsWith("/milestones")) {
      return JSON.stringify([{ title: "TPMUM-715", number: 8 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    // A real open issue AND a stale tracker are both open.
    if (key.includes("issue list") && key.includes("--state open")) {
      return JSON.stringify([
        {
          number: 816,
          title: "Merge milestone 'TPMUM-715' to main",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "TPMUM-715" },
          author: { login: "bot" },
          url: "u",
          body: MILESTONE_TRACKING_MARKER,
        },
        {
          number: 820,
          title: "New real work added after the tracker",
          assignees: [],
          labels: [],
          createdAt: "2024-01-02T00:00:00Z",
          milestone: { title: "TPMUM-715" },
          author: { login: "alice" },
          url: "u",
        },
      ]);
    }
    if (key.includes("issue create")) {
      createdIssues.push(key);
      return "x";
    }
    if (key.includes("issue close")) {
      const num = args.find((a) => /^\d+$/.test(a));
      if (num) closedIssueNumbers.push(Number(num));
      return "";
    }
    return "[]";
  };

  const logs: string[] = [];
  const deps = createMockDeps({ ghCommandFn: ghFn, log: (m) => logs.push(m) });
  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.summaryPrsCreated, 0);

  // The premature tracker #816 is closed; no new tracker filed.
  assertEquals(closedIssueNumbers.includes(816), true);
  assertEquals(createdIssues.length, 0);

  const prematureLog = logs.find((l) =>
    l.includes("premature milestone tracking issue #816")
  );
  assertEquals(prematureLog !== undefined, true);
});

// ============================================================================
// Final-PR classification and empty-milestone close-out (Issue #3474)
// ============================================================================

const BRANCH_3474 = createMilestoneBranchName("scan");

interface Scenario3474 {
  /** Value returned for the `number,state,headRefName` PR classification. */
  prs: unknown;
  closedIssues?: boolean;
  branchExists?: boolean;
  tracker?: boolean;
  openIssue?: boolean;
  classifyThrows?: boolean;
  /** Comments on a closed final PR, keyed by PR number (`pr view --json comments`). */
  prComments?: Record<number, string[]>;
  /** PRs the cached all-state branch listing (create-path idempotency) returns. */
  allStatePrs?: unknown[];
  /** An open sync PR into the milestone branch, for #1967 retirement. */
  syncPr?: boolean;
  /** Login that authored the PR comments (default: a fleet login). */
  commentAuthor?: string;
  /** Fleet logins the scan trusts (default `["bot"]`). */
  fleet?: string[];
  /** Milestone `created_at`: a string, or `null` to omit it (default: long ago). */
  createdAt?: string | null;
}

async function run3474(sc: Scenario3474) {
  const calls: string[] = [];
  const patched: number[] = [];
  const order: string[] = [];
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    calls.push(key);
    if (
      sc.syncPr && key.startsWith("pr list") && key.includes("--head sync/")
    ) {
      return JSON.stringify([{
        number: 1957,
        headRefName: `sync/${BRANCH_3474.replace("/", "-")}`,
        baseRefName: BRANCH_3474,
      }]);
    }
    if (key.startsWith("pr close")) {
      order.push(`pr-closed-${args[2]}`);
      return "";
    }
    if (key.startsWith("pr view") && key.includes("--json comments")) {
      const n = Number(args[2]);
      return JSON.stringify({
        comments: (sc.prComments?.[n] ?? []).map((body) => ({
          body,
          author: { login: sc.commentAuthor ?? "bot" },
        })),
      });
    }
    if (key.includes("number,title,headRefName")) {
      return JSON.stringify(sc.allStatePrs ?? []);
    }
    const authoritative = sc.openIssue
      ? authoritativeStub(key, 1, [{
        number: 5,
        title: "real",
        pull_request: null,
      }])
      : authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (args[0] === "api" && args.includes("-X") && args.includes("PATCH")) {
      const match = key.match(/milestones\/(\d+)/);
      if (match) {
        patched.push(Number(match[1]));
        order.push("milestone-patched");
      }
      return "{}";
    }
    if (key.includes("api") && key.endsWith("/milestones")) {
      return JSON.stringify([{
        title: "scan",
        number: 1,
        open_issues: 0,
        ...(sc.createdAt === null
          ? {}
          : { created_at: sc.createdAt ?? "2020-01-01T00:00:00Z" }),
      }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      const open: unknown[] = [];
      if (sc.tracker) {
        open.push({
          number: 1508,
          title: "Merge milestone 'scan' to main",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "scan" },
          author: { login: "bot" },
          url: "u",
          body: MILESTONE_TRACKING_MARKER,
        });
      }
      if (sc.openIssue) {
        open.push({
          number: 5,
          title: "real",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "scan" },
          author: { login: "alice" },
          url: "u",
        });
      }
      return JSON.stringify(open);
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify(
        sc.closedIssues === false
          ? []
          : [{ number: 100, title: "did work", milestone: { title: "scan" } }],
      );
    }
    if (key.includes("api") && key.includes("/branches/")) {
      if (sc.branchExists) return BRANCH_3474;
      throw new Error("Not found");
    }
    if (key.includes("api") && key.includes("/compare/")) return "5";
    if (key.includes("number,state,headRefName")) {
      if (sc.classifyThrows) throw new Error("gh boom");
      return JSON.stringify(sc.prs);
    }
    if (key.includes("issue create")) {
      return "https://github.com/owner/repo/issues/999";
    }
    if (key.includes("pr create")) {
      return "https://github.com/owner/repo/pull/999";
    }
    if (key.includes("issue close")) return "";
    return "[]";
  };
  const logs: string[] = [];
  const result = await checkAndHandleMilestoneCompletions(
    createMockDeps({
      ghCommandFn: ghFn,
      log: (m) => logs.push(m),
      authorOptions: { fleetAuthors: sc.fleet ?? ["bot"] },
    }),
  );
  assertEquals(result.ok, true);
  return {
    calls,
    patched,
    order,
    logs,
    created: calls.filter((c) =>
      c.includes("pr create") || c.includes("issue create")
    ),
    comments: calls.filter((c) =>
      /^(pr|issue) comment /.test(c) && c.includes("closed without merging")
    ),
  };
}

const pr3474 = (
  number: number,
  state?: string,
  head = BRANCH_3474,
  isCrossRepository: unknown = false,
) => ({
  number,
  headRefName: head,
  isCrossRepository,
  ...(state !== undefined ? { state } : {}),
});

Deno.test("close-out - closes a milestone whose only final PR was closed unmerged, commenting on the PR (Issue #3474)", async () => {
  const r = await run3474({ prs: [pr3474(77, "CLOSED")], branchExists: true });
  assertEquals(r.patched, [1]);
  assertEquals(r.comments.length, 1);
  assertStringIncludes(r.comments[0]!, "pr comment 77");
  assertStringIncludes(r.comments[0]!, "#77");
  assertEquals(r.created, []);
});

Deno.test("close-out - abandoned final PR comments on and closes the open tracker (Issue #3474)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    branchExists: true,
    tracker: true,
  });
  assertEquals(r.patched, [1]);
  assertEquals(r.comments.length, 1);
  assertStringIncludes(r.comments[0]!, "issue comment 1508");
  assertStringIncludes(r.comments[0]!, "#77");
  assertEquals(
    r.calls.some((c) => c.startsWith("issue close") && c.includes("1508")),
    true,
  );
  assertEquals(r.created, []);
});

Deno.test("close-out - a failing abandoned-PR comment does not stop the close (Issue #3474)", async () => {
  // A thrown non-Error must still reach the log as its own text.
  for (const thrown of [new Error("comment boom"), "raw comment failure"]) {
    const calls: string[] = [];
    const logs: string[] = [];
    const result = await checkAndHandleMilestoneCompletions(createMockDeps({
      log: (m) => logs.push(m),
      ghCommandFn: async (args: string[]) => {
        const key = args.join(" ");
        calls.push(key);
        const a = authoritativeStub(key);
        if (a !== null) return a;
        if (key.includes("-X PATCH")) return "{}";
        if (key.includes("api") && key.endsWith("/milestones")) {
          return JSON.stringify([{ title: "scan", number: 1 }]);
        }
        if (key.includes(".default_branch")) return "main";
        if (key.includes("issue list") && key.includes("--state closed")) {
          return JSON.stringify([
            { number: 100, title: "w", milestone: { title: "scan" } },
          ]);
        }
        if (key.includes("number,state,headRefName")) {
          return JSON.stringify([pr3474(77, "CLOSED")]);
        }
        if (key.includes("pr comment")) throw thrown;
        return "[]";
      },
    }));
    assertEquals(result.ok, true);
    assertEquals(calls.some((c) => c.includes("-X PATCH")), true);
    const expected = thrown instanceof Error ? thrown.message : thrown;
    assertEquals(
      logs.some((l) =>
        l.includes("Could not comment") && l.includes(`: ${expected} (Issue`)
      ),
      true,
    );
  }
});

Deno.test("close-out - a merged final PR beside a closed one closes the milestone with no comment (Issue #3474)", async () => {
  const r = await run3474({
    prs: [pr3474(80, "CLOSED"), pr3474(81, "MERGED")],
    branchExists: true,
  });
  assertEquals(r.patched, [1]);
  assertEquals(r.comments, []);
  assertEquals(r.created, []);
});

Deno.test("close-out - a merged final PR closes the open tracker (Issue #3474)", async () => {
  const r = await run3474({
    prs: [pr3474(81, "MERGED")],
    branchExists: true,
    tracker: true,
  });
  assertEquals(r.patched, [1]);
  assertEquals(
    r.calls.some((c) => c.startsWith("issue close") && c.includes("1508")),
    true,
  );
  assertEquals(r.created, []);
});

Deno.test("close-out - a merged final PR with an open issue leaves the milestone open (Issue #3474)", async () => {
  const r = await run3474({
    prs: [pr3474(81, "MERGED")],
    branchExists: true,
    openIssue: true,
  });
  assertEquals(r.patched, []);
});

Deno.test("close-out - empty milestone with no branch is closed, not skipped (Issue #3474)", async () => {
  const r = await run3474({ prs: [], closedIssues: false });
  assertEquals(r.patched, [1]);
  assertEquals(r.created, []);
});

Deno.test("close-out - empty milestone with only closed PRs and no branch is closed (Issue #3474)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    closedIssues: false,
  });
  assertEquals(r.patched, [1]);
  assertEquals(r.created, []);
});

Deno.test("close-out - a just-created empty branchless milestone is left for a later scan (PR #3592 review)", async () => {
  const r = await run3474({
    prs: [],
    closedIssues: false,
    createdAt: new Date().toISOString(),
  });
  assertEquals(r.patched, []);
  assertEquals(r.created, []);
  assertEquals(
    r.logs.some((l) => l.includes("leaving it for a later scan")),
    true,
  );
});

Deno.test("close-out - an empty branchless milestone with no usable created_at is left for a later scan (PR #3592 review)", async () => {
  for (const createdAt of [null, "not-a-date"]) {
    const r = await run3474({ prs: [], closedIssues: false, createdAt });
    assertEquals(r.patched, []);
  }
});

Deno.test("close-out - a young milestone WITH closed items is still closed (PR #3592 review)", async () => {
  const r = await run3474({
    prs: [],
    createdAt: new Date().toISOString(),
  });
  assertEquals(r.patched, [1]);
});

Deno.test("isMilestoneYoung - grace window boundaries (PR #3592 review)", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assertEquals(isMilestoneYoung("2026-01-01T11:50:00Z", now), true);
  assertEquals(isMilestoneYoung("2026-01-01T11:45:00Z", now), false);
  assertEquals(isMilestoneYoung("2026-01-01T13:00:00Z", now), true);
  assertEquals(isMilestoneYoung(undefined, now), true);
  assertEquals(isMilestoneYoung("", now), true);
});

Deno.test("close-out - empty milestone with commits ahead is still skipped (Issue #3474)", async () => {
  const r = await run3474({
    prs: [],
    closedIssues: false,
    branchExists: true,
  });
  assertEquals(r.patched, []);
  assertEquals(r.created, []);
});

Deno.test("close-out - open issues keep the milestone open even with a closed final PR (Issue #3474)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    branchExists: true,
    openIssue: true,
  });
  assertEquals(r.patched, []);
  assertEquals(r.comments, []);
});

Deno.test("close-out - an open final PR leaves the milestone open with no comment (Issue #3474)", async () => {
  const r = await run3474({ prs: [pr3474(77, "OPEN")], branchExists: true });
  assertEquals(r.patched, []);
  assertEquals(r.comments, []);
});

Deno.test("close-out - a PR with no state is not treated as abandoned (Issue #3474)", async () => {
  const r = await run3474({ prs: [pr3474(77)], branchExists: true });
  assertEquals(r.patched, []);
  assertEquals(r.comments, []);
});

Deno.test("close-out - a classification failure falls through to the existing flow (Issue #3474)", async () => {
  const r = await run3474({
    prs: [],
    classifyThrows: true,
    branchExists: true,
  });
  assertEquals(r.patched, []);
  assertEquals(r.comments, []);
  assertEquals(
    r.logs.some((l) =>
      l.includes("WARNING") &&
      l.includes("Failed to classify final PRs for milestone branch")
    ),
    true,
  );
  // Execution continued past classification into the normal final-PR flow.
  assertEquals(r.created.length > 0, true);
});

// --- classifyMilestoneFinalPrs ---------------------------------------------

const classify3474 = (out: unknown | (() => never)) =>
  classifyMilestoneFinalPrs(
    "owner/repo",
    BRANCH_3474,
    async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") return '{"comments":[]}';
      assertEquals(
        args.includes("number,state,headRefName,isCrossRepository"),
        true,
      );
      if (typeof out === "function") return (out as () => never)();
      return typeof out === "string" ? out : JSON.stringify(out);
    },
    async () => ["bot"],
  );

Deno.test("classifyMilestoneFinalPrs - merged takes precedence over open and closed (Issue #3474)", async () => {
  const r = await classify3474([
    pr3474(1, "OPEN"),
    pr3474(2, "MERGED"),
    pr3474(3, "CLOSED"),
    pr3474(4, "MERGED"),
  ]);
  assertEquals(r, { ok: true, value: { kind: "merged", prNumber: 4 } });
});

Deno.test("classifyMilestoneFinalPrs - open beats closed (Issue #3474)", async () => {
  const r = await classify3474([pr3474(1, "CLOSED"), pr3474(2, "OPEN")]);
  assertEquals(r, { ok: true, value: { kind: "open", prNumber: 2 } });
});

Deno.test("classifyMilestoneFinalPrs - all closed is abandoned at the highest number (Issue #3474)", async () => {
  const r = await classify3474([pr3474(5, "CLOSED"), pr3474(9, "CLOSED")]);
  assertEquals(r, { ok: true, value: { kind: "abandoned", prNumber: 9 } });
});

Deno.test("classifyMilestoneFinalPrs - none when there are no PRs (Issue #3474)", async () => {
  assertEquals(await classify3474([]), { ok: true, value: { kind: "none" } });
});

Deno.test("classifyMilestoneFinalPrs - a missing or unknown state fails safe to none (Issue #3474)", async () => {
  assertEquals(await classify3474([pr3474(5), pr3474(6, "CLOSED")]), {
    ok: true,
    value: { kind: "none" },
  });
  assertEquals(await classify3474([pr3474(5, "WEIRD")]), {
    ok: true,
    value: { kind: "none" },
  });
});

Deno.test("classifyMilestoneFinalPrs - ignores PRs on other head branches (Issue #3474)", async () => {
  const r = await classify3474([pr3474(5, "MERGED", "milestone/other")]);
  assertEquals(r, { ok: true, value: { kind: "none" } });
});

Deno.test("classifyMilestoneFinalPrs - errors on bad JSON, non-array output or a gh failure (Issue #3474)", async () => {
  for (
    const out of ["not json", "{}", () => {
      throw new Error("gh boom");
    }]
  ) {
    const r = await classify3474(out);
    assertEquals(r.ok, false);
    if (!r.ok) {
      assertStringIncludes(
        r.error.message,
        "Failed to classify final PRs for milestone branch",
      );
    }
  }
});

Deno.test("classifyMilestoneFinalPrs - a thrown non-Error is reported by its own text (Issue #3474)", async () => {
  const r = await classify3474(() => {
    throw "raw gh failure";
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertStringIncludes(r.error.message, ": raw gh failure");
});

// ============================================================================
// Write-phase identity guard (Issue #3528)
// ============================================================================

/**
 * A gh mock that reports a complete milestone (so the write path would fire)
 * and records every write (issue/PR create, issue close). Used to prove the
 * identity guard refuses to write on a mismatch.
 */
function completeMilestoneGhFn(writes: string[]) {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return authoritative;

    if (key.includes("api") && key.includes("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Add login", milestone: { title: "v1.0" } },
      ]);
    }
    if (key.includes("issue list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("pr list")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      writes.push("issue create");
      return "https://github.com/owner/repo/issues/300";
    }
    if (key.includes("pr create")) {
      writes.push("pr create");
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) {
      writes.push("issue close");
      return "";
    }
    return "[]";
  };
}

Deno.test("checkAndHandleMilestoneCompletions - refuses ALL writes when live login is not a service account (Issue #3528)", async () => {
  const writes: string[] = [];
  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: completeMilestoneGhFn(writes),
    serviceAccounts: ["stsvcbot", "Vibecoderbot"],
    // gh auth has drifted to a human personal token mid-run.
    resolveActualLogin: () => Promise.resolve("maintainer"),
    hostname: () => "host-drifted",
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);

  // Fail loud: ok=false, and NOT a single write was performed.
  assertEquals(result.ok, false);
  assertEquals(writes.length, 0);
  // The refusal message self-identifies the host and the offending login.
  const joined = logs.join("\n");
  assertStringIncludes(joined, "MISMATCH");
  assertStringIncludes(joined, "host-drifted");
  assertStringIncludes(joined, "maintainer");
});

Deno.test("checkAndHandleMilestoneCompletions - proceeds when live login is an allowed service account (Issue #3528)", async () => {
  const writes: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: completeMilestoneGhFn(writes),
    serviceAccounts: ["stsvcbot", "Vibecoderbot"],
    resolveActualLogin: () => Promise.resolve("stsvcbot"),
    hostname: () => "host-ok",
  });

  const result = await checkAndHandleMilestoneCompletions(deps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summaryPrsCreated, 1);
  }
  // The full write path ran once the identity check passed.
  assertStringIncludes(writes.join(","), "pr create");
});

Deno.test("checkAndHandleMilestoneCompletions - inactive allowlist skips the re-check and proceeds (Issue #3528)", async () => {
  const writes: string[] = [];
  let resolveCalled = false;
  const deps = createMockDeps({
    ghCommandFn: completeMilestoneGhFn(writes),
    // No service accounts configured — guard inactive.
    serviceAccounts: [],
    resolveActualLogin: () => {
      resolveCalled = true;
      return Promise.resolve("anyone");
    },
  });

  const result = await checkAndHandleMilestoneCompletions(deps);

  assertEquals(result.ok, true);
  // The re-check is skipped entirely when the allowlist is inactive.
  assertEquals(resolveCalled, false);
  assertStringIncludes(writes.join(","), "pr create");
});

Deno.test("checkAndHandleMilestoneCompletions - unresolved live login under an active allowlist refuses writes (Issue #3528)", async () => {
  const writes: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: completeMilestoneGhFn(writes),
    serviceAccounts: ["stsvcbot"],
    // gh could not resolve a login at write time.
    resolveActualLogin: () => Promise.resolve(null),
    hostname: () => "host-x",
  });

  const result = await checkAndHandleMilestoneCompletions(deps);

  assertEquals(result.ok, false);
  assertEquals(writes.length, 0);
});

// ============================================================================
// Authoritative open-children veto (Issue #3908)
// ============================================================================

/**
 * A gh mock whose *cached* view says the milestone is complete (no open issues
 * in the `issue list` batch) while GitHub's authoritative reads are supplied by
 * the caller. This is the milestone-53 shape: the cached projection read zero
 * while 12 children were still open.
 */
function vetoScenarioGhFn(
  writes: string[],
  authoritative: (key: string) => string | null,
) {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    const authored = authoritative(key);
    if (authored !== null) return authored;

    if (key.includes("api") && key.endsWith("/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1, open_issues: 0 }]);
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return "main";
    }
    // Cached open-issue batch — empty, i.e. "milestone complete".
    if (key.includes("issue list") && key.includes("--state open")) {
      return "[]";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return JSON.stringify([
        { number: 10, title: "Add login", milestone: { title: "v1.0" } },
      ]);
    }
    if (key.includes("issue list") && key.includes("--state all")) {
      return "[]";
    }
    if (key.includes("pr list")) {
      return "[]";
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return JSON.stringify({ name: "milestone/v1-0" });
    }
    if (key.includes("issue create")) {
      writes.push("issue create");
      return "https://github.com/owner/repo/issues/300";
    }
    if (key.includes("pr create")) {
      writes.push("pr create");
      return "https://github.com/owner/repo/pull/301";
    }
    if (key.includes("issue close")) {
      writes.push("issue close");
      return "";
    }
    if (key.includes("-X PATCH") && key.includes("/milestones/")) {
      writes.push("milestone close");
      return "";
    }
    return "[]";
  };
}

Deno.test("Issue #3908 - open children per GitHub veto finalisation even when the cached list reads zero", async () => {
  // The milestone-53 regression: `fetchOpenIssuesByMilestone` returned an
  // empty list while 12 children were still open. Fails against the unfixed
  // code, which created a tracker and a summary PR.
  const writes: string[] = [];
  const logs: string[] = [];
  const openChildren = [
    3875,
    3876,
    3878,
    3879,
    3880,
    3881,
    3882,
    3883,
    3884,
    3885,
    3886,
    3887,
  ].map((number) => ({ number, title: `Child ${number}` }));

  const deps = createMockDeps({
    ghCommandFn: vetoScenarioGhFn(
      writes,
      (key) => authoritativeStub(key, openChildren.length, openChildren),
    ),
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.summaryPrsCreated, 0);
  // No tracker, no summary PR, no milestone close.
  assertEquals(writes, []);

  const joined = logs.join("\n");
  assertStringIncludes(joined, "is NOT complete");
  assertStringIncludes(joined, "#3875");
  assertStringIncludes(joined, "#3887");
  // The disagreement between the two sources is logged loudly with both
  // counts and both issue-number sets.
  assertStringIncludes(joined, "WARNING: Open-children disagreement");
  assertStringIncludes(joined, "GitHub reports 12");
  assertStringIncludes(joined, "cached issue list reports 0");
});

Deno.test("Issue #3908 - an open child PR vetoes finalisation", async () => {
  // #3906: merging the summary PR deletes the milestone branch, which
  // auto-closes any in-flight child PR still targeting it.
  const writes: string[] = [];
  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: vetoScenarioGhFn(writes, (key) =>
      authoritativeStub(key, 1, [
        { number: 3901, title: "Fix the scan", pull_request: { url: "u" } },
      ])),
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);

  assertEquals(result.ok, true);
  assertEquals(writes, []);
  assertStringIncludes(logs.join("\n"), "#3901");
});

Deno.test("Issue #3908 - both sources read zero, so the milestone finalises", async () => {
  const writes: string[] = [];
  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: vetoScenarioGhFn(writes, (key) => authoritativeStub(key, 0)),
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.summaryPrsCreated, 1);
  assertStringIncludes(writes.join(","), "issue create");
  assertStringIncludes(writes.join(","), "pr create");
  // Agreement — no disagreement warning.
  assertEquals(
    logs.some((l) => l.includes("Open-children disagreement")),
    false,
  );
});

Deno.test("Issue #3908 - the milestone's own tracking issue is not an open child", async () => {
  // Issue #3214's self-blocking fix is preserved: a tracker is the only open
  // child, so the milestone still finalises.
  const writes: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: vetoScenarioGhFn(writes, (key) =>
      authoritativeStub(key, 1, [
        {
          number: 300,
          title: "Merge milestone 'v1.0' to main",
          body: MILESTONE_TRACKING_MARKER,
          // The REST child listing names the opener `user` (Issue #1246).
          user: { login: "bot" },
        },
      ])),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.summaryPrsCreated, 1);
  assertStringIncludes(writes.join(","), "pr create");
});

Deno.test("Issue #3908 - an unreadable authoritative count vetoes rather than passing", async () => {
  const writes: string[] = [];
  const logs: string[] = [];
  const deps = createMockDeps({
    ghCommandFn: vetoScenarioGhFn(writes, (key) => {
      if (/api repos\/[^ ]+\/milestones\/\d+$/.test(key)) {
        throw new Error("gh: 502 Bad Gateway");
      }
      if (key.includes("/issues?milestone=")) return "[]";
      return null;
    }),
    log: (msg) => logs.push(msg),
  });

  const result = await checkAndHandleMilestoneCompletions(deps);

  assertEquals(result.ok, true);
  assertEquals(writes, []);
  assertStringIncludes(logs.join("\n"), "refusing to finalise");
});

// ============================================================================
// Milestone deadlock: partial rollup wiring (Issue #2835)
// ============================================================================

const DEADLOCK_REPO = "owner/repo";

/** A FilterableIssue-shaped open issue for the deadlock graph fixtures. */
function deadlockOpenIssue(
  number: number,
  milestoneTitle: string,
  body: string,
) {
  return {
    number,
    title: `Issue #${number}`,
    assignees: [],
    labels: [],
    createdAt: "2024-01-01T00:00:00Z",
    milestone: { title: milestoneTitle },
    author: { login: "alice" },
    url: `https://github.com/owner/repo/issues/${number}`,
    body,
  };
}

/**
 * GRQ-AutoTrader-shaped deadlock: #1459 (milestone "Crates API") depends on
 * closed #1456 (milestone "Web src"); #1460 and #1461 (both "Web src")
 * transitively depend on #1459. "Web src" is deadlocked — it cannot close
 * until #1459 lands, and #1459 is held behind #1456 in "Web src" itself.
 */
const DEADLOCK_OPEN_ISSUES = [
  deadlockOpenIssue(1459, "Crates API", "Depends on #1456"),
  deadlockOpenIssue(1460, "Web src", "Depends on #1459"),
  deadlockOpenIssue(1461, "Web src", "Depends on #1460"),
];
const DEADLOCK_CLOSED_ISSUES = [
  { number: 1456, title: "Closed dependency", milestone: { title: "Web src" } },
];
const DEADLOCK_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const DEADLOCK_SNAPSHOT_PREFIX = "partial-rollup/web-src-abcdef1";

interface DeadlockScenarioOptions {
  openPartialRollupPrs?: unknown[];
  behindBy?: number;
  aheadBy?: number;
  /** Files the milestone tip changes against default (compare `.files`). */
  filesChanged?: number;
  mergedPartialRollupPrs?: unknown[];
  gitRefThrows?: boolean;
}

/**
 * Scripted `gh` for both open milestones "Crates API" (#1) and "Web src"
 * (#2), incomplete (so the normal per-milestone path does nothing), plus the
 * partial-rollup calls the deadlock scan drives afterwards.
 */
function scriptDeadlockGh(
  options: DeadlockScenarioOptions = {},
): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  const behindBy = options.behindBy ?? 0;
  const aheadBy = options.aheadBy ?? 3;
  const filesChanged = options.filesChanged ?? 5;
  const mergedPartialRollupPrs = options.mergedPartialRollupPrs ?? [];
  const openPartialRollupPrs = options.openPartialRollupPrs ?? [];

  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.join(" ");

    if (key.includes("api") && /\/milestones$/.test(key)) {
      return Promise.resolve(
        JSON.stringify([
          { title: "Crates API", number: 1 },
          { title: "Web src", number: 2 },
        ]),
      );
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return Promise.resolve("main");
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      return Promise.resolve(JSON.stringify(DEADLOCK_OPEN_ISSUES));
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return Promise.resolve(JSON.stringify(DEADLOCK_CLOSED_ISSUES));
    }
    // Partial-rollup idempotency check.
    if (
      key.includes("pr list") && key.includes("--state open") &&
      key.includes("vibe-partial-rollup")
    ) {
      return Promise.resolve(JSON.stringify(openPartialRollupPrs));
    }
    if (
      key.includes("pr list") && key.includes("--state merged") &&
      key.includes("vibe-partial-rollup")
    ) {
      return Promise.resolve(JSON.stringify(mergedPartialRollupPrs));
    }
    if (
      key.includes("api") && key.includes("/git/ref/heads/milestone/web-src")
    ) {
      if (options.gitRefThrows) {
        return Promise.reject(new Error("Not Found (HTTP 404)"));
      }
      return Promise.resolve(`${DEADLOCK_SHA}\n`);
    }
    if (key.includes("api") && key.includes("/compare/main...")) {
      return Promise.resolve(
        JSON.stringify({
          behind_by: behindBy,
          ahead_by: aheadBy,
          files: filesChanged,
        }),
      );
    }
    if (
      key.includes("-X") && key.includes("POST") && key.includes("/git/refs")
    ) {
      return Promise.resolve("{}");
    }
    if (key.includes("pr create")) {
      return Promise.resolve(`https://github.com/${DEADLOCK_REPO}/pull/501`);
    }
    // Arming path (Issue #4375 base protection, then `pr merge --auto`).
    if (key.includes("/rules/branches/")) {
      return Promise.resolve("required_status_checks");
    }
    if (key.includes("pr merge")) {
      return Promise.resolve("");
    }
    if (key.includes("pr comment")) return Promise.resolve("");
    if (key.includes("/comments")) return Promise.resolve("[]");
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

function prCreateCalls(calls: string[][]): string[][] {
  return calls.filter((a) => a[0] === "pr" && a[1] === "create");
}
function refPostCalls(calls: string[][]): string[][] {
  return calls.filter((a) =>
    a[0] === "api" && a[1] === "-X" && a[2] === "POST" &&
    (a[3] ?? "").includes("/git/refs")
  );
}
function mergeAutoCalls(calls: string[][]): string[][] {
  return calls.filter((a) =>
    a[0] === "pr" && a[1] === "merge" && a.includes("--auto")
  );
}

Deno.test("milestone deadlock rollup - a deadlock raises a partial rollup and arms it", async () => {
  _resetBaseProtectionMemo();
  const { gh, calls } = scriptDeadlockGh();
  const logs: string[] = [];
  const deps = createMockDeps({ ghCommandFn: gh, log: (m) => logs.push(m) });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.summaryPrsCreated, 0);

  const creates = prCreateCalls(calls);
  assertEquals(creates.length, 1);
  const created = creates[0]!;
  const head = created[created.indexOf("--head") + 1]!;
  const base = created[created.indexOf("--base") + 1]!;
  const body = created[created.indexOf("--body") + 1]!;
  assertStringIncludes(head, "partial-rollup/web-src-");
  assertEquals(base, "main");
  assertFalse(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b\s*#\d/i.test(body));
  assertStringIncludes(body, partialRollupMarker("Web src"));

  const merges = mergeAutoCalls(calls);
  assertEquals(merges.length, 1);
  assertEquals(merges[0]!.includes("501"), true);

  // No summary PR / tracking issue for either milestone — both remain
  // incomplete, and this was a partial rollup, not a full one.
  assertEquals(calls.some((a) => a[0] === "issue" && a[1] === "create"), false);
});

Deno.test("milestone deadlock rollup - an open partial rollup is reused, not recreated", async () => {
  _resetBaseProtectionMemo();
  const { gh, calls } = scriptDeadlockGh({
    openPartialRollupPrs: [
      {
        number: 601,
        headRefName: `${DEADLOCK_SNAPSHOT_PREFIX}`,
        headRefOid: DEADLOCK_SHA,
        body: partialRollupMarker("Web src"),
        author: { login: "bot" },
      },
    ],
  });
  const deps = createMockDeps({ ghCommandFn: gh });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(refPostCalls(calls).length, 0);
});

Deno.test("milestone deadlock rollup - a milestone behind default is deferred, not rolled up", async () => {
  _resetBaseProtectionMemo();
  const { gh, calls } = scriptDeadlockGh({ behindBy: 3 });
  const logs: string[] = [];
  const deps = createMockDeps({ ghCommandFn: gh, log: (m) => logs.push(m) });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(refPostCalls(calls).length, 0);
  assertStringIncludes(logs.join("\n"), "behind");
});

Deno.test("milestone deadlock rollup - a deadlock still present after its partial rollup merged and synced raises no empty rollup", async () => {
  _resetBaseProtectionMemo();
  // The earlier partial rollup squash-merged and the sync landed it back into
  // the milestone: level with main, 4 commits ahead, no file changes.
  const { gh, calls } = scriptDeadlockGh({
    behindBy: 0,
    aheadBy: 4,
    filesChanged: 0,
    mergedPartialRollupPrs: [
      {
        number: 601,
        headRefName: "partial-rollup/web-src-1234567",
        headRefOid: "1234567000000000000000000000000000000000",
        body: partialRollupMarker("Web src"),
        author: { login: "bot" },
      },
    ],
  });
  const deps = createMockDeps({ ghCommandFn: gh });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);

  assertEquals(refPostCalls(calls).length, 0);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(mergeAutoCalls(calls).length, 0);
});

Deno.test("milestone deadlock rollup - a failed partial rollup for one milestone does not abort the scan", async () => {
  _resetBaseProtectionMemo();
  const { gh } = scriptDeadlockGh({ gitRefThrows: true });
  const logs: string[] = [];
  const deps = createMockDeps({ ghCommandFn: gh, log: (m) => logs.push(m) });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  assertStringIncludes(logs.join("\n"), "WARNING");
});

Deno.test("milestone deadlock rollup - the final rollup still fires after a merged partial rollup, with no new partial rollup", async () => {
  _resetBaseProtectionMemo();
  const MILESTONE = "Web src";
  const BRANCH = "milestone/web-src";
  const closedIssues = [
    {
      number: 1456,
      title: "Closed dependency",
      milestone: { title: MILESTONE },
    },
    { number: 1460, title: "Landed work", milestone: { title: MILESTONE } },
    {
      number: 1461,
      title: "More landed work",
      milestone: { title: MILESTONE },
    },
  ];
  // The deadlock's earlier partial rollup, now merged.
  const mergedPartialRollup = [{
    number: 601,
    headRefName: "partial-rollup/web-src-abcdef1",
    headRefOid: DEADLOCK_SHA,
    body: partialRollupMarker(MILESTONE),
    author: { login: "bot" },
  }];
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.join(" ");
    const authoritative = authoritativeStub(key);
    if (authoritative !== null) return Promise.resolve(authoritative);

    if (key.includes("api") && /\/milestones$/.test(key)) {
      return Promise.resolve(
        JSON.stringify([{ title: MILESTONE, number: 2 }]),
      );
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return Promise.resolve("main");
    }
    // No open issues remain anywhere — the milestone is complete, and the
    // deadlock scan finds nothing to hold.
    if (key.includes("issue list") && key.includes("--state open")) {
      return Promise.resolve("[]");
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return Promise.resolve(JSON.stringify(closedIssues));
    }
    // The partial rollup's own idempotency search — merged, and no open one.
    if (key.includes("pr list") && key.includes("vibe-partial-rollup")) {
      return Promise.resolve(
        key.includes("--state merged")
          ? JSON.stringify(mergedPartialRollup)
          : "[]",
      );
    }
    if (key.includes("pr list") && key.includes("--state all")) {
      return Promise.resolve("[]");
    }
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return Promise.resolve(JSON.stringify({ name: BRANCH }));
    }
    if (key.includes("api") && key.includes("/compare/")) {
      return Promise.resolve(JSON.stringify({ ahead_by: 5, behind_by: 0 }));
    }
    if (key.includes("issue create")) {
      return Promise.resolve(`https://github.com/owner/repo/issues/900`);
    }
    if (key.includes("pr create")) {
      return Promise.resolve(`https://github.com/owner/repo/pull/501`);
    }
    if (key.includes("issue close")) return Promise.resolve("");
    if (key.includes("/rules/branches/")) {
      return Promise.resolve("required_status_checks");
    }
    if (key.includes("pr merge")) return Promise.resolve("");
    if (key.includes("pr comment")) return Promise.resolve("");
    if (key.includes("/comments")) return Promise.resolve("[]");
    return Promise.resolve("[]");
  };
  const deps = createMockDeps({ ghCommandFn: gh });

  const result = await checkAndHandleMilestoneCompletions(deps);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.summaryPrsCreated, 1);

  const creates = prCreateCalls(calls);
  assertEquals(creates.length, 1);
  const created = creates[0]!;
  assertEquals(created[created.indexOf("--head") + 1], BRANCH);
  assertEquals(created[created.indexOf("--base") + 1], "main");
  assertEquals(refPostCalls(calls).length, 0);
});

// --- PR #3478 review of #3474: forks, roll-back closes, sync-PR retirement ---

Deno.test("close-out - a closed fork-headed PR reusing the branch name does not close the milestone (Issue #3474, #1124)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED", BRANCH_3474, true)],
    branchExists: true,
  });
  assertEquals(r.comments, []);
  assert(!r.patched.includes(1), "a fork's PR must never close the milestone");
  assert(
    r.created.some((c) => c.includes("pr create")),
    "with no same-repo final PR, the real final PR is raised",
  );
});

Deno.test("close-out - a PR whose isCrossRepository is not exactly false is ignored (Issue #3474, #1124)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED", BRANCH_3474, null)],
    branchExists: true,
  });
  assertEquals(r.comments, []);
  assert(!r.patched.includes(1));
});

Deno.test("close-out - a final PR the fleet's roll-back closed is superseded: a fresh final PR is raised, the milestone stays open (Issue #3474, #1781)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    branchExists: true,
    prComments: {
      77: [rollbackCloseCommentForTest("milestone/scan", "abc1234", 12)],
    },
    allStatePrs: [{
      number: 77,
      title: "Milestone: scan",
      headRefName: BRANCH_3474,
    }],
  });
  assertEquals(r.comments, [], "no 'closed without merging' close-out");
  assert(!r.patched.includes(1), "the milestone stays open");
  assert(
    r.created.some((c) => c.includes("pr create")),
    "a fresh final PR is raised despite the closed one",
  );
});

Deno.test("close-out - a roll-back close from before the marker existed (prose only) is also superseded (Issue #3474, #1781)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    branchExists: true,
    prComments: {
      77: [
        "Closed by a milestone roll-back of `milestone/scan` (reverted PR #12, revert `abc123`) (Issue #1781).",
      ],
    },
  });
  assertEquals(r.comments, []);
  assert(!r.patched.includes(1));
});

Deno.test("close-out - a final PR closed by hand, with no roll-back comment, is still abandoned (Issue #3474)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    branchExists: true,
    prComments: { 77: ["Closing: nothing left to land."] },
  });
  assertEquals(r.patched, [1]);
  assertEquals(r.comments.length, 1);
});

Deno.test("close-out - a roll-back close comment posted by a non-fleet account is ignored: the final PR stays abandoned, no PR is raised (PR #3592 review)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    branchExists: true,
    commentAuthor: "outsider",
    prComments: {
      77: [
        rollbackCloseCommentForTest("milestone/scan", "abc1234", 12),
        "Closed by a milestone roll-back of `milestone/scan` (reverted PR #12).",
      ],
    },
    allStatePrs: [{
      number: 77,
      title: "Milestone: scan",
      headRefName: BRANCH_3474,
    }],
  });
  assertEquals(r.patched, [1], "abandoned close-out closes the milestone");
  assertEquals(r.comments.length, 1);
  assert(
    !r.calls.some((c) => c.includes("pr create")),
    "an outsider's comment must never get a fresh final PR raised",
  );
});

Deno.test("close-out - an unresolved fleet set classes a roll-back-commented final PR as neither abandoned nor superseded (PR #3592 review)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    branchExists: true,
    fleet: [],
    prComments: {
      77: [rollbackCloseCommentForTest("milestone/scan", "abc1234", 12)],
    },
    allStatePrs: [{
      number: 77,
      title: "Milestone: scan",
      headRefName: BRANCH_3474,
    }],
  });
  assertEquals(r.patched, [], "the milestone is not closed");
  assertEquals(r.comments, []);
  assert(
    !r.calls.some((c) => c.includes("pr create")),
    "no fresh final PR is raised on an unattributable comment",
  );
  assert(
    r.logs.some((l) =>
      l.includes("WARNING") && l.includes("fleet author set unresolved")
    ),
    "the unresolved fleet set is logged loudly",
  );
});

Deno.test("close-out - the superseded arm retires an open sync PR before the fresh final PR is raised (PR #3592 review, #1967)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    branchExists: true,
    syncPr: true,
    prComments: {
      77: [rollbackCloseCommentForTest("milestone/scan", "abc1234", 12)],
    },
    allStatePrs: [{
      number: 77,
      title: "Milestone: scan",
      headRefName: BRANCH_3474,
    }],
  });
  const closeAt = r.calls.findIndex((c) => c.startsWith("pr close 1957"));
  const createAt = r.calls.findIndex((c) => c.includes("pr create"));
  assert(closeAt >= 0, "the sync PR is retired");
  assert(createAt >= 0, "the fresh final PR is raised");
  assert(closeAt < createAt, "sync PR retired before the final PR is raised");
  assertEquals(r.patched, []);
});

Deno.test("close-out - the merged arm retires an open sync PR before closing the milestone (Issue #3474, #1967)", async () => {
  const r = await run3474({
    prs: [pr3474(81, "MERGED")],
    branchExists: true,
    syncPr: true,
  });
  assertEquals(r.order, ["pr-closed-1957", "milestone-patched"]);
});

Deno.test("close-out - the abandoned arm retires an open sync PR before closing the milestone (Issue #3474, #1967)", async () => {
  const r = await run3474({
    prs: [pr3474(77, "CLOSED")],
    branchExists: true,
    syncPr: true,
  });
  assertEquals(r.order, ["pr-closed-1957", "milestone-patched"]);
});
