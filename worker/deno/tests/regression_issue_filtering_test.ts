/**
 * Regression test suite — issue finding and filtering parity (Issue #1235).
 *
 * Validates that the Deno issue filtering and priority selection produce
 * identical results to the original shell implementations, focusing on
 * edge cases with empty inputs, special characters, milestone awareness,
 * and dependency blocking.
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  type FilterableIssue,
  filterAndSort,
  filterByAllowedAuthors,
  filterByAssignee,
  type FilterLabels,
  getFilterDiagnostics,
  getStaleLabelsForReopenedIssue,
  isMilestoneOccupied,
  isMilestoneTrackingIssue,
  MILESTONE_TRACKING_MARKER,
  wasReopenedAfterLabel,
} from "../lib/issue_filter.ts";
import {
  formatCandidateOutput,
  type IssueCandidate,
  selectHighestPriority,
  type SelectionResult,
  selectOldestCandidate,
  sortCandidatesByAge,
} from "../lib/issue_priority.ts";

// ============================================================================
// Helpers — create test fixtures
// ============================================================================

function makeIssue(overrides: Partial<FilterableIssue> = {}): FilterableIssue {
  return {
    number: 1,
    title: "Test issue",
    url: "https://github.com/org/repo/issues/1",
    author: "user1",
    assignees: [],
    labels: [],
    createdAt: "2024-01-01T00:00:00Z",
    milestone: "",
    ...overrides,
  };
}

function makeLabels(): FilterLabels {
  return {
    failedLabel: "failed",
    needsRevisionLabel: "needs-revision",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
    needsHumanLabel: "needs-human",
  };
}

function makeCandidate(
  overrides: Partial<IssueCandidate> = {},
): IssueCandidate {
  return {
    repo: "org/repo",
    number: 1,
    url: "https://github.com/org/repo/issues/1",
    title: "Test issue",
    milestone: "",
    createdAt: "2024-01-01T00:00:00Z",
    labelIndex: 0,
    source: "configured-label",
    ...overrides,
  };
}

// ============================================================================
// filterByAssignee — edge cases
// ============================================================================

Deno.test("regression issue_filter - filterByAssignee with empty array", () => {
  assertEquals(filterByAssignee([]).length, 0);
});

Deno.test("regression issue_filter - filterByAssignee keeps unassigned issues", () => {
  const issues = [
    makeIssue({ number: 1, assignees: [] }),
    makeIssue({ number: 2, assignees: ["someone"] }),
    makeIssue({ number: 3, assignees: [] }),
  ];
  const result = filterByAssignee(issues);
  assertEquals(result.length, 2);
  assertEquals(result[0]!.number, 1);
  assertEquals(result[1]!.number, 3);
});

Deno.test("regression issue_filter - filterByAssignee removes multi-assignee issues", () => {
  const issues = [
    makeIssue({ number: 1, assignees: ["user1", "user2"] }),
  ];
  assertEquals(filterByAssignee(issues).length, 0);
});

// ============================================================================
// filterAndSort — comprehensive filtering
// ============================================================================

Deno.test("regression issue_filter - filterAndSort with empty array", () => {
  assertEquals(filterAndSort([], makeLabels()).length, 0);
});

Deno.test("regression issue_filter - filterAndSort excludes all blocking labels", () => {
  const labels = makeLabels();
  const issues = [
    makeIssue({ number: 1, labels: [labels.failedLabel] }),
    // Issue #2031: needs-clarification retired; needs-human is the handoff label.
    makeIssue({ number: 2, labels: [labels.needsHumanLabel] }),
    makeIssue({ number: 3, labels: [labels.needsRevisionLabel] }),
    makeIssue({ number: 4, labels: [labels.refineIssueLabel] }),
    makeIssue({ number: 5, labels: [labels.planningLabel] }),
    makeIssue({ number: 6, labels: [labels.questionLabel] }),
    makeIssue({ number: 7, labels: [] }), // eligible
  ];
  const result = filterAndSort(issues, labels);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.number, 7);
});

Deno.test("regression issue_filter - filterAndSort sorts by createdAt ascending", () => {
  const issues = [
    makeIssue({ number: 3, createdAt: "2024-03-01T00:00:00Z" }),
    makeIssue({ number: 1, createdAt: "2024-01-01T00:00:00Z" }),
    makeIssue({ number: 2, createdAt: "2024-02-01T00:00:00Z" }),
  ];
  const result = filterAndSort(issues, makeLabels());
  assertEquals(result[0]!.number, 1);
  assertEquals(result[1]!.number, 2);
  assertEquals(result[2]!.number, 3);
});

Deno.test("regression issue_filter - filterAndSort excludes assigned issues", () => {
  const issues = [
    makeIssue({ number: 1, assignees: ["user"] }),
    makeIssue({ number: 2, assignees: [] }),
  ];
  const result = filterAndSort(issues, makeLabels());
  assertEquals(result.length, 1);
  assertEquals(result[0]!.number, 2);
});

Deno.test("regression issue_filter - filterAndSort excludes milestone tracking issues", () => {
  const issues = [
    makeIssue({
      number: 1,
      title: "Merge milestone 'Auth' to main",
      body: MILESTONE_TRACKING_MARKER,
    }),
    makeIssue({ number: 2, title: "Normal issue" }),
  ];
  const result = filterAndSort(issues, makeLabels());
  assertEquals(result.length, 1);
  assertEquals(result[0]!.number, 2);
});

// ============================================================================
// filterByAllowedAuthors — edge cases
// ============================================================================

Deno.test("regression issue_filter - filterByAllowedAuthors with empty allowed list", () => {
  const issues = [makeIssue({ author: "user1" })];
  assertEquals(filterByAllowedAuthors(issues, []).length, 0);
});

Deno.test("regression issue_filter - filterByAllowedAuthors is case-insensitive", () => {
  const issues = [
    makeIssue({ number: 1, author: "UserOne" }),
    makeIssue({ number: 2, author: "usertwo" }),
  ];
  const result = filterByAllowedAuthors(issues, ["userone", "USERTWO"]);
  assertEquals(result.length, 2);
});

Deno.test("regression issue_filter - filterByAllowedAuthors with empty issues", () => {
  assertEquals(filterByAllowedAuthors([], ["user"]).length, 0);
});

// ============================================================================
// isMilestoneOccupied — edge cases
// ============================================================================

Deno.test("regression issue_filter - isMilestoneOccupied blocks default branch for worker", () => {
  const issues = [
    makeIssue({ assignees: ["worker-bot"], milestone: "" }),
  ];
  assertEquals(isMilestoneOccupied(issues, "", "worker-bot"), true);
});

Deno.test("regression issue_filter - isMilestoneOccupied ignores human on default branch", () => {
  const issues = [
    makeIssue({ assignees: ["maintainer"], milestone: "" }),
  ];
  assertEquals(isMilestoneOccupied(issues, "", "worker-bot"), false);
});

Deno.test("regression issue_filter - isMilestoneOccupied returns true when worker assigned in same milestone", () => {
  const issues = [
    makeIssue({ assignees: ["worker-bot"], milestone: "Auth" }),
  ];
  assertEquals(isMilestoneOccupied(issues, "Auth", "worker-bot"), true);
});

Deno.test("regression issue_filter - isMilestoneOccupied returns false when human assigned in same milestone", () => {
  const issues = [
    makeIssue({ assignees: ["maintainer"], milestone: "Auth" }),
  ];
  assertEquals(isMilestoneOccupied(issues, "Auth", "worker-bot"), false);
});

Deno.test("regression issue_filter - isMilestoneOccupied returns false for different milestone", () => {
  const issues = [
    makeIssue({ assignees: ["worker-bot"], milestone: "Auth" }),
  ];
  assertEquals(isMilestoneOccupied(issues, "Other", "worker-bot"), false);
});

Deno.test("regression issue_filter - isMilestoneOccupied returns false when unassigned", () => {
  const issues = [
    makeIssue({ assignees: [], milestone: "Auth" }),
  ];
  assertEquals(isMilestoneOccupied(issues, "Auth", "worker-bot"), false);
});

Deno.test("regression issue_filter - isMilestoneOccupied with empty issues array", () => {
  assertEquals(isMilestoneOccupied([], "Auth", "worker-bot"), false);
});

// ============================================================================
// isMilestoneTrackingIssue — detection
// ============================================================================

Deno.test("regression issue_filter - isMilestoneTrackingIssue detects body marker", () => {
  const issue = makeIssue({
    body: `Some preamble\n${MILESTONE_TRACKING_MARKER}\nMore text`,
  });
  assertEquals(isMilestoneTrackingIssue(issue), true);
});

Deno.test("regression issue_filter - isMilestoneTrackingIssue detects title pattern fallback", () => {
  const issue = makeIssue({
    title: "Merge milestone 'OIDC Auth' to main",
    body: "",
  });
  assertEquals(isMilestoneTrackingIssue(issue), true);
});

Deno.test("regression issue_filter - isMilestoneTrackingIssue rejects normal issues", () => {
  assertEquals(isMilestoneTrackingIssue(makeIssue()), false);
});

Deno.test("regression issue_filter - isMilestoneTrackingIssue with undefined body", () => {
  const issue = makeIssue({ body: undefined });
  assertEquals(isMilestoneTrackingIssue(issue), false);
});

// ============================================================================
// getFilterDiagnostics — correctness
// ============================================================================

Deno.test("regression issue_filter - getFilterDiagnostics counts correctly", () => {
  // Issue #2031: needs-clarification retired; the diagnostic counter now
  // tracks needs-human (the worker-to-human handoff label).
  const issues = [
    makeIssue({ number: 1, assignees: ["user"], labels: ["failed"] }),
    makeIssue({ number: 2, labels: ["needs-human"] }),
    makeIssue({ number: 3, labels: [] }),
    makeIssue({
      number: 4,
      assignees: ["user2"],
      labels: ["failed", "needs-human"],
    }),
  ];
  const diagnostics = getFilterDiagnostics(issues, "failed", "needs-human");

  assertEquals(diagnostics.total, 4);
  assertEquals(diagnostics.assignedToOthers, 2);
  assertEquals(diagnostics.withFailedLabel, 2);
  assertEquals(diagnostics.withNeedsHumanLabel, 2);
});

Deno.test("regression issue_filter - getFilterDiagnostics with empty array", () => {
  const diagnostics = getFilterDiagnostics([], "failed", "needs-human");
  assertEquals(diagnostics.total, 0);
  assertEquals(diagnostics.assignedToOthers, 0);
  assertEquals(diagnostics.withFailedLabel, 0);
  assertEquals(diagnostics.withNeedsHumanLabel, 0);
});

// ============================================================================
// wasReopenedAfterLabel — timeline analysis
// ============================================================================

Deno.test("regression issue_filter - wasReopenedAfterLabel detects reopened after labelled", () => {
  const timeline = [
    {
      event: "labeled",
      label: { name: "failed" },
      created_at: "2024-01-01T00:00:00Z",
    },
    { event: "reopened", created_at: "2024-01-02T00:00:00Z" },
  ];
  assertEquals(wasReopenedAfterLabel(timeline, "failed"), true);
});

Deno.test("regression issue_filter - wasReopenedAfterLabel returns false when labelled after reopen", () => {
  const timeline = [
    { event: "reopened", created_at: "2024-01-01T00:00:00Z" },
    {
      event: "labeled",
      label: { name: "failed" },
      created_at: "2024-01-02T00:00:00Z",
    },
  ];
  assertEquals(wasReopenedAfterLabel(timeline, "failed"), false);
});

Deno.test("regression issue_filter - wasReopenedAfterLabel returns false with no events", () => {
  assertEquals(wasReopenedAfterLabel([], "failed"), false);
});

Deno.test("regression issue_filter - wasReopenedAfterLabel ignores different labels", () => {
  const timeline = [
    {
      event: "labeled",
      label: { name: "other-label" },
      created_at: "2024-01-01T00:00:00Z",
    },
    { event: "reopened", created_at: "2024-01-02T00:00:00Z" },
  ];
  assertEquals(wasReopenedAfterLabel(timeline, "failed"), false);
});

// ============================================================================
// getStaleLabelsForReopenedIssue — stale label detection
// ============================================================================

Deno.test("regression issue_filter - getStaleLabelsForReopenedIssue finds stale labels", () => {
  const timeline = [
    {
      event: "labeled",
      label: { name: "failed" },
      created_at: "2024-01-01T00:00:00Z",
    },
    {
      event: "labeled",
      label: { name: "failed-once" },
      created_at: "2024-01-01T00:00:00Z",
    },
    { event: "reopened", created_at: "2024-01-02T00:00:00Z" },
  ];
  const stale = getStaleLabelsForReopenedIssue(
    ["failed", "failed-once", "work-on"],
    timeline,
    "failed",
    "failed-once",
  );
  assertEquals(stale.length, 2);
  assert(stale.includes("failed"));
  assert(stale.includes("failed-once"));
});

Deno.test("regression issue_filter - getStaleLabelsForReopenedIssue returns empty when no stale", () => {
  // Issue #2031: needs-clarification retired — stale cleanup only checks
  // failure labels on reopened issues.
  const stale = getStaleLabelsForReopenedIssue(
    ["work-on"],
    [],
    "failed",
    "failed-once",
  );
  assertEquals(stale.length, 0);
});

// ============================================================================
// Issue Priority — selectHighestPriority edge cases
// ============================================================================

Deno.test("regression issue_priority - selectHighestPriority with empty candidates", () => {
  const emptyResult: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
  };
  const selected = selectHighestPriority(emptyResult);
  assertEquals(selected, null);
});

Deno.test("regression issue_priority - selectHighestPriority prefers labels over work-on", () => {
  const labelCandidate = makeCandidate({
    number: 1,
    source: "configured-label",
  });
  const workOnCandidate = makeCandidate({ number: 2, source: "work-on" });

  const result: SelectionResult = {
    selected: null,
    labelCandidates: [labelCandidate],
    workOnCandidates: [workOnCandidate],
    blockedEntries: [],
  };
  const selected = selectHighestPriority(result);
  assertEquals(
    selected?.number,
    1,
    "Configured-label should take priority over work-on",
  );
});

Deno.test("regression issue_priority - selectHighestPriority falls back to work-on when no labels", () => {
  const workOnCandidate = makeCandidate({
    number: 2,
    source: "work-on",
    createdAt: "2024-01-01T00:00:00Z",
  });

  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [workOnCandidate],
    blockedEntries: [],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 2, "Should fall back to work-on candidates");
});

Deno.test("regression issue_priority - selectOldestCandidate selects oldest from label candidates", () => {
  const candidates = [
    makeCandidate({ number: 1, createdAt: "2024-02-01T00:00:00Z" }),
    makeCandidate({ number: 2, createdAt: "2024-01-01T00:00:00Z" }),
  ];

  const selected = selectOldestCandidate(candidates);
  assertEquals(selected?.number, 2, "Should select oldest candidate");
});

Deno.test("regression issue_priority - selectOldestCandidate with empty array returns null", () => {
  assertEquals(selectOldestCandidate([]), null);
});

// ============================================================================
// sortCandidatesByAge — ordering validation
// ============================================================================

Deno.test("regression issue_priority - sortCandidatesByAge sorts oldest first", () => {
  const candidates = [
    makeCandidate({ number: 3, createdAt: "2024-03-01T00:00:00Z" }),
    makeCandidate({ number: 1, createdAt: "2024-01-01T00:00:00Z" }),
    makeCandidate({ number: 2, createdAt: "2024-02-01T00:00:00Z" }),
  ];
  const sorted = sortCandidatesByAge(candidates);
  assertEquals(sorted[0]!.number, 1);
  assertEquals(sorted[1]!.number, 2);
  assertEquals(sorted[2]!.number, 3);
});

Deno.test("regression issue_priority - sortCandidatesByAge with empty array", () => {
  assertEquals(sortCandidatesByAge([]).length, 0);
});

Deno.test("regression issue_priority - sortCandidatesByAge with single candidate", () => {
  const sorted = sortCandidatesByAge([makeCandidate()]);
  assertEquals(sorted.length, 1);
});

// ============================================================================
// formatCandidateOutput — format validation
// ============================================================================

Deno.test("regression issue_priority - formatCandidateOutput uses pipe delimiter", () => {
  const candidate = makeCandidate({
    repo: "org/repo",
    number: 42,
    url: "https://github.com/org/repo/issues/42",
    title: "Fix bug",
    milestone: "",
  });
  const output = formatCandidateOutput(candidate);
  const parts = output.split("|");
  assert(
    parts.length >= 4,
    "Output should have at least 4 pipe-delimited parts",
  );
  assert(parts.some((p) => p.includes("org/repo")), "Should include repo");
  assert(parts.some((p) => p.includes("42")), "Should include issue number");
});

Deno.test("regression issue_priority - formatCandidateOutput handles special characters in title", () => {
  const candidate = makeCandidate({
    title: "Fix: handle `pipes|in|titles` correctly",
  });
  const output = formatCandidateOutput(candidate);
  assert(
    output.length > 0,
    "Should produce output even with pipe characters in title",
  );
});
