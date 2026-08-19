/**
 * Tests for issue_filter.ts (Issue #910).
 */

import { assertEquals } from "@std/assert";
import {
  filterAndSort,
  filterByAllowedAuthors,
  filterByAssignee,
  getFilterDiagnostics,
  getStaleLabelsForReopenedIssue,
  isMilestoneOccupied,
  isMilestoneTrackingIssue,
  MILESTONE_TRACKING_MARKER,
  wasReopenedAfterLabel,
} from "../lib/issue_filter.ts";
import type { FilterableIssue, FilterLabels } from "../lib/issue_filter.ts";

function makeIssue(overrides: Partial<FilterableIssue> = {}): FilterableIssue {
  return {
    number: 1,
    title: "Test issue",
    url: "https://github.com/owner/repo/issues/1",
    author: "testuser",
    assignees: [],
    labels: [],
    createdAt: "2024-01-01T00:00:00Z",
    milestone: "",
    ...overrides,
  };
}

const defaultFilterLabels: FilterLabels = {
  failedLabel: "failed",
  needsRevisionLabel: "needs-revision",
  refineIssueLabel: "refine-issue",
  planningLabel: "planning",
  questionLabel: "question",
  needsHumanLabel: "needs-human",
};

// =============================================================================
// filterByAssignee tests
// =============================================================================

Deno.test("issue_filter - filterByAssignee keeps unassigned issues", () => {
  const issues = [
    makeIssue({ number: 1, assignees: [] }),
    makeIssue({ number: 2, assignees: ["other-user"] }),
    makeIssue({ number: 3, assignees: [] }),
  ];
  const result = filterByAssignee(issues);
  assertEquals(result.length, 2);
  assertEquals(result[0]?.number, 1);
  assertEquals(result[1]?.number, 3);
});

Deno.test("issue_filter - filterByAssignee returns empty for all assigned", () => {
  const issues = [
    makeIssue({ number: 1, assignees: ["user1"] }),
    makeIssue({ number: 2, assignees: ["user2"] }),
  ];
  assertEquals(filterByAssignee(issues).length, 0);
});

// =============================================================================
// isMilestoneOccupied tests
// =============================================================================

Deno.test("issue_filter - isMilestoneOccupied returns false when no issues assigned", () => {
  const issues = [
    makeIssue({ milestone: "v1.0", assignees: [] }),
    makeIssue({ milestone: "v1.0", assignees: [] }),
  ];
  assertEquals(isMilestoneOccupied(issues, "v1.0", "worker-bot"), false);
});

Deno.test("issue_filter - isMilestoneOccupied returns true when worker has assigned issue", () => {
  const issues = [
    makeIssue({ milestone: "v1.0", assignees: ["worker-bot"] }),
    makeIssue({ milestone: "v2.0", assignees: [] }),
  ];
  assertEquals(isMilestoneOccupied(issues, "v1.0", "worker-bot"), true);
  assertEquals(isMilestoneOccupied(issues, "v2.0", "worker-bot"), false);
});

Deno.test("issue_filter - isMilestoneOccupied ignores human-assigned issues", () => {
  // Human assignments must not block the milestone — the occupancy check
  // exists to prevent the worker from creating multiple PRs per milestone,
  // not to wait on humans. This was the root cause of tp-web-react
  // DEFECT_AND_REFINEMENT issues not being picked up: 5 human-assigned
  // issues blocked all 15 unassigned work-on issues.
  const issues = [
    makeIssue({ milestone: "D&R", assignees: ["CDelSTSW"] }),
    makeIssue({ milestone: "D&R", assignees: ["maintainer"] }),
    makeIssue({ milestone: "D&R", assignees: [] }),
  ];
  assertEquals(isMilestoneOccupied(issues, "D&R", "worker-bot"), false);
});

