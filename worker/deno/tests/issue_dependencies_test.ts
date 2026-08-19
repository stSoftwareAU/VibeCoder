/**
 * Tests for the issue dependency resolution module (Issue #484).
 *
 * These tests verify that parent issues are correctly blocked when they
 * have open child issues, and that the dependency graph resolution
 * properly handles forward dependencies, parent/child relationships,
 * and edge cases.
 *
 * All GitHub API responses are mocked to enable deterministic testing
 * without network access.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  buildDependencyGraph,
  checkParentBlocked,
  type DependencyNode,
  extractDependencyReferences,
  extractSubIssueReferences,
  formatParentBlockedMessage,
  hasBackReference,
  type IssueFetcher,
  type IssueState,
  normaliseIssueState,
  type ParentBlockedResult,
  resolveWorkOrder,
  stripCodeSpans,
} from "../lib/issue_dependencies.ts";

// =============================================================================
// Mock IssueFetcher for testing
// =============================================================================

/**
 * Create a mock IssueFetcher with configurable responses.
 *
 * @param issues - Map of issue number to state and body
 * @param subIssues - Map of issue number to child issue numbers
 */
function createMockFetcher(
  issues: Map<
    number,
    { state: "OPEN" | "CLOSED"; body: string; title?: string }
  >,
  subIssues: Map<number, number[]> = new Map(),
): IssueFetcher {
  return {
    async getIssueState(
      _repo: string,
      issueNumber: number,
    ): Promise<IssueState> {
      const issue = issues.get(issueNumber);
      if (!issue) {
        throw new Error(`Issue #${issueNumber} not found`);
      }
      return {
        number: issueNumber,
        state: issue.state,
        title: issue.title ?? `Issue #${issueNumber}`,
      };
    },
    async getSubIssues(_repo: string, issueNumber: number): Promise<number[]> {
      return subIssues.get(issueNumber) ?? [];
    },
    async getIssueBody(_repo: string, issueNumber: number): Promise<string> {
      const issue = issues.get(issueNumber);
      if (!issue) {
        throw new Error(`Issue #${issueNumber} not found`);
      }
      return issue.body;
    },
  };
}

// =============================================================================
// extractSubIssueReferences tests
// =============================================================================

Deno.test("extractSubIssueReferences - returns empty array for empty body", () => {
  assertEquals(extractSubIssueReferences(""), []);
});

Deno.test("extractSubIssueReferences - returns empty array for body with no task lists", () => {
  assertEquals(
    extractSubIssueReferences(
      "This is a regular issue body with no sub-issues.",
    ),
    [],
  );
});

Deno.test("extractSubIssueReferences - extracts unchecked task list references", () => {
  const body = `## Sub-issues
- [ ] #101
- [ ] #102
- [ ] #103`;
  assertEquals(extractSubIssueReferences(body), [101, 102, 103]);
});

Deno.test("extractSubIssueReferences - extracts checked task list references", () => {
  const body = `## Sub-issues
- [x] #101
- [X] #102
- [ ] #103`;
  assertEquals(extractSubIssueReferences(body), [101, 102, 103]);
});

Deno.test("extractSubIssueReferences - extracts mixed checked and unchecked references", () => {
  const body = `## Tasks
- [x] #10 - First task (done)
- [ ] #20 - Second task (pending)
- [x] #30 - Third task (done)`;
  assertEquals(extractSubIssueReferences(body), [10, 20, 30]);
});

Deno.test("extractSubIssueReferences - extracts GitHub URL references in task lists", () => {
  const body = `## Sub-issues
- [ ] https://github.com/owner/repo/issues/101
- [ ] https://github.com/owner/repo/issues/102`;
  assertEquals(extractSubIssueReferences(body, "owner/repo"), [101, 102]);
});

Deno.test("extractSubIssueReferences - ignores URLs from different repos", () => {
  const body = `## Sub-issues
- [ ] https://github.com/owner/repo/issues/101
- [ ] https://github.com/other/repo/issues/102`;
  assertEquals(extractSubIssueReferences(body, "owner/repo"), [101]);
});

Deno.test("extractSubIssueReferences - extracts 'Parent of' references", () => {
  const body = `This is a parent issue.
Parent of #201
Parent of #202`;
  assertEquals(extractSubIssueReferences(body), [201, 202]);
});

Deno.test("extractSubIssueReferences - deduplicates references", () => {
  const body = `## Sub-issues
- [ ] #101
- [ ] #101
- [ ] #102`;
  assertEquals(extractSubIssueReferences(body), [101, 102]);
});

Deno.test("extractSubIssueReferences - returns sorted issue numbers", () => {
  const body = `## Sub-issues
- [ ] #300
- [ ] #100
- [ ] #200`;
  assertEquals(extractSubIssueReferences(body), [100, 200, 300]);
});

Deno.test("extractSubIssueReferences - does not match non-task-list issue references", () => {
  const body = `See #101 for context. Related to #102.`;
  assertEquals(extractSubIssueReferences(body), []);
});

