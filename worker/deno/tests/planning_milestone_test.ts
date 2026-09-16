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

// ---------------------------------------------------------------------------
// Grouped milestones — one milestone per file-area group (Issue #2175)
// ---------------------------------------------------------------------------

Deno.test("buildPlanningMilestoneTitle — area goes before a colon", () => {
  assertEquals(
    buildPlanningMilestoneTitle(
      2163,
      "Parent title",
      "options trading",
      "infra",
    ),
    "#2163 infra: options trading",
  );
});

Deno.test("buildPlanningMilestoneTitle — a blank area keeps today's shape", () => {
  assertEquals(
    buildPlanningMilestoneTitle(5, "Parent title", undefined, "   "),
    "#5 Parent title",
  );
  assertEquals(
    buildPlanningMilestoneTitle(5, "Parent title", undefined, ""),
    "#5 Parent title",
  );
  // An area of only unsafe characters sanitises away to the same shape.
  assertEquals(
    buildPlanningMilestoneTitle(5, "Parent title", undefined, '"$&"'),
    "#5 Parent title",
  );
});

Deno.test("buildPlanningMilestoneTitle — the area is sanitised with the allowlist", () => {
  assertEquals(
    buildPlanningMilestoneTitle(7, "Parent", "short", 'worker/deno "lib"'),
    "#7 worker deno lib: short",
  );
});

Deno.test("buildPlanningMilestoneTitle — a long area keeps the prefix, the colon and a description", () => {
  const longArea =
    "worker deno lib planning milestone processor and every adjacent module";
  const title = buildPlanningMilestoneTitle(
    2163,
    "Group the sub-issues of a plan by the file area each one touches",
    undefined,
    longArea,
  );
  assertEquals(title.length <= MAX_MILESTONE_TITLE_LENGTH, true);
  assertEquals(title.startsWith("#2163 "), true);
  assertStringIncludes(title, ": ");
  // Both halves are cut on a word boundary — no half words either side.
  const area = title.slice("#2163 ".length, title.indexOf(":"));
  assertEquals(longArea.startsWith(area), true);
  const description = title.slice(title.indexOf(": ") + 2);
  assertEquals(description === "", false);
});

Deno.test("buildPlanningMilestoneTitle — a long description is cut, the area and colon survive", () => {
  const title = buildPlanningMilestoneTitle(
    42,
    "x".repeat(MAX_MILESTONE_TITLE_LENGTH * 2),
    undefined,
    "docs",
  );
  assertEquals(title.length <= MAX_MILESTONE_TITLE_LENGTH, true);
  assertEquals(title.startsWith("#42 docs: x"), true);
});

Deno.test("planningMilestoneMarker — carries the area when one is given", () => {
  assertEquals(
    planningMilestoneMarker(2163, "infra"),
    '<!-- planning-milestone parent="2163" area="infra" -->',
  );
  // No area → today's marker, so pre-#2175 milestones still match.
  assertEquals(
    planningMilestoneMarker(2163),
    '<!-- planning-milestone parent="2163" -->',
  );
  assertEquals(
    planningMilestoneMarker(2163, "   "),
    '<!-- planning-milestone parent="2163" -->',
  );
  // The area is sanitised, so a quote can never break out of the attribute.
  assertEquals(
    planningMilestoneMarker(2163, 'infra" --><script>'),
    '<!-- planning-milestone parent="2163" area="infra -- script" -->',
  );
});

/** Group shape the gate hands `maybeCreatePlanningMilestone` (Issue #2172). */
function group(area: string, title: string, subIssueNumbers: number[]) {
  return { area, title, subIssueNumbers };
}

/** A gh stub that records calls and answers listings/creates from `state`. */
function groupedGh(state: {
  listing: unknown[];
  calls: string[][];
  failEdits?: number[];
  failPostFor?: string[];
}) {
  const nextNumber = () =>
    Math.max(
      99,
      ...state.listing.map((m) => (m as { number: number }).number),
    ) + 1;
  return (args: string[]): Promise<string> => {
    state.calls.push(args);
    if (args[0] === "api" && args[1]?.includes("/milestones?")) {
      return Promise.resolve(JSON.stringify(state.listing));
    }
    if (args.includes("POST")) {
      const title = (args.find((a) => a.startsWith("title=")) ?? "").slice(
        "title=".length,
      );
      if (state.failPostFor?.some((t) => title.includes(t))) {
        return Promise.reject(new Error(`cannot create ${title}`));
      }
      const description = (args.find((a) => a.startsWith("description=")) ?? "")
        .slice(
          "description=".length,
        );
      const created = { number: nextNumber(), title, description };
      state.listing.push(created);
      return Promise.resolve(JSON.stringify(created));
    }
    if (args[0] === "issue" && args[1] === "edit") {
      if (state.failEdits?.includes(Number(args[2]))) {
        return Promise.reject(new Error(`issue ${args[2]} locked`));
      }
    }
    return Promise.resolve("");
  };
}

