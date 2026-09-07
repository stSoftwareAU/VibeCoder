/**
 * Tests for markdownlint_check.ts (Issue #1685).
 *
 * Covers:
 *   - parseMarkdownlintOutput parses violation lines with file:line:col
 *     and file:line variants, ignoring summary/preamble noise.
 *   - runMarkdownlintCheck PASSED when runner exits 0 with no violations.
 *   - runMarkdownlintCheck FAILED when runner reports violations
 *     (malformed table fixture mirrors the regression class the issue
 *     calls out).
 *   - runMarkdownlintCheck SKIPPED when no runner is detected.
 *   - SKIPPED state is promoted to FAILED via the shared formatSummary
 *     helper when strict mode is requested (mirrors the mermaid
 *     pattern).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type DetectMarkdownlintRunner,
  type MarkdownlintRunner,
  parseMarkdownlintOutput,
  runMarkdownlintCheck,
} from "../lib/markdownlint_check.ts";
import { formatSummary, recordCheck } from "../lib/quality_helpers.ts";

// =============================================================================
// parseMarkdownlintOutput
// =============================================================================

Deno.test("parseMarkdownlintOutput - ignores preamble and summary lines", () => {
  const output = [
    "markdownlint-cli2 v0.22.1 (markdownlint v0.40.0)",
    "Finding: AGENTS.md docs/**/*.md",
    "Linting: 60 file(s)",
    "Summary: 0 error(s)",
  ].join("\n");
  assertEquals(parseMarkdownlintOutput(output), []);
});

Deno.test("parseMarkdownlintOutput - parses file:line:col violation", () => {
  const output =
    'AGENTS.md:148:1 error MD018/no-missing-space-atx No space after hash on atx style heading [Context: "#1575 and #1600."]';
  const violations = parseMarkdownlintOutput(output);
  assertEquals(violations.length, 1);
  const v = violations[0]!;
  assertEquals(v.file, "AGENTS.md");
  assertEquals(v.line, 148);
  assertEquals(v.column, 1);
  assertEquals(v.rule, "MD018/no-missing-space-atx");
  assertStringIncludes(v.message, "No space after hash");
});

Deno.test("parseMarkdownlintOutput - parses file:line (no column) violation", () => {
  const output =
    "docs/INTERNALS.md:7 error MD001/heading-increment Heading levels should only increment by one level at a time";
  const violations = parseMarkdownlintOutput(output);
  assertEquals(violations.length, 1);
  const v = violations[0]!;
  assertEquals(v.file, "docs/INTERNALS.md");
  assertEquals(v.line, 7);
  assertEquals(v.column, undefined);
  assertEquals(v.rule, "MD001/heading-increment");
});

Deno.test("parseMarkdownlintOutput - extracts multiple violations", () => {
  const output = [
    "markdownlint-cli2 v0.22.1",
    "Linting: 3 file(s)",
    "Summary: 2 error(s)",
    "AGENTS.md:1:1 error MD041/first-line-h1 first line should be h1",
    "SECURITY.md:179:100 error MD056/table-column-count Table column count [Expected: 3; Actual: 4]",
  ].join("\n");
  const violations = parseMarkdownlintOutput(output);
  assertEquals(violations.length, 2);
  assertEquals(violations[0]!.file, "AGENTS.md");
  assertEquals(violations[1]!.file, "SECURITY.md");
  assertEquals(violations[1]!.line, 179);
  assertEquals(violations[1]!.column, 100);
});

// =============================================================================
// runMarkdownlintCheck — uses an injected fake runner so the test does
// not depend on a Node/markdownlint-cli2 toolchain. The fake captures
// invocations and returns canned exit codes/output, so we can drive the
// orchestrator through every status branch.
// =============================================================================

interface FakeRunnerCapture {
  invocations: Array<{ scriptDir: string }>;
}

function makeFakeRunner(
  exitCode: number,
  stdout: string,
  capture: FakeRunnerCapture,
): MarkdownlintRunner {
  return (scriptDir) => {
    capture.invocations.push({ scriptDir });
    return Promise.resolve({ exitCode, stdout, stderr: "" });
  };
}