// Issue #3218 regression: a task-list checkbox inside a fenced code example is
// documentation, not a genuine sub-issue reference.
Deno.test("extractSubIssueReferences - ignores task list inside a fenced code block (Issue #3218)", () => {
  const body = [
    "Example of the syntax:",
    "",
    "```md",
    "- [ ] #501",
    "- [x] #502",
    "```",
  ].join("\n");
  assertEquals(extractSubIssueReferences(body), []);
});

// =============================================================================
// stripCodeSpans tests (Issue #3218)
// =============================================================================

Deno.test("stripCodeSpans - removes a fenced code block but keeps prose", () => {
  const body = "before\n```\nsecret #5\n```\nafter";
  const out = stripCodeSpans(body);
  assertEquals(out.includes("secret"), false);
  assertEquals(out.includes("before"), true);
  assertEquals(out.includes("after"), true);
});

Deno.test("stripCodeSpans - removes inline code spans", () => {
  assertEquals(stripCodeSpans("a `inline #5` b").includes("#5"), false);
});

Deno.test("stripCodeSpans - drops an unterminated fenced block to end of body", () => {
  const out = stripCodeSpans("intro\n```\ndepends on #5\nno closing fence");
  assertEquals(out.includes("#5"), false);
  assertEquals(out.includes("intro"), true);
});

Deno.test("stripCodeSpans - leaves a body with no code spans unchanged", () => {
  const body = "depends on #5 in plain prose";
  assertEquals(stripCodeSpans(body), body);
});

// =============================================================================
// normaliseIssueState tests (Issue #3218)
// =============================================================================

Deno.test("normaliseIssueState - OPEN stays OPEN", () => {
  assertEquals(normaliseIssueState("OPEN"), "OPEN");
});

Deno.test("normaliseIssueState - CLOSED stays CLOSED", () => {
  assertEquals(normaliseIssueState("CLOSED"), "CLOSED");
});

Deno.test("normaliseIssueState - a merged PR (MERGED) resolves to CLOSED (Issue #3218)", () => {
  // Issues and PRs share one numbering space, so a dependency reference can
  // land on a PR number. A merged PR is satisfied, not outstanding — it must
  // never resolve to OPEN (the old `=== CLOSED ? CLOSED : OPEN` bug).
  assertEquals(normaliseIssueState("MERGED"), "CLOSED");
});

Deno.test("normaliseIssueState - is case-insensitive and trims", () => {
  assertEquals(normaliseIssueState(" open "), "OPEN");
  assertEquals(normaliseIssueState("merged"), "CLOSED");
});

// =============================================================================
// hasBackReference tests
// =============================================================================

Deno.test("hasBackReference - detects 'Part of #N'", () => {
  assertEquals(hasBackReference("Some text\n\nPart of #100", 100), true);
});

Deno.test("hasBackReference - detects 'Child of #N'", () => {
  assertEquals(hasBackReference("Child of #42", 42), true);
});

Deno.test("hasBackReference - case insensitive", () => {
  assertEquals(hasBackReference("part of #100", 100), true);
  assertEquals(hasBackReference("PART OF #100", 100), true);
});

Deno.test("hasBackReference - does not match different parent number", () => {
  assertEquals(hasBackReference("Part of #200", 100), false);
});

Deno.test("hasBackReference - does not match partial number", () => {
  assertEquals(hasBackReference("Part of #1001", 100), false);
});

Deno.test("hasBackReference - returns false for empty body", () => {
  assertEquals(hasBackReference("", 100), false);
});

// =============================================================================
// extractDependencyReferences tests
// =============================================================================

Deno.test("extractDependencyReferences - returns empty array for empty body", () => {
  assertEquals(extractDependencyReferences(""), []);
});

Deno.test("extractDependencyReferences - extracts 'Depends on' references", () => {
  const body = `This issue depends on #101.
Depends on #102.`;
  assertEquals(extractDependencyReferences(body), [101, 102]);
});

Deno.test("extractDependencyReferences - extracts 'Blocked by' references", () => {
  const body = `Blocked by #201.
blocked by #202.`;
  assertEquals(extractDependencyReferences(body), [201, 202]);
});

Deno.test("extractDependencyReferences - case insensitive matching", () => {
  const body = `DEPENDS ON #101
depends on #102
Depends On #103
BLOCKED BY #201
blocked by #202`;
  assertEquals(extractDependencyReferences(body), [101, 102, 103, 201, 202]);
});

Deno.test("extractDependencyReferences - deduplicates references", () => {
  const body = `Depends on #101.
Also depends on #101.`;
  assertEquals(extractDependencyReferences(body), [101]);
});

Deno.test("extractDependencyReferences - does not match plain issue mentions", () => {
  const body = `See #101 for context. Fixed in #102.`;
  assertEquals(extractDependencyReferences(body), []);
});