Deno.test("maybeCreatePlanningMilestone — three groups yield three milestones and per-group assignments", async () => {
  const state = { listing: [] as unknown[], calls: [] as string[][] };
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Split sub-issues by file area",
    subIssueNumbers: [10, 11, 12, 13, 14, 15],
    groups: [
      group("infra", "options trading", [10, 11]),
      group("docs", "milestone docs", [12, 13]),
      group("worker", "gate wiring", [14, 15]),
    ],
    ghCommandFn: groupedGh(state),
    logger: silentLogger,
  });

  assertEquals(result.created, true);
  const posts = state.calls.filter((c) => c.includes("POST"));
  assertEquals(posts.length, 3);
  assertEquals(result.milestones?.length, 3);
  assertEquals(
    result.milestones?.map((m) => m.milestoneTitle),
    [
      "#2163 infra: options trading",
      "#2163 docs: milestone docs",
      "#2163 worker: gate wiring",
    ],
  );
  assertEquals(result.milestones?.map((m) => m.area), [
    "infra",
    "docs",
    "worker",
  ]);
  assertEquals(result.milestones?.map((m) => m.assigned), [
    [10, 11],
    [12, 13],
    [14, 15],
  ]);
  // Every sub-issue is assigned to its own group's milestone, and only that one.
  const edits = state.calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  assertEquals(edits.length, 6);
  const assignedTitleFor = (n: number) =>
    edits.find((c) => c[2] === String(n))!.at(-1);
  assertEquals(assignedTitleFor(10), "#2163 infra: options trading");
  assertEquals(assignedTitleFor(12), "#2163 docs: milestone docs");
  assertEquals(assignedTitleFor(15), "#2163 worker: gate wiring");
  // Every generated title is within the cap.
  for (const m of result.milestones ?? []) {
    assertEquals(
      (m.milestoneTitle ?? "").length <= MAX_MILESTONE_TITLE_LENGTH,
      true,
    );
  }
});

Deno.test("maybeCreatePlanningMilestone — a group of one sub-issue gets no milestone", async () => {
  const state = { listing: [] as unknown[], calls: [] as string[][] };
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11, 12],
    groups: [
      group("infra", "options trading", [10, 11]),
      group("docs", "", [12]),
    ],
    ghCommandFn: groupedGh(state),
    logger: silentLogger,
  });

  assertEquals(state.calls.filter((c) => c.includes("POST")).length, 1);
  assertEquals(result.milestones?.length, 2);
  const solo = result.milestones![1]!;
  assertEquals(solo.area, "docs");
  assertEquals(solo.milestoneTitle, undefined);
  assertEquals(solo.milestoneNumber, undefined);
  assertEquals(solo.assigned, []);
  assertEquals(solo.skippedReason, "too-few-sub-issues");
  // #12 keeps the default branch: it is never edited.
  const edits = state.calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  assertEquals(edits.some((c) => c[2] === "12"), false);
});

Deno.test("maybeCreatePlanningMilestone — re-running reuses each group's milestone by marker", async () => {
  const listing: unknown[] = [];
  const groups = [
    group("infra", "options trading", [10, 11]),
    group("docs", "milestone docs", [12, 13]),
  ];
  const first = { listing, calls: [] as string[][] };
  await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11, 12, 13],
    groups,
    ghCommandFn: groupedGh(first),
    logger: silentLogger,
  });
  assertEquals(first.calls.filter((c) => c.includes("POST")).length, 2);

  // Second run over the same listing: no POST, no rename, same milestones.
  const second = { listing, calls: [] as string[][] };
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11, 12, 13],
    groups,
    ghCommandFn: groupedGh(second),
    logger: silentLogger,
  });
  assertEquals(second.calls.filter((c) => c.includes("POST")).length, 0);
  assertEquals(second.calls.some((c) => c.includes("PATCH")), false);
  assertEquals(result.milestones?.map((m) => m.milestoneNumber), [100, 101]);
  assertEquals(result.milestones?.map((m) => m.milestoneTitle), [
    "#2163 infra: options trading",
    "#2163 docs: milestone docs",
  ]);
});

Deno.test("maybeCreatePlanningMilestone — a group never adopts a sibling group's milestone", async () => {
  // Only the `infra` group's milestone exists; `docs` must create its own
  // rather than adopt the sibling by its leading `#2163`.
  const state = {
    listing: [{
      number: 100,
      title: "#2163 infra: options trading",
      description: `${planningMilestoneMarker(2163, "infra")} grouping`,
    }] as unknown[],
    calls: [] as string[][],
  };
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Parent",
    subIssueNumbers: [12, 13],
    groups: [group("docs", "milestone docs", [12, 13])],
    ghCommandFn: groupedGh(state),
    logger: silentLogger,
  });
  assertEquals(state.calls.filter((c) => c.includes("POST")).length, 1);
  assertEquals(result.milestones?.[0]?.milestoneNumber, 101);
  assertEquals(
    result.milestones?.[0]?.milestoneTitle,
    "#2163 docs: milestone docs",
  );
});