function fakeDetect(
  runner: MarkdownlintRunner | null,
): DetectMarkdownlintRunner {
  return () => Promise.resolve(runner);
}

Deno.test("runMarkdownlintCheck - PASSED when runner exits 0 with no violations", async () => {
  const capture: FakeRunnerCapture = { invocations: [] };
  const runner = makeFakeRunner(
    0,
    "markdownlint-cli2 v0.22.1\nLinting: 4 file(s)\nSummary: 0 error(s)\n",
    capture,
  );
  const result = await runMarkdownlintCheck("/some/repo", {
    detectRunner: fakeDetect(runner),
  });

  assertEquals(result.status, "PASSED");
  assertEquals(result.violations.length, 0);
  assertStringIncludes(result.output, "markdownlint: PASSED");
  assertEquals(capture.invocations.length, 1);
  assertEquals(capture.invocations[0]!.scriptDir, "/some/repo");
});

Deno.test("runMarkdownlintCheck - FAILED when runner reports a malformed table violation", async () => {
  const capture: FakeRunnerCapture = { invocations: [] };
  const stdout = [
    "markdownlint-cli2 v0.22.1",
    "Linting: 1 file(s)",
    "Summary: 1 error(s)",
    "fixture.md:5:1 error MD056/table-column-count Table column count [Expected: 3; Actual: 4]",
  ].join("\n");
  const runner = makeFakeRunner(1, stdout, capture);
  const result = await runMarkdownlintCheck("/some/repo", {
    detectRunner: fakeDetect(runner),
  });

  assertEquals(result.status, "FAILED");
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0]!.file, "fixture.md");
  assertEquals(result.violations[0]!.line, 5);
  assertEquals(result.violations[0]!.rule, "MD056/table-column-count");
  assertStringIncludes(result.output, "markdownlint: FAILED");
  assertStringIncludes(result.output, "fixture.md:5");
  assertStringIncludes(result.output, "MD056/table-column-count");
});

Deno.test("runMarkdownlintCheck - FAILED when runner exits non-zero even without parsed violations", async () => {
  // Defensive: if the runner dies (e.g. config syntax error) and emits
  // only a stderr blob, we still report FAILED rather than swallow.
  const capture: FakeRunnerCapture = { invocations: [] };
  const runner: MarkdownlintRunner = (scriptDir) => {
    capture.invocations.push({ scriptDir });
    return Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: "Error: cannot parse .markdownlint-cli2.jsonc",
    });
  };
  const result = await runMarkdownlintCheck("/some/repo", {
    detectRunner: fakeDetect(runner),
  });

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "markdownlint: FAILED");
  assertStringIncludes(result.output, "cannot parse");
});

Deno.test("runMarkdownlintCheck - SKIPPED when no runner is detected", async () => {
  const result = await runMarkdownlintCheck("/some/repo", {
    detectRunner: fakeDetect(null),
  });

  assertEquals(result.status, "SKIPPED");
  assertEquals(result.violations.length, 0);
  assertEquals(result.filesChecked, 0);
  assertStringIncludes(result.output, "markdownlint: SKIPPED");
  assert(result.skipReason);
  assertStringIncludes(result.skipReason!, "markdownlint-cli2");
});

Deno.test("runMarkdownlintCheck - SKIPPED is promoted to FAILED in strict mode (formatSummary)", () => {
  // Mirrors how the quality gate evaluates strictness for SKIPPED rows
  // — check-mermaid does the same. Keeping this in the markdownlint
  // suite documents the contract and prevents regressions if the
  // helper changes.
  const checks: Array<
    { name: string; status: "PASSED" | "SKIPPED" | "FAILED" }
  > = [];
  recordCheck(checks, "markdownlint", "SKIPPED");

  const lenient = formatSummary(checks, false);
  assertEquals(lenient.passed, true);
  assertStringIncludes(lenient.text, "markdownlint");

  const strict = formatSummary(checks, true);
  assertEquals(strict.passed, false);
  assertStringIncludes(strict.text, "FAILED");
});
