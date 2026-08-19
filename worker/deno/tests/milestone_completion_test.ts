/**
 * Tests for milestone completion detection and tracking issue creation.
 *
 * Issue #1106: Milestone completion issue creation regression.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMilestoneSummaryBody,
  checkAndHandleMilestoneCompletions,
  checkMilestoneComplete,
  closeGitHubMilestone,
  getOpenMilestoneTrackers,
  hasExistingMilestoneSummaryPr,
  hasExistingMilestoneTrackingIssue,
  hasNothingToMerge,
  isMilestoneTrackingTitle,
  isSummaryPrMerged,
  type MilestoneCompletionDeps,
  selectDuplicateTrackersToClose,
} from "../lib/milestone_completion.ts";

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

  const result = await checkMilestoneComplete("owner/repo", "v1.0", ghFn);
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

  const result = await checkMilestoneComplete("owner/repo", "v1.0", ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("checkMilestoneComplete - returns error on gh failure", async () => {
  const ghFn = async (_args: string[]): Promise<string> => {
    throw new Error("API error");
  };

  const result = await checkMilestoneComplete("owner/repo", "v1.0", ghFn);
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
        { number: 200, title: "Merge milestone 'v1.0' to main" },
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
        { number: 250, title: "Merge milestone 'Milestone 3' to Develop" },
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
        { number: 260, title: "Merge milestone 'Milestone 4 (old)' to main" },
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
        { number: 410, title: "Merge milestone 'M5' to Develop" },
        { number: 401, title: "Merge milestone 'M5' to Develop" },
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
        { number: 250, title: "Merge milestone 'Milestone 3' to Develop" },
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
        { number: 200, title: "Merge milestone 'v1.0' to main" },
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
        },
      ]);
    }
    return "[]";
  };

  const result = await checkMilestoneComplete("owner/repo", "scan", ghFn);
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

  const result = await checkMilestoneComplete("owner/repo", "scan", ghFn);
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
        { number: 369, title: "Merge milestone 'Milestone 3' to main" },
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
    serviceAccounts: ["stsvcbot", "VibeCoderBot"],
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
    serviceAccounts: ["stsvcbot", "VibeCoderBot"],
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
        { number: 300, title: "Merge milestone 'v1.0' to main" },
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
