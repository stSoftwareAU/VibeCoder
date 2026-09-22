/**
 * Tests for the pure dependency-chain promotion resolver (Issue #2493).
 *
 * `resolveChainPromotions` walks the dependency chain behind every blocked
 * `top-priority`/`work-on` candidate and decides which chain members the
 * fleet should work now (at the blocked issue's tier) and which chain roots
 * are unworkable. It performs no I/O, so every branch is exercised here with
 * plain in-memory snapshots.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  chainIssueKey,
  type ChainPromotionInput,
  type ChainSnapshotIssue,
  resolveChainPromotions,
} from "../lib/dependency_chain_promotion.ts";
import type { DependencyBlocker } from "../lib/issue_dependencies.ts";

const REPO = "stSoftwareAU/VibeCoder";
const OTHER = "stSoftwareAU/Other";
const FLEET = "vibe-coder-bot";

function blocker(
  issueNumber: number,
  repo = REPO,
  kind: DependencyBlocker["kind"] = "depends-on",
): DependencyBlocker {
  return { repo, number: issueNumber, kind };
}

function snapshot(
  issueNumber: number,
  overrides: Partial<ChainSnapshotIssue> = {},
): ChainSnapshotIssue {
  return {
    repo: REPO,
    number: issueNumber,
    labels: ["enhancement"],
    assignees: [],
    blockers: [],
    ...overrides,
  };
}

function issueMap(
  ...issues: ChainSnapshotIssue[]
): Map<string, ChainSnapshotIssue> {
  return new Map(issues.map((i) => [chainIssueKey(i.repo, i.number), i]));
}

function input(
  overrides: Partial<ChainPromotionInput> = {},
): ChainPromotionInput {
  return {
    blocked: [],
    issues: new Map(),
    monitoredRepos: new Set([REPO]),
    discoveryLabels: ["enhancement", "bug"],
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Single chain
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - single chain promotes the open root at the blocked tier", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(101)],
    }],
    issues: issueMap(snapshot(101)),
  }));

  assertEquals(result.promoted, [{
    repo: REPO,
    number: 101,
    tier: "configured-label",
    promotedBy: { repo: REPO, number: 100 },
  }]);
  assertEquals(result.fleetWorking, []);
  assertEquals(result.unworkableRoots, []);
});

Deno.test("resolveChainPromotions - work-on chain promotes at the work-on tier", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "work-on",
      blockers: [blocker(101, REPO, "child")],
    }],
    issues: issueMap(snapshot(101)),
  }));

  assertEquals(result.promoted.map((p) => [p.number, p.tier]), [[
    101,
    "work-on",
  ]]);
});

// ---------------------------------------------------------------------------
// Shared root across tiers — highest tier wins
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - shared root takes the highest tier, emitted once", () => {
  const issues = issueMap(snapshot(300));
  const workOnFirst = resolveChainPromotions(input({
    blocked: [
      { repo: REPO, number: 100, tier: "work-on", blockers: [blocker(300)] },
      {
        repo: REPO,
        number: 200,
        tier: "configured-label",
        blockers: [blocker(300)],
      },
    ],
    issues,
  }));

  assertEquals(workOnFirst.promoted, [{
    repo: REPO,
    number: 300,
    tier: "configured-label",
    promotedBy: { repo: REPO, number: 200 },
  }]);

  // The reverse order must not downgrade the already-promoted member.
  const topFirst = resolveChainPromotions(input({
    blocked: [
      {
        repo: REPO,
        number: 200,
        tier: "configured-label",
        blockers: [blocker(300)],
      },
      { repo: REPO, number: 100, tier: "work-on", blockers: [blocker(300)] },
    ],
    issues,
  }));

  assertEquals(topFirst.promoted, [{
    repo: REPO,
    number: 300,
    tier: "configured-label",
    promotedBy: { repo: REPO, number: 200 },
  }]);
});

// ---------------------------------------------------------------------------
// Still-blocked middle member is walked through, never promoted
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - still-blocked middle member is skipped but walked through", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(101)],
    }],
    issues: issueMap(
      snapshot(101, { blockers: [blocker(102)] }),
      snapshot(102),
    ),
  }));

  assertEquals(result.promoted.map((p) => p.number), [102]);
  assertEquals(result.unworkableRoots, []);
});

Deno.test("resolveChainPromotions - a still-blocked member is not classified as unworkable", () => {
  // 101 is assigned to a human AND still blocked: it is walked through, and
  // only the terminal root 102 is reported.
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "work-on",
      blockers: [blocker(101)],
    }],
    issues: issueMap(
      snapshot(101, { assignees: ["alice"], blockers: [blocker(102)] }),
      snapshot(102, { assignees: ["bob"] }),
    ),
  }));

  assertEquals(result.promoted, []);
  assertEquals(result.unworkableRoots.map((u) => [u.root.number, u.reason]), [
    [102, "assigned"],
  ]);
});

// ---------------------------------------------------------------------------
// Cycles terminate and promote nothing
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - cycle terminates and promotes nothing on the cycle", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(101)],
    }],
    issues: issueMap(
      snapshot(101, { blockers: [blocker(102)] }),
      snapshot(102, { blockers: [blocker(101)] }),
    ),
  }));

  assertEquals(result.promoted, []);
  assertEquals(result.fleetWorking, []);
  assertEquals(result.unworkableRoots, []);
});

Deno.test("resolveChainPromotions - a blocked issue never promotes itself", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(100)],
    }],
    issues: issueMap(snapshot(100)),
  }));

  assertEquals(result.promoted, []);
  assertEquals(result.unworkableRoots, []);
});

Deno.test("resolveChainPromotions - a root reached past a cycle is still promoted", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "work-on",
      blockers: [blocker(101)],
    }],
    issues: issueMap(
      snapshot(101, { blockers: [blocker(102), blocker(103)] }),
      snapshot(102, { blockers: [blocker(101)] }),
      snapshot(103),
    ),
  }));

  assertEquals(result.promoted.map((p) => p.number), [103]);
});

// ---------------------------------------------------------------------------
// Cross-repo: monitored vs unmonitored
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - cross-repo root in a monitored repo is promoted", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(500, OTHER)],
    }],
    issues: issueMap(snapshot(500, { repo: OTHER })),
    monitoredRepos: new Set([REPO, OTHER]),
  }));

  assertEquals(result.promoted, [{
    repo: OTHER,
    number: 500,
    tier: "configured-label",
    promotedBy: { repo: REPO, number: 100 },
  }]);
});

Deno.test("resolveChainPromotions - cross-repo root in an unmonitored repo is unworkable", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(500, OTHER)],
    }],
    // The snapshot exists, but the repo is not monitored: the repo check
    // comes first, so it is still reported as cross-repo-unmonitored.
    issues: issueMap(snapshot(500, { repo: OTHER })),
    monitoredRepos: new Set([REPO]),
  }));

  assertEquals(result.promoted, []);
  assertEquals(result.unworkableRoots, [{
    blocked: { repo: REPO, number: 100 },
    root: { repo: OTHER, number: 500 },
    reason: "cross-repo-unmonitored",
    detail: OTHER,
  }]);
});

Deno.test("resolveChainPromotions - monitored repo matching ignores case", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(500, OTHER)],
    }],
    issues: issueMap(snapshot(500, { repo: OTHER })),
    // GitHub hands back either casing; the same repo must not read as foreign.
    monitoredRepos: new Set([REPO, OTHER.toUpperCase()]),
  }));

  assertEquals(result.unworkableRoots, []);
  assertEquals(result.promoted, [{
    repo: OTHER,
    number: 500,
    tier: "configured-label",
    promotedBy: { repo: REPO, number: 100 },
  }]);
});

// ---------------------------------------------------------------------------
// Assignees: fleet vs human
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - fleet assignee reports fleetWorking only", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(101)],
    }],
    issues: issueMap(snapshot(101, { assignees: ["Vibe-Coder-Bot"] })),
  }));

  assertEquals(result.fleetWorking, [{
    blocked: { repo: REPO, number: 100 },
    root: { repo: REPO, number: 101 },
    assignee: "Vibe-Coder-Bot",
  }]);
  assertEquals(result.promoted, []);
  assertEquals(result.unworkableRoots, []);
});

Deno.test("resolveChainPromotions - a fleet assignee outranks a human co-assignee", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "work-on",
      blockers: [blocker(101)],
    }],
    issues: issueMap(snapshot(101, { assignees: ["alice", FLEET] })),
  }));

  assertEquals(result.fleetWorking.map((f) => f.assignee), [FLEET]);
  assertEquals(result.unworkableRoots, []);
});

Deno.test("resolveChainPromotions - human assignee is unworkable with the login in detail", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(101)],
    }],
    issues: issueMap(snapshot(101, { assignees: ["alice"] })),
  }));

  assertEquals(result.unworkableRoots, [{
    blocked: { repo: REPO, number: 100 },
    root: { repo: REPO, number: 101 },
    reason: "assigned",
    detail: "alice",
  }]);
  assertEquals(result.promoted, []);
  assertEquals(result.fleetWorking, []);
});

// ---------------------------------------------------------------------------
// needs-human root
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - needs-human root is unworkable and outranks assignment", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(101)],
    }],
    issues: issueMap(
      snapshot(101, {
        labels: ["enhancement", "needs-human"],
        assignees: ["alice"],
      }),
    ),
  }));

  assertEquals(result.unworkableRoots, [{
    blocked: { repo: REPO, number: 100 },
    root: { repo: REPO, number: 101 },
    reason: "needs-human",
    detail: "needs-human",
  }]);
  assertEquals(result.promoted, []);
});

// ---------------------------------------------------------------------------
// Unlabelled root
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - root without a discovery label is unworkable", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "work-on",
      blockers: [blocker(101)],
    }],
    issues: issueMap(snapshot(101, { labels: ["documentation"] })),
  }));

  assertEquals(result.unworkableRoots, [{
    blocked: { repo: REPO, number: 100 },
    root: { repo: REPO, number: 101 },
    reason: "no-discovery-label",
    detail: "documentation",
  }]);
  assertEquals(result.promoted, []);
});

Deno.test("resolveChainPromotions - root with no labels at all is unworkable", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "work-on",
      blockers: [blocker(101)],
    }],
    issues: issueMap(snapshot(101, { labels: [] })),
  }));

  assertEquals(result.unworkableRoots.map((u) => u.reason), [
    "no-discovery-label",
  ]);
});

Deno.test("resolveChainPromotions - discovery label matching ignores case and padding", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "work-on",
      blockers: [blocker(101)],
    }],
    issues: issueMap(snapshot(101, { labels: [" Enhancement "] })),
  }));

  assertEquals(result.promoted.map((p) => p.number), [101]);
  assertEquals(result.unworkableRoots, []);
});

// ---------------------------------------------------------------------------
// Unknown root
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - unknown root in a monitored repo yields nothing", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [blocker(999)],
    }],
    issues: new Map(),
  }));

  assertEquals(result.promoted, []);
  assertEquals(result.fleetWorking, []);
  assertEquals(result.unworkableRoots, []);
});

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - empty input yields empty results", () => {
  const result = resolveChainPromotions(input());

  assertEquals(result, {
    promoted: [],
    fleetWorking: [],
    unworkableRoots: [],
  });
});

Deno.test("resolveChainPromotions - blocked issue with no blockers yields nothing", () => {
  const result = resolveChainPromotions(input({
    blocked: [{
      repo: REPO,
      number: 100,
      tier: "configured-label",
      blockers: [],
    }],
    issues: issueMap(snapshot(101)),
  }));

  assertEquals(result.promoted, []);
});

// ---------------------------------------------------------------------------
// Key helper
// ---------------------------------------------------------------------------

Deno.test("chainIssueKey - renders the owner/repo#N snapshot key", () => {
  assertEquals(chainIssueKey(REPO, 101), "stSoftwareAU/VibeCoder#101");
});

// ---------------------------------------------------------------------------
// Two blocked issues reaching different classifications
// ---------------------------------------------------------------------------

Deno.test("resolveChainPromotions - one unworkable root is reported per blocked issue that reaches it", () => {
  const issues = issueMap(snapshot(300, { assignees: ["alice"] }));
  const result = resolveChainPromotions(input({
    blocked: [
      {
        repo: REPO,
        number: 100,
        tier: "configured-label",
        blockers: [blocker(300)],
      },
      { repo: REPO, number: 200, tier: "work-on", blockers: [blocker(300)] },
    ],
    issues,
  }));

  assertEquals(result.unworkableRoots.map((u) => u.blocked.number), [100, 200]);
});
