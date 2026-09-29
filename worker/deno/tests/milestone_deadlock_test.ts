/**
 * Tests for the cross-milestone dependency deadlock detector (Issue #2829).
 */

import { assertEquals } from "@std/assert";
import {
  detectMilestoneDeadlocks,
  type MilestoneDependencyGraph,
} from "../lib/milestone_deadlock.ts";

const WEB_SRC = "#1441 web src";
const CRATES_API = "#1441 crates api";

/** The GRQ-AutoTrader shape: #1459 is held by closed #1456 in "web src",
 * while web src's open #1461 needs #1460, which needs #1459. */
function autoTraderGraph(): MilestoneDependencyGraph {
  return {
    openIssues: [
      { number: 1459, milestone: CRATES_API, dependsOn: [1456] },
      { number: 1460, milestone: WEB_SRC, dependsOn: [1459] },
      { number: 1461, milestone: WEB_SRC, dependsOn: [1460] },
    ],
    closedDependencies: [{ number: 1456, milestone: WEB_SRC }],
    openMilestones: new Set([WEB_SRC, CRATES_API]),
  };
}

Deno.test("detectMilestoneDeadlocks - reports the GRQ-AutoTrader deadlock", () => {
  assertEquals(detectMilestoneDeadlocks(autoTraderGraph()), [
    {
      milestone: WEB_SRC,
      heldIssue: 1459,
      closedDependency: 1456,
      blockingOpenIssues: [1460, 1461],
    },
  ]);
});

Deno.test("detectMilestoneDeadlocks - follows a chain through another milestone", () => {
  const graph = autoTraderGraph();
  graph.openIssues = [
    { number: 1459, milestone: CRATES_API, dependsOn: [1456] },
    { number: 1460, milestone: "other", dependsOn: [1459] },
    { number: 1461, milestone: WEB_SRC, dependsOn: [1460] },
  ];
  graph.openMilestones = new Set([WEB_SRC, CRATES_API, "other"]);
  assertEquals(detectMilestoneDeadlocks(graph), [
    {
      milestone: WEB_SRC,
      heldIssue: 1459,
      closedDependency: 1456,
      blockingOpenIssues: [1461],
    },
  ]);
});

Deno.test("detectMilestoneDeadlocks - a held issue with no path back reports nothing", () => {
  const graph = autoTraderGraph();
  graph.openIssues = [
    { number: 1459, milestone: CRATES_API, dependsOn: [1456] },
    { number: 1460, milestone: WEB_SRC, dependsOn: [] },
    { number: 1461, milestone: WEB_SRC, dependsOn: [1460] },
  ];
  assertEquals(detectMilestoneDeadlocks(graph), []);
});

Deno.test("detectMilestoneDeadlocks - a dependant outside the dependency's milestone is not a deadlock", () => {
  const graph = autoTraderGraph();
  graph.openIssues = [
    { number: 1459, milestone: CRATES_API, dependsOn: [1456] },
    { number: 1460, milestone: CRATES_API, dependsOn: [1459] },
  ];
  assertEquals(detectMilestoneDeadlocks(graph), []);
});

Deno.test("detectMilestoneDeadlocks - dependency cycles terminate without duplicate results", () => {
  const graph = autoTraderGraph();
  graph.openIssues = [
    { number: 1459, milestone: CRATES_API, dependsOn: [1456, 1461] },
    { number: 1460, milestone: WEB_SRC, dependsOn: [1459, 1461] },
    { number: 1461, milestone: WEB_SRC, dependsOn: [1460] },
  ];
  assertEquals(detectMilestoneDeadlocks(graph), [
    {
      milestone: WEB_SRC,
      heldIssue: 1459,
      closedDependency: 1456,
      blockingOpenIssues: [1460, 1461],
    },
  ]);
});

Deno.test("detectMilestoneDeadlocks - multiple held issues against one milestone yield one result", () => {
  const graph = autoTraderGraph();
  graph.openIssues = [
    { number: 1459, milestone: CRATES_API, dependsOn: [1456] },
    { number: 1462, milestone: CRATES_API, dependsOn: [1456, 1457] },
    { number: 1460, milestone: WEB_SRC, dependsOn: [1459, 1462] },
    { number: 1461, milestone: WEB_SRC, dependsOn: [1460] },
  ];
  graph.closedDependencies = [
    { number: 1456, milestone: WEB_SRC },
    { number: 1457, milestone: WEB_SRC },
  ];
  const results = detectMilestoneDeadlocks(graph);
  assertEquals(results.length, 1);
  assertEquals(results[0]?.milestone, WEB_SRC);
  // Deterministic: the lowest held issue and dependency are named.
  assertEquals(results[0]?.heldIssue, 1459);
  assertEquals(results[0]?.closedDependency, 1456);
});

Deno.test("detectMilestoneDeadlocks - reports each blocked milestone separately", () => {
  const graph: MilestoneDependencyGraph = {
    openIssues: [
      { number: 1, milestone: "A", dependsOn: [10] },
      { number: 2, milestone: "B", dependsOn: [1] },
      { number: 3, milestone: "B", dependsOn: [20] },
      { number: 4, milestone: "C", dependsOn: [3] },
    ],
    closedDependencies: [
      { number: 10, milestone: "B" },
      { number: 20, milestone: "C" },
    ],
    openMilestones: new Set(["A", "B", "C"]),
  };
  assertEquals(detectMilestoneDeadlocks(graph), [
    {
      milestone: "B",
      heldIssue: 1,
      closedDependency: 10,
      blockingOpenIssues: [2],
    },
    {
      milestone: "C",
      heldIssue: 3,
      closedDependency: 20,
      blockingOpenIssues: [4],
    },
  ]);
});

Deno.test("detectMilestoneDeadlocks - a dependency in a closed milestone is not held", () => {
  const graph = autoTraderGraph();
  graph.openMilestones = new Set([CRATES_API]);
  assertEquals(detectMilestoneDeadlocks(graph), []);
});

Deno.test("detectMilestoneDeadlocks - a dependency in the same milestone is not held", () => {
  const graph = autoTraderGraph();
  graph.openIssues = [
    { number: 1459, milestone: WEB_SRC, dependsOn: [1456] },
    { number: 1460, milestone: WEB_SRC, dependsOn: [1459] },
  ];
  assertEquals(detectMilestoneDeadlocks(graph), []);
});

Deno.test("detectMilestoneDeadlocks - a dependency with no milestone is not held", () => {
  const graph = autoTraderGraph();
  graph.closedDependencies = [{ number: 1456, milestone: null }];
  assertEquals(detectMilestoneDeadlocks(graph), []);
});

Deno.test("detectMilestoneDeadlocks - an empty graph reports nothing", () => {
  assertEquals(
    detectMilestoneDeadlocks({
      openIssues: [],
      closedDependencies: [],
      openMilestones: new Set(),
    }),
    [],
  );
});