Deno.test("maybeCreatePlanningMilestone — the ungrouped path never adopts a grouped milestone", async () => {
  const state = {
    listing: [{
      number: 100,
      title: "#2163 infra: options trading",
      description: `${planningMilestoneMarker(2163, "infra")} grouping`,
    }] as unknown[],
    calls: [] as string[][],
  };
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Parent",
    subIssueNumbers: [20, 21],
    ghCommandFn: groupedGh(state),
    logger: silentLogger,
  });
  assertEquals(state.calls.filter((c) => c.includes("POST")).length, 1);
  assertEquals(result.milestoneNumber, 101);
  assertEquals(result.milestoneTitle, "#2163 Parent");
});

Deno.test("maybeCreatePlanningMilestone — the ungrouped path still reuses a legacy prefix milestone", async () => {
  // Guard against over-reach: skipping `area=` markers must not break the
  // legacy `#<N>` reuse that milestone #50 depends on.
  const state = {
    listing: [{
      number: 50,
      title: "#2163 A long legacy title nobody generated this way",
      description: "",
    }] as unknown[],
    calls: [] as string[][],
  };
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Parent",
    subIssueNumbers: [20, 21],
    ghCommandFn: groupedGh(state),
    logger: silentLogger,
  });
  assertEquals(state.calls.filter((c) => c.includes("POST")).length, 0);
  assertEquals(result.milestoneNumber, 50);
});

Deno.test("maybeCreatePlanningMilestone — a new grouped milestone carries the area marker", async () => {
  const state = { listing: [] as unknown[], calls: [] as string[][] };
  await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11],
    groups: [group("infra", "options trading", [10, 11])],
    ghCommandFn: groupedGh(state),
    logger: silentLogger,
  });
  const post = state.calls.find((c) => c.includes("POST"))!;
  const description = post.find((a) => a.startsWith("description="))!;
  assertStringIncludes(description, planningMilestoneMarker(2163, "infra"));
});

Deno.test("maybeCreatePlanningMilestone — one group's failure does not stop the others", async () => {
  const state = {
    listing: [] as unknown[],
    calls: [] as string[][],
    failPostFor: ["docs"],
    failEdits: [15],
  };
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11, 12, 13, 14, 15],
    groups: [
      group("infra", "options trading", [10, 11]),
      group("docs", "milestone docs", [12, 13]),
      group("worker", "gate wiring", [14, 15]),
    ],
    ghCommandFn: groupedGh(state),
    logger: silentLogger,
  });

  assertEquals(result.created, true);
  assertEquals(result.milestones?.length, 3);
  // The infra group landed, docs failed to be ensured, worker still ran.
  assertEquals(result.milestones?.[0]?.assigned, [10, 11]);
  assertEquals(result.milestones?.[1]?.milestoneNumber, undefined);
  assertEquals(result.milestones?.[1]?.assigned, []);
  assertEquals(
    result.milestones?.[2]?.milestoneTitle,
    "#2163 worker: gate wiring",
  );
  // #15 failed to assign; #14 still did.
  assertEquals(result.milestones?.[2]?.assigned, [14]);
});

Deno.test("maybeCreatePlanningMilestone — groups are ignored when the parent owns a milestone", async () => {
  const state = { listing: [] as unknown[], calls: [] as string[][] };
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 2163,
    parentIssueTitle: "Parent",
    parentMilestoneTitle: "v1.0",
    subIssueNumbers: [10, 11, 12, 13],
    groups: [
      group("infra", "options trading", [10, 11]),
      group("docs", "milestone docs", [12, 13]),
    ],
    ghCommandFn: groupedGh(state),
    logger: silentLogger,
  });
  assertEquals(result.created, false);
  assertEquals(result.skippedReason, "parent-has-milestone");
  assertEquals(state.calls.length, 0);
});

Deno.test("maybeCreatePlanningMilestone — an empty group list falls back to the ungrouped path", async () => {
  const state = { listing: [] as unknown[], calls: [] as string[][] };
  const result = await maybeCreatePlanningMilestone({
    repo: "o/r",
    parentIssueNumber: 5,
    parentIssueTitle: "Parent",
    subIssueNumbers: [10, 11],
    groups: [],
    ghCommandFn: groupedGh(state),
    logger: silentLogger,
  });
  assertEquals(result.created, true);
  assertEquals(result.milestoneTitle, "#5 Parent");
  assertEquals(result.milestones, undefined);
  assertEquals(result.assigned, [10, 11]);
});
