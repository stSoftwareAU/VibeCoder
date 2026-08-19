/**
 * Tests for quality_helpers.ts (Issue #917).
 *
 * Verifies quality check helper functions: argument parsing, check recording,
 * summary formatting, failure message formatting, baseline note formatting,
 * and tool detection.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyEnvOverrides,
  type CheckResult,
  detectMissingQualityTools,
  detectTool,
  formatBaselineCarryoverNote,
  formatBaselineQualityNote,
  formatMissingToolsMessage,
  formatQualityFailureMessage,
  formatSummary,
  parseQualityArgs,
  recordCheck,
} from "../lib/quality_helpers.ts";

// =============================================================================
// parseQualityArgs tests
// =============================================================================

Deno.test("parseQualityArgs - returns defaults with no arguments", () => {
  const result = parseQualityArgs([]);
  assertEquals(result, {
    strict: false,
    sequential: false,
    validatePrompts: false,
  });
});

Deno.test("parseQualityArgs - sets strict for --strict flag", () => {
  const result = parseQualityArgs(["--strict"]);
  assertEquals(result.strict, true);
  assertEquals(result.sequential, false);
});

Deno.test("parseQualityArgs - sets sequential for --sequential flag", () => {
  const result = parseQualityArgs(["--sequential"]);
  assertEquals(result.sequential, true);
  assertEquals(result.strict, false);
});

Deno.test("parseQualityArgs - sets validatePrompts for --validate-prompts", () => {
  const result = parseQualityArgs(["--validate-prompts"]);
  assertEquals(result.validatePrompts, true);
});

Deno.test("parseQualityArgs - handles multiple flags together", () => {
  const result = parseQualityArgs([
    "--strict",
    "--sequential",
    "--validate-prompts",
  ]);
  assertEquals(result.strict, true);
  assertEquals(result.sequential, true);
  assertEquals(result.validatePrompts, true);
});

Deno.test("parseQualityArgs - ignores unknown arguments", () => {
  const result = parseQualityArgs(["--unknown", "some-arg"]);
  assertEquals(result, {
    strict: false,
    sequential: false,
    validatePrompts: false,
  });
});

// =============================================================================
// applyEnvOverrides tests
// =============================================================================

Deno.test("applyEnvOverrides - applies QUALITY_STRICT env var", () => {
  const base = { strict: false, sequential: false, validatePrompts: false };
  const result = applyEnvOverrides(base, { QUALITY_STRICT: "true" });
  assertEquals(result.strict, true);
});

Deno.test("applyEnvOverrides - applies QUALITY_SEQUENTIAL env var", () => {
  const base = { strict: false, sequential: false, validatePrompts: false };
  const result = applyEnvOverrides(base, { QUALITY_SEQUENTIAL: "true" });
  assertEquals(result.sequential, true);
});

Deno.test("applyEnvOverrides - does not override CLI flags with missing env", () => {
  const base = { strict: true, sequential: false, validatePrompts: false };
  const result = applyEnvOverrides(base, {});
  assertEquals(result.strict, true);
});

Deno.test("applyEnvOverrides - env var 'false' does not enable option", () => {
  const base = { strict: false, sequential: false, validatePrompts: false };
  const result = applyEnvOverrides(base, { QUALITY_STRICT: "false" });
  assertEquals(result.strict, false);
});

// =============================================================================
// recordCheck tests
// =============================================================================

Deno.test("recordCheck - adds new entry", () => {
  const results: CheckResult[] = [];
  recordCheck(results, "shellcheck", "PASSED");
  assertEquals(results.length, 1);
  assertEquals(results[0]!.name, "shellcheck");
  assertEquals(results[0]!.status, "PASSED");
});

Deno.test("recordCheck - updates existing entry in place", () => {
  const results: CheckResult[] = [];
  recordCheck(results, "shellcheck", "PASSED");
  recordCheck(results, "shellcheck", "FAILED");
  assertEquals(results.length, 1);
  assertEquals(results[0]!.status, "FAILED");
});

Deno.test("recordCheck - preserves other entries when updating", () => {
  const results: CheckResult[] = [];
  recordCheck(results, "shellcheck", "PASSED");
  recordCheck(results, "deno lint", "PASSED");
  recordCheck(results, "shellcheck", "FAILED");
  assertEquals(results.length, 2);
  assertEquals(results[0]!.status, "FAILED");
  assertEquals(results[1]!.status, "PASSED");
});

// =============================================================================
// formatSummary tests
// =============================================================================

Deno.test("formatSummary - all passed shows PASSED", () => {
  const results: CheckResult[] = [
    { name: "shellcheck", status: "PASSED" },
    { name: "deno test", status: "PASSED" },
    { name: "deno lint", status: "PASSED" },
  ];
  const summary = formatSummary(results, false);
  assertEquals(summary.passed, true);
  assertStringIncludes(summary.text, "Result: PASSED");
  assertStringIncludes(summary.text, "shellcheck");
  assertStringIncludes(summary.text, "deno test");
  assertStringIncludes(summary.text, "deno lint");
});

Deno.test("formatSummary - skipped checks pass in non-strict mode", () => {
  const results: CheckResult[] = [
    { name: "shellcheck", status: "SKIPPED" },
    { name: "deno test", status: "PASSED" },
  ];
  const summary = formatSummary(results, false);
  assertEquals(summary.passed, true);
  assertStringIncludes(summary.text, "PASSED (with skipped checks)");
});

Deno.test("formatSummary - skipped checks fail in strict mode", () => {
  const results: CheckResult[] = [
    { name: "shellcheck", status: "SKIPPED" },
    { name: "deno test", status: "PASSED" },
  ];
  const summary = formatSummary(results, true);
  assertEquals(summary.passed, false);
  assertStringIncludes(summary.text, "strict mode");
});

Deno.test("formatSummary - failed check returns FAILED", () => {
  const results: CheckResult[] = [
    { name: "shellcheck", status: "PASSED" },
    { name: "deno test", status: "FAILED" },
  ];
  const summary = formatSummary(results, false);
  assertEquals(summary.passed, false);
  assertStringIncludes(summary.text, "Result: FAILED");
});

Deno.test("formatSummary - preserves check order", () => {
  const results: CheckResult[] = [
    { name: "first check", status: "PASSED" },
    { name: "second check", status: "SKIPPED" },
    { name: "third check", status: "PASSED" },
  ];
  const summary = formatSummary(results, false);
  const firstIdx = summary.text.indexOf("first check");
  const secondIdx = summary.text.indexOf("second check");
  const thirdIdx = summary.text.indexOf("third check");
  assertEquals(firstIdx < secondIdx, true);
  assertEquals(secondIdx < thirdIdx, true);
});

Deno.test("formatSummary - includes Quality Check Summary header", () => {
  const results: CheckResult[] = [{ name: "test", status: "PASSED" }];
  const summary = formatSummary(results, false);
  assertStringIncludes(summary.text, "=== Quality Check Summary ===");
});

// =============================================================================
// detectTool tests
// =============================================================================

Deno.test("detectTool - finds bash (always available)", async () => {
  const result = await detectTool("bash");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "bash");
  }
});

Deno.test("detectTool - returns error for nonexistent tool", async () => {
  const result = await detectTool("nonexistent_tool_xyzzy_12345");
  assertEquals(result.ok, false);
});

Deno.test("detectTool - finds deno in HOME/.deno/bin if on PATH", async () => {
  // Deno is always on PATH when running this test
  const result = await detectTool("deno");
  assertEquals(result.ok, true);
});

// =============================================================================
// detectMissingQualityTools tests (Issue #3036)
//
// These exercise the real PATH/regex logic rather than a mock, so a refactor
// of the tool list or word-boundary pattern cannot silently break detection.
// =============================================================================

Deno.test("detectMissingQualityTools - missing script returns empty list", async () => {
  // The documented graceful path: an unreadable script yields no missing tools.
  const result = await detectMissingQualityTools(
    "/no/such/file_xyzzy_3036.sh",
  );
  assertEquals(result.ok, true);
  assertEquals(result.ok && result.value, []);
});

Deno.test("detectMissingQualityTools - present tool (deno) is not reported", async () => {
  // deno is always on PATH while these tests run, so it must never be flagged.
  const tmp = await Deno.makeTempFile({ suffix: ".sh" });
  try {
    await Deno.writeTextFile(tmp, "#!/bin/bash\ndeno task test\n");
    const result = await detectMissingQualityTools(tmp);
    assertEquals(result.ok, true);
    assertEquals(result.ok && result.value.includes("deno"), false);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("detectMissingQualityTools - word-boundary regex ignores substring matches", async () => {
  // "npmrc" must not match the "npm" tool word, so npm is never checked or
  // reported even though the three letters appear in the script.
  const tmp = await Deno.makeTempFile({ suffix: ".sh" });
  try {
    await Deno.writeTextFile(tmp, "#!/bin/bash\ncat .npmrc\ndeno task test\n");
    const result = await detectMissingQualityTools(tmp);
    assertEquals(result.ok, true);
    assertEquals(result.ok && result.value.includes("npm"), false);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("detectMissingQualityTools - reports a referenced tool that is absent from PATH", async () => {
  // Find a candidate tool genuinely absent on this machine, reference it, and
  // assert the real implementation flags it as missing.
  const candidates = ["yarn", "pnpm", "bun", "npx", "npm", "node"];
  let absent: string | undefined;
  for (const tool of candidates) {
    if (!(await detectTool(tool)).ok) {
      absent = tool;
      break;
    }
  }
  if (!absent) {
    // Every candidate is installed here; nothing deterministic to assert.
    return;
  }

  const tmp = await Deno.makeTempFile({ suffix: ".sh" });
  try {
    await Deno.writeTextFile(tmp, `#!/bin/bash\n${absent} build\n`);
    const result = await detectMissingQualityTools(tmp);
    assertEquals(result.ok, true);
    assertEquals(result.ok && result.value.includes(absent), true);
  } finally {
    await Deno.remove(tmp);
  }
});

// =============================================================================
// formatQualityFailureMessage tests
// =============================================================================

Deno.test("formatQualityFailureMessage - includes actual output", () => {
  const output =
    "Running shellcheck...\nERROR: SC2086 Double quote\nFAIL: 1 error";
  const message = formatQualityFailureMessage(output);
  assertStringIncludes(message, "SC2086 Double quote");
  assertStringIncludes(message, "FAIL: 1 error");
});

Deno.test("formatQualityFailureMessage - uses details block for full output", () => {
  const output = "Check 1: PASSED\nCheck 2: FAILED";
  const message = formatQualityFailureMessage(output);
  assertStringIncludes(message, "<details>");
  assertStringIncludes(message, "</details>");
  assertStringIncludes(message, "Full quality check output");
});

Deno.test("formatQualityFailureMessage - shows last 30 lines prominently", () => {
  const lines = Array.from(
    { length: 50 },
    (_, i) => `Line ${i + 1}: test output`,
  );
  const output = lines.join("\n");
  const message = formatQualityFailureMessage(output);
  assertStringIncludes(message, "Line 50: test output");
  assertStringIncludes(message, "Line 21: test output");
  assertStringIncludes(message, "Quality Check Output");
});

Deno.test("formatQualityFailureMessage - truncates full output to 200 lines max", () => {
  const lines = Array.from(
    { length: 300 },
    (_, i) => `Line ${i + 1}: verbose output`,
  );
  const output = lines.join("\n");
  const message = formatQualityFailureMessage(output);
  assertStringIncludes(message, "truncated");
  assertStringIncludes(message, "Line 300: verbose output");
});

Deno.test("formatQualityFailureMessage - short output is not truncated", () => {
  const output = "Line 1: check passed\nLine 2: check failed\nLine 3: done";
  const message = formatQualityFailureMessage(output);
  assertEquals(message.includes("truncated"), false);
  assertStringIncludes(message, "Line 1: check passed");
  assertStringIncludes(message, "Line 3: done");
});

Deno.test("formatQualityFailureMessage - handles empty output", () => {
  const message = formatQualityFailureMessage("");
  assertStringIncludes(message, "Quality checks");
  assertStringIncludes(message, "failed");
});

Deno.test("formatQualityFailureMessage - includes header about quality checks failing", () => {
  const message = formatQualityFailureMessage("FAIL: tests failed");
  assertStringIncludes(message, "Quality checks");
  assertStringIncludes(message, "failed");
  assertStringIncludes(message, "could not be fixed automatically");
});

Deno.test("formatQualityFailureMessage - includes retry notice", () => {
  const message = formatQualityFailureMessage("FAIL: tests failed");
  assertStringIncludes(message, "retried");
});

Deno.test("formatQualityFailureMessage - includes baseline context when baseline failed", () => {
  const message = formatQualityFailureMessage(
    "FAIL: tests failed",
    false,
    "FAIL: pre-existing lint error",
  );
  assertStringIncludes(message, "pre-existing");
  assertStringIncludes(message, "before the worker started");
});

Deno.test("formatQualityFailureMessage - no baseline context when baseline passed", () => {
  const message = formatQualityFailureMessage(
    "FAIL: tests failed",
    true,
    "",
  );
  assertEquals(message.includes("pre-existing"), false);
  assertEquals(message.includes("before the worker started"), false);
});

// =============================================================================
// formatBaselineQualityNote tests
// =============================================================================

Deno.test("formatBaselineQualityNote - includes pre-existing failure notice", () => {
  const note = formatBaselineQualityNote("FAIL: shellcheck found 2 errors");
  assertStringIncludes(note, "already failing");
  assertStringIncludes(note, "before the worker started");
});

Deno.test("formatBaselineQualityNote - includes baseline output excerpt", () => {
  const note = formatBaselineQualityNote(
    "FAIL: shellcheck found 2 errors\nERROR: worker/foo.sh:10 SC2086",
  );
  assertStringIncludes(note, "SC2086");
});

Deno.test("formatBaselineQualityNote - returns empty when baseline passed", () => {
  const note = formatBaselineQualityNote("");
  assertEquals(note, "");
});

Deno.test("formatBaselineQualityNote - truncates very long baseline output", () => {
  const lines = Array.from(
    { length: 100 },
    (_, i) => `Line ${i + 1}: baseline error`,
  );
  const note = formatBaselineQualityNote(lines.join("\n"));
  assertEquals(note.length > 0, true);
  assertStringIncludes(note, "Line 100");
});

// =============================================================================
// formatMissingToolsMessage tests
// =============================================================================

Deno.test("formatMissingToolsMessage - lists missing tools", () => {
  const message = formatMissingToolsMessage(["npm", "node"], "./quality.sh");
  assertStringIncludes(message, "`npm`");
  assertStringIncludes(message, "`node`");
  assertStringIncludes(message, "not available in the worker environment");
});

Deno.test("formatMissingToolsMessage - references quality script path", () => {
  const message = formatMissingToolsMessage(["deno"], "/path/to/quality.sh");
  assertStringIncludes(message, "/path/to/quality.sh");
});

Deno.test("formatMissingToolsMessage - includes fix instructions", () => {
  const message = formatMissingToolsMessage(["npm"], "./quality.sh");
  assertStringIncludes(message, "docker_image");
  assertStringIncludes(message, "How to fix");
});

// =============================================================================
// formatBaselineCarryoverNote tests (Issue #1549)
// =============================================================================

Deno.test("formatBaselineCarryoverNote - returns empty string for zero count", () => {
  assertEquals(formatBaselineCarryoverNote(0), "");
});

Deno.test("formatBaselineCarryoverNote - singular grammar for count of 1", () => {
  const note = formatBaselineCarryoverNote(1);
  assertStringIncludes(note, "1 pre-existing");
  assertStringIncludes(note, "finding was");
  assertStringIncludes(note, "Baseline carryover");
});

Deno.test("formatBaselineCarryoverNote - plural grammar for count > 1", () => {
  const note = formatBaselineCarryoverNote(3);
  assertStringIncludes(note, "3 pre-existing");
  assertStringIncludes(note, "findings were");
});