// Issue #3218 regression: dependency phrases quoted inside a Markdown code
// example are not real dependencies. A test-audit finding (#3204) embedded a
// suggested-fix snippet containing `reasons: ["depends on #5"]`, which was
// parsed as a dependency on #5 and blocked the issue forever.
Deno.test("extractDependencyReferences - ignores phrase inside a fenced code block (Issue #3218)", () => {
  const body = [
    "Add a test for the formatter.",
    "",
    "```ts",
    'Deno.test("blocked issue", () => {',
    '  const out = format({ reasons: ["depends on #5"] });',
    '  assertStringIncludes(out, "- depends on #5");',
    "});",
    "```",
    "",
    "That is the whole change.",
  ].join("\n");
  assertEquals(extractDependencyReferences(body), []);
});

Deno.test("extractDependencyReferences - ignores phrase inside a ~~~ fenced block (Issue #3218)", () => {
  const body = "~~~\nblocked by #7\n~~~";
  assertEquals(extractDependencyReferences(body), []);
});

Deno.test("extractDependencyReferences - ignores phrase inside an inline code span (Issue #3218)", () => {
  const body = "The example uses `depends on #9` as sample text.";
  assertEquals(extractDependencyReferences(body), []);
});

Deno.test("extractDependencyReferences - keeps a real prose dependency alongside a code example (Issue #3218)", () => {
  const body = [
    "This work depends on #42 landing first.",
    "",
    "```ts",
    '  reasons: ["depends on #5"], // illustrative only',
    "```",
  ].join("\n");
  assertEquals(extractDependencyReferences(body), [42]);
});

// =============================================================================
// checkParentBlocked tests
// =============================================================================

Deno.test("checkParentBlocked - not blocked when issue has no sub-issues", async () => {
  const issues = new Map([
    [1, { state: "OPEN" as const, body: "Regular issue with no sub-issues" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 1);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, false);
    assertEquals(result.value.totalChildren, 0);
    assertEquals(result.value.openChildren, []);
    assertEquals(result.value.closedChildren, []);
  }
});

Deno.test("checkParentBlocked - blocked when has open sub-issues from API", async () => {
  const issues = new Map([
    [1, { state: "OPEN" as const, body: "Parent issue" }],
    [2, { state: "OPEN" as const, body: "Child 1" }],
    [3, { state: "OPEN" as const, body: "Child 2" }],
  ]);
  const subIssues = new Map([
    [1, [2, 3]],
  ]);
  const fetcher = createMockFetcher(issues, subIssues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 1);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, true);
    assertEquals(result.value.openChildren, [2, 3]);
    assertEquals(result.value.closedChildren, []);
    assertEquals(result.value.totalChildren, 2);
  }
});

Deno.test("checkParentBlocked - blocked when has open sub-issues from body task list", async () => {
  const issues = new Map([
    [1, {
      state: "OPEN" as const,
      body: `## Sub-issues
- [ ] #10
- [ ] #20
- [x] #30`,
    }],
    [10, { state: "OPEN" as const, body: "Child 1\n\nPart of #1" }],
    [20, { state: "OPEN" as const, body: "Child 2\n\nPart of #1" }],
    [30, { state: "CLOSED" as const, body: "Child 3 (done)\n\nPart of #1" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 1);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, true);
    assertEquals(result.value.openChildren, [10, 20]);
    assertEquals(result.value.closedChildren, [30]);
    assertEquals(result.value.totalChildren, 3);
  }
});

Deno.test("checkParentBlocked - not blocked when all sub-issues are closed", async () => {
  const issues = new Map([
    [1, { state: "OPEN" as const, body: "Parent issue" }],
    [2, { state: "CLOSED" as const, body: "Child 1 (done)" }],
    [3, { state: "CLOSED" as const, body: "Child 2 (done)" }],
  ]);
  const subIssues = new Map([
    [1, [2, 3]],
  ]);
  const fetcher = createMockFetcher(issues, subIssues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 1);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, false);
    assertEquals(result.value.openChildren, []);
    assertEquals(result.value.closedChildren, [2, 3]);
    assertEquals(result.value.totalChildren, 2);
  }
});

Deno.test("checkParentBlocked - partially completed children", async () => {
  const issues = new Map([
    [100, { state: "OPEN" as const, body: "Parent" }],
    [101, { state: "CLOSED" as const, body: "Done child" }],
    [102, { state: "OPEN" as const, body: "Open child" }],
    [103, { state: "CLOSED" as const, body: "Done child" }],
  ]);
  const subIssues = new Map([
    [100, [101, 102, 103]],
  ]);
  const fetcher = createMockFetcher(issues, subIssues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 100);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, true);
    assertEquals(result.value.openChildren, [102]);
    assertEquals(result.value.closedChildren, [101, 103]);
    assertEquals(result.value.totalChildren, 3);
  }
});

