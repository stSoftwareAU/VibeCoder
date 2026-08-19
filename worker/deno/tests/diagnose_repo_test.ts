/**
 * Tests for diagnose_repo library (Issue #1118).
 *
 * Covers label formatting, blocking reason detection, per-issue
 * diagnosis, and summary generation.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  diagnoseRepoIssue,
  formatIssueDiagnostic,
  formatLabels,
  generateSummary,
  getBlockingLabelReasons,
  type LabelConfig,
  type RepoIssueDiagnosticInput,
} from "../lib/diagnose_repo.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { OpenPR } from "../lib/issue_query.ts";

// =============================================================================
// formatLabels tests
// =============================================================================

Deno.test("formatLabels - returns comma-separated label names", () => {
  const labels = ["bug", "enhancement", "help wanted"];
  const result = formatLabels(labels);
  assertEquals(result, "bug, enhancement, help wanted");
});

Deno.test("formatLabels - returns 'none' for empty array", () => {
  const result = formatLabels([]);
  assertEquals(result, "none");
});

Deno.test("formatLabels - returns single label without comma", () => {
  const result = formatLabels(["bug"]);
  assertEquals(result, "bug");
});

// =============================================================================
// getBlockingLabelReasons tests
// =============================================================================

const defaultLabelConfig: LabelConfig = {
  failedLabel: "failed",
  failedOnceLabel: "failed-once",
  needsHumanLabel: "needs-human",
  refineIssueLabel: "refine-issue",
  planningLabel: "planning",
  questionLabel: "question",
};

Deno.test("getBlockingLabelReasons - detects failed label", () => {
  const reasons = getBlockingLabelReasons(
    ["failed", "bug"],
    defaultLabelConfig,
  );
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0]!.label, "failed");
  assertEquals(reasons[0]!.reason, "permanently failed");
  assertEquals(reasons[0]!.isBlocking, true);
});

Deno.test("getBlockingLabelReasons - detects failed-once as non-blocking", () => {
  const reasons = getBlockingLabelReasons(
    ["failed-once"],
    defaultLabelConfig,
  );
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0]!.label, "failed-once");
  assertEquals(reasons[0]!.isBlocking, false);
});

Deno.test("getBlockingLabelReasons - detects needs-human label (Issue #2031)", () => {
  const reasons = getBlockingLabelReasons(
    ["needs-human"],
    defaultLabelConfig,
  );
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0]!.reason, "handed back to a human");
  assertEquals(reasons[0]!.isBlocking, true);
});

Deno.test("getBlockingLabelReasons - detects refine-issue label", () => {
  const reasons = getBlockingLabelReasons(
    ["refine-issue"],
    defaultLabelConfig,
  );
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0]!.reason, "undergoing refinement");
  assertEquals(reasons[0]!.isBlocking, true);
});

Deno.test("getBlockingLabelReasons - detects planning label", () => {
  const reasons = getBlockingLabelReasons(["planning"], defaultLabelConfig);
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0]!.reason, "in planning mode");
  assertEquals(reasons[0]!.isBlocking, true);
});

Deno.test("getBlockingLabelReasons - detects question label", () => {
  const reasons = getBlockingLabelReasons(["question"], defaultLabelConfig);
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0]!.reason, "question workflow");
  assertEquals(reasons[0]!.isBlocking, true);
});

Deno.test("getBlockingLabelReasons - returns empty for non-blocking labels", () => {
  const reasons = getBlockingLabelReasons(
    ["bug", "enhancement", "help wanted"],
    defaultLabelConfig,
  );
  assertEquals(reasons.length, 0);
});

Deno.test("getBlockingLabelReasons - detects multiple blocking labels", () => {
  const reasons = getBlockingLabelReasons(
    ["failed", "needs-human", "bug"],
    defaultLabelConfig,
  );
  assertEquals(reasons.length, 2);
});

Deno.test("getBlockingLabelReasons - uses custom label config", () => {
  const customConfig: LabelConfig = {
    ...defaultLabelConfig,
    failedLabel: "custom-failed",
  };
  const reasons = getBlockingLabelReasons(["custom-failed"], customConfig);
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0]!.label, "custom-failed");
});

// =============================================================================
// diagnoseRepoIssue tests
// =============================================================================

function makeIssue(overrides: Partial<FilterableIssue> = {}): FilterableIssue {
  return {
    number: 42,
    title: "Test issue",
    url: "https://github.com/org/repo/issues/42",
    author: "testuser",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2024-01-01T00:00:00Z",
    milestone: "",
    ...overrides,
  };
}

Deno.test("diagnoseRepoIssue - eligible issue with no blockers", () => {
  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue(),
    prs: [],
    allIssues: [],
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.issueNumber, 42);
  assertEquals(result.issueTitle, "Test issue");
  assertEquals(result.isBlocked, false);
  assertEquals(result.reasons.length, 0);
});

Deno.test("diagnoseRepoIssue - detects assignment blocking", () => {
  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue({ assignees: ["someuser"] }),
    prs: [],
    allIssues: [],
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.isBlocked, true);
  assertEquals(result.reasons.some((r) => r.includes("Assigned to")), true);
});

Deno.test("diagnoseRepoIssue - detects blocking labels", () => {
  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue({ labels: ["work-on", "failed"] }),
    prs: [],
    allIssues: [],
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.isBlocked, true);
  assertEquals(
    result.reasons.some((r) => r.includes("Blocking label")),
    true,
  );
});

Deno.test("diagnoseRepoIssue - failed-once is noted but not blocking", () => {
  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue({ labels: ["work-on", "failed-once"] }),
    prs: [],
    allIssues: [],
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.isBlocked, false);
  assertEquals(result.reasons.length, 1);
  assertEquals(result.reasons[0]!.includes("Label:"), true);
});

Deno.test("diagnoseRepoIssue - detects PR blocking for non-milestone issue", () => {
  const prs: OpenPR[] = [
    {
      number: 100,
      title: "Fix something",
      baseRefName: "Develop",
      headRefName: "issue-99",
    },
  ];

  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue(),
    prs,
    allIssues: [],
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.isBlocked, true);
  assertEquals(
    result.reasons.some((r) => r.includes("Blocked by open PR #100")),
    true,
  );
});

Deno.test("diagnoseRepoIssue - milestone issue not blocked by non-milestone PR", () => {
  const prs: OpenPR[] = [
    {
      number: 100,
      title: "Fix something",
      baseRefName: "Develop",
      headRefName: "issue-99",
    },
  ];

  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue({ milestone: "v2.0" }),
    prs,
    allIssues: [],
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.isBlocked, false);
});

Deno.test("diagnoseRepoIssue - milestone issue blocked by same-milestone PR", () => {
  const prs: OpenPR[] = [
    {
      number: 100,
      title: "Fix something",
      baseRefName: "milestone/v2-0",
      headRefName: "issue-99",
    },
  ];

  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue({ milestone: "v2.0" }),
    prs,
    allIssues: [],
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.isBlocked, true);
  assertEquals(
    result.reasons.some((r) => r.includes("Blocked by open PR #100")),
    true,
  );
});

Deno.test("diagnoseRepoIssue - detects milestone occupancy by worker", () => {
  const allIssues: FilterableIssue[] = [
    makeIssue({ number: 10, milestone: "v2.0", assignees: ["worker-bot"] }),
  ];

  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue({ number: 42, milestone: "v2.0" }),
    prs: [],
    allIssues,
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.isBlocked, true);
  assertEquals(
    result.reasons.some((r) =>
      r.includes("Milestone") && r.includes("occupied")
    ),
    true,
  );
});

Deno.test("diagnoseRepoIssue - cooldown blocking", () => {
  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue(),
    prs: [],
    allIssues: [],
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
    isInCooldown: true,
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.isBlocked, true);
  assertEquals(
    result.reasons.some((r) => r.includes("cooldown")),
    true,
  );
});

Deno.test("diagnoseRepoIssue - reports milestone in diagnostic", () => {
  const input: RepoIssueDiagnosticInput = {
    issue: makeIssue({ milestone: "v2.0" }),
    prs: [],
    allIssues: [],
    labelConfig: defaultLabelConfig,
    workerUser: "worker-bot",
  };

  const result = diagnoseRepoIssue(input);
  assertEquals(result.milestone, "v2.0");
});

// =============================================================================
// generateSummary tests
// =============================================================================

Deno.test("generateSummary - all eligible issues", () => {
  const summary = generateSummary({
    totalIssues: 5,
    eligibleCount: 5,
    prBlockedCount: 0,
    labelBlockedCount: 0,
    dependencyBlockedCount: 0,
    otherBlockedCount: 0,
  });

  assertEquals(summary.totalIssues, 5);
  assertEquals(summary.eligibleCount, 5);
  assertEquals(summary.guidance.length, 0);
  assertEquals(
    summary.formatted.includes("5 issue(s) should be available"),
    true,
  );
});

Deno.test("generateSummary - no eligible issues with PR blocking", () => {
  const summary = generateSummary({
    totalIssues: 3,
    eligibleCount: 0,
    prBlockedCount: 2,
    labelBlockedCount: 1,
    dependencyBlockedCount: 0,
    otherBlockedCount: 0,
  });

  assertEquals(summary.eligibleCount, 0);
  assertEquals(
    summary.formatted.includes("No issues are currently eligible"),
    true,
  );
  assertEquals(
    summary.guidance.some((g) => g.includes("Merge or close")),
    true,
  );
  assertEquals(
    summary.guidance.some((g) => g.includes("Remove blocking labels")),
    true,
  );
});

Deno.test("generateSummary - dependency blocked guidance", () => {
  const summary = generateSummary({
    totalIssues: 1,
    eligibleCount: 0,
    prBlockedCount: 0,
    labelBlockedCount: 0,
    dependencyBlockedCount: 1,
    otherBlockedCount: 0,
  });

  assertEquals(
    summary.guidance.some((g) => g.includes("dependency")),
    true,
  );
});

Deno.test("generateSummary - other blocked guidance", () => {
  const summary = generateSummary({
    totalIssues: 2,
    eligibleCount: 0,
    prBlockedCount: 0,
    labelBlockedCount: 0,
    dependencyBlockedCount: 0,
    otherBlockedCount: 2,
  });

  assertEquals(
    summary.guidance.some((g) => g.includes("cooldown")),
    true,
  );
});

Deno.test("generateSummary - zero issues", () => {
  const summary = generateSummary({
    totalIssues: 0,
    eligibleCount: 0,
    prBlockedCount: 0,
    labelBlockedCount: 0,
    dependencyBlockedCount: 0,
    otherBlockedCount: 0,
  });

  assertEquals(summary.totalIssues, 0);
  assertEquals(
    summary.formatted.includes("No issues are currently eligible"),
    true,
  );
});

// =============================================================================
// formatIssueDiagnostic (Issue #3204 — coverage gap for the operator-facing
// per-issue Markdown renderer). Assert on the observable Markdown output so the
// tests survive any refactor of how the string is assembled.
// =============================================================================

Deno.test("formatIssueDiagnostic - eligible issue, no reasons, no milestone", () => {
  const out = formatIssueDiagnostic({
    issueNumber: 42,
    issueTitle: "Example",
    labelNames: "bug",
    milestone: "",
    reasons: [],
    isBlocked: false,
  });

  assertStringIncludes(out, "### Issue #42: Example");
  assertStringIncludes(out, "- **Labels**: bug");
  assertStringIncludes(out, "- **Status**: Eligible for pickup");
  // No milestone line when milestone is empty.
  assert(!out.includes("**Milestone**"));
  // Empty reasons must not emit a Blocked status.
  assert(!out.includes("- **Status**: Blocked"));
});

Deno.test("formatIssueDiagnostic - blocked issue lists reasons and Blocked status", () => {
  const out = formatIssueDiagnostic({
    issueNumber: 7,
    issueTitle: "Blocked one",
    labelNames: "bug, blocked",
    milestone: "Sprint 3",
    reasons: ["depends on #5"],
    isBlocked: true,
  });

  assertStringIncludes(out, "### Issue #7: Blocked one");
  assertStringIncludes(out, "- **Milestone**: Sprint 3");
  assertStringIncludes(out, "- depends on #5");
  assertStringIncludes(out, "- **Status**: Blocked");
  assert(!out.includes("- **Status**: Eligible for pickup"));
});

Deno.test("formatIssueDiagnostic - non-blocked issue with reasons stays eligible", () => {
  const out = formatIssueDiagnostic({
    issueNumber: 11,
    issueTitle: "Informational reasons",
    labelNames: "enhancement",
    milestone: "Sprint 4",
    reasons: ["assigned to worker (informational)"],
    isBlocked: false,
  });

  // Reasons present but not blocked → reasons listed, Eligible status.
  assertStringIncludes(out, "- **Milestone**: Sprint 4");
  assertStringIncludes(out, "- assigned to worker (informational)");
  assertStringIncludes(out, "- **Status**: Eligible for pickup");
  assert(!out.includes("- **Status**: Blocked"));
});
