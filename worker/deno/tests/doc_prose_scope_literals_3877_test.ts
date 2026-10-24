// Unchanged user-visible strings beside a changed condition (Issue #4196)
// and inside a function the diff newly calls (Issue #4197).
// Uses Australian English throughout.

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { docProseClaimInstruction } from "../lib/doc_prose_claims.ts";
import {
  collectDocProseScope,
  renderProseRanges,
} from "../lib/doc_prose_scope.ts";
import { buildDriftQuestionPrompt } from "../lib/pr_feedback_drift_check.ts";
import { sourceStringLiterals } from "../lib/removed_assertion_gate.ts";
import { buildSummaryClaimQuestionPrompt } from "../lib/summary_claim_check.ts";

const REASON = "negative numbers are refused";

const CLASSIFY = `/** Classifies a number. */
export function classify(n: number): string {
  if (n <= 0) {
    return "${REASON}";
  }
  return "every other value is accepted";
  return "nope";
  return "src/classify file";
  return "value is %s now";
}

export function other(): string {
  return "this other reason stays put";
}
`;

const CLASSIFY_DIFF = `+++ b/src/classify.ts
@@ -3 +3 @@
-  if (n < 0) {
+  if (n <= 0) {
`;

function filesOf(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    changedFiles: [...map.keys()],
    trackedFiles: [...map.keys()],
    readFile: (path: string) => Promise.resolve(map.get(path)),
  };
}

Deno.test("sourceStringLiterals returns the text, line and column of each literal", () => {
  const source = 'const label = "hello world stays";\n';
  const literals = sourceStringLiterals(source, "src/labels.ts");
  assertEquals(literals, [{ text: "hello world stays", line: 1, column: 15 }]);
});

Deno.test("a widened predicate selects the unchanged reason string in that declaration (Issue #4196)", async () => {
  const scope = await collectDocProseScope({
    ...filesOf({ "src/classify.ts": CLASSIFY }),
    summaryContent: "",
    diff: CLASSIFY_DIFF,
  });
  const visible = scope.ranges.filter((r) => r.kind === "user-visible string");
  assert(
    visible.some((r) =>
      r.file === "src/classify.ts" && r.start === 4 && r.end === 4
    ),
    `expected the reason string, got ${JSON.stringify(visible)}`,
  );
  assertStringIncludes(scope.contents.get("src/classify.ts")!, REASON);
  assert(
    visible.some((r) => r.start === 6),
    "the other unchanged sentence in the same declaration is in scope",
  );
  assertFalse(
    visible.some((r) => r.start === 7),
    "a single-word literal is not user-visible",
  );
  assertFalse(
    visible.some((r) => r.start === 8 || r.start === 9),
    "a path or a format token is not user-visible",
  );
  assertFalse(
    scope.contents.get("src/classify.ts")!.includes(
      "this other reason stays put",
    ),
    "a literal in a different top-level declaration is not selected",
  );

  const rendered = renderProseRanges(visible);
  assertStringIncludes(rendered, "src/classify.ts:4-4 — user-visible string");
  const promptOpts = {
    repo: "acme/widgets",
    issueNumber: 7,
    baseRef: "origin/main" as string,
    summaryPath: "docs/archive/pr-summaries/pr-summary-7.md",
    docFiles: ["src/classify.ts"],
    proseRanges: scope.ranges,
  };
  const summaryPrompt = buildSummaryClaimQuestionPrompt(promptOpts);
  const driftPrompt = buildDriftQuestionPrompt({
    repo: "acme/widgets",
    prNumber: 7,
    beforeSha: "a".repeat(40),
    baseRef: "main",
    files: ["src/classify.ts"],
    proseRanges: scope.ranges,
  });
  for (const prompt of [summaryPrompt, driftPrompt]) {
    assertStringIncludes(prompt, "src/classify.ts:4-4 — user-visible string");
    assertStringIncludes(prompt, REASON);
  }
});

Deno.test("docProseClaimInstruction asks whether a user-visible string is now false for a new case", () => {
  const text = docProseClaimInstruction("this branch's diff");
  assertStringIncludes(text, "sends a case");
  assertStringIncludes(text, "now false");
  assertStringIncludes(text, "file:line");
  assertStringIncludes(text, "never treat executable code as prose");
  assertFalse(text.includes("\n"));
  assertFalse(text.includes("  "));
});

Deno.test("a literal in a test file is not selected (Issue #4196)", async () => {
  const path = "worker/deno/tests/classify_test.ts";
  const scope = await collectDocProseScope({
    ...filesOf({ [path]: CLASSIFY }),
    summaryContent: "",
    diff: CLASSIFY_DIFF.replaceAll("src/classify.ts", path),
  });
  assertEquals(
    scope.ranges.filter((r) => r.kind === "user-visible string"),
    [],
  );
});

Deno.test("a rename-only diff selects no user-visible string (Issue #4196)", async () => {
  const source = `export function classify(total: number): string {
  return "${REASON}";
}
`;
  const scope = await collectDocProseScope({
    ...filesOf({ "src/classify.ts": source }),
    summaryContent: "",
    diff: `+++ b/src/classify.ts
@@ -1 +1 @@
-export function classify(count: number): string {
+export function classify(total: number): string {
`,
  });
  assertEquals(
    scope.ranges.filter((r) => r.kind === "user-visible string"),
    [],
  );
});