Deno.test("checkParentBlocked - merges API sub-issues and body task list references", async () => {
  const issues = new Map([
    [1, {
      state: "OPEN" as const,
      body: `## Sub-issues
- [ ] #30`,
    }],
    [20, { state: "OPEN" as const, body: "API child" }],
    [30, { state: "OPEN" as const, body: "Body child\n\nPart of #1" }],
  ]);
  const subIssues = new Map([
    [1, [20]],
  ]);
  const fetcher = createMockFetcher(issues, subIssues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 1);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, true);
    assertEquals(result.value.openChildren, [20, 30]);
    assertEquals(result.value.totalChildren, 2);
  }
});

Deno.test("checkParentBlocked - deduplicates sub-issues from API and body", async () => {
  const issues = new Map([
    [1, {
      state: "OPEN" as const,
      body: `## Sub-issues
- [ ] #20`,
    }],
    [20, { state: "OPEN" as const, body: "Child" }],
  ]);
  const subIssues = new Map([
    [1, [20]], // Same child in both API and body
  ]);
  const fetcher = createMockFetcher(issues, subIssues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 1);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.totalChildren, 1); // Not 2
    assertEquals(result.value.openChildren, [20]);
  }
});

Deno.test("checkParentBlocked - treats unreachable children as open (fail closed)", async () => {
  const issues = new Map([
    [1, { state: "OPEN" as const, body: "Parent" }],
    // Child #2 intentionally missing from map to simulate API failure
  ]);
  const subIssues = new Map([
    [1, [2]],
  ]);
  const fetcher = createMockFetcher(issues, subIssues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 1);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, true);
    assertEquals(result.value.openChildren, [2]);
  }
});

Deno.test("checkParentBlocked - returns error when issue itself fails", async () => {
  // Empty map — issue #999 doesn't exist
  const fetcher = createMockFetcher(new Map());
  // Override getSubIssues to throw
  fetcher.getSubIssues = async () => {
    throw new Error("API error: issue not found");
  };

  const result = await checkParentBlocked(fetcher, "owner/repo", 999);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message, "API error: issue not found");
  }
});

Deno.test("checkParentBlocked - NOT blocked by body task list items without back-reference", async () => {
  // Simulates FLEET#1472: acceptance criteria has "- [ ] #747" but #747 does NOT
  // say "Part of #1472" — it's a checklist item, not a real sub-issue.
  const issues = new Map([
    [1472, {
      state: "OPEN" as const,
      body: `## Acceptance criteria
- [ ] #747 body updated
- [ ] #851 body updated
- [ ] #1415 recommendations updated`,
    }],
    [747, { state: "OPEN" as const, body: "Add Treasury Yield observations" }],
    [851, {
      state: "CLOSED" as const,
      body: "Add Commodity Price observations",
    }],
    [1415, { state: "OPEN" as const, body: "Update Investopedia gap issues" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 1472);

  assertEquals(result.ok, true);
  if (result.ok) {
    // Must NOT be blocked — these are checklist items, not real sub-issues
    assertEquals(result.value.isBlocked, false);
    assertEquals(result.value.totalChildren, 0);
  }
});

Deno.test("checkParentBlocked - blocked by body task list items WITH back-reference", async () => {
  // When the child says "Part of #parent", it IS a real sub-issue
  const issues = new Map([
    [100, {
      state: "OPEN" as const,
      body: `## Sub-issues
- [ ] #101
- [ ] #102`,
    }],
    [101, {
      state: "OPEN" as const,
      body: "Implement feature A\n\nPart of #100",
    }],
    [102, {
      state: "CLOSED" as const,
      body: "Implement feature B\n\nPart of #100",
    }],
  ]);
  const fetcher = createMockFetcher(issues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 100);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, true);
    assertEquals(result.value.openChildren, [101]);
    assertEquals(result.value.closedChildren, [102]);
    assertEquals(result.value.totalChildren, 2);
  }
});

Deno.test("checkParentBlocked - API sub-issues always trusted (no back-reference needed)", async () => {
  // Sub-issues from the GitHub API are real parent-child relationships
  const issues = new Map([
    [100, { state: "OPEN" as const, body: "Parent issue" }],
    [101, { state: "OPEN" as const, body: "Child (no back-reference)" }],
  ]);
  const subIssues = new Map([
    [100, [101]], // From GitHub sub-issues API
  ]);
  const fetcher = createMockFetcher(issues, subIssues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 100);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, true);
    assertEquals(result.value.openChildren, [101]);
  }
});

Deno.test("checkParentBlocked - mixed API sub-issues and unconfirmed body refs", async () => {
  // API sub-issue #201 blocks, but body ref #747 does NOT (no back-reference)
  const issues = new Map([
    [200, {
      state: "OPEN" as const,
      body: `## Tasks
- [ ] #747 needs updating`,
    }],
    [201, { state: "OPEN" as const, body: "Real child task" }],
    [747, { state: "OPEN" as const, body: "Unrelated issue" }],
  ]);
  const subIssues = new Map([
    [200, [201]], // Real sub-issue from API
  ]);
  const fetcher = createMockFetcher(issues, subIssues);

  const result = await checkParentBlocked(fetcher, "owner/repo", 200);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.isBlocked, true);
    assertEquals(result.value.openChildren, [201]); // Only API child, not #747
    assertEquals(result.value.totalChildren, 1);
  }
});

