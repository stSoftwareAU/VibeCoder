/**
 * Tests for the milestone open-children gate (Issue #3909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideSummaryPrMerge,
  fetchOpenMilestoneChildren,
  isMilestoneBranch,
  OPEN_CHILDREN_BLOCK_MARKER,
  postOpenChildrenBlockComment,
  renderOpenChildrenBlockComment,
} from "../lib/milestone_children_gate.ts";
import { MILESTONE_TRACKING_MARKER } from "../lib/milestone_tracker_identity.ts";

/**
 * Issue #1246: excluding a child from the blocking set is what lets the merge
 * (and the branch deletion) through, so it takes the tracking-issue body
 * marker and a fleet author on top of the title shape.
 */
const VERIFICATION = { authorOptions: { fleetAuthors: ["bot"] } };

// ---------------------------------------------------------------------------
// isMilestoneBranch
// ---------------------------------------------------------------------------

Deno.test("milestone_children_gate - isMilestoneBranch recognises milestone branches", () => {
  assertEquals(isMilestoneBranch("milestone/3872-security-scan"), true);
  assertEquals(isMilestoneBranch("issue-3909-block-auto-merge"), false);
  assertEquals(isMilestoneBranch("milestone/"), false);
  assertEquals(isMilestoneBranch("Develop"), false);
});

// ---------------------------------------------------------------------------
// fetchOpenMilestoneChildren
// ---------------------------------------------------------------------------

Deno.test("fetchOpenMilestoneChildren - counts open issues and PRs, skipping the tracker", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        { number: 10, title: "Open child issue" },
        {
          number: 11,
          title: "Merge milestone 'M1' to Develop",
          body: MILESTONE_TRACKING_MARKER,
          user: { login: "bot" },
        },
        { number: 12, title: "Milestone-assigned PR", pull_request: {} },
      ]);
    }
    if (key.includes("pr list")) {
      return JSON.stringify([{ number: 3901, title: "In-flight child PR" }]);
    }
    return "[]";
  };

  const result = await fetchOpenMilestoneChildren({
    repo: "owner/repo",
    milestoneNumber: 53,
    milestoneBranch: "milestone/m1",
    ghCommandFn: ghFn,
    verification: VERIFICATION,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.map((c) => c.number), [10, 12, 3901]);
  assertEquals(result.value[0]!.kind, "issue");
  assertEquals(result.value[1]!.kind, "pr");
  assertEquals(result.value[2]!.kind, "pr");
});

Deno.test("fetchOpenMilestoneChildren - excludes the summary PR itself", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("pr list")) {
      return JSON.stringify([{ number: 900, title: "Milestone: M1" }]);
    }
    return "[]";
  };

  const result = await fetchOpenMilestoneChildren({
    repo: "owner/repo",
    milestoneNumber: 53,
    milestoneBranch: "milestone/m1",
    excludePrNumbers: [900],
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length, 0);
});

Deno.test("fetchOpenMilestoneChildren - reads concatenated --paginate pages", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("/issues?milestone=")) {
      return '[{"number":1,"title":"a"}]\n[{"number":2,"title":"b"}]';
    }
    return "[]";
  };

  const result = await fetchOpenMilestoneChildren({
    repo: "owner/repo",
    milestoneNumber: 53,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.map((c) => c.number), [1, 2]);
});