Deno.test("issue_filter - isMilestoneOccupied blocks default branch when worker has assigned issue", () => {
  // The worker serialises work on the default branch too — if it already
  // has an assigned non-milestone issue, don't pick up another one.
  const issues = [
    makeIssue({ milestone: "", assignees: ["worker-bot"] }),
    makeIssue({ milestone: "v1.0", assignees: [] }),
  ];
  assertEquals(isMilestoneOccupied(issues, "", "worker-bot"), true);
  assertEquals(isMilestoneOccupied(issues, "v1.0", "worker-bot"), false);
});

Deno.test("issue_filter - isMilestoneOccupied ignores human-assigned non-milestone issues", () => {
  // Human assignments on the default branch must not block the worker,
  // same as for milestones.
  const issues = [
    makeIssue({ milestone: "", assignees: ["maintainer"] }),
    makeIssue({ milestone: "", assignees: ["CDelSTSW"] }),
  ];
  assertEquals(isMilestoneOccupied(issues, "", "worker-bot"), false);
});

Deno.test("issue_filter - isMilestoneOccupied only blocks same milestone", () => {
  const issues = [
    makeIssue({ milestone: "Easter", assignees: ["worker-bot"] }),
    makeIssue({ milestone: "", assignees: ["dev2"] }),
    makeIssue({ milestone: "Sprint-1", assignees: [] }),
  ];
  assertEquals(isMilestoneOccupied(issues, "Easter", "worker-bot"), true);
  assertEquals(isMilestoneOccupied(issues, "Sprint-1", "worker-bot"), false);
  assertEquals(isMilestoneOccupied(issues, "", "worker-bot"), false);
});

// -----------------------------------------------------------------------------
// isMilestoneOccupied — fleet-awareness (Issue #3099)
// -----------------------------------------------------------------------------

Deno.test("issue_filter - isMilestoneOccupied is occupied when assigned to another fleet account", () => {
  // The current host is VibeCoderBot; another fleet host (stsvcbot) already
  // holds an issue in the same milestone. The work stream must read as
  // occupied so this host does not start the same issue (duplicate PRs).
  const issues = [
    makeIssue({ milestone: "v1.0", assignees: ["stsvcbot"] }),
  ];
  assertEquals(
    isMilestoneOccupied(issues, "v1.0", "VibeCoderBot", [
      "VibeCoderBot",
      "stsvcbot",
    ]),
    true,
  );
});

Deno.test("issue_filter - isMilestoneOccupied is occupied when assigned to the current worker (fleet set)", () => {
  // Regression: the current worker's own assignment must still occupy even
  // when the fleet-account set is supplied.
  const issues = [
    makeIssue({ milestone: "v1.0", assignees: ["VibeCoderBot"] }),
  ];
  assertEquals(
    isMilestoneOccupied(issues, "v1.0", "VibeCoderBot", [
      "VibeCoderBot",
      "stsvcbot",
    ]),
    true,
  );
});

Deno.test("issue_filter - isMilestoneOccupied not occupied when assigned only to a non-fleet human", () => {
  // A human assigning themselves must not occupy the work stream — only
  // fleet logins count.
  const issues = [
    makeIssue({ milestone: "v1.0", assignees: ["maintainer"] }),
    makeIssue({ milestone: "v1.0", assignees: ["CDelSTSW"] }),
  ];
  assertEquals(
    isMilestoneOccupied(issues, "v1.0", "VibeCoderBot", [
      "VibeCoderBot",
      "stsvcbot",
    ]),
    false,
  );
});

Deno.test("issue_filter - isMilestoneOccupied fleet match is case-insensitive", () => {
  const issues = [
    makeIssue({ milestone: "v1.0", assignees: ["stsvcbot"] }),
  ];
  assertEquals(
    isMilestoneOccupied(issues, "v1.0", "VibeCoderBot", [
      "VibeCoderBot",
      "stsvcbot",
    ]),
    true,
  );
});

// =============================================================================
// filterAndSort tests
// =============================================================================