// =============================================================================
// buildDependencyGraph tests
// =============================================================================

Deno.test("buildDependencyGraph - builds graph for independent issues", async () => {
  const issues = new Map([
    [1, { state: "OPEN" as const, body: "Issue 1" }],
    [2, { state: "OPEN" as const, body: "Issue 2" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const graph = await buildDependencyGraph(fetcher, "owner/repo", [1, 2]);

  assertEquals(graph.length, 2);
  const node1 = graph.find((n) => n.issueNumber === 1);
  const node2 = graph.find((n) => n.issueNumber === 2);
  assertExists(node1);
  assertExists(node2);
  assertEquals(node1.dependsOn, []);
  assertEquals(node2.dependsOn, []);
  assertEquals(node1.childOf, undefined);
  assertEquals(node2.childOf, undefined);
});

Deno.test("buildDependencyGraph - includes forward dependencies", async () => {
  const issues = new Map([
    [1, { state: "OPEN" as const, body: "First issue" }],
    [2, { state: "OPEN" as const, body: "Depends on #1" }],
    [3, { state: "OPEN" as const, body: "Depends on #2" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const graph = await buildDependencyGraph(fetcher, "owner/repo", [1, 2, 3]);

  const node2 = graph.find((n) => n.issueNumber === 2);
  const node3 = graph.find((n) => n.issueNumber === 3);
  assertExists(node2);
  assertExists(node3);
  assertEquals(node2.dependsOn, [1]);
  assertEquals(node3.dependsOn, [2]);
});

Deno.test("buildDependencyGraph - detects parent/child relationships", async () => {
  const issues = new Map([
    [100, {
      state: "OPEN" as const,
      body: `## Sub-issues
- [ ] #101
- [ ] #102`,
    }],
    [101, { state: "OPEN" as const, body: "Child 1" }],
    [102, { state: "OPEN" as const, body: "Child 2" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const graph = await buildDependencyGraph(fetcher, "owner/repo", [
    100,
    101,
    102,
  ]);

  const node101 = graph.find((n) => n.issueNumber === 101);
  const node102 = graph.find((n) => n.issueNumber === 102);
  assertExists(node101);
  assertExists(node102);
  assertEquals(node101.childOf, 100);
  assertEquals(node102.childOf, 100);
});

Deno.test("buildDependencyGraph - only includes in-set dependencies", async () => {
  const issues = new Map([
    [1, { state: "OPEN" as const, body: "Depends on #999" }], // #999 not in set
    [2, { state: "OPEN" as const, body: "Depends on #1" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const graph = await buildDependencyGraph(fetcher, "owner/repo", [1, 2]);

  const node1 = graph.find((n) => n.issueNumber === 1);
  assertExists(node1);
  assertEquals(node1.dependsOn, []); // #999 excluded because not in set
});

// =============================================================================
// resolveWorkOrder tests
// =============================================================================

Deno.test("resolveWorkOrder - all independent issues are ready", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 1, dependsOn: [], state: "OPEN" },
    { issueNumber: 2, dependsOn: [], state: "OPEN" },
    { issueNumber: 3, dependsOn: [], state: "OPEN" },
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.ready, [1, 2, 3]);
  assertEquals(result.blocked, []);
  assertEquals(result.circular, []);
});

Deno.test("resolveWorkOrder - issues with open dependencies are blocked", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 1, dependsOn: [], state: "OPEN" },
    { issueNumber: 2, dependsOn: [1], state: "OPEN" },
    { issueNumber: 3, dependsOn: [2], state: "OPEN" },
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.ready, [1]);
  assertEquals(result.blocked.length, 2);
  assertEquals(result.blocked[0]?.issue, 2);
  assertEquals(result.blocked[0]?.blockedBy, [1]);
  assertEquals(result.blocked[1]?.issue, 3);
  assertEquals(result.blocked[1]?.blockedBy, [2]);
});

Deno.test("resolveWorkOrder - issues with closed dependencies are ready", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 1, dependsOn: [], state: "CLOSED" },
    { issueNumber: 2, dependsOn: [1], state: "OPEN" },
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.ready, [2]);
  assertEquals(result.blocked, []);
});

Deno.test("resolveWorkOrder - parent issues are blocked by open children", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 100, dependsOn: [], state: "OPEN" }, // Parent
    { issueNumber: 101, dependsOn: [], childOf: 100, state: "OPEN" }, // Child 1
    { issueNumber: 102, dependsOn: [101], childOf: 100, state: "OPEN" }, // Child 2 depends on child 1
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.ready, [101]); // Only child 1 is ready
  // Parent blocked by both children, child 2 blocked by child 1
  const parentBlocked = result.blocked.find((b) => b.issue === 100);
  assertExists(parentBlocked);
  assertEquals(parentBlocked.blockedBy, [101, 102]);

  const child2Blocked = result.blocked.find((b) => b.issue === 102);
  assertExists(child2Blocked);
  assertEquals(child2Blocked.blockedBy, [101]);
});

Deno.test("resolveWorkOrder - parent ready when all children closed", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 100, dependsOn: [], state: "OPEN" }, // Parent
    { issueNumber: 101, dependsOn: [], childOf: 100, state: "CLOSED" },
    { issueNumber: 102, dependsOn: [], childOf: 100, state: "CLOSED" },
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.ready, [100]); // Parent is ready now
  assertEquals(result.blocked, []);
});

Deno.test("resolveWorkOrder - detects circular dependencies", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 1, dependsOn: [2], state: "OPEN" },
    { issueNumber: 2, dependsOn: [1], state: "OPEN" },
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.circular, [1, 2]);
  assertEquals(result.ready, []);
});

