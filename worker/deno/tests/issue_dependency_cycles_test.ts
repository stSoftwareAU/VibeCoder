/**
 * Tests for dependency-cycle detection (Issue #2752).
 *
 * Covers the pure graph helpers added to `issue_dependencies.ts`:
 *   - `detectDependencyCycles` — flags every issue on a cycle exactly once,
 *     flags nothing for an acyclic graph, and does not flag a node that
 *     merely points into a cycle.
 *   - `findCyclePath` — renders a concrete loop path for messaging.
 *   - `buildWorkOnDependencyGraph` — O(n) edge extraction restricted to the
 *     supplied issue set.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  buildWorkOnDependencyGraph,
  type DependencyNode,
  detectDependencyCycles,
  findCyclePath,
  type IssueFetcher,
  type IssueState,
} from "../lib/issue_dependencies.ts";

function node(
  issueNumber: number,
  dependsOn: number[] = [],
  childOf?: number,
): DependencyNode {
  return { issueNumber, dependsOn, childOf, state: "OPEN" };
}

// ---------------------------------------------------------------------------
// detectDependencyCycles
// ---------------------------------------------------------------------------

Deno.test("detectDependencyCycles - direct A→B→A cycle flags both", () => {
  const nodes = [node(340, [341]), node(341, [340])];
  assertEquals(detectDependencyCycles(nodes), [340, 341]);
});

Deno.test("detectDependencyCycles - acyclic graph flags nothing", () => {
  const nodes = [node(1, [2]), node(2, [3]), node(3, [])];
  assertEquals(detectDependencyCycles(nodes), []);
});

Deno.test(
  "detectDependencyCycles - node pointing into a cycle is not flagged",
  () => {
    // 3 → 1 → 2 → 1. Node 3 reaches the cycle but is not part of it.
    const nodes = [node(3, [1]), node(1, [2]), node(2, [1])];
    assertEquals(detectDependencyCycles(nodes), [1, 2]);
  },
);

Deno.test("detectDependencyCycles - parent/child cycle is detected", () => {
  // Parent 10 has child 11 (10→11); child 11 depends on parent 10 (11→10).
  const nodes = [node(10), node(11, [10], 10)];
  assertEquals(detectDependencyCycles(nodes), [10, 11]);
});

Deno.test("detectDependencyCycles - three-node cycle flags all three", () => {
  const nodes = [node(1, [2]), node(2, [3]), node(3, [1])];
  assertEquals(detectDependencyCycles(nodes), [1, 2, 3]);
});

Deno.test("detectDependencyCycles - self-loop is detected", () => {
  const nodes = [node(7, [7])];
  assertEquals(detectDependencyCycles(nodes), [7]);
});

// ---------------------------------------------------------------------------
// findCyclePath
// ---------------------------------------------------------------------------

Deno.test("findCyclePath - returns the loop rooted at start", () => {
  const nodes = [node(340, [341]), node(341, [340])];
  assertEquals(findCyclePath(nodes, 340), [340, 341]);
  assertEquals(findCyclePath(nodes, 341), [341, 340]);
});

Deno.test("findCyclePath - self-loop returns the single node", () => {
  assertEquals(findCyclePath([node(7, [7])], 7), [7]);
});

Deno.test("findCyclePath - acyclic start returns empty", () => {
  const nodes = [node(1, [2]), node(2, [])];
  assertEquals(findCyclePath(nodes, 1), []);
});

// ---------------------------------------------------------------------------
// buildWorkOnDependencyGraph
// ---------------------------------------------------------------------------

function makeFetcher(
  bodies: Record<number, string>,
  subIssues: Record<number, number[]> = {},
): IssueFetcher {
  return {
    getIssueBody: (_repo: string, n: number) =>
      Promise.resolve(bodies[n] ?? ""),
    getSubIssues: (_repo: string, n: number) =>
      Promise.resolve(subIssues[n] ?? []),
    getIssueState: (_repo: string, n: number): Promise<IssueState> =>
      Promise.resolve({ number: n, state: "OPEN" }),
  };
}

Deno.test(
  "buildWorkOnDependencyGraph - extracts a forward-dependency cycle within the set",
  async () => {
    const fetcher = makeFetcher({
      340: "Depends on #341",
      341: "Blocked by #340",
    });
    const graph = await buildWorkOnDependencyGraph(fetcher, "owner/repo", [
      340,
      341,
    ]);
    assertEquals(detectDependencyCycles(graph), [340, 341]);
  },
);

Deno.test(
  "buildWorkOnDependencyGraph - ignores edges that leave the set",
  async () => {
    // 1 depends on 99 (not in the set) — no edge recorded, so no cycle.
    const fetcher = makeFetcher({ 1: "Depends on #99", 2: "" });
    const graph = await buildWorkOnDependencyGraph(fetcher, "owner/repo", [
      1,
      2,
    ]);
    assertEquals(graph.find((n) => n.issueNumber === 1)?.dependsOn, []);
    assertEquals(detectDependencyCycles(graph), []);
  },
);

Deno.test(
  "buildWorkOnDependencyGraph - records parent/child edges from sub-issues",
  async () => {
    const fetcher = makeFetcher(
      { 10: "", 11: "Depends on #10" },
      { 10: [11] },
    );
    const graph = await buildWorkOnDependencyGraph(fetcher, "owner/repo", [
      10,
      11,
    ]);
    assertEquals(graph.find((n) => n.issueNumber === 11)?.childOf, 10);
    // 10→11 (parent) and 11→10 (depends-on) closes a cycle.
    assertEquals(detectDependencyCycles(graph), [10, 11]);
  },
);
