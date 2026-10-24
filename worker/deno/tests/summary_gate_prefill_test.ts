/**
 * Unit tests for the pre-filled summary gate drafts (Issue #4234, point 4).
 *
 * Each fixture is a real `git diff --unified=0` text with real hunk headers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildSummaryPrefill,
  type SummaryPrefillInput,
} from "../lib/summary_gate_prefill.ts";

const HEADER =
  "PRE-FILLED DRAFT — confirm or correct each line against the diff; do not copy blindly";

/**
 * `lib/widget.ts`: a renamed exported function (line 10 added), a branch on
 * new-side line 11, and a new top-level constant (line 32). `tests/widget_test.ts`
 * adds a named test on line 6 and a branch on line 7.
 */
const CODE_DIFF = [
  "diff --git a/lib/widget.ts b/lib/widget.ts",
  "index 1111111..2222222 100644",
  "--- a/lib/widget.ts",
  "+++ b/lib/widget.ts",
  "@@ -10 +10,2 @@",
  "-export function renderWidget(name: string) {",
  "+export function renderWidget(name: string, size: number) {",
  '+  if (size < 1) return "";',
  "@@ -30,0 +32,1 @@",
  "+const retryLimit = 3;",
  "diff --git a/tests/widget_test.ts b/tests/widget_test.ts",
  "--- a/tests/widget_test.ts",
  "+++ b/tests/widget_test.ts",
  "@@ -5,0 +6,2 @@",
  '+Deno.test("renders a widget at size one", () => {',
  "+  if (ready) return;",
  "",
].join("\n");

/** Only a changed test file: its branch is never a candidate. */
const TEST_ONLY_DIFF = [
  "diff --git a/tests/widget_test.ts b/tests/widget_test.ts",
  "--- a/tests/widget_test.ts",
  "+++ b/tests/widget_test.ts",
  "@@ -5,0 +6,2 @@",
  '+Deno.test("renders a widget at size one", () => {',
  "+  if (ready) return;",
  "",
].join("\n");

/** Only a docs file changed. */
const DOCS_ONLY_DIFF = [
  "diff --git a/docs/widget.md b/docs/widget.md",
  "--- a/docs/widget.md",
  "+++ b/docs/widget.md",
  "@@ -1 +1 @@",
  "-Old wording.",
  "+New wording names renderWidget.",
  "",
].join("\n");

const NOTHING_DOCS = async (_term: string): Promise<readonly string[]> => [];