Deno.test("resolveWorkOrder - excludes closed issues from results", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 1, dependsOn: [], state: "CLOSED" },
    { issueNumber: 2, dependsOn: [], state: "CLOSED" },
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.ready, []);
  assertEquals(result.blocked, []);
});

Deno.test("resolveWorkOrder - complex graph with parent/child and forward deps", () => {
  // Scenario: Parent #100 has children #101, #102, #103
  // #102 depends on #101, #103 depends on #102
  // Only #101 should be ready
  const nodes: DependencyNode[] = [
    { issueNumber: 100, dependsOn: [], state: "OPEN" }, // Parent
    { issueNumber: 101, dependsOn: [], childOf: 100, state: "OPEN" }, // Child 1 — ready
    { issueNumber: 102, dependsOn: [101], childOf: 100, state: "OPEN" }, // Child 2 — blocked by 101
    { issueNumber: 103, dependsOn: [102], childOf: 100, state: "OPEN" }, // Child 3 — blocked by 102
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.ready, [101]);
  assertEquals(result.blocked.length, 3); // Parent + child 2 + child 3

  const parentBlocked = result.blocked.find((b) => b.issue === 100);
  assertExists(parentBlocked);
  // Parent blocked by all open children
  assertEquals(parentBlocked.blockedBy, [101, 102, 103]);
});

Deno.test("resolveWorkOrder - progressive unblocking as children complete", () => {
  // After #101 is closed, #102 becomes ready
  const nodes: DependencyNode[] = [
    { issueNumber: 100, dependsOn: [], state: "OPEN" }, // Parent
    { issueNumber: 101, dependsOn: [], childOf: 100, state: "CLOSED" }, // Child 1 — done
    { issueNumber: 102, dependsOn: [101], childOf: 100, state: "OPEN" }, // Child 2 — now ready
    { issueNumber: 103, dependsOn: [102], childOf: 100, state: "OPEN" }, // Child 3 — still blocked
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.ready, [102]); // Child 2 now ready (101 is closed)
  assertEquals(result.blocked.length, 2); // Parent + child 3

  const parentBlocked = result.blocked.find((b) => b.issue === 100);
  assertExists(parentBlocked);
  assertEquals(parentBlocked.blockedBy, [102, 103]); // Still blocked by open children
});

Deno.test("resolveWorkOrder - empty input returns empty results", () => {
  const result = resolveWorkOrder([]);

  assertEquals(result.ready, []);
  assertEquals(result.blocked, []);
  assertEquals(result.circular, []);
});

Deno.test("resolveWorkOrder - single open issue with no deps is ready", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 42, dependsOn: [], state: "OPEN" },
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.ready, [42]);
  assertEquals(result.blocked, []);
});

// =============================================================================
// formatParentBlockedMessage tests
// =============================================================================

Deno.test("formatParentBlockedMessage - not blocked with no children", () => {
  const result: ParentBlockedResult = {
    isBlocked: false,
    openChildren: [],
    closedChildren: [],
    totalChildren: 0,
  };

  const message = formatParentBlockedMessage(100, result);
  assertEquals(message, "Issue #100 has no sub-issues — not blocked.");
});

Deno.test("formatParentBlockedMessage - not blocked with all children closed", () => {
  const result: ParentBlockedResult = {
    isBlocked: false,
    openChildren: [],
    closedChildren: [101, 102],
    totalChildren: 2,
  };

  const message = formatParentBlockedMessage(100, result);
  assertEquals(
    message,
    "Issue #100 — all 2 sub-issues are closed. Ready to work on.",
  );
});

Deno.test("formatParentBlockedMessage - blocked with open children", () => {
  const result: ParentBlockedResult = {
    isBlocked: true,
    openChildren: [102, 103],
    closedChildren: [101],
    totalChildren: 3,
  };

  const message = formatParentBlockedMessage(100, result);
  assertEquals(
    message,
    "Issue #100 is blocked by 2 open sub-issue(s): #102, #103. 1/3 sub-issues completed.",
  );
});

