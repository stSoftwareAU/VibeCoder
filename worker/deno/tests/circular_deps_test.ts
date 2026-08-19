/**
 * Additional circular dependency detection tests (Issue #630).
 *
 * The existing issue_dependencies_test.ts has a basic 2-node cycle test.
 * These tests cover additional edge cases:
 * - Three-node cycle (A -> B -> C -> A)
 * - Self-referencing dependency
 * - Cycle within a larger graph (some nodes not in cycle)
 * - Cycle detected via buildDependencyGraph + resolveWorkOrder integration
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  buildDependencyGraph,
  type DependencyNode,
  type IssueFetcher,
  type IssueState,
  resolveWorkOrder,
} from "../lib/issue_dependencies.ts";

/** Create a mock IssueFetcher with configurable responses. */
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
      if (!issue) throw new Error(`Issue #${issueNumber} not found`);
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
      if (!issue) throw new Error(`Issue #${issueNumber} not found`);
      return issue.body;
    },
  };
}

// =============================================================================
// Three-node cycle
// =============================================================================

Deno.test("circular_deps - detects three-node cycle (A -> B -> C -> A)", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 1, dependsOn: [2], state: "OPEN" },
    { issueNumber: 2, dependsOn: [3], state: "OPEN" },
    { issueNumber: 3, dependsOn: [1], state: "OPEN" },
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.circular.sort(), [1, 2, 3]);
  assertEquals(result.ready, []);
  assertEquals(result.blocked, []);
});

// =============================================================================
// Self-referencing dependency
// =============================================================================

Deno.test("circular_deps - detects self-referencing dependency", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 42, dependsOn: [42], state: "OPEN" },
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.circular, [42]);
  assertEquals(result.ready, []);
});

// =============================================================================
// Cycle within a larger graph
// =============================================================================

Deno.test("circular_deps - cycle within larger graph does not affect non-cyclic nodes", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 1, dependsOn: [], state: "OPEN" }, // Independent — ready
    { issueNumber: 2, dependsOn: [3], state: "OPEN" }, // Part of cycle
    { issueNumber: 3, dependsOn: [2], state: "OPEN" }, // Part of cycle
    { issueNumber: 4, dependsOn: [], state: "OPEN" }, // Independent — ready
  ];

  const result = resolveWorkOrder(nodes);

  assertEquals(result.circular.sort(), [2, 3]);
  assertEquals(result.ready.sort(), [1, 4]);
  assertEquals(result.blocked, []);
});

// =============================================================================
// Node depends on cyclic node but is not in cycle itself
// =============================================================================

Deno.test("circular_deps - node depending on cyclic node is also detected as circular", () => {
  const nodes: DependencyNode[] = [
    { issueNumber: 1, dependsOn: [2], state: "OPEN" }, // Cycle
    { issueNumber: 2, dependsOn: [1], state: "OPEN" }, // Cycle
    { issueNumber: 3, dependsOn: [1], state: "OPEN" }, // Depends on cyclic node
  ];

  const result = resolveWorkOrder(nodes);

  // The cycle detection walks the dependency chain from each node.
  // Node #3 depends on #1 which leads into the cycle, so #3 is also
  // detected as part of the circular set.
  assertEquals(result.circular.sort(), [1, 2, 3]);
  assertEquals(result.ready, []);
});

// =============================================================================
// Integration: circular deps detected via buildDependencyGraph
// =============================================================================

Deno.test("circular_deps - integration: detected via body dependency references", async () => {
  const issues = new Map<number, { state: "OPEN" | "CLOSED"; body: string }>([
    [10, { state: "OPEN", body: "Depends on #11" }],
    [11, { state: "OPEN", body: "Depends on #12" }],
    [12, { state: "OPEN", body: "Depends on #10" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const graph = await buildDependencyGraph(fetcher, "owner/repo", [10, 11, 12]);
  const order = resolveWorkOrder(graph);

  assertEquals(order.circular.sort(), [10, 11, 12]);
  assertEquals(order.ready, []);
});

Deno.test("circular_deps - integration: partial cycle with independent issues", async () => {
  const issues = new Map<number, { state: "OPEN" | "CLOSED"; body: string }>([
    [1, { state: "OPEN", body: "No dependencies" }],
    [2, { state: "OPEN", body: "Depends on #3" }],
    [3, { state: "OPEN", body: "Depends on #2" }],
    [4, { state: "OPEN", body: "Depends on #1" }],
  ]);
  const fetcher = createMockFetcher(issues);

  const graph = await buildDependencyGraph(fetcher, "owner/repo", [1, 2, 3, 4]);
  const order = resolveWorkOrder(graph);

  assertEquals(order.circular.sort(), [2, 3]);
  assertEquals(order.ready, [1]);
  // #4 depends on #1 which is ready, so #4 is blocked by #1 (which is open)
  const blocked4 = order.blocked.find((b) => b.issue === 4);
  assertExists(blocked4);
  assertEquals(blocked4.blockedBy, [1]);
});
