// Tests for the manual/prompt prose scope and question shared by the
// first-run claim check and the review-fix drift check (Issue #3347).
// Uses Australian English throughout.

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { collectDocProseScope } from "../lib/doc_prose_scope.ts";
import {
  docProseClaimInstruction,
  isManualProsePath,
  selectManualProseFiles,
} from "../lib/doc_prose_claims.ts";

Deno.test("isManualProsePath accepts manuals and prompts", () => {
  for (
    const p of [
      "docs/workflows/pr-feedback.md",
      "SECURITY.md",
      "CODING-STANDARDS.md",
      "prompts/issue/prompt.md",
      "README.MD",
      "docs/audits/x.md",
    ]
  ) assert(isManualProsePath(p), p);
});

Deno.test("isManualProsePath rejects PR summaries", () => {
  assert(isManualProsePath("docs/x.md"));
  assertFalse(
    isManualProsePath("docs/archive/pr-summaries/pr-summary-3347.md"),
  );
  assertFalse(isManualProsePath("docs/archive/pr-summaries/notes.md"));
  assertFalse(isManualProsePath("docs/pr-summary-12.md"));
});

Deno.test("isManualProsePath rejects non-Markdown", () => {
  assertFalse(isManualProsePath("worker/deno/lib/foo.ts"));
  assertFalse(isManualProsePath("docs/notes.txt"));
});

Deno.test("isManualProsePath rejects unsafe path shapes", () => {
  assertFalse(isManualProsePath("../etc/x.md"));
  assertFalse(isManualProsePath("docs/../x.md"));
  assertFalse(isManualProsePath("/abs/x.md"));
  assertFalse(isManualProsePath("-x.md"));
  assertFalse(isManualProsePath("docs//x.md"));
  assertFalse(isManualProsePath("docs/./x.md"));
  assertFalse(isManualProsePath("docs/x.md "));
  assertFalse(isManualProsePath(" docs/x.md"));
  assertFalse(isManualProsePath("docs/a`b.md"));
  assertFalse(isManualProsePath("docs/a\\b.md"));
  assertFalse(isManualProsePath("docs/a\nb.md"));
  assertFalse(isManualProsePath("docs/a\x7fb.md"));
  assertFalse(isManualProsePath(""));
});

Deno.test("isManualProsePath enforces the length limit", () => {
  const ok = "d/" + "a".repeat(500 - "d/.md".length) + ".md";
  assertEquals(ok.length, 500);
  assert(isManualProsePath(ok));
  const long = "d/" + "a".repeat(501 - "d/.md".length) + ".md";
  assertEquals(long.length, 501);
  assertFalse(isManualProsePath(long));
});

Deno.test("isManualProsePath rejects Markdown under a test directory", () => {
  assertFalse(isManualProsePath("worker/deno/tests/fixtures/x.md"));
  assert(isManualProsePath("worker/deno/docs/x.md"));
});

Deno.test("selectManualProseFiles de-duplicates, filters and orders", () => {
  const r = selectManualProseFiles(
    ["b.md", "a.ts", "a.md", "b.md", "docs/pr-summary-1.md", "a.md"],
    10,
  );
  assertEquals(r.files, ["b.md", "a.md"]);
  assertEquals(r.overCap, []);
});

Deno.test("selectManualProseFiles splits at the cap", () => {
  const r = selectManualProseFiles(["a.md", "b.md", "c.md"], 2);
  assertEquals(r.files, ["a.md", "b.md"]);
  assertEquals(r.overCap, ["c.md"]);
  const zero = selectManualProseFiles(["a.md", "b.md"], 0);
  assertEquals(zero.files, []);
  assertEquals(zero.overCap, ["a.md", "b.md"]);
});

Deno.test("selectManualProseFiles rejects an invalid cap", () => {
  assertThrows(() => selectManualProseFiles(["a.md"], -1));
  assertThrows(() => selectManualProseFiles(["a.md"], 1.5));
});

Deno.test("docProseClaimInstruction substitutes the change phrase", () => {
  const a = docProseClaimInstruction("this branch's diff");
  const b = docProseClaimInstruction("this push's change");
  assert(a.includes("the lines this branch's diff adds or edits"));
  assert(b.includes("the lines this push's change adds or edits"));
  for (const s of [a, b]) {
    assert(s.includes('"never"'));
    assert(s.includes("file:line"));
    assertFalse(s.includes("\n"));
    assertFalse(s.includes("  "));
  }
});

