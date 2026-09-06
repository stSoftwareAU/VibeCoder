/**
 * Tests for failure_message.ts — detailed failure message construction.
 *
 * Issue #1188: Enhance failure messages with diagnostic context (elapsed time,
 * clarity status, output size, last output snippet).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type FailureDiagnosticContext,
  formatDetailedFailureMessage,
} from "../lib/failure_message.ts";
// `lastOutputSnippet` is `RedactedText` (Issue #1217) — the brand can only be
// minted by the redact-before-truncate constructors, so these fixtures route
// through `redactedTail` rather than passing a bare string.
import { redactedTail } from "../lib/redacted_text.ts";

// ============================================================================
// Basic formatting
// ============================================================================

Deno.test("failure message - returns reason unchanged when no context provided", () => {
  const result = formatDetailedFailureMessage("Something failed", {});
  assertEquals(result, "Something failed");
});

// ============================================================================
// Elapsed time
// ============================================================================

Deno.test("failure message - includes elapsed time", () => {
  const ctx: FailureDiagnosticContext = { elapsedSeconds: 312 };
  const result = formatDetailedFailureMessage("Claude timed out", ctx);
  assertStringIncludes(result, "312s");
  assertStringIncludes(result, "Elapsed");
});

Deno.test("failure message - includes elapsed time with zero seconds", () => {
  const ctx: FailureDiagnosticContext = { elapsedSeconds: 0 };
  const result = formatDetailedFailureMessage("Claude failed", ctx);
  assertStringIncludes(result, "0s");
});

// ============================================================================
// Timeout — zero vs partial output
// ============================================================================

Deno.test("failure message - timeout distinguishes zero output", () => {
  const ctx: FailureDiagnosticContext = {
    timedOut: true,
    outputSize: 0,
    timeoutSeconds: 900,
  };
  const result = formatDetailedFailureMessage("Claude timed out", ctx);
  assertStringIncludes(result, "zero");
  assertStringIncludes(result, "900s");
});

Deno.test("failure message - timeout distinguishes partial output", () => {
  const ctx: FailureDiagnosticContext = {
    timedOut: true,
    outputSize: 5432,
    timeoutSeconds: 1800,
  };
  const result = formatDetailedFailureMessage("Claude timed out", ctx);
  assertStringIncludes(result, "partial");
  assertStringIncludes(result, "5432");
  assertStringIncludes(result, "1800s");
});

Deno.test("failure message - timeout with undefined output size treated as zero", () => {
  const ctx: FailureDiagnosticContext = {
    timedOut: true,
    timeoutSeconds: 600,
  };
  const result = formatDetailedFailureMessage("Claude timed out", ctx);
  assertStringIncludes(result, "zero");
});

// ============================================================================
// Clarity status
// ============================================================================

Deno.test("failure message - includes clarity status assessed_clear", () => {
  const ctx: FailureDiagnosticContext = { clarityStatus: "assessed_clear" };
  const result = formatDetailedFailureMessage("No changes", ctx);
  assertStringIncludes(result, "Clarity: assessed as clear");
});

Deno.test("failure message - includes clarity status skipped", () => {
  const ctx: FailureDiagnosticContext = { clarityStatus: "skipped" };
  const result = formatDetailedFailureMessage("No changes", ctx);
  assertStringIncludes(result, "Clarity: skipped");
});

Deno.test("failure message - includes clarity status not_assessed", () => {
  const ctx: FailureDiagnosticContext = { clarityStatus: "not_assessed" };
  const result = formatDetailedFailureMessage("No changes", ctx);
  assertStringIncludes(result, "Clarity: not assessed");
});

// ============================================================================
// Quality failures include baseline context
// ============================================================================

Deno.test("failure message - includes baseline context for quality failures", () => {
  const ctx: FailureDiagnosticContext = {
    baselineQualityPassed: false,
  };
  const result = formatDetailedFailureMessage("Quality gate failed", ctx);
  assertStringIncludes(result, "pre-existing");
});

Deno.test("failure message - omits baseline context when baseline passed", () => {
  const ctx: FailureDiagnosticContext = {
    baselineQualityPassed: true,
  };
  const result = formatDetailedFailureMessage("Quality gate failed", ctx);
  assertEquals(result.includes("pre-existing"), false);
});

// ============================================================================
// Last output snippet
// ============================================================================

Deno.test("failure message - includes last output snippet", () => {
  const ctx: FailureDiagnosticContext = {
    lastOutputSnippet: redactedTail(
      "Error: could not compile\nfatal: build failed",
      500,
    ),
  };
  const result = formatDetailedFailureMessage("Claude failed", ctx);
  assertStringIncludes(result, "Last output");
  assertStringIncludes(result, "could not compile");
  assertStringIncludes(result, "build failed");
});

Deno.test("failure message - truncates long output snippet", () => {
  const longOutput = "x".repeat(2000);
  const ctx: FailureDiagnosticContext = {
    lastOutputSnippet: redactedTail(longOutput, longOutput.length),
  };
  const result = formatDetailedFailureMessage("Claude failed", ctx);
  assertEquals(result.length < longOutput.length, true);
  assertStringIncludes(result, "…");
});

Deno.test("failure message - does not include snippet section when output is empty", () => {
  const ctx: FailureDiagnosticContext = {
    lastOutputSnippet: redactedTail("", 500),
  };
  const result = formatDetailedFailureMessage("Claude failed", ctx);
  assertEquals(result.includes("Last output"), false);
});

// ============================================================================
// Combined context
// ============================================================================

Deno.test("failure message - combines all diagnostic fields", () => {
  const ctx: FailureDiagnosticContext = {
    elapsedSeconds: 845,
    clarityStatus: "assessed_clear",
    timedOut: true,
    outputSize: 1234,
    timeoutSeconds: 900,
    lastOutputSnippet: redactedTail(
      "Processing issue...\nTimeout reached",
      500,
    ),
  };
  const result = formatDetailedFailureMessage(
    "Claude timed out without creating changes",
    ctx,
  );
  assertStringIncludes(result, "845s");
  assertStringIncludes(result, "assessed as clear");
  assertStringIncludes(result, "partial");
  assertStringIncludes(result, "1234");
  assertStringIncludes(result, "900s");
  assertStringIncludes(result, "Timeout reached");
});