// =============================================================================
// Integration-style tests with realistic GitHub issue scenarios
// =============================================================================

Deno.test("integration - realistic parent issue with sub-issues scenario", async () => {
  // Simulates the example-org/private-repo-57#482 scenario from the issue description
  const issues = new Map<number, { state: "OPEN" | "CLOSED"; body: string }>([
    [482, {
      state: "OPEN",
      body: `# Improve authentication system

## Sub-issues
- [ ] #483
- [ ] #484
- [x] #485`,
    }],
    [483, {
      state: "OPEN",
      body: "Add OAuth2 support\nDepends on #485\n\nPart of #482",
    }],
    [484, { state: "OPEN", body: "Add session management\n\nPart of #482" }],
    [485, {
      state: "CLOSED",
      body: "Refactor auth middleware\n\nPart of #482",
    }],
  ]);
  const fetcher = createMockFetcher(issues);

  // Check if the parent is blocked
  const parentResult = await checkParentBlocked(fetcher, "owner/repo", 482);
  assertEquals(parentResult.ok, true);
  if (parentResult.ok) {
    assertEquals(parentResult.value.isBlocked, true);
    assertEquals(parentResult.value.openChildren, [483, 484]);
    assertEquals(parentResult.value.closedChildren, [485]);
  }

  // Build dependency graph for all issues
  const graph = await buildDependencyGraph(fetcher, "owner/repo", [
    482,
    483,
    484,
    485,
  ]);

  // Resolve work order
  const order = resolveWorkOrder(graph);

  // Only #484 should be ready (#483 depends on #485 which is done but also depends on nothing else... wait, #483 depends on #485 which is CLOSED, so #483 should also be ready)
  // #482 is parent with open children — blocked
  // #485 is closed — excluded
  // #483 has dependency on #485 (closed) — ready
  // #484 has no dependencies — ready
  assertEquals(order.ready.includes(484), true);
  assertEquals(order.ready.includes(483), true);
  assertEquals(order.ready.includes(482), false); // Parent blocked
});

