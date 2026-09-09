/**
 * Tests for planning_milestone.ts (Issue #2863, #1690).
 *
 * Covers the planning auto-milestone helper: when a planning run creates 2+
 * sub-issues and the parent has no milestone, a milestone named
 * `#<N> <short description>` is auto-created (idempotently) and every
 * sub-issue is assigned to it.
 *
 * Coverage:
 *   - buildPlanningMilestoneTitle: format, sanitisation, bounded length,
 *     word-boundary truncation, collision resistance and input validation
 *     (Issue #1690, with the #1653 quoted `session limit` regression fixture).
 *   - Lookup/reuse: structured marker, exact title, and the legacy `#<N>`
 *     prefix that keeps milestone #50-style titles discoverable.
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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildPlanningMilestoneTitle,
  MAX_MILESTONE_TITLE_LENGTH,
  maybeCreatePlanningMilestone,
  planningMilestoneMarker,
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
  assertEquals(result.startsWith("#1 x"), true);
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

// ---------------------------------------------------------------------------
// Safe, short titles (Issue #1690)
// ---------------------------------------------------------------------------

/**
 * Regression fixture from milestone #50 — the parent title of issue #1653,
 * whose embedded quotes and length made the milestone awkward in CLI and
 * search contexts.
 */
const SESSION_LIMIT_TITLE =
  `The CLI now says "hit your session limit", which is misleading when the ` +
  `credential pool still has spare capacity — reword it`;

Deno.test("buildPlanningMilestoneTitle — #1653 quoted session-limit title is short and quote-free", () => {
  const title = buildPlanningMilestoneTitle(1653, SESSION_LIMIT_TITLE);
  assertEquals(title.startsWith("#1653 "), true);
  assertEquals(title.length <= MAX_MILESTONE_TITLE_LENGTH, true);
  assertEquals(/["'`‘’“”]/.test(title), false);
  // Enough words survive to identify the milestone.
  assertStringIncludes(title, "session limit");
});

Deno.test("buildPlanningMilestoneTitle — strips newlines and control characters", () => {
  const title = buildPlanningMilestoneTitle(
    9,
    "Line one\nline\ttwo\u0007and  three",
  );
  assertEquals(title, "#9 Line one line two and three");
  // The control-character class is the point of this assertion.
  // deno-lint-ignore no-control-regex
  assertEquals(/[\u0000-\u001F]/u.test(title), false);
});

Deno.test("buildPlanningMilestoneTitle — truncates on a word boundary, no trailing punctuation", () => {
  const source =
    "Refactor the credential pool selection strategy, then document it";
  const title = buildPlanningMilestoneTitle(12, source);
  assertEquals(title.length <= MAX_MILESTONE_TITLE_LENGTH, true);
  assertEquals(/[\s,.:;+&\-_/()]$/.test(title), false);
  // The cut lands between words — every kept word is whole.
  assertEquals(source.startsWith(title.slice("#12 ".length)), true);
});

Deno.test("buildPlanningMilestoneTitle — similar titles on different parents cannot collide", () => {
  const shared = "Improve the milestone planner naming behaviour everywhere";
  const a = buildPlanningMilestoneTitle(101, shared);
  const b = buildPlanningMilestoneTitle(102, shared);
  assertEquals(a === b, false);
  assertEquals(a.startsWith("#101 "), true);
  assertEquals(b.startsWith("#102 "), true);
});

Deno.test("buildPlanningMilestoneTitle — a title of only unsafe characters falls back to the number", () => {
  assertEquals(buildPlanningMilestoneTitle(77, '"""\n'), "#77");
});

Deno.test("buildPlanningMilestoneTitle — prefers an explicit short planning title", () => {
  assertEquals(
    buildPlanningMilestoneTitle(5, SESSION_LIMIT_TITLE, "Credential pool"),
    "#5 Credential pool",
  );
  // An explicit title that sanitises to nothing falls back to the issue title.
  assertEquals(
    buildPlanningMilestoneTitle(5, "Parent title", '"'),
    "#5 Parent title",
  );
});

Deno.test("buildPlanningMilestoneTitle — rejects a non-positive issue number", () => {
  assertThrows(
    () => buildPlanningMilestoneTitle(0, "Parent"),
    Error,
    "invalid parent issue number",
  );
  assertThrows(
    () => buildPlanningMilestoneTitle(1.5, "Parent"),
    Error,
    "invalid parent issue number",
  );
});

// ---------------------------------------------------------------------------
// Lookup and reuse (Issue #1690)
// ---------------------------------------------------------------------------

Deno.test("maybeCreatePlanningMilestone — reuses a legacy long-titled milestone (#50 shape)", async () => {
  const legacyTitle = `#1653 ${SESSION_LIMIT_TITLE}`;
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1]?.includes("?state=open")) {
      return Promise.resolve(JSON.stringify([
        { number: 50, title: legacyTitle, description: "" },
        { number: 51, title: "#165 Unrelated", description: "" },
      ]));
    }
    return Promise.resolve("");
  };

  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 1653,
    parentIssueTitle: SESSION_LIMIT_TITLE,
    subIssueNumbers: [10, 11],
    ghCommandFn,
    logger: silentLogger,
  });

  assertEquals(result.created, true);
  assertEquals(result.milestoneNumber, 50);
  // No rename, and the legacy title is what the sub-issues are assigned to.
  assertEquals(result.milestoneTitle, legacyTitle);
  assertEquals(calls.some((c) => c.includes("POST")), false);
  assertEquals(calls.some((c) => c.includes("PATCH")), false);
  const edits = calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  assertEquals(edits.length, 2);
  assertEquals(edits[0]?.[edits[0].length - 1], legacyTitle);
});

