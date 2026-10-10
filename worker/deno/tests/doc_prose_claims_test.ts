// Tests for the manual/prompt prose scope and question shared by the
// first-run claim check and the review-fix drift check (Issue #3347).
// Uses Australian English throughout.

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
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