Deno.test("fetchOpenMilestoneChildren - fails loud on an unreadable response", async () => {
  const ghFn = async (): Promise<string> => "not json";
  const result = await fetchOpenMilestoneChildren({
    repo: "owner/repo",
    milestoneNumber: 53,
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, false);
});

Deno.test("fetchOpenMilestoneChildren - rejects an invalid repo", async () => {
  const result = await fetchOpenMilestoneChildren({
    repo: "owner/repo; rm -rf /",
    milestoneNumber: 53,
    ghCommandFn: async () => "[]",
  });
  assertEquals(result.ok, false);
});

// ---------------------------------------------------------------------------
// decideSummaryPrMerge
// ---------------------------------------------------------------------------

Deno.test("decideSummaryPrMerge - allows a non-milestone PR without any lookup", async () => {
  let calls = 0;
  const decision = await decideSummaryPrMerge({
    repo: "owner/repo",
    prNumber: 1,
    headRefName: "issue-1-fix",
    ghCommandFn: async () => {
      calls++;
      return "[]";
    },
  });
  assertEquals(decision.decision, "allow");
  assertEquals(calls, 0);
});

Deno.test("decideSummaryPrMerge - allows when the branch matches no open milestone", async () => {
  const decision = await decideSummaryPrMerge({
    repo: "owner/repo",
    prNumber: 1,
    headRefName: "milestone/unknown",
    ghCommandFn: async () => JSON.stringify([{ number: 1, title: "Other" }]),
  });
  assertEquals(decision.decision, "allow");
  if (decision.decision === "allow") {
    assertEquals(decision.reason, "milestone-not-found");
  }
});

Deno.test("decideSummaryPrMerge - blocks when the milestone still has open children", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/milestones?state=open")) {
      return JSON.stringify([{ number: 53, title: "M1" }]);
    }
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([{ number: 3866, title: "Open child" }]);
    }
    return "[]";
  };

  const decision = await decideSummaryPrMerge({
    repo: "owner/repo",
    prNumber: 900,
    headRefName: "milestone/m1",
    ghCommandFn: ghFn,
  });

  assertEquals(decision.decision, "block");
  if (decision.decision === "block" && decision.reason === "open-children") {
    assertEquals(decision.milestoneNumber, 53);
    assertEquals(decision.children.map((c) => c.number), [3866]);
  }
});

// ---------------------------------------------------------------------------
// Comment rendering and idempotency
// ---------------------------------------------------------------------------

Deno.test("renderOpenChildrenBlockComment - names the milestone and every child", () => {
  const body = renderOpenChildrenBlockComment("M1", [
    { number: 3866, title: "Open child", kind: "issue" },
    { number: 3901, title: "In-flight PR", kind: "pr" },
  ]);
  assertStringIncludes(body, OPEN_CHILDREN_BLOCK_MARKER);
  assertStringIncludes(body, "M1");
  assertStringIncludes(body, "#3866 (issue): Open child");
  assertStringIncludes(body, "#3901 (pr): In-flight PR");
});

Deno.test("postOpenChildrenBlockComment - posts once, then never again", async () => {
  // Since Issue #1249 the dedup read projects the commenter, and only a
  // fleet-authored marker suppresses the comment — so the stub records who
  // posted and the options name the fleet.
  const comments: { author: string; body: string }[] = [];
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/comments?per_page=")) return JSON.stringify(comments);
    if (key.includes("pr comment")) {
      comments.push({
        author: "vibe-bot",
        body: args[args.indexOf("--body") + 1]!,
      });
      return "";
    }
    return "";
  };

  const options = {
    repo: "owner/repo",
    prNumber: 900,
    milestoneTitle: "M1",
    children: [{ number: 3866, title: "Open child", kind: "issue" as const }],
    ghCommandFn: ghFn,
    log: () => {},
    authorOptions: { fleetAuthors: ["vibe-bot"] },
  };

  assertEquals(await postOpenChildrenBlockComment(options), true);
  assertEquals(await postOpenChildrenBlockComment(options), false);
  assertEquals(await postOpenChildrenBlockComment(options), false);
  assertEquals(comments.length, 1);
});

Deno.test("postOpenChildrenBlockComment - posts nothing when the thread cannot be read", async () => {
  const logs: string[] = [];
  let posted = 0;
  const ghFn = async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("/comments?per_page=")) {
      throw new Error("HTTP 502 Bad Gateway");
    }
    posted++;
    return "";
  };

  const result = await postOpenChildrenBlockComment({
    repo: "owner/repo",
    prNumber: 900,
    milestoneTitle: "M1",
    children: [{ number: 3866, title: "Open child", kind: "issue" }],
    ghCommandFn: ghFn,
    log: (message) => logs.push(message),
  });

  assertEquals(result, false);
  assertEquals(posted, 0);
  assertStringIncludes(logs[0]!, "could not read comments");
});

// ---------------------------------------------------------------------------
// decideMilestoneBaseMerge (Issue #4396) — never merge into a milestone
// branch whose route to the default branch has already closed
// ---------------------------------------------------------------------------

import { decideMilestoneBaseMerge } from "../lib/milestone_children_gate.ts";