Deno.test("each user-visible string over the 40-string cap is not checked, never passed (Issue #4196)", async () => {
  const body = Array.from(
    { length: 45 },
    (_, i) => `  const label${i} = "reason number ${i} stays visible";`,
  );
  const source = `export function classify(n: number): string {
  if (n <= 0) {
    return "anchor reason stays";
  }
${body.join("\n")}
}
`;
  const scope = await collectDocProseScope({
    ...filesOf({ "src/classify.ts": source }),
    summaryContent: "",
    diff: `+++ b/src/classify.ts
@@ -2 +2 @@
-  if (n < 0) {
+  if (n <= 0) {
`,
  });
  const visible = scope.ranges.filter((r) => r.kind === "user-visible string");
  assertEquals(visible.length, 40);
  const overflow = scope.notChecked.filter((n) =>
    n.includes("user-visible string over the 40-string cap")
  );
  assertEquals(overflow.length, 6);
  for (const note of overflow) {
    assertStringIncludes(note, "not checked, never passed");
  }
});

const BADGE_LABEL = "Archived items stay hidden";
const BADGE = `export function StatusBadge(_props: { state: string }) {
  const label = "${BADGE_LABEL}";
  return label;
}
`;
const PAGE = `import { StatusBadge } from "./StatusBadge.tsx";

export function Page() {
  return <StatusBadge state="archived" />;
}
`;
const PAGE_DIFF = `+++ b/src/page.tsx
@@ -3 +3 @@
-  return null;
+  return <StatusBadge state="archived" />;
`;

Deno.test("a newly rendered component's fixed label is selected and its file is loaded (Issue #4197)", async () => {
  const scope = await collectDocProseScope({
    ...filesOf({ "src/page.tsx": PAGE, "src/StatusBadge.tsx": BADGE }),
    changedFiles: ["src/page.tsx"],
    summaryContent: "",
    diff: PAGE_DIFF,
  });
  const visible = scope.ranges.filter((r) => r.kind === "user-visible string");
  assert(
    visible.some((r) =>
      r.file === "src/StatusBadge.tsx" && r.start === 2 &&
      r.text === BADGE_LABEL
    ),
    `expected the badge label, got ${JSON.stringify(visible)}`,
  );
  assertStringIncludes(scope.contents.get("src/StatusBadge.tsx")!, BADGE_LABEL);
});

Deno.test("a moved call selects no label (Issue #4197)", async () => {
  const scope = await collectDocProseScope({
    ...filesOf({ "src/page.tsx": PAGE, "src/StatusBadge.tsx": BADGE }),
    changedFiles: ["src/page.tsx"],
    summaryContent: "",
    diff: `+++ b/src/page.tsx
@@ -3 +3 @@
-  return <StatusBadge state="open" />;
+  return <StatusBadge state="archived" />;
`,
  });
  assertEquals(
    scope.ranges.filter((r) => r.kind === "user-visible string"),
    [],
  );
  assertFalse(scope.contents.has("src/StatusBadge.tsx"));
});

Deno.test("an unresolvable package import selects nothing and does not throw (Issue #4197)", async () => {
  const page = `import { Widget } from "widget-kit";

export function Page() {
  return <Widget />;
}
`;
  const scope = await collectDocProseScope({
    changedFiles: ["src/page.tsx"],
    trackedFiles: ["src/page.tsx"],
    summaryContent: "",
    diff: `+++ b/src/page.tsx
@@ -3 +3 @@
-  return null;
+  return <Widget />;
`,
    readFile: (path) => {
      if (path !== "src/page.tsx") {
        throw new Error(`unexpected read of ${path}`);
      }
      return Promise.resolve(page);
    },
  });
  assertEquals(
    scope.ranges.filter((r) => r.kind === "user-visible string"),
    [],
  );
});

Deno.test("a definition file over fileCap and a literal over the string cap are not checked (Issue #4197)", async () => {
  const capped = await collectDocProseScope({
    ...filesOf({ "src/page.tsx": PAGE, "src/StatusBadge.tsx": BADGE }),
    changedFiles: ["src/page.tsx"],
    summaryContent: "",
    diff: PAGE_DIFF,
    fileCap: 0,
  });
  assertFalse(capped.contents.has("src/StatusBadge.tsx"));
  assert(
    capped.notChecked.some((note) =>
      note.includes("src/StatusBadge.tsx") &&
      note.includes("not checked, never passed")
    ),
  );

  const labels = Array.from(
    { length: 41 },
    (_, i) => `  const label${i} = "badge label ${i} stays visible";`,
  );
  const many = `export function StatusBadge(_props: { state: string }) {
${labels.join("\n")}
  return label0;
}
`;
  const overflow = await collectDocProseScope({
    ...filesOf({ "src/page.tsx": PAGE, "src/StatusBadge.tsx": many }),
    changedFiles: ["src/page.tsx"],
    summaryContent: "",
    diff: PAGE_DIFF,
  });
  assertEquals(
    overflow.ranges.filter((r) => r.kind === "user-visible string").length,
    40,
  );
  assert(
    overflow.notChecked.some((note) =>
      note.includes("src/StatusBadge.tsx") &&
      note.includes("user-visible string over the 40-string cap") &&
      note.includes("not checked, never passed")
    ),
  );
  assert(overflow.contents.has("src/StatusBadge.tsx"));
});