Deno.test("maybeCreatePlanningMilestone — reuses by structured marker after a rename", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1]?.includes("?state=open")) {
      return Promise.resolve(JSON.stringify([{
        number: 7,
        title: "Renamed by a human",
        description: `${planningMilestoneMarker(88)} grouping`,
      }]));
    }
    return Promise.resolve("");
  };

  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 88,
    parentIssueTitle: "Parent",
    subIssueNumbers: [1, 2],
    ghCommandFn,
    logger: silentLogger,
  });

  assertEquals(result.milestoneNumber, 7);
  assertEquals(result.milestoneTitle, "Renamed by a human");
  assertEquals(calls.some((c) => c.includes("POST")), false);
});

Deno.test("maybeCreatePlanningMilestone — new milestone carries the safe title and the parent marker", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1]?.includes("?state=open")) {
      return Promise.resolve("[]");
    }
    if (args.includes("POST")) {
      const titleField = args.find((a) => a.startsWith("title=")) ?? "";
      return Promise.resolve(JSON.stringify({
        number: 21,
        title: titleField.slice("title=".length),
      }));
    }
    return Promise.resolve("");
  };

  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 1653,
    parentIssueTitle: SESSION_LIMIT_TITLE,
    subIssueNumbers: [10, 11],
    ghCommandFn,
    logger: silentLogger,
  });

  const post = calls.find((c) => c.includes("POST"));
  assertEquals(post !== undefined, true);
  const postedTitle = post!.find((a) => a.startsWith("title="))!.slice(
    "title=".length,
  );
  assertEquals(
    postedTitle,
    buildPlanningMilestoneTitle(1653, SESSION_LIMIT_TITLE),
  );
  assertEquals(postedTitle.length <= MAX_MILESTONE_TITLE_LENGTH, true);
  assertEquals(postedTitle.includes('"'), false);
  const postedDescription = post!.find((a) => a.startsWith("description="))!;
  assertStringIncludes(postedDescription, planningMilestoneMarker(1653));
  assertEquals(result.milestoneTitle, postedTitle);
  assertEquals(result.milestoneNumber, 21);
});

Deno.test("buildPlanningMilestoneTitle — shell metacharacters become spaces", () => {
  assertEquals(
    buildPlanningMilestoneTitle(3, "Fix $HOME & CI/CD (staging) <prod>"),
    "#3 Fix HOME CI CD staging prod",
  );
});

Deno.test("buildPlanningMilestoneTitle — truncation never splits an astral character", () => {
  // Each CJK Extension B ideograph is two UTF-16 units; slicing by unit would
  // leave a lone surrogate that GitHub rejects.
  const title = buildPlanningMilestoneTitle(1, "\u{20000}".repeat(80));
  assertEquals(title.length <= MAX_MILESTONE_TITLE_LENGTH, true);
  for (const character of title) {
    const code = character.codePointAt(0)!;
    assertEquals(code < 0xd800 || code > 0xdfff, true);
  }
});

Deno.test("maybeCreatePlanningMilestone — lists a full page of milestones", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1]?.includes("/milestones?")) {
      return Promise.resolve("[]");
    }
    if (args.includes("POST")) {
      return Promise.resolve(JSON.stringify({ number: 4, title: "#5 Parent" }));
    }
    return Promise.resolve("");
  };

  await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11],
    ghCommandFn,
    logger: silentLogger,
  });

  // The default page is 30 — an existing milestone past it would be missed and
  // duplicated.
  const listing = calls.find((c) => c[1]?.includes("/milestones?"));
  assertStringIncludes(listing?.[1] ?? "", "per_page=100");
});
