/**
 * Tests for planning_milestone.ts (Issue #2863).
 *
 * Covers the planning auto-milestone helper: when a planning run creates 2+
 * sub-issues and the parent has no milestone, a milestone named `#<N> <title>`
 * is auto-created (idempotently) and every sub-issue is assigned to it.
 *
 * Coverage:
 *   - buildPlanningMilestoneTitle: format and truncation.
 *   - Gate: parent already has a milestone → no-op.
 *   - Gate: fewer than two sub-issues → no-op.
 *   - Happy path: existing milestone reused (no POST), sub-issues assigned.
 *   - Happy path: no existing milestone → POST then assign.
 *   - Idempotency: duplicate sub-issue numbers collapse to one assign each.
 *   - Best-effort: ensure failure is swallowed (created=false, no throw).
 *   - Best-effort: a single assign failure does not abort the rest.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals } from "@std/assert";
import {
  buildPlanningMilestoneTitle,
  MAX_MILESTONE_TITLE_LENGTH,
  maybeCreatePlanningMilestone,
} from "../lib/planning_milestone.ts";
import type { Logger } from "../types.ts";

// A no-op logger that satisfies the Logger interface for tests.
const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  security() {},
  skipReason() {},
  timing() {},
  scanSummary() {},
  workerSummary() {},
};

// ---------------------------------------------------------------------------
// buildPlanningMilestoneTitle
// ---------------------------------------------------------------------------

Deno.test("buildPlanningMilestoneTitle — formats as #N title", () => {
  assertEquals(
    buildPlanningMilestoneTitle(42, "Add retry logic"),
    "#42 Add retry logic",
  );
});

Deno.test("buildPlanningMilestoneTitle — trims surrounding whitespace", () => {
  assertEquals(
    buildPlanningMilestoneTitle(7, "  spaced title  "),
    "#7 spaced title",
  );
});

Deno.test("buildPlanningMilestoneTitle — truncates over the limit", () => {
  const longTitle = "x".repeat(MAX_MILESTONE_TITLE_LENGTH + 50);
  const result = buildPlanningMilestoneTitle(1, longTitle);
  assertEquals(result.length, MAX_MILESTONE_TITLE_LENGTH);
  assertEquals(result.endsWith("…"), true);
});

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

Deno.test("maybeCreatePlanningMilestone — no-op when parent has a milestone", async () => {
  const calls: string[][] = [];
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    parentMilestoneTitle: "v1.0",
    subIssueNumbers: [10, 11, 12],
    ghCommandFn: (args) => {
      calls.push(args);
      return Promise.resolve("");
    },
    logger: silentLogger,
  });
  assertEquals(result.created, false);
  assertEquals(result.skippedReason, "parent-has-milestone");
  assertEquals(calls.length, 0);
});

Deno.test("maybeCreatePlanningMilestone — no-op for a single sub-issue", async () => {
  const calls: string[][] = [];
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10],
    ghCommandFn: (args) => {
      calls.push(args);
      return Promise.resolve("");
    },
    logger: silentLogger,
  });
  assertEquals(result.created, false);
  assertEquals(result.skippedReason, "too-few-sub-issues");
  assertEquals(calls.length, 0);
});

Deno.test("maybeCreatePlanningMilestone — no-op for zero sub-issues", async () => {
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    subIssueNumbers: [],
    ghCommandFn: () => Promise.resolve(""),
    logger: silentLogger,
  });
  assertEquals(result.created, false);
  assertEquals(result.skippedReason, "too-few-sub-issues");
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

Deno.test("maybeCreatePlanningMilestone — reuses existing milestone, no POST", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1]?.includes("?state=open")) {
      return Promise.resolve(JSON.stringify([
        { number: 3, title: "#5 Parent" },
        { number: 9, title: "other" },
      ]));
    }
    return Promise.resolve("");
  };

  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11],
    ghCommandFn,
    logger: silentLogger,
  });

  assertEquals(result.created, true);
  assertEquals(result.milestoneTitle, "#5 Parent");
  assertEquals(result.assigned, [10, 11]);
  // 1 listing + 2 assigns, no POST.
  assertEquals(calls.length, 3);
  assertEquals(calls.some((c) => c.includes("POST")), false);
  // Sub-issues edited with the milestone title.
  const edits = calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  assertEquals(edits.length, 2);
  assertEquals(edits[0]?.includes("--milestone"), true);
});

Deno.test("maybeCreatePlanningMilestone — creates milestone when none exists", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1]?.includes("?state=open")) {
      return Promise.resolve("[]");
    }
    if (args.includes("POST")) {
      return Promise.resolve(
        JSON.stringify({ number: 21, title: "#5 Parent" }),
      );
    }
    return Promise.resolve("");
  };

  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11, 12],
    ghCommandFn,
    logger: silentLogger,
  });

  assertEquals(result.created, true);
  assertEquals(result.milestoneTitle, "#5 Parent");
  assertEquals(result.assigned, [10, 11, 12]);
  // listing + POST + 3 assigns.
  assertEquals(calls.length, 5);
  assertEquals(calls.some((c) => c.includes("POST")), true);
});

Deno.test("maybeCreatePlanningMilestone — collapses duplicate sub-issue numbers", async () => {
  const edits: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.includes("?state=open")) {
      return Promise.resolve(
        JSON.stringify([{ number: 3, title: "#5 Parent" }]),
      );
    }
    if (args[0] === "issue" && args[1] === "edit") edits.push(args);
    return Promise.resolve("");
  };

  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 10, 11],
    ghCommandFn,
    logger: silentLogger,
  });

  assertEquals(result.assigned, [10, 11]);
  assertEquals(edits.length, 2);
});

// ---------------------------------------------------------------------------
// Best-effort error handling
// ---------------------------------------------------------------------------

Deno.test("maybeCreatePlanningMilestone — ensure failure is non-fatal", async () => {
  const ghCommandFn = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("network down"));

  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11],
    ghCommandFn,
    logger: silentLogger,
  });

  assertEquals(result.created, false);
  assertEquals(result.assigned, []);
});

Deno.test("maybeCreatePlanningMilestone — one assign failure does not abort the rest", async () => {
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.includes("?state=open")) {
      return Promise.resolve(
        JSON.stringify([{ number: 3, title: "#5 Parent" }]),
      );
    }
    if (args[0] === "issue" && args[1] === "edit" && args[2] === "11") {
      return Promise.reject(new Error("issue 11 locked"));
    }
    return Promise.resolve("");
  };

  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11, 12],
    ghCommandFn,
    logger: silentLogger,
  });

  assertEquals(result.created, true);
  // 11 failed; 10 and 12 still assigned.
  assertEquals(result.assigned, [10, 12]);
});