Deno.test("integration - all children closed makes parent ready", async () => {
  const issues = new Map<number, { state: "OPEN" | "CLOSED"; body: string }>([
    [50, {
      state: "OPEN",
      body: `## Sub-issues
- [x] #51
- [x] #52`,
    }],
    [51, { state: "CLOSED", body: "First task\n\nPart of #50" }],
    [52, { state: "CLOSED", body: "Second task\n\nPart of #50" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const parentResult = await checkParentBlocked(fetcher, "owner/repo", 50);
  assertEquals(parentResult.ok, true);
  if (parentResult.ok) {
    assertEquals(parentResult.value.isBlocked, false);
    assertEquals(parentResult.value.totalChildren, 2);
  }

  // In work order, parent should be ready
  const graph = await buildDependencyGraph(fetcher, "owner/repo", [50, 51, 52]);
  const order = resolveWorkOrder(graph);
  assertEquals(order.ready, [50]); // Parent ready, children excluded (closed)
});

Deno.test("integration - chain of dependencies resolved correctly", async () => {
  // Issue #1 -> #2 -> #3 (sequential chain)
  const issues = new Map<number, { state: "OPEN" | "CLOSED"; body: string }>([
    [1, { state: "OPEN", body: "First issue — no dependencies" }],
    [2, { state: "OPEN", body: "Second issue\nDepends on #1" }],
    [3, { state: "OPEN", body: "Third issue\nDepends on #2" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const graph = await buildDependencyGraph(fetcher, "owner/repo", [1, 2, 3]);
  const order = resolveWorkOrder(graph);

  assertEquals(order.ready, [1]);
  assertEquals(order.blocked.length, 2);
  assertEquals(order.blocked.find((b) => b.issue === 2)?.blockedBy, [1]);
  assertEquals(order.blocked.find((b) => b.issue === 3)?.blockedBy, [2]);
});

Deno.test("integration - diamond dependency pattern", async () => {
  // #1 is ready
  // #2 depends on #1, #3 depends on #1
  // #4 depends on #2 and #3
  const issues = new Map<number, { state: "OPEN" | "CLOSED"; body: string }>([
    [1, { state: "OPEN", body: "Base issue" }],
    [2, { state: "OPEN", body: "Left branch\nDepends on #1" }],
    [3, { state: "OPEN", body: "Right branch\nDepends on #1" }],
    [4, { state: "OPEN", body: "Final merge\nDepends on #2\nDepends on #3" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const graph = await buildDependencyGraph(fetcher, "owner/repo", [1, 2, 3, 4]);
  const order = resolveWorkOrder(graph);

  assertEquals(order.ready, [1]);
  assertEquals(order.blocked.find((b) => b.issue === 4)?.blockedBy, [2, 3]);
});

// =============================================================================
// Issue #1808 — checkParentBlocked openStateMap (batched state lookup)
// =============================================================================

/**
 * Wrap a fetcher and count `getIssueState` invocations so the cache
 * tests can assert call-volume reductions.
 */
function instrumentFetcher(base: IssueFetcher): {
  fetcher: IssueFetcher;
  stateCalls: number[];
} {
  const stateCalls: number[] = [];
  const fetcher: IssueFetcher = {
    getIssueState: (repo, n) => {
      stateCalls.push(n);
      return base.getIssueState(repo, n);
    },
    getSubIssues: (repo, n) => base.getSubIssues(repo, n),
    getIssueBody: (repo, n) => base.getIssueBody(repo, n),
  };
  return { fetcher, stateCalls };
}

Deno.test(
  "checkParentBlocked - openStateMap hit: zero per-child getIssueState calls",
  async () => {
    const issues = new Map<
      number,
      { state: "OPEN" | "CLOSED"; body: string }
    >([
      [1, { state: "OPEN", body: "Parent" }],
      [10, { state: "OPEN", body: "Child A" }],
      [11, { state: "OPEN", body: "Child B" }],
      [12, { state: "OPEN", body: "Child C" }],
    ]);
    const subIssues = new Map([[1, [10, 11, 12]]]);
    const { fetcher, stateCalls } = instrumentFetcher(
      createMockFetcher(issues, subIssues),
    );

    // All three children are present in the open-state map.
    const map: Map<number, "OPEN"> = new Map([
      [10, "OPEN"],
      [11, "OPEN"],
      [12, "OPEN"],
    ]);

    const result = await checkParentBlocked(fetcher, "owner/repo", 1, map);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.isBlocked, true);
      assertEquals(result.value.openChildren, [10, 11, 12]);
      assertEquals(result.value.totalChildren, 3);
    }
    assertEquals(
      stateCalls.length,
      0,
      "warm cache path must not call getIssueState",
    );
  },
);

Deno.test(
  "checkParentBlocked - closed-issue fallback: missing children fall back to fetcher",
  async () => {
    const issues = new Map<
      number,
      { state: "OPEN" | "CLOSED"; body: string }
    >([
      [1, { state: "OPEN", body: "Parent" }],
      [10, { state: "OPEN", body: "Open child" }],
      [11, { state: "CLOSED", body: "Closed child" }],
    ]);
    const subIssues = new Map([[1, [10, 11]]]);
    const { fetcher, stateCalls } = instrumentFetcher(
      createMockFetcher(issues, subIssues),
    );

    // Only the open child is in the map — the closed one falls back.
    const map: Map<number, "OPEN"> = new Map([[10, "OPEN"]]);

    const result = await checkParentBlocked(fetcher, "owner/repo", 1, map);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.isBlocked, true);
      assertEquals(result.value.openChildren, [10]);
      assertEquals(result.value.closedChildren, [11]);
    }
    // Exactly one fallback call — for the closed child only.
    assertEquals(stateCalls, [11]);
  },
);

Deno.test(
  "checkParentBlocked - no map: behaviour unchanged (one call per child)",
  async () => {
    const issues = new Map<
      number,
      { state: "OPEN" | "CLOSED"; body: string }
    >([
      [1, { state: "OPEN", body: "Parent" }],
      [10, { state: "OPEN", body: "Child" }],
      [11, { state: "CLOSED", body: "Child" }],
    ]);
    const subIssues = new Map([[1, [10, 11]]]);
    const { fetcher, stateCalls } = instrumentFetcher(
      createMockFetcher(issues, subIssues),
    );

    const result = await checkParentBlocked(fetcher, "owner/repo", 1);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.isBlocked, true);
    }
    // Without the map, each child triggers a fetcher.getIssueState call.
    assertEquals(stateCalls.sort((a, b) => a - b), [10, 11]);
  },
);

Deno.test(
  "checkParentBlocked - openStateMap with all children open: not a single fallback",
  async () => {
    // Regression check: if the map covers every child, the fetcher
    // must never see a state lookup. This is the warm-path guarantee
    // for the dependency-blocking scan.
    const N = 25;
    const childNumbers = Array.from({ length: N }, (_, i) => 100 + i);
    const issues = new Map<
      number,
      { state: "OPEN" | "CLOSED"; body: string }
    >();
    issues.set(1, { state: "OPEN", body: "Parent" });
    for (const n of childNumbers) {
      issues.set(n, { state: "OPEN", body: "Child" });
    }
    const subIssues = new Map([[1, childNumbers]]);
    const { fetcher, stateCalls } = instrumentFetcher(
      createMockFetcher(issues, subIssues),
    );

    const map: Map<number, "OPEN"> = new Map(
      childNumbers.map((n) => [n, "OPEN" as const]),
    );

    const result = await checkParentBlocked(fetcher, "owner/repo", 1, map);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.openChildren.length, N);
    }
    assertEquals(stateCalls.length, 0);
  },
);