/** gh stub: `pr list --head <branch>` answers from `rollups`; milestones from `milestones`. */
function ghForBaseGate(scenario: {
  base?: string;
  rollups?: Array<
    { number: number; state: string; baseRefName: string; mergedAt?: string }
  >;
  milestones?: Array<{ number: number; title: string; state: string }>;
  fail?: "rollups" | "milestones";
}) {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr view") && key.includes("baseRefName")) {
      return JSON.stringify({ baseRefName: scenario.base ?? "Develop" });
    }
    if (key.includes("pr list") && key.includes("--head")) {
      if (scenario.fail === "rollups") throw new Error("HTTP 500");
      return JSON.stringify(scenario.rollups ?? []);
    }
    if (key.includes("/milestones?state=all")) {
      if (scenario.fail === "milestones") throw new Error("HTTP 500");
      return JSON.stringify(scenario.milestones ?? []);
    }
    return "[]";
  };
}

Deno.test("decideMilestoneBaseMerge - a non-milestone base is allowed without any lookup (Issue #4396)", async () => {
  let calls = 0;
  const d = await decideMilestoneBaseMerge({
    repo: "org/repo",
    prNumber: 1,
    baseRefName: "Develop",
    ghCommandFn: (args) => {
      calls++;
      return ghForBaseGate({})(args);
    },
  });
  assertEquals(d, { decision: "allow", reason: "not-milestone-base" });
  assertEquals(calls, 0);
});

Deno.test("decideMilestoneBaseMerge - an open milestone whose rollup has not merged is allowed (Issue #4396)", async () => {
  const d = await decideMilestoneBaseMerge({
    repo: "org/repo",
    prNumber: 1,
    baseRefName: "milestone/clean-up",
    ghCommandFn: ghForBaseGate({
      rollups: [{ number: 3125, state: "OPEN", baseRefName: "Develop" }],
      milestones: [{ number: 7, title: "Clean up", state: "open" }],
    }),
  });
  assertEquals(d.decision, "allow");
});

Deno.test("decideMilestoneBaseMerge - a merged rollup PR blocks, naming it (Issue #4396)", async () => {
  const d = await decideMilestoneBaseMerge({
    repo: "org/repo",
    prNumber: 3371,
    baseRefName: "milestone/clean-up",
    ghCommandFn: ghForBaseGate({
      rollups: [
        {
          number: 3125,
          state: "MERGED",
          baseRefName: "Develop",
          mergedAt: "2026-06-30T02:27:52Z",
        },
      ],
      milestones: [{ number: 7, title: "Clean up", state: "closed" }],
    }),
  });
  assertEquals(d.decision, "block");
  if (d.decision === "block") {
    assertEquals(d.reason, "rollup-merged");
    assertEquals(d.rollupPrNumber, 3125);
    assertEquals(d.milestoneBranch, "milestone/clean-up");
  }
});

Deno.test("decideMilestoneBaseMerge - a closed milestone blocks even with no rollup PR on record (Issue #4396)", async () => {
  const d = await decideMilestoneBaseMerge({
    repo: "org/repo",
    prNumber: 1,
    baseRefName: "milestone/clean-up",
    ghCommandFn: ghForBaseGate({
      rollups: [],
      milestones: [{ number: 7, title: "Clean up", state: "closed" }],
    }),
  });
  assertEquals(d.decision, "block");
  if (d.decision === "block") assertEquals(d.reason, "milestone-closed");
});

Deno.test("decideMilestoneBaseMerge - a milestone base that cannot be verified DEFERS, it does not block (Issue #477)", async () => {
  // Business-logic change from Issue #4396, which blocked here. A `block`
  // retargets the PR at the default branch, so an unreadable route — a
  // GitHub rate limit, certain across an unattended weekend — refused every
  // milestone child and moved the ones it could onto the review-gated
  // default branch, to wait for a human who was not there. "I could not
  // read it" is not evidence; only a merged rollup or a closed milestone is.
  const d = await decideMilestoneBaseMerge({
    repo: "org/repo",
    prNumber: 1,
    baseRefName: "milestone/clean-up",
    ghCommandFn: ghForBaseGate({ fail: "rollups" }),
  });
  assertEquals(d.decision, "defer");
  if (d.decision === "defer") assertEquals(d.reason, "lookup-failed");
});

Deno.test("decideMilestoneBaseMerge - resolves the base itself when the caller has none (Issue #4396)", async () => {
  const d = await decideMilestoneBaseMerge({
    repo: "org/repo",
    prNumber: 1,
    ghCommandFn: ghForBaseGate({
      base: "milestone/still-open",
      rollups: [],
      milestones: [{ number: 8, title: "Still open", state: "open" }],
    }),
  });
  assertEquals(d.decision, "allow");
});