Deno.test("issue_filter - filterAndSort excludes blocking labels", () => {
  // Issue #2031: needs-clarification retired; needs-human is the blocking
  // handoff label.
  const issues = [
    makeIssue({ number: 1, labels: ["bug"] }),
    makeIssue({ number: 2, labels: ["failed"] }),
    makeIssue({ number: 3, labels: ["needs-human"] }),
    makeIssue({ number: 4, labels: ["enhancement"] }),
  ];
  const result = filterAndSort(issues, defaultFilterLabels);
  assertEquals(result.length, 2);
  assertEquals(result[0]?.number, 1);
  assertEquals(result[1]?.number, 4);
});

Deno.test("issue_filter - filterAndSort excludes assigned issues", () => {
  const issues = [
    makeIssue({ number: 1, assignees: [] }),
    makeIssue({ number: 2, assignees: ["someone"] }),
  ];
  const result = filterAndSort(issues, defaultFilterLabels);
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 1);
});

Deno.test("issue_filter - filterAndSort sorts by createdAt oldest first", () => {
  const issues = [
    makeIssue({ number: 3, createdAt: "2024-03-01T00:00:00Z" }),
    makeIssue({ number: 1, createdAt: "2024-01-01T00:00:00Z" }),
    makeIssue({ number: 2, createdAt: "2024-02-01T00:00:00Z" }),
  ];
  const result = filterAndSort(issues, defaultFilterLabels);
  assertEquals(result[0]?.number, 1);
  assertEquals(result[1]?.number, 2);
  assertEquals(result[2]?.number, 3);
});

Deno.test("issue_filter - filterAndSort excludes needs-revision issues (Issue #1064)", () => {
  const issues = [
    makeIssue({ number: 1, labels: [] }),
    makeIssue({ number: 2, labels: ["needs-revision"] }),
  ];
  const result = filterAndSort(issues, defaultFilterLabels);
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 1);
});

Deno.test("issue_filter - filterAndSort excludes needs-human issues (Issue #1470)", () => {
  // needs-human signals the worker has handed the issue back. Discovery
  // must never re-pick such issues, regardless of any other labels.
  const issues = [
    makeIssue({ number: 1, labels: [] }),
    makeIssue({ number: 2, labels: ["needs-human"] }),
    makeIssue({ number: 3, labels: ["help wanted", "needs-human"] }),
  ];
  const result = filterAndSort(issues, defaultFilterLabels);
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 1);
});

Deno.test("issue_filter - filterAndSort honours custom needsHumanLabel (Issue #1470)", () => {
  // The label name is configurable — verify the filter uses the config value.
  const issues = [
    makeIssue({ number: 1, labels: [] }),
    makeIssue({ number: 2, labels: ["custom-hand-off"] }),
  ];
  const result = filterAndSort(issues, {
    ...defaultFilterLabels,
    needsHumanLabel: "custom-hand-off",
  });
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 1);
});

// =============================================================================
// filterByAllowedAuthors tests
// =============================================================================

Deno.test("issue_filter - filterByAllowedAuthors keeps issues from allowed authors", () => {
  const issues = [
    makeIssue({ number: 1, author: "alice" }),
    makeIssue({ number: 2, author: "bob" }),
    makeIssue({ number: 3, author: "charlie" }),
  ];
  const result = filterByAllowedAuthors(issues, ["alice", "charlie"]);
  assertEquals(result.length, 2);
  assertEquals(result[0]?.number, 1);
  assertEquals(result[1]?.number, 3);
});

Deno.test("issue_filter - filterByAllowedAuthors is case-insensitive", () => {
  const issues = [makeIssue({ author: "Alice" })];
  const result = filterByAllowedAuthors(issues, ["alice"]);
  assertEquals(result.length, 1);
});

// =============================================================================
// getFilterDiagnostics tests
// =============================================================================

