/**
 * Tests for failure_diagnosis.ts — context-aware failure categorisation
 * and diagnosis messaging (Issue #398, #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  detectFailureCategory,
  extractKeyErrorLines,
  type FailureCategory,
  formatZeroOutputDiagnostics,
  getFailureCategoryDisplay,
  getFailureDiagnosis,
  getFailureDiagnosisOneliner,
  isInfrastructureFailure,
  normaliseFailureCategory,
  parseDiagnosticContext,
} from "../lib/failure_diagnosis.ts";

// ============================================================================
// detectFailureCategory
// ============================================================================

Deno.test("failure diagnosis - detects timeout from 'timed out'", () => {
  assertEquals(
    detectFailureCategory("Claude timed out after 3600s"),
    "timeout",
  );
});

Deno.test("failure diagnosis - detects timeout from 'timeout'", () => {
  assertEquals(detectFailureCategory("timeout exceeded"), "timeout");
});

Deno.test("failure diagnosis - detects zero_output within timeout context", () => {
  assertEquals(
    detectFailureCategory("timed out with zero output"),
    "zero_output",
  );
});

Deno.test("failure diagnosis - detects zero_output from 'No output captured'", () => {
  assertEquals(
    detectFailureCategory("No output captured from Claude"),
    "zero_output",
  );
});

Deno.test("failure diagnosis - detects rate_limit", () => {
  assertEquals(detectFailureCategory("API rate limit exceeded"), "rate_limit");
});

Deno.test("failure diagnosis - detects rate-limited variant", () => {
  assertEquals(detectFailureCategory("Claude was rate-limited"), "rate_limit");
});

Deno.test("failure diagnosis - detects missing_tools from 'command not found'", () => {
  assertEquals(
    detectFailureCategory("npm: command not found"),
    "missing_tools",
  );
});

Deno.test("failure diagnosis - detects missing_tools from 'not installed'", () => {
  assertEquals(
    detectFailureCategory("node not installed or not in PATH"),
    "missing_tools",
  );
});

Deno.test("failure diagnosis - detects quality_check", () => {
  assertEquals(
    detectFailureCategory("Failed quality.sh checks"),
    "quality_check",
  );
});

Deno.test("failure diagnosis - detects quality_check from 'Quality checks'", () => {
  assertEquals(
    detectFailureCategory("Quality checks failed"),
    "quality_check",
  );
});

Deno.test("failure diagnosis - detects push_failure", () => {
  assertEquals(
    detectFailureCategory("Git push failed due to remote rejection"),
    "push_failure",
  );
});

Deno.test("failure diagnosis - detects evidence_missing", () => {
  assertEquals(
    detectFailureCategory("Missing screenshot evidence for UI changes"),
    "evidence_missing",
  );
});

Deno.test("failure diagnosis - detects no_changes", () => {
  assertEquals(
    detectFailureCategory("Completed without making any changes"),
    "no_changes",
  );
});

Deno.test("failure diagnosis - detects internal_error from 'Error:'", () => {
  assertEquals(
    detectFailureCategory("Error: EACCES permission denied"),
    "internal_error",
  );
});

Deno.test("failure diagnosis - detects internal_error from ENOENT", () => {
  assertEquals(detectFailureCategory("ENOENT: no such file"), "internal_error");
});

Deno.test("failure diagnosis - detects internal_error from SIGABRT", () => {
  assertEquals(
    detectFailureCategory("Process received SIGABRT"),
    "internal_error",
  );
});

Deno.test("failure diagnosis - returns unknown for unrecognised messages", () => {
  assertEquals(
    detectFailureCategory("Something unexpected happened"),
    "unknown",
  );
});

Deno.test("failure diagnosis - returns unknown for empty message", () => {
  assertEquals(detectFailureCategory(""), "unknown");
});

// ============================================================================
// isInfrastructureFailure
// ============================================================================

Deno.test("failure diagnosis - zero_output is infrastructure", () => {
  assertEquals(isInfrastructureFailure("zero_output"), true);
});

Deno.test("failure diagnosis - rate_limit is infrastructure", () => {
  assertEquals(isInfrastructureFailure("rate_limit"), true);
});

Deno.test("failure diagnosis - internal_error is infrastructure", () => {
  assertEquals(isInfrastructureFailure("internal_error"), true);
});

Deno.test("failure diagnosis - push_failure is infrastructure", () => {
  assertEquals(isInfrastructureFailure("push_failure"), true);
});

Deno.test("failure diagnosis - missing_tools is infrastructure", () => {
  assertEquals(isInfrastructureFailure("missing_tools"), true);
});

Deno.test("failure diagnosis - timeout is not infrastructure", () => {
  assertEquals(isInfrastructureFailure("timeout"), false);
});

Deno.test("failure diagnosis - quality_check is not infrastructure", () => {
  assertEquals(isInfrastructureFailure("quality_check"), false);
});

Deno.test("failure diagnosis - no_changes is not infrastructure", () => {
  assertEquals(isInfrastructureFailure("no_changes"), false);
});

Deno.test("failure diagnosis - unknown is not infrastructure", () => {
  assertEquals(isInfrastructureFailure("unknown"), false);
});

// ============================================================================
// getFailureCategoryDisplay
// ============================================================================

Deno.test("failure diagnosis - display for timeout", () => {
  assertEquals(getFailureCategoryDisplay("timeout"), "timeout");
});

Deno.test("failure diagnosis - display for rate_limit", () => {
  assertEquals(getFailureCategoryDisplay("rate_limit"), "rate-limit");
});

Deno.test("failure diagnosis - display for zero_output", () => {
  assertEquals(getFailureCategoryDisplay("zero_output"), "no-output");
});

Deno.test("failure diagnosis - display for quality_check", () => {
  assertEquals(getFailureCategoryDisplay("quality_check"), "quality-failure");
});

Deno.test("failure diagnosis - display for push_failure", () => {
  assertEquals(
    getFailureCategoryDisplay("push_failure"),
    "infrastructure-error",
  );
});

Deno.test("failure diagnosis - display for no_changes", () => {
  assertEquals(getFailureCategoryDisplay("no_changes"), "task-not-understood");
});

// ============================================================================
// getFailureDiagnosis
// ============================================================================

Deno.test("failure diagnosis - diagnosis for timeout mentions time limit", () => {
  const diagnosis = getFailureDiagnosis("timeout");
  assertEquals(diagnosis.includes("ran out of time"), true);
});

Deno.test("failure diagnosis - diagnosis for rate_limit mentions transient", () => {
  const diagnosis = getFailureDiagnosis("rate_limit");
  assertEquals(diagnosis.includes("transient infrastructure issue"), true);
});

Deno.test("failure diagnosis - diagnosis for zero_output with diagnostics includes context", () => {
  const diagnosis = getFailureDiagnosis(
    "zero_output",
    "not_assessed",
    "health_check=passed;clarity=assessed_clear;elapsed_seconds=900",
  );
  assertEquals(diagnosis.includes("Health check: passed"), true);
  assertEquals(diagnosis.includes("Clarity assessment: CLEAR"), true);
  assertEquals(diagnosis.includes("900s"), true);
});

Deno.test("failure diagnosis - diagnosis for zero_output without diagnostics is generic", () => {
  const diagnosis = getFailureDiagnosis("zero_output");
  assertEquals(diagnosis.includes("transient infrastructure issue"), true);
});

Deno.test("failure diagnosis - diagnosis for no_changes with assessed clarity omits 'more detail'", () => {
  const diagnosis = getFailureDiagnosis("no_changes", "assessed_clear");
  assertEquals(diagnosis.includes("assessed as clear"), true);
  assertEquals(diagnosis.includes("may need more detail"), false);
});

Deno.test("failure diagnosis - diagnosis for no_changes without clarity suggests detail", () => {
  const diagnosis = getFailureDiagnosis("no_changes", "not_assessed");
  assertEquals(diagnosis.includes("may need more detail"), true);
});

Deno.test("failure diagnosis - diagnosis for unknown with clarity omits 'more detail'", () => {
  const diagnosis = getFailureDiagnosis("unknown", "skipped");
  assertEquals(diagnosis.includes("assessed as clear"), true);
});

// ============================================================================
// getFailureDiagnosisOneliner
// ============================================================================

Deno.test("failure diagnosis - oneliner for timeout", () => {
  assertEquals(
    getFailureDiagnosisOneliner("timeout"),
    "Likely cause: Claude ran out of time.",
  );
});

Deno.test("failure diagnosis - oneliner for no_changes with clarity", () => {
  const oneliner = getFailureDiagnosisOneliner("no_changes", "assessed_clear");
  assertEquals(oneliner.includes("assessed as clear"), true);
});

Deno.test("failure diagnosis - oneliner for unknown", () => {
  const oneliner = getFailureDiagnosisOneliner("unknown");
  assertEquals(
    oneliner.includes("could not be automatically determined"),
    true,
  );
});

// ============================================================================
// extractKeyErrorLines
// ============================================================================

Deno.test("failure diagnosis - extracts error lines from text", () => {
  const text = `Some info line
Error: something went wrong
Another info line
FAILED test_case
not ok 3 my test`;
  const lines = extractKeyErrorLines(text);
  assertEquals(lines.includes("Error: something went wrong"), true);
  assertEquals(lines.includes("FAILED test_case"), true);
  assertEquals(lines.includes("not ok 3"), true);
});

Deno.test("failure diagnosis - returns empty for no errors", () => {
  assertEquals(extractKeyErrorLines("All good here"), "");
});

Deno.test("failure diagnosis - returns empty for empty text", () => {
  assertEquals(extractKeyErrorLines(""), "");
});

Deno.test("failure diagnosis - limits to 10 error lines", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `Error: line ${i}`).join(
    "\n",
  );
  const result = extractKeyErrorLines(lines);
  assertEquals(result.split("\n").length, 10);
});

// ============================================================================
// parseDiagnosticContext
// ============================================================================

Deno.test("failure diagnosis - parses diagnostic context string", () => {
  const ctx = parseDiagnosticContext(
    "health_check=passed;clarity=assessed_clear;elapsed_seconds=900",
  );
  assertEquals(ctx.healthCheck, "passed");
  assertEquals(ctx.clarity, "assessed_clear");
  assertEquals(ctx.elapsedSeconds, "900");
});

Deno.test("failure diagnosis - parseDiagnosticContext handles empty string", () => {
  const ctx = parseDiagnosticContext("");
  assertEquals(ctx.healthCheck, undefined);
});

// ============================================================================
// formatZeroOutputDiagnostics
// ============================================================================

Deno.test("failure diagnosis - formats zero output diagnostics with all fields", () => {
  const formatted = formatZeroOutputDiagnostics(
    "health_check=passed;clarity=skipped;elapsed_seconds=120;no_output_timeout=90;claude_timeout=3600;retry_count=2;max_retries=3",
  );
  assertEquals(formatted.includes("Health check: passed"), true);
  assertEquals(formatted.includes("skipped (simple task)"), true);
  assertEquals(formatted.includes("120s"), true);
  assertEquals(formatted.includes("2/3 times"), true);
});

Deno.test("failure diagnosis - formatZeroOutputDiagnostics returns empty for empty input", () => {
  assertEquals(formatZeroOutputDiagnostics(""), "");
});

Deno.test("failure diagnosis - explains the extension history instead of the bare hard timeout (Issue #4298)", () => {
  const formatted = formatZeroOutputDiagnostics(
    "health_check=passed;clarity=skipped;elapsed_seconds=5640;" +
      "no_output_timeout=600;claude_timeout=3600;extensions_granted=4;" +
      "extended_seconds=2040;final_deadline_seconds=5640;" +
      "extension_refused=working tree unchanged despite tool activity 31s ago",
  );
  assertEquals(formatted.includes("extended 4× by 2040s"), true);
  assertEquals(formatted.includes("final deadline of 5640s"), true);
  assertEquals(
    formatted.includes(
      "last extension refused: working tree unchanged despite tool activity 31s ago",
    ),
    true,
  );
});

Deno.test("failure diagnosis - a refused first check is reported as no extension granted (Issue #4298)", () => {
  const formatted = formatZeroOutputDiagnostics(
    "health_check=passed;clarity=skipped;elapsed_seconds=3601;" +
      "no_output_timeout=600;claude_timeout=3600;extensions_granted=0;" +
      "extended_seconds=0;final_deadline_seconds=3600;" +
      "extension_refused=no tool activity recorded",
  );
  assertEquals(formatted.includes("no extension granted"), true);
  assertEquals(
    formatted.includes("last extension refused: no tool activity recorded"),
    true,
  );
});

Deno.test("failure diagnosis - without extension telemetry the runtime line is byte-identical (Issue #4298)", () => {
  const formatted = formatZeroOutputDiagnostics(
    "health_check=passed;clarity=skipped;elapsed_seconds=120;no_output_timeout=90;claude_timeout=3600",
  );
  assertEquals(
    formatted.includes(
      "Claude ran for 120s with zero output before being terminated " +
        "(no-output timeout: 90s, hard timeout: 3600s)",
    ),
    true,
  );
  assertEquals(formatted.includes("extension"), false);
});

// ---------------------------------------------------------------------------
// normaliseFailureCategory + exhaustiveness guard (Issue #2794)
// ---------------------------------------------------------------------------

Deno.test("normaliseFailureCategory - passes through every known category", () => {
  const known: FailureCategory[] = [
    "timeout",
    "rate_limit",
    "zero_output",
    "quality_check",
    "push_failure",
    "no_changes",
    "evidence_missing",
    "internal_error",
    "missing_tools",
    "unknown",
  ];
  for (const category of known) {
    assertEquals(normaliseFailureCategory(category), category);
  }
});

Deno.test("normaliseFailureCategory - maps an unrecognised string to unknown", () => {
  assertEquals(normaliseFailureCategory("not_a_category"), "unknown");
  assertEquals(normaliseFailureCategory(""), "unknown");
});

Deno.test("getFailureDiagnosis - unknown category still yields the graceful fallback", () => {
  const diagnosis = getFailureDiagnosis("unknown");
  assertEquals(
    diagnosis.includes("could not be automatically determined"),
    true,
  );
});

Deno.test("getFailureDiagnosis - throws via assertNever on an out-of-union category", () => {
  assertThrows(
    () => getFailureDiagnosis("bogus" as FailureCategory),
    Error,
    "Unreachable",
  );
});

Deno.test("getFailureDiagnosisOneliner - throws via assertNever on an out-of-union category", () => {
  assertThrows(
    () => getFailureDiagnosisOneliner("bogus" as FailureCategory),
    Error,
    "Unreachable",
  );
});

// ---------------------------------------------------------------------------
// The `killed` category (Issue #4202) — SIGKILL evidence preserved end-to-end
// ---------------------------------------------------------------------------

Deno.test("detectFailureCategory - a SIGKILL message is killed, not timeout (Issue #4202)", () => {
  assertEquals(
    detectFailureCategory(
      "Claude was killed (exit 137, SIGKILL — possible out-of-memory in the VM) without creating changes",
    ),
    "killed",
  );
});

Deno.test("isInfrastructureFailure - killed is infrastructure, so the retry wrapper fires (Issue #4202)", () => {
  assertEquals(isInfrastructureFailure("killed"), true);
});

Deno.test("normaliseFailureCategory - accepts killed (Issue #4202)", () => {
  assertEquals(normaliseFailureCategory("killed"), "killed");
});

Deno.test("getFailureCategoryDisplay - killed maps to its own display name (Issue #4202)", () => {
  assertEquals(getFailureCategoryDisplay("killed"), "killed");
});

Deno.test("getFailureDiagnosis - killed names the SIGKILL and the OOM suspicion (Issue #4202)", () => {
  const diagnosis = getFailureDiagnosis("killed");
  assertEquals(diagnosis.includes("SIGKILL"), true, diagnosis);
  assertEquals(diagnosis.toLowerCase().includes("memory"), true, diagnosis);
});

Deno.test("getFailureDiagnosisOneliner - killed has its own one-liner (Issue #4202)", () => {
  const oneliner = getFailureDiagnosisOneliner("killed");
  assertEquals(oneliner.length > 0, true);
  assertEquals(oneliner.toLowerCase().includes("killed"), true, oneliner);
});

Deno.test("detectFailureCategory - usage limit and capitalised rate limit are rate_limit → infrastructure (Issue #4315)", () => {
  assertEquals(
    detectFailureCategory("Claude usage limit reached (subscription window)"),
    "rate_limit",
  );
  assertEquals(
    detectFailureCategory("Rate limit — retries exhausted"),
    "rate_limit",
  );
  assertEquals(isInfrastructureFailure("rate_limit"), true);
});