/** Build an input with every draft requested, overridable per test. */
function input(
  overrides: Partial<SummaryPrefillInput>,
): SummaryPrefillInput {
  return {
    issueNumber: 4234,
    changedFiles: ["lib/widget.ts", "tests/widget_test.ts"],
    unifiedDiff: CODE_DIFF,
    removedUnaccounted: [],
    want: { docsSweep: true, branchOutcomes: true, removedAssertions: true },
    docsMentioning: NOTHING_DOCS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Docs sweep
// ---------------------------------------------------------------------------

Deno.test("buildSummaryPrefill docs sweep: drafts the line from the changed identifiers", async () => {
  const out = await buildSummaryPrefill(input({
    want: { docsSweep: true, branchOutcomes: false, removedAssertions: false },
    docsMentioning: async (term) =>
      term === "renderWidget" ? ["docs/widget.md"] : [],
  }));
  assertStringIncludes(out, HEADER);
  assertStringIncludes(
    out,
    "**Docs sweep** — grep: `renderWidget`, `retryLimit`; section: `docs/widget.md#<anchor — read that section and name its heading>`; siblings: none — <why no existing set gained a member>; updated: <leave for the agent>; hits: `renderWidget` in 1 doc(s), `retryLimit` in 0 doc(s)",
  );
  assertStringIncludes(out, "- `renderWidget`: docs/widget.md");
  assertStringIncludes(out, "- `retryLimit`: no doc mentions it");
});

Deno.test("buildSummaryPrefill docs sweep: the injected lookup receives each term in order", async () => {
  const seen: string[] = [];
  await buildSummaryPrefill(input({
    want: { docsSweep: true, branchOutcomes: false, removedAssertions: false },
    docsMentioning: async (term) => {
      seen.push(term);
      return [];
    },
  }));
  assertEquals(seen, ["renderWidget", "retryLimit"]);
});

Deno.test("buildSummaryPrefill docs sweep: no manual found gives the honest-negative placeholder", async () => {
  const out = await buildSummaryPrefill(input({
    want: { docsSweep: true, branchOutcomes: false, removedAssertions: false },
    docsMentioning: NOTHING_DOCS,
  }));
  assertStringIncludes(
    out,
    "section: none — <why no manual documents it>",
  );
});

Deno.test("buildSummaryPrefill docs sweep: terms capped at eight and shorter than four characters dropped", async () => {
  const seen: string[] = [];
  const addedLines = [];
  for (let i = 0; i < 10; i++) {
    addedLines.push(
      `+export function helper${String.fromCharCode(97 + i)}() {}`,
    );
  }
  addedLines.push("+export function ab() {}");
  addedLines.push("+const io = 1;");
  const diff = [
    "diff --git a/lib/many.ts b/lib/many.ts",
    "--- a/lib/many.ts",
    "+++ b/lib/many.ts",
    "@@ -0,0 +1,12 @@",
    ...addedLines,
    "",
  ].join("\n");
  await buildSummaryPrefill(input({
    changedFiles: ["lib/many.ts"],
    unifiedDiff: diff,
    want: { docsSweep: true, branchOutcomes: false, removedAssertions: false },
    docsMentioning: async (term) => {
      seen.push(term);
      return [];
    },
  }));
  assertEquals(seen, [
    "helpera",
    "helperb",
    "helperc",
    "helperd",
    "helpere",
    "helperf",
    "helperg",
    "helperh",
  ]);
});

Deno.test("buildSummaryPrefill docs sweep: a docs-only change gives no docs sweep block", async () => {
  let calls = 0;
  const out = await buildSummaryPrefill(input({
    changedFiles: ["docs/widget.md"],
    unifiedDiff: DOCS_ONLY_DIFF,
    want: { docsSweep: true, branchOutcomes: false, removedAssertions: false },
    docsMentioning: async () => {
      calls++;
      return [];
    },
  }));
  assertEquals(out, "");
  assertEquals(calls, 0);
});

Deno.test("buildSummaryPrefill docs sweep: a test-only change gives no docs sweep block", async () => {
  const out = await buildSummaryPrefill(input({
    changedFiles: ["tests/widget_test.ts"],
    unifiedDiff: TEST_ONLY_DIFF,
    want: { docsSweep: true, branchOutcomes: false, removedAssertions: false },
  }));
  assertEquals(out, "");
});

Deno.test("buildSummaryPrefill docs sweep: an unreadable diff still drafts the line with placeholders", async () => {
  let calls = 0;
  const out = await buildSummaryPrefill(input({
    unifiedDiff: null,
    want: { docsSweep: true, branchOutcomes: false, removedAssertions: false },
    docsMentioning: async () => {
      calls++;
      return [];
    },
  }));
  assertStringIncludes(
    out,
    "grep: <quote each removed or changed name in backticks>",
  );
  assertStringIncludes(
    out,
    "Candidate docs to read: none, because the diff names no term.",
  );
  assertEquals(calls, 0);
});

// ---------------------------------------------------------------------------
// Branch outcomes
// ---------------------------------------------------------------------------

Deno.test("buildSummaryPrefill branch outcomes: lists the new-side branch line and pre-sets the one changed test file", async () => {
  const out = await buildSummaryPrefill(input({
    want: { docsSweep: false, branchOutcomes: true, removedAssertions: false },
  }));
  assertStringIncludes(out, "#### Branch outcomes");
  assertStringIncludes(out, '- lib/widget.ts:11: if (size < 1) return "";');
  assertStringIncludes(
    out,
    '{"version":1,"branchOutcomes":{"noneAdded":false,"entries":[{"path":"lib/widget.ts","line":11,"outcome":"<what this branch does>","test":"tests/widget_test.ts","testName":"<test name>","flipWentRed":"<what you observed when you flipped it>"}]}}',
  );
});

Deno.test("buildSummaryPrefill branch outcomes: lists the test names added in changed test files", async () => {
  const out = await buildSummaryPrefill(input({
    want: { docsSweep: false, branchOutcomes: true, removedAssertions: false },
  }));
  assertStringIncludes(out, '- "renders a widget at size one"');
  assertStringIncludes(
    out,
    "flipWentRed` must be what you actually observed",
  );
});

Deno.test("buildSummaryPrefill branch outcomes: test-only files give no candidates and noneAdded true", async () => {
  const out = await buildSummaryPrefill(input({
    changedFiles: ["tests/widget_test.ts"],
    unifiedDiff: TEST_ONLY_DIFF,
    want: { docsSweep: false, branchOutcomes: true, removedAssertions: false },
  }));
  assertStringIncludes(out, '"noneAdded":true,"entries":[]');
  assertStringIncludes(
    out,
    "- none: this scan found no branch construct in non-test code.",
  );
  assertEquals(out.includes("- tests/widget_test.ts:"), false);
});

Deno.test("buildSummaryPrefill branch outcomes: caps twelve per file and forty in total, and says so", async () => {
  const files: string[] = [];
  for (const name of ["a", "b", "c", "d"]) {
    const lines = [];
    for (let i = 0; i < 15; i++) lines.push(`+  if (n${i} > 0) return;`);
    files.push(
      [
        `diff --git a/lib/${name}.ts b/lib/${name}.ts`,
        `--- a/lib/${name}.ts`,
        `+++ b/lib/${name}.ts`,
        "@@ -0,0 +1,15 @@",
        ...lines,
      ].join("\n"),
    );
  }
  const out = await buildSummaryPrefill(input({
    changedFiles: ["lib/a.ts", "lib/b.ts", "lib/c.ts", "lib/d.ts"],
    unifiedDiff: files.join("\n") + "\n",
    want: { docsSweep: false, branchOutcomes: true, removedAssertions: false },
  }));
  const listed = out.split("\n");
  assertEquals(listed.filter((l) => l.startsWith("- lib/")).length, 40);
  assertEquals(listed.filter((l) => l.startsWith("- lib/a.ts:")).length, 12);
  assertEquals(listed.filter((l) => l.startsWith("- lib/d.ts:")).length, 4);
  // Forty skeleton entries exceed the 6000-character cap, so the JSON is clipped.
  assertEquals(out.endsWith("\n(truncated)"), true);
  assertStringIncludes(
    out,
    "(more branch lines exist; the list is capped at 12 per file and 40 in total)",
  );
});

Deno.test("buildSummaryPrefill branch outcomes: an unreadable diff gives no branch block", async () => {
  const out = await buildSummaryPrefill(input({
    unifiedDiff: null,
    removedUnaccounted: [{
      file: "tests/widget_test.ts",
      text: "assertOld(1);",
    }],
    want: { docsSweep: false, branchOutcomes: true, removedAssertions: true },
  }));
  assertEquals(out.includes("#### Branch outcomes"), false);
  assertStringIncludes(out, "#### Removed assertions");
});

// ---------------------------------------------------------------------------
// Removed assertions
// ---------------------------------------------------------------------------

Deno.test("buildSummaryPrefill removed assertions: one entry per item with the three choice lines", async () => {
  const out = await buildSummaryPrefill(input({
    unifiedDiff: null,
    removedUnaccounted: [
      {
        file: "tests/widget_test.ts",
        text: 'assertEquals(renderWidget("a"), "a");',
      },
    ],
    want: { docsSweep: false, branchOutcomes: false, removedAssertions: true },
  }));
  assertStringIncludes(
    out,
    '- Removed from `tests/widget_test.ts`: assertEquals(renderWidget("a"), "a");',
  );
  assertStringIncludes(
    out,
    '  - Required by: "<quote of at least 5 words from the issue title or body>"',
  );
  assertStringIncludes(
    out,
    "  - Moved to: <destination path, or delete this line>",
  );
  assertStringIncludes(
    out,
    "  - Replaced by: <assertion on an added line in the same file, or delete this line>",
  );
  assertStringIncludes(
    out,
    "Choose exactly one of Required by / Moved to / Replaced by, and delete the other two.",
  );
});

Deno.test("buildSummaryPrefill removed assertions: backticks are neutralised and text clipped to 200 characters", async () => {
  const text = "`" + "y".repeat(250);
  const out = await buildSummaryPrefill(input({
    unifiedDiff: null,
    removedUnaccounted: [{ file: "tests/widget_test.ts", text }],
    want: { docsSweep: false, branchOutcomes: false, removedAssertions: true },
  }));
  assertStringIncludes(
    out,
    "- Removed from `tests/widget_test.ts`: '" + "y".repeat(199),
  );
  assertEquals(out.includes("y".repeat(200)), false);
});

Deno.test("buildSummaryPrefill removed assertions: nothing unaccounted gives no block", async () => {
  const out = await buildSummaryPrefill(input({
    removedUnaccounted: [],
    want: { docsSweep: false, branchOutcomes: false, removedAssertions: true },
  }));
  assertEquals(out, "");
});

Deno.test("buildSummaryPrefill removed assertions: still drafted when the diff is null", async () => {
  const out = await buildSummaryPrefill(input({
    unifiedDiff: null,
    removedUnaccounted: [{
      file: "tests/widget_test.ts",
      text: "assertOld(1);",
    }],
    want: { docsSweep: false, branchOutcomes: true, removedAssertions: true },
  }));
  assertStringIncludes(out, "#### Removed assertions");
  assertEquals(out.includes("#### Branch outcomes"), false);
});

// ---------------------------------------------------------------------------
// Flags, output limit and validation
// ---------------------------------------------------------------------------

Deno.test("buildSummaryPrefill: every want flag off produces an empty string", async () => {
  const out = await buildSummaryPrefill(input({
    removedUnaccounted: [{
      file: "tests/widget_test.ts",
      text: "assertOld(1);",
    }],
    want: { docsSweep: false, branchOutcomes: false, removedAssertions: false },
  }));
  assertEquals(out, "");
});

Deno.test("buildSummaryPrefill: a branch-only request omits the docs sweep line", async () => {
  let calls = 0;
  const out = await buildSummaryPrefill(input({
    want: { docsSweep: false, branchOutcomes: true, removedAssertions: false },
    docsMentioning: async () => {
      calls++;
      return [];
    },
  }));
  assertStringIncludes(out, "#### Branch outcomes");
  assertEquals(out.includes("**Docs sweep**"), false);
  assertEquals(calls, 0);
});

Deno.test("buildSummaryPrefill: a long draft is clipped to 6000 characters with a truncated line", async () => {
  const items = [];
  for (let i = 0; i < 60; i++) {
    items.push({ file: "tests/long_test.ts", text: "x".repeat(200) });
  }
  const out = await buildSummaryPrefill(input({
    unifiedDiff: null,
    removedUnaccounted: items,
    want: { docsSweep: false, branchOutcomes: false, removedAssertions: true },
  }));
  assertEquals(out.length <= 6000, true);
  assertEquals(out.length, 6000);
  assertEquals(out.endsWith("\n(truncated)"), true);
  assertStringIncludes(out, HEADER);
});

Deno.test("buildSummaryPrefill: a short draft is not truncated", async () => {
  const out = await buildSummaryPrefill(input({
    unifiedDiff: null,
    removedUnaccounted: [{
      file: "tests/widget_test.ts",
      text: "assertOld(1);",
    }],
    want: { docsSweep: false, branchOutcomes: false, removedAssertions: true },
  }));
  assertEquals(out.includes("(truncated)"), false);
});

Deno.test("buildSummaryPrefill: an issue number of zero throws", async () => {
  await assertRejects(
    () => buildSummaryPrefill(input({ issueNumber: 0 })),
    RangeError,
  );
});

Deno.test("buildSummaryPrefill: a negative issue number throws", async () => {
  await assertRejects(
    () => buildSummaryPrefill(input({ issueNumber: -3 })),
    RangeError,
  );
});