Deno.test("issue_filter - getFilterDiagnostics counts correctly", () => {
  // Issue #2031: needs-clarification retired; the diagnostic counter now
  // tracks needs-human (the worker-to-human handoff label).
  const issues = [
    makeIssue({ number: 1, assignees: ["user1"], labels: [] }),
    makeIssue({ number: 2, labels: ["failed"] }),
    makeIssue({ number: 3, labels: ["needs-human"] }),
    makeIssue({ number: 4 }),
  ];
  const diag = getFilterDiagnostics(issues, "failed", "needs-human");
  assertEquals(diag.total, 4);
  assertEquals(diag.assignedToOthers, 1);
  assertEquals(diag.withFailedLabel, 1);
  assertEquals(diag.withNeedsHumanLabel, 1);
});

// =============================================================================
// wasReopenedAfterLabel tests
// =============================================================================

Deno.test("issue_filter - wasReopenedAfterLabel detects reopen after label", () => {
  const timeline = [
    {
      event: "labeled",
      label: { name: "failed" },
      created_at: "2024-01-01T00:00:00Z",
    },
    { event: "reopened", created_at: "2024-02-01T00:00:00Z" },
  ];
  assertEquals(wasReopenedAfterLabel(timeline, "failed"), true);
});

Deno.test("issue_filter - wasReopenedAfterLabel returns false when not reopened", () => {
  const timeline = [
    {
      event: "labeled",
      label: { name: "failed" },
      created_at: "2024-01-01T00:00:00Z",
    },
  ];
  assertEquals(wasReopenedAfterLabel(timeline, "failed"), false);
});

Deno.test("issue_filter - wasReopenedAfterLabel returns false when reopened before label", () => {
  const timeline = [
    { event: "reopened", created_at: "2024-01-01T00:00:00Z" },
    {
      event: "labeled",
      label: { name: "failed" },
      created_at: "2024-02-01T00:00:00Z",
    },
  ];
  assertEquals(wasReopenedAfterLabel(timeline, "failed"), false);
});

// =============================================================================
// getStaleLabelsForReopenedIssue tests
// =============================================================================

Deno.test("issue_filter - getStaleLabelsForReopenedIssue finds stale labels", () => {
  // Issue #2031: needs-clarification retired — stale cleanup only checks
  // failure labels (failed, failed-once) on reopened issues.
  const issueLabels = ["failed", "failed-once"];
  const timeline = [
    {
      event: "labeled",
      label: { name: "failed" },
      created_at: "2024-01-01T00:00:00Z",
    },
    {
      event: "labeled",
      label: { name: "failed-once" },
      created_at: "2024-01-02T00:00:00Z",
    },
    { event: "reopened", created_at: "2024-02-01T00:00:00Z" },
  ];

  const result = getStaleLabelsForReopenedIssue(
    issueLabels,
    timeline,
    "failed",
    "failed-once",
  );
  assertEquals(result.length, 2);
  assertEquals(result.includes("failed"), true);
  assertEquals(result.includes("failed-once"), true);
});

Deno.test("issue_filter - getStaleLabelsForReopenedIssue returns empty when no stale labels", () => {
  const issueLabels = ["bug"];
  const timeline = [
    { event: "reopened", created_at: "2024-02-01T00:00:00Z" },
  ];

  const result = getStaleLabelsForReopenedIssue(
    issueLabels,
    timeline,
    "failed",
    "failed-once",
  );
  assertEquals(result.length, 0);
});

// =============================================================================
// isMilestoneTrackingIssue tests (Issue #1134)
// =============================================================================

Deno.test("issue_filter - isMilestoneTrackingIssue detects body marker", () => {
  const issue = makeIssue({
    title: "Some unrelated title",
    body:
      `${MILESTONE_TRACKING_MARKER}\n## Milestone completion: v1.0\nDetails here.`,
  });
  assertEquals(isMilestoneTrackingIssue(issue), true);
});

Deno.test("issue_filter - isMilestoneTrackingIssue detects title pattern as fallback", () => {
  // Pre-existing tracking issue without the marker
  const issue = makeIssue({
    title: "Merge milestone 'v1.0' to main",
    body: "Some body without the marker",
  });
  assertEquals(isMilestoneTrackingIssue(issue), true);
});

