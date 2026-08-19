/**
 * Tests for milestone priority ordering (Issue #1237).
 *
 * Verifies that priority labels (priority-high, priority-low) affect
 * issue ordering within the same milestone, while cross-milestone
 * and cross-repo selection remains globally oldest-first.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  extractMilestonePriority,
  MILESTONE_PRIORITY_LABELS,
  MILESTONE_PRIORITY_VALUES,
} from "../lib/milestone_priority.ts";
import {
  selectOldestCandidate,
  sortCandidatesByAge,
} from "../lib/issue_priority.ts";
import type {
  IssueCandidate,
  SelectionOptions,
} from "../lib/issue_priority.ts";

function makeCandidate(
  overrides: Partial<IssueCandidate> = {},
): IssueCandidate {
  return {
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/issues/1",
    title: "Test issue",
    milestone: "",
    createdAt: "2024-01-01T00:00:00Z",
    labelIndex: 0,
    source: "configured-label",
    milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    ...overrides,
  };
}

// =============================================================================
// extractMilestonePriority tests
// =============================================================================

Deno.test("milestone_priority - extractMilestonePriority returns high for priority-high label", () => {
  const labels = ["bug", MILESTONE_PRIORITY_LABELS.high, "work-on"];
  assertEquals(
    extractMilestonePriority(labels),
    MILESTONE_PRIORITY_VALUES.high,
  );
});

Deno.test("milestone_priority - extractMilestonePriority returns low for priority-low label", () => {
  const labels = ["feature", MILESTONE_PRIORITY_LABELS.low];
  assertEquals(extractMilestonePriority(labels), MILESTONE_PRIORITY_VALUES.low);
});

Deno.test("milestone_priority - extractMilestonePriority returns normal when no priority label", () => {
  const labels = ["bug", "work-on", "enhancement"];
  assertEquals(
    extractMilestonePriority(labels),
    MILESTONE_PRIORITY_VALUES.normal,
  );
});

Deno.test("milestone_priority - extractMilestonePriority returns normal for empty labels", () => {
  assertEquals(extractMilestonePriority([]), MILESTONE_PRIORITY_VALUES.normal);
});

Deno.test("milestone_priority - extractMilestonePriority prefers high when both labels present", () => {
  const labels = [
    MILESTONE_PRIORITY_LABELS.high,
    MILESTONE_PRIORITY_LABELS.low,
  ];
  assertEquals(
    extractMilestonePriority(labels),
    MILESTONE_PRIORITY_VALUES.high,
  );
});

Deno.test("milestone_priority - priority-high value is less than normal (sorts first)", () => {
  assertEquals(
    MILESTONE_PRIORITY_VALUES.high < MILESTONE_PRIORITY_VALUES.normal,
    true,
  );
});

Deno.test("milestone_priority - priority-low value is greater than normal (sorts last)", () => {
  assertEquals(
    MILESTONE_PRIORITY_VALUES.low > MILESTONE_PRIORITY_VALUES.normal,
    true,
  );
});

// =============================================================================
// selectOldestCandidate with milestone priority tests
// =============================================================================

Deno.test("milestone_priority - selectOldestCandidate picks high-priority over older issue in same milestone", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "v1.0",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    }),
    makeCandidate({
      number: 2,
      milestone: "v1.0",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
  ];
  const result = selectOldestCandidate(candidates);
  assertEquals(result?.number, 2); // Higher priority wins despite being newer
});

Deno.test("milestone_priority - selectOldestCandidate picks older issue when both have same priority in same milestone", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "v1.0",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
    makeCandidate({
      number: 2,
      milestone: "v1.0",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
  ];
  const result = selectOldestCandidate(candidates);
  assertEquals(result?.number, 2); // Same priority → oldest wins
});

Deno.test("milestone_priority - selectOldestCandidate does not apply priority across different milestones", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "v1.0",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
    makeCandidate({
      number: 2,
      milestone: "v2.0",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.low,
    }),
  ];
  const result = selectOldestCandidate(candidates);
  // Different milestones → oldest-first applies, not priority
  assertEquals(result?.number, 2);
});

Deno.test("milestone_priority - selectOldestCandidate does not apply priority to non-milestone issues", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
    makeCandidate({
      number: 2,
      milestone: "",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.low,
    }),
  ];
  const result = selectOldestCandidate(candidates);
  // No milestone → oldest-first applies
  assertEquals(result?.number, 2);
});

Deno.test("milestone_priority - selectOldestCandidate low-priority sorted after normal in same milestone", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "v1.0",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.low,
    }),
    makeCandidate({
      number: 2,
      milestone: "v1.0",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    }),
  ];
  const result = selectOldestCandidate(candidates);
  assertEquals(result?.number, 2); // Normal priority beats low, despite being newer
});

Deno.test("milestone_priority - selectOldestCandidate labelIndex still takes precedence over milestone priority", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "v1.0",
      labelIndex: 1,
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
    makeCandidate({
      number: 2,
      milestone: "v1.0",
      labelIndex: 0,
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.low,
    }),
  ];
  const result = selectOldestCandidate(candidates);
  assertEquals(result?.number, 2); // Lower labelIndex wins
});

Deno.test("milestone_priority - selectOldestCandidate works with randomisation and milestone priority", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "v1.0",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
    makeCandidate({
      number: 2,
      milestone: "v1.0",
      createdAt: "2024-02-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
    makeCandidate({
      number: 3,
      milestone: "v1.0",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    }),
  ];
  const opts: SelectionOptions = {
    randomFn: () => 0.99,
    randomPoolSize: 3,
  };
  const result = selectOldestCandidate(candidates, opts);
  // Top tier has high-priority candidates (1 and 2). Normal is below.
  // Pool of top labelIndex tier: all 3 candidates (all labelIndex 0).
  // But within same milestone, high priority sorts first (1, 2), then normal (3).
  // With randomPoolSize=3, all 3 are in pool. floor(0.99*3) = 2 → index 2 → number 3
  assertEquals(result?.number, 3);
});

Deno.test("milestone_priority - three-tier ordering within same milestone", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "v1.0",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.low,
    }),
    makeCandidate({
      number: 2,
      milestone: "v1.0",
      createdAt: "2024-02-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
    makeCandidate({
      number: 3,
      milestone: "v1.0",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    }),
  ];
  const result = selectOldestCandidate(candidates);
  assertEquals(result?.number, 2); // High priority wins
});

Deno.test("milestone_priority - fallback to oldest-first when no priority labels set", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "v1.0",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    }),
    makeCandidate({
      number: 2,
      milestone: "v1.0",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    }),
    makeCandidate({
      number: 3,
      milestone: "v1.0",
      createdAt: "2024-02-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    }),
  ];
  const result = selectOldestCandidate(candidates);
  assertEquals(result?.number, 2); // All normal → oldest-first
});

Deno.test("milestone_priority - mixed milestone and non-milestone candidates", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    }),
    makeCandidate({
      number: 2,
      milestone: "v1.0",
      createdAt: "2024-02-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
    makeCandidate({
      number: 3,
      milestone: "v1.0",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.normal,
    }),
  ];
  const result = selectOldestCandidate(candidates);
  // Non-milestone #1 (Jan) vs milestone #2 (Feb, high) vs milestone #3 (Mar, normal)
  // Cross-milestone ordering is by age → #1 is oldest
  assertEquals(result?.number, 1);
});

// =============================================================================
// sortCandidatesByAge remains unchanged (no priority ordering)
// =============================================================================

Deno.test("milestone_priority - sortCandidatesByAge ignores milestone priority (used for multi-result workflows)", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      milestone: "v1.0",
      createdAt: "2024-03-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.high,
    }),
    makeCandidate({
      number: 2,
      milestone: "v1.0",
      createdAt: "2024-01-01T00:00:00Z",
      milestonePriority: MILESTONE_PRIORITY_VALUES.low,
    }),
  ];
  const result = sortCandidatesByAge(candidates);
  assertEquals(result[0]?.number, 2); // Oldest first regardless of priority
  assertEquals(result[1]?.number, 1);
});

// =============================================================================
// Label constant tests
// =============================================================================

Deno.test("milestone_priority - MILESTONE_PRIORITY_LABELS has expected label names", () => {
  assertEquals(MILESTONE_PRIORITY_LABELS.high, "priority-high");
  assertEquals(MILESTONE_PRIORITY_LABELS.low, "priority-low");
});
