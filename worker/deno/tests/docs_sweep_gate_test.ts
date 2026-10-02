/**
 * Unit tests for the PR-summary docs-sweep gate (Issue #3073).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDocsSweepGateComment,
  codeChangingFiles,
  isDocsSweepExemptPath,
  parseDocsSweepLine,
  validateDocsSweep,
} from "../lib/docs_sweep_gate.ts";

// ---------------------------------------------------------------------------
// isDocsSweepExemptPath / codeChangingFiles
// ---------------------------------------------------------------------------

Deno.test("isDocsSweepExemptPath - test files are exempt", () => {
  assert(isDocsSweepExemptPath("worker/deno/tests/foo_test.ts"));
  assert(isDocsSweepExemptPath("web/src/foo.test.tsx"));
});

Deno.test("isDocsSweepExemptPath - documentation files are exempt", () => {
  assert(isDocsSweepExemptPath("README.md"));
});

Deno.test("isDocsSweepExemptPath - a docs/ path segment is exempt regardless of extension", () => {
  assert(isDocsSweepExemptPath("docs/guide.png"));
  assert(isDocsSweepExemptPath("crates/x/docs/a.txt"));
});

Deno.test("isDocsSweepExemptPath - code paths are not exempt", () => {
  assertEquals(isDocsSweepExemptPath("web/src/BrokerBalance.tsx"), false);
  assertEquals(isDocsSweepExemptPath("crates/report/src/decisions.rs"), false);
  assertEquals(isDocsSweepExemptPath(".github/workflows/ci.yml"), false);
});

Deno.test("isDocsSweepExemptPath - empty or whitespace path is exempt", () => {
  assert(isDocsSweepExemptPath(""));
  assert(isDocsSweepExemptPath("   "));
});

Deno.test("codeChangingFiles - filters out test and doc paths", () => {
  const files = [
    "worker/deno/tests/foo_test.ts",
    "README.md",
    "docs/guide.md",
    "web/src/BrokerBalance.tsx",
    "crates/report/src/decisions.rs",
  ];
  assertEquals(codeChangingFiles(files), [
    "web/src/BrokerBalance.tsx",
    "crates/report/src/decisions.rs",
  ]);
});

// ---------------------------------------------------------------------------
// parseDocsSweepLine
// ---------------------------------------------------------------------------

Deno.test("parseDocsSweepLine - plain line with section parses", () => {
  const line = parseDocsSweepLine(
    "**Docs sweep** — grep: `retryLimit`; section: `docs/workflows/retries.md#retry-limit`; no hits",
  );
  assert(line.present);
  assertEquals(line.section, "docs/workflows/retries.md#retry-limit");
});

Deno.test("parseDocsSweepLine - list-item decorated variant parses", () => {
  const line = parseDocsSweepLine(
    "- **Docs sweep** — grep: `x`; section: `docs/x.md#y`; no hits",
  );
  assert(line.present);
  assertEquals(line.section, "docs/x.md#y");
});

Deno.test("parseDocsSweepLine - bold-colon variant parses", () => {
  const line = parseDocsSweepLine(
    "**Docs sweep:** grep: `x`; section: `docs/x.md#y`; no hits",
  );
  assert(line.present);
  assertEquals(line.section, "docs/x.md#y");
});

Deno.test("parseDocsSweepLine - a mid-prose mention does not count", () => {
  const line = parseDocsSweepLine(
    "We did the docs sweep already in a previous PR, no need to repeat it here.",
  );
  assertEquals(line.present, false);
});

Deno.test("parseDocsSweepLine - absent line reports not present", () => {
  const line = parseDocsSweepLine("## Summary\n\nFixed the thing.\n");
  assertEquals(line.present, false);
  assertEquals(line.section, "");
});

Deno.test("parseDocsSweepLine - line with no section field reports empty section", () => {
  const line = parseDocsSweepLine("**Docs sweep** — grep: `x`; no hits");
  assert(line.present);
  assertEquals(line.section, "");
});

// ---------------------------------------------------------------------------
// validateDocsSweep
// ---------------------------------------------------------------------------

const CODE_FILES = ["web/src/BrokerBalance.tsx", "crates/report/src/decisions.rs"];
const DOC_FILES = ["README.md", "docs/guide.md", "worker/deno/tests/foo_test.ts"];

Deno.test("validateDocsSweep - docs-only diff is not applicable", () => {
  const result = validateDocsSweep({
    changedFiles: DOC_FILES,
    prSummaryContent: "## Summary\n\nFixed the docs.\n",
  });
  assertEquals(result.applicable, false);
  assertEquals(result.valid, true);
});

Deno.test("validateDocsSweep - code diff with no line is rejected", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: "## Summary\n\nFixed the thing.\n",
  });
  assertEquals(result.applicable, true);
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "Docs sweep");
});

Deno.test("validateDocsSweep - code diff with a line but no section is rejected", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: "**Docs sweep** — grep: `x`; no hits",
  });
  assertEquals(result.applicable, true);
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "section");
});

Deno.test("validateDocsSweep - a bare 'section: none' is rejected", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: "**Docs sweep** — grep: `x`; section: none; no hits",
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "placeholder");
});

Deno.test("validateDocsSweep - 'section: none — <reason>' is accepted", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent:
      "**Docs sweep** — grep: `x`; section: none — no manual documents this flag; no hits",
  });
  assertEquals(result.valid, true, result.problems.join("; "));
});

Deno.test(
  "validateDocsSweep - rejects a code-changing summary without the line and accepts `no hits` with a named section",
  () => {
    const rejected = validateDocsSweep({
      changedFiles: CODE_FILES,
      prSummaryContent: "## Summary\n\nNo docs sweep line here.\n",
    });
    assertEquals(rejected.valid, false);
    assertStringIncludes(rejected.problems[0]!, "Docs sweep");

    const accepted = validateDocsSweep({
      changedFiles: CODE_FILES,
      prSummaryContent:
        "**Docs sweep** — grep: `retryLimit`; section: `docs/workflows/retries.md#retry-limit`; no hits",
    });
    assertEquals(accepted.valid, true, accepted.problems.join("; "));
  },
);

Deno.test("validateDocsSweep - changedFiles null is applicable and rejected without a line", () => {
  const result = validateDocsSweep({
    changedFiles: null,
    prSummaryContent: "## Summary\n\nFixed the thing.\n",
  });
  assertEquals(result.applicable, true);
  assertEquals(result.valid, false);
  assertEquals(result.changedFilesKnown, false);
  assertEquals(result.codeFiles, []);
});

Deno.test("validateDocsSweep - changedFiles null is accepted with a valid line", () => {
  const result = validateDocsSweep({
    changedFiles: null,
    prSummaryContent:
      "**Docs sweep** — grep: `x`; section: `docs/x.md#y`; no hits",
  });
  assertEquals(result.applicable, true);
  assertEquals(result.valid, true, result.problems.join("; "));
});

Deno.test("validateDocsSweep - names up to 5 code files then 'and N more'", () => {
  const files = [
    "a.ts",
    "b.ts",
    "c.ts",
    "d.ts",
    "e.ts",
    "f.ts",
    "g.ts",
  ];
  const result = validateDocsSweep({
    changedFiles: files,
    prSummaryContent: "## Summary\n\nNo line.\n",
  });
  assertStringIncludes(result.problems[0]!, "a.ts");
  assertStringIncludes(result.problems[0]!, "and 2 more");
});

// ---------------------------------------------------------------------------
// buildDocsSweepGateComment
// ---------------------------------------------------------------------------

Deno.test("buildDocsSweepGateComment - contains the problems and the section shape", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: "## Summary\n\nNo docs sweep line.\n",
  });
  const comment = buildDocsSweepGateComment(result);
  assertStringIncludes(comment, result.problems[0]!);
  assertStringIncludes(comment, "section:");
  assertStringIncludes(comment, "Docs sweep");
});