Deno.test("issue_filter - isMilestoneTrackingIssue detects title pattern with different branch", () => {
  const issue = makeIssue({
    title: "Merge milestone 'Easter' to develop",
  });
  assertEquals(isMilestoneTrackingIssue(issue), true);
});

Deno.test("issue_filter - isMilestoneTrackingIssue does not match regular issues", () => {
  const issue = makeIssue({
    title: "Fix merge conflict in milestone branch",
    body: "This is a regular bug fix issue",
  });
  assertEquals(isMilestoneTrackingIssue(issue), false);
});

Deno.test("issue_filter - isMilestoneTrackingIssue does not match partial title", () => {
  // Title contains similar words but does not match the exact pattern
  const issue = makeIssue({
    title: "Merge milestone changes",
    body: "Regular issue about merging milestone work",
  });
  assertEquals(isMilestoneTrackingIssue(issue), false);
});

Deno.test("issue_filter - isMilestoneTrackingIssue handles missing body", () => {
  const issue = makeIssue({ title: "Normal issue" });
  assertEquals(isMilestoneTrackingIssue(issue), false);
});

Deno.test("issue_filter - isMilestoneTrackingIssue handles empty body", () => {
  const issue = makeIssue({ title: "Normal issue", body: "" });
  assertEquals(isMilestoneTrackingIssue(issue), false);
});

// =============================================================================
// filterAndSort — milestone tracking issue exclusion (Issue #1134)
// =============================================================================

Deno.test("issue_filter - filterAndSort excludes issues with milestone tracking marker", () => {
  const issues = [
    makeIssue({ number: 1, labels: ["help wanted"] }),
    makeIssue({
      number: 2,
      labels: ["help wanted"],
      body: `${MILESTONE_TRACKING_MARKER}\n## Milestone completion`,
    }),
    makeIssue({ number: 3, labels: ["bug"] }),
  ];
  const result = filterAndSort(issues, defaultFilterLabels);
  assertEquals(result.length, 2);
  assertEquals(result[0]?.number, 1);
  assertEquals(result[1]?.number, 3);
});

// =============================================================================
// filterAndSort — top-priority and help wanted both pass (Issue #1623)
// =============================================================================

Deno.test("issue_filter - filterAndSort keeps top-priority issues ahead of help wanted (Issue #1623)", () => {
  // Issue #1623: top-priority is the canonical highest-priority issue-discovery
  // label; help wanted is retained for backward compatibility. Both labels must
  // pass through filterAndSort (neither is blocking). When the top-priority
  // issue is older, it sorts ahead of the help-wanted issue.
  const issues = [
    makeIssue({
      number: 1,
      labels: ["help wanted"],
      createdAt: "2024-02-01T00:00:00Z",
    }),
    makeIssue({
      number: 2,
      labels: ["top-priority"],
      createdAt: "2024-01-01T00:00:00Z",
    }),
  ];
  const result = filterAndSort(issues, defaultFilterLabels);
  assertEquals(
    result.length,
    2,
    "both labelled issues must pass filterAndSort",
  );
  assertEquals(
    result[0]?.number,
    2,
    "the older top-priority issue should sort ahead of the help-wanted issue",
  );
  assertEquals(result[1]?.number, 1);
});

Deno.test("issue_filter - filterAndSort accepts an issue labelled only top-priority (Issue #1623)", () => {
  // An issue carrying only the top-priority label — with no help wanted or
  // claude — must still be discovered (not filtered out by any blocking rule).
  const issues = [makeIssue({ number: 42, labels: ["top-priority"] })];
  const result = filterAndSort(issues, defaultFilterLabels);
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 42);
});

Deno.test("issue_filter - filterAndSort excludes issues matching tracking title pattern", () => {
  const issues = [
    makeIssue({ number: 1 }),
    makeIssue({ number: 2, title: "Merge milestone 'v2.0' to main" }),
    makeIssue({ number: 3 }),
  ];
  const result = filterAndSort(issues, defaultFilterLabels);
  assertEquals(result.length, 2);
  assertEquals(result[0]?.number, 1);
  assertEquals(result[1]?.number, 3);
});