Deno.test("prose scope selects changed comments and unchanged attached headers, never code or strings", async () => {
  const sources = {
    "src/a.ts":
      '/** Entries record only a. */\nexport interface Entry {\n  a: string;\n  b: string;\n}\nconst sample = "// not a comment";\n// Every value is accepted.\nrun();\n',
    "src/run.sh": '# only one caller\necho "# not a comment"\n',
    "src/run.rs": '// only one caller\nlet text = r#"// not a comment"#;\n',
    "src/run.sql": "-- only one caller\nSELECT '-- not a comment';\n",
    "tests/a_test.ts": "// must never be selected\n",
  };
  const scope = await collectDocProseScope({
    changedFiles: Object.keys(sources),
    trackedFiles: Object.keys(sources),
    summaryContent: "",
    diff: Object.keys(sources).map((p) => `+++ b/${p}\n@@ -0,0 +1,8 @@\n`).join(
      "",
    ),
    readFile: async (p) => sources[p as keyof typeof sources],
  });
  assertStringIncludes(
    scope.contents.get("src/a.ts")!,
    "Entries record only a.",
  );
  assertStringIncludes(
    scope.contents.get("src/a.ts")!,
    "Every value is accepted.",
  );
  for (const text of scope.contents.values()) {
    assertFalse(text.includes("not a comment"));
    assertFalse(text.includes("run();"));
    assertFalse(text.includes("a: string"));
  }
  assertEquals(scope.contents.has("tests/a_test.ts"), false);
  assertEquals(scope.contents.size, 4);
});

Deno.test("prose scope follows named sections and source basenames into untouched manuals", async () => {
  const files = new Map([
    [
      "src/gate.ts",
      "/** Applies a gate. */\nexport function gate() {\n  third();\n}\n",
    ],
    [
      "docs/config.md",
      "# Configuration\n## Pre-flight gate\nThe gate runs at two points.\nEvery failure is refused.\n## Other\nUnrelated claim.\n",
    ],
    [
      "docs/operator.md",
      "# Operator\n## Invocation\n`gate.ts` never runs before a push.\n## Other\nNot selected.\n",
    ],
    ["docs/api.md", "# API\n## Contract\nThe exported gate always rejects.\n"],
    ["docs/archive/old.md", "# Old\n`gate.ts` old claim.\n"],
  ]);
  const scope = await collectDocProseScope({
    changedFiles: ["src/gate.ts"],
    trackedFiles: [...files.keys()],
    summaryContent:
      "**Docs sweep** — section: docs/config.md pre-flight gate section; siblings: none — no member added",
    diff: "+++ b/src/gate.ts\n@@ -2,0 +3,1 @@\n+third();\n",
    readFile: async (p) => files.get(p),
  });
  assertStringIncludes(scope.contents.get("src/gate.ts")!, "Applies a gate.");
  assertStringIncludes(
    scope.contents.get("docs/config.md")!,
    "The gate runs at two points.",
  );
  assertStringIncludes(
    scope.contents.get("docs/config.md")!,
    "Every failure is refused.",
  );
  assertFalse(
    scope.contents.get("docs/config.md")!.includes("Unrelated claim"),
  );
  assertStringIncludes(
    scope.contents.get("docs/operator.md")!,
    "never runs before a push",
  );
  assertStringIncludes(
    scope.contents.get("docs/api.md")!,
    "The exported gate always rejects.",
  );
  assertFalse(scope.contents.has("docs/archive/old.md"));
  const capped = await collectDocProseScope({
    changedFiles: ["src/gate.ts"],
    trackedFiles: [...files.keys()],
    summaryContent: "",
    diff: "+++ b/src/gate.ts\n@@ -2,0 +3,1 @@\n+third();\n",
    readFile: async (p) => files.get(p),
    sectionCap: 0,
  });
  assertFalse(capped.contents.has("docs/operator.md"));
  assert(
    capped.notChecked.some((s) =>
      s.includes("docs/operator.md:2-3") &&
      s.includes("not checked, never passed")
    ),
  );
});

Deno.test("prose scope bounds the issue's Configuration section and recognises multiline declaration parameters", async () => {
  const files = new Map([
    [
      "src/gate.ts",
      'import { run } from "./run.ts";\n/** This function runs only twice. */\nexport function gate(\n  opts: {\n    x: string;\n  },\n) {\n  run();\n  run();\n  run();\n}\n',
    ],
    [
      "docs/CONFIGURATION.md",
      "# Configuration\n## Pre-flight gate\nThe gate runs at two points.\n## Unrelated\nOld unrelated prose.\n",
    ],
  ]);
  const scope = await collectDocProseScope({
    changedFiles: ["src/gate.ts"],
    trackedFiles: [...files.keys()],
    summaryContent:
      "**Docs sweep** — section: docs/CONFIGURATION.md pre-flight gate section; siblings: none — no member added",
    diff: "+++ b/src/gate.ts\n@@ -9,0 +10,1 @@\n+run();\n",
    readFile: async (p) => files.get(p),
  });
  assertStringIncludes(
    scope.contents.get("src/gate.ts")!,
    "This function runs only twice.",
  );
  assertEquals(
    scope.ranges.filter((r) => r.file === "docs/CONFIGURATION.md").map((
      r,
    ) => [r.start, r.end]),
    [[2, 3]],
  );
  assertFalse(
    scope.contents.get("docs/CONFIGURATION.md")!.includes(
      "Old unrelated prose.",
    ),
  );
  const unreadable = await collectDocProseScope({
    changedFiles: ["src/gate.ts"],
    trackedFiles: ["src/gate.ts"],
    summaryContent: "",
    diff: null,
    readFile: async () => undefined,
  });
  assertEquals(unreadable.contents.size, 0);
  assert(
    unreadable.notChecked.some((n) =>
      n.includes("src/gate.ts") && n.includes("not checked, never passed")
    ),
  );
});
