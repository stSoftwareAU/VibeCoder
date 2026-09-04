/**
 * Tests for claude_executor.ts — Low-level Claude CLI subprocess execution (Issue #913).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildClaudeEffortArgs,
  buildClaudeModelArgs,
  captureTimeoutDiagnostics,
  describeRepoBaseTierOverride,
  detectAlreadyComplete,
  detectGithubApiSuccess,
  detectOutOfMemory,
  detectRateLimit,
  extractErrorPatterns,
  extractFailureSummary,
  extractStreamJsonText,
  getTokenEstimate,
  hasExplicitEffortOverride,
  setActiveRepoModelEffortOverrides,
  setPhaseEffortConfigOverrides,
  setPhaseModelConfigOverrides,
  stripEscapeCodes,
  TIMEOUT_EXIT_CODE,
} from "../lib/claude_executor.ts";
import { envLookup, NO_ENV } from "./support/env_lookup.ts";

// ---------------------------------------------------------------------------
// TIMEOUT_EXIT_CODE
// ---------------------------------------------------------------------------

Deno.test("claude executor - TIMEOUT_EXIT_CODE is 124", () => {
  assertEquals(TIMEOUT_EXIT_CODE, 124);
});

// ---------------------------------------------------------------------------
// stripEscapeCodes
// ---------------------------------------------------------------------------

Deno.test("claude executor - stripEscapeCodes removes OSC sequences", () => {
  const input = "hello\x1b]11;rgb:0000/0000/0000\x07world";
  assertEquals(stripEscapeCodes(input), "helloworld");
});

Deno.test("claude executor - stripEscapeCodes removes CSI cursor position reports", () => {
  const input = "hello\x1b[60;1Rworld";
  assertEquals(stripEscapeCodes(input), "helloworld");
});

Deno.test("claude executor - stripEscapeCodes preserves normal text", () => {
  const input = "Hello, World! This is normal text.";
  assertEquals(stripEscapeCodes(input), input);
});

Deno.test("claude executor - stripEscapeCodes handles mixed escape codes and text", () => {
  const input = "start\x1b[32mgreen\x1b[0mend";
  assertEquals(stripEscapeCodes(input), "startgreenend");
});

// ---------------------------------------------------------------------------
// getTokenEstimate
// ---------------------------------------------------------------------------

Deno.test("claude executor - getTokenEstimate estimates tokens correctly", () => {
  // 20 characters / 4 chars per token = 5 tokens
  assertEquals(getTokenEstimate("12345678901234567890"), 5);
});

Deno.test("claude executor - getTokenEstimate returns 0 for empty string", () => {
  assertEquals(getTokenEstimate(""), 0);
});

Deno.test("claude executor - getTokenEstimate respects custom chars per token", () => {
  // 20 characters / 5 chars per token = 4 tokens
  assertEquals(getTokenEstimate("12345678901234567890", 5), 4);
});

// ---------------------------------------------------------------------------
// extractStreamJsonText
// ---------------------------------------------------------------------------

Deno.test("claude executor - extractStreamJsonText returns empty for blank input", () => {
  assertEquals(extractStreamJsonText(""), "");
  assertEquals(extractStreamJsonText("  \n  "), "");
});

Deno.test("claude executor - extractStreamJsonText extracts result field", () => {
  const input = '{"type":"result","result":"The answer is 42"}\n';
  assertEquals(extractStreamJsonText(input), "The answer is 42");
});

Deno.test("claude executor - extractStreamJsonText concatenates assistant text blocks", () => {
  const input = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"World"}]}}',
  ].join("\n");
  assertEquals(extractStreamJsonText(input), "Hello World");
});

Deno.test("claude executor - extractStreamJsonText falls back to raw for non-JSON", () => {
  const input = "This is not JSON at all";
  assertEquals(extractStreamJsonText(input), input);
});

Deno.test("claude executor - extractStreamJsonText prefers result over text blocks", () => {
  const input = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    '{"type":"result","result":"The complete answer"}',
  ].join("\n");
  assertEquals(extractStreamJsonText(input), "The complete answer");
});

// ---------------------------------------------------------------------------
// extractErrorPatterns
// ---------------------------------------------------------------------------

Deno.test("claude executor - extractErrorPatterns detects JS stack traces", () => {
  const input = "  at Object.handler (/app/server.js:42:13)\n";
  const patterns = extractErrorPatterns(input);
  assertEquals(patterns.length, 1);
});

Deno.test("claude executor - extractErrorPatterns detects Python tracebacks", () => {
  const input = "Traceback (most recent call last):\n  File test.py\n";
  const patterns = extractErrorPatterns(input);
  assertEquals(patterns.length, 1);
});

Deno.test("claude executor - extractErrorPatterns detects Error messages", () => {
  const input = "TypeError: Cannot read property 'x' of undefined\n";
  const patterns = extractErrorPatterns(input);
  assertEquals(patterns.length, 1);
});

Deno.test("claude executor - extractErrorPatterns detects FATAL messages", () => {
  const patterns = extractErrorPatterns("FATAL: database connection lost");
  assertEquals(patterns.length, 1);
});

Deno.test("claude executor - extractErrorPatterns detects PANIC messages", () => {
  const patterns = extractErrorPatterns("PANIC: out of memory");
  assertEquals(patterns.length, 1);
});

Deno.test("claude executor - extractErrorPatterns returns empty for clean output", () => {
  const patterns = extractErrorPatterns("All tests passed\nEverything OK\n");
  assertEquals(patterns.length, 0);
});

Deno.test("claude executor - extractErrorPatterns returns empty for blank input", () => {
  assertEquals(extractErrorPatterns("").length, 0);
  assertEquals(extractErrorPatterns("  ").length, 0);
});

// ---------------------------------------------------------------------------
// extractFailureSummary
// ---------------------------------------------------------------------------

Deno.test("claude executor - extractFailureSummary detects 'could not find' pattern", () => {
  const result = extractFailureSummary("I could not find the function foo()");
  assertEquals(result.length, 1);
});

Deno.test("claude executor - extractFailureSummary detects 'does not exist' pattern", () => {
  const result = extractFailureSummary("The file src/bar.ts does not exist");
  assertEquals(result.length, 1);
});

Deno.test("claude executor - extractFailureSummary detects 'unable to' pattern", () => {
  const result = extractFailureSummary("I was unable to compile the project");
  assertEquals(result.length, 1);
});

Deno.test("claude executor - extractFailureSummary detects 'not merged' pattern", () => {
  const result = extractFailureSummary(
    "The changes have not been merged into main",
  );
  assertEquals(result.length, 1);
});

Deno.test("claude executor - extractFailureSummary respects maxLines limit", () => {
  const lines = Array.from(
    { length: 20 },
    (_, i) => `Could not find item ${i}`,
  );
  const result = extractFailureSummary(lines.join("\n"), 5);
  assertEquals(result.length, 5);
});

Deno.test("claude executor - extractFailureSummary returns empty for clean output", () => {
  assertEquals(extractFailureSummary("Everything worked fine").length, 0);
});

Deno.test("claude executor - extractFailureSummary returns empty for blank input", () => {
  assertEquals(extractFailureSummary("").length, 0);
});

// ---------------------------------------------------------------------------
// detectAlreadyComplete (Issue #519)
// ---------------------------------------------------------------------------

Deno.test("claude executor - detectAlreadyComplete detects 'already complete'", () => {
  assertEquals(
    detectAlreadyComplete("The implementation is already complete"),
    true,
  );
});

Deno.test("claude executor - detectAlreadyComplete detects 'already implemented'", () => {
  assertEquals(
    detectAlreadyComplete("This has already been implemented"),
    true,
  );
});

Deno.test("claude executor - detectAlreadyComplete detects 'already merged'", () => {
  assertEquals(detectAlreadyComplete("The PR was already merged"), true);
});

Deno.test("claude executor - detectAlreadyComplete detects 'already fixed'", () => {
  assertEquals(detectAlreadyComplete("This bug is already fixed"), true);
});

Deno.test("claude executor - detectAlreadyComplete detects 'no changes needed'", () => {
  assertEquals(detectAlreadyComplete("No changes are needed"), true);
});

Deno.test("claude executor - detectAlreadyComplete detects 'nothing left to implement'", () => {
  assertEquals(
    detectAlreadyComplete("There is nothing left to implement"),
    true,
  );
});

Deno.test("claude executor - detectAlreadyComplete detects 'implementation is complete'", () => {
  assertEquals(detectAlreadyComplete("The implementation is complete"), true);
});

Deno.test("claude executor - detectAlreadyComplete returns false for normal output", () => {
  assertEquals(
    detectAlreadyComplete("I have made the following changes"),
    false,
  );
});

Deno.test("claude executor - detectAlreadyComplete returns false for empty input", () => {
  assertEquals(detectAlreadyComplete(""), false);
});

// ---------------------------------------------------------------------------
// detectGithubApiSuccess (Issue #534)
// ---------------------------------------------------------------------------

Deno.test("claude executor - detectGithubApiSuccess detects gh issue edit", () => {
  assertEquals(detectGithubApiSuccess("Ran gh issue edit 42"), true);
});

Deno.test("claude executor - detectGithubApiSuccess detects gh pr create", () => {
  assertEquals(detectGithubApiSuccess("Ran gh pr create"), true);
});

Deno.test("claude executor - detectGithubApiSuccess detects 'edited issue'", () => {
  assertEquals(detectGithubApiSuccess("I edited issue #42"), true);
});

Deno.test("claude executor - detectGithubApiSuccess detects 'added label'", () => {
  assertEquals(detectGithubApiSuccess("Added label 'enhancement'"), true);
});

Deno.test("claude executor - detectGithubApiSuccess detects 'successfully updated'", () => {
  assertEquals(detectGithubApiSuccess("Successfully updated the issue"), true);
});

Deno.test("claude executor - detectGithubApiSuccess detects 'issue body updated'", () => {
  assertEquals(detectGithubApiSuccess("The issue body updated"), true);
});

Deno.test("claude executor - detectGithubApiSuccess returns false for normal output", () => {
  assertEquals(detectGithubApiSuccess("Made code changes"), false);
});

Deno.test("claude executor - detectGithubApiSuccess returns false for empty input", () => {
  assertEquals(detectGithubApiSuccess(""), false);
});

// ---------------------------------------------------------------------------
// detectRateLimit
// ---------------------------------------------------------------------------

Deno.test("claude executor - detectRateLimit detects 'rate limit' as primary", () => {
  const result = detectRateLimit("Error: rate limit exceeded");
  assertEquals(result.isRateLimited, true);
  assertEquals(result.isPrimary, true);
});

Deno.test("claude executor - detectRateLimit detects 'credit' as primary", () => {
  const result = detectRateLimit("No credit remaining");
  assertEquals(result.isRateLimited, true);
  assertEquals(result.isPrimary, true);
});

Deno.test("claude executor - detectRateLimit detects '429' as primary", () => {
  const result = detectRateLimit("HTTP 429 Too Many Requests");
  assertEquals(result.isRateLimited, true);
  assertEquals(result.isPrimary, true);
});

Deno.test("claude executor - detectRateLimit detects 'try again' as secondary", () => {
  const result = detectRateLimit("Please try again later");
  assertEquals(result.isRateLimited, true);
  assertEquals(result.isPrimary, false);
});

Deno.test("claude executor - detectRateLimit returns false for normal output", () => {
  const result = detectRateLimit("All good, no issues");
  assertEquals(result.isRateLimited, false);
  assertEquals(result.isPrimary, false);
});

Deno.test("claude executor - detectRateLimit returns false for empty input", () => {
  const result = detectRateLimit("");
  assertEquals(result.isRateLimited, false);
});

Deno.test("claude executor - detectRateLimit only checks tail lines", () => {
  // Rate limit text in line 1, but 50 clean lines after
  const lines = ["Rate limit exceeded"];
  for (let i = 0; i < 50; i++) {
    lines.push(`Clean output line ${i}`);
  }
  const result = detectRateLimit(lines.join("\n"), 30);
  // Rate limit is beyond the tail, should not be detected
  assertEquals(result.isRateLimited, false);
});

// ---------------------------------------------------------------------------
// detectOutOfMemory (Issue #2740)
// ---------------------------------------------------------------------------

Deno.test("claude executor - detectOutOfMemory detects JS heap OOM", () => {
  const output = [
    "<--- Last few GCs --->",
    "FATAL ERROR: Reached heap limit Allocation failed - " +
    "JavaScript heap out of memory",
  ].join("\n");
  assertEquals(detectOutOfMemory(output), true);
});

Deno.test("claude executor - detectOutOfMemory detects 'near heap limit'", () => {
  const output =
    "Mark-Compact ... Ineffective mark-compacts near heap limit Allocation failed";
  assertEquals(detectOutOfMemory(output), true);
});

Deno.test("claude executor - detectOutOfMemory detects 'FATAL ERROR' with heap", () => {
  assertEquals(
    detectOutOfMemory("FATAL ERROR: Reached heap limit Allocation failed"),
    true,
  );
});

Deno.test("claude executor - detectOutOfMemory detects generic 'out of memory'", () => {
  assertEquals(detectOutOfMemory("error: Out of memory"), true);
});

Deno.test("claude executor - detectOutOfMemory detects 'Cannot allocate memory'", () => {
  assertEquals(detectOutOfMemory("fork: Cannot allocate memory"), true);
});

Deno.test("claude executor - detectOutOfMemory detects 'std::bad_alloc'", () => {
  assertEquals(detectOutOfMemory("terminate called: std::bad_alloc"), true);
});

Deno.test("claude executor - detectOutOfMemory ignores 'heap limit' rate-limit overlap", () => {
  // The OOM tail contains the word "limit", which the secondary rate-limit
  // regex matches — confirm OOM is classified as OOM, distinct from a rate
  // limit (the root cause this helper addresses).
  const output =
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";
  assertEquals(detectOutOfMemory(output), true);
  // The rate-limit detector also (wrongly) fires on "limit" — the run loop
  // must consult detectOutOfMemory first.
  assertEquals(detectRateLimit(output).isRateLimited, true);
  assertEquals(detectRateLimit(output).isPrimary, false);
});

Deno.test("claude executor - detectOutOfMemory returns false for normal output", () => {
  assertEquals(detectOutOfMemory("All good, no issues"), false);
});

Deno.test("claude executor - detectOutOfMemory returns false for rate-limit output", () => {
  assertEquals(detectOutOfMemory("Error: rate limit exceeded"), false);
});

Deno.test("claude executor - detectOutOfMemory returns false when output merely mentions memory", () => {
  assertEquals(
    detectOutOfMemory("I optimised the in-memory cache to reduce memory use"),
    false,
  );
});

Deno.test("claude executor - detectOutOfMemory returns false for empty input", () => {
  assertEquals(detectOutOfMemory(""), false);
});

Deno.test("claude executor - detectOutOfMemory only checks tail lines", () => {
  const lines = ["JavaScript heap out of memory"];
  for (let i = 0; i < 50; i++) {
    lines.push(`Clean output line ${i}`);
  }
  // OOM signature is beyond the tail, should not be detected.
  assertEquals(detectOutOfMemory(lines.join("\n"), 30), false);
});

// ---------------------------------------------------------------------------
// buildClaudeModelArgs
// ---------------------------------------------------------------------------

Deno.test("claude executor - buildClaudeModelArgs returns empty when no model set", () => {
  // Clear any existing env var
  const args = buildClaudeModelArgs(undefined, NO_ENV);
  assertEquals(args.length, 0);
});

Deno.test("claude executor - buildClaudeModelArgs warns when a non-empty phase resolves to no model (Issue #2712)", () => {
  // Clear repo + global overrides so the unknown phase falls all the way through.
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    // A phase absent from PHASE_MODEL_DEFAULTS (typo / new phase, no default).
    const args = buildClaudeModelArgs("totally_unknown_phase", NO_ENV);
    assertEquals(args.length, 0);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0] ?? "", "totally_unknown_phase");
    assertStringIncludes(warnings[0] ?? "", "no --model arg");
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("claude executor - buildClaudeModelArgs stays silent for a phase-less call (Issue #2712)", () => {
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const args = buildClaudeModelArgs(undefined, NO_ENV);
    assertEquals(args.length, 0);
    assertEquals(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("claude executor - buildClaudeModelArgs warns on an unrecognised model alias (typo) (Issue #2711)", () => {
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  // A typo of the `fable` alias — must still be forwarded, but warned about.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  const env = envLookup({ CLAUDE_MODEL_PLANNING: "fabel" });
  try {
    const args = buildClaudeModelArgs("planning", env);
    // Value is still forwarded verbatim (CLI is the authority).
    assertEquals(args, ["--model", "fabel"]);
    // Exactly one warning, naming the level and the value.
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0] ?? "", "fabel");
    assertStringIncludes(warnings[0] ?? "", "CLAUDE_MODEL_PLANNING");
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("claude executor - buildClaudeModelArgs stays silent for a known alias (Issue #2711)", () => {
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  const env = envLookup({ CLAUDE_MODEL_PLANNING: "opus" });
  try {
    const args = buildClaudeModelArgs("planning", env);
    assertEquals(args, ["--model", "opus"]);
    assertEquals(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("claude executor - buildClaudeModelArgs stays silent for a full claude-* model id (Issue #2711)", () => {
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  const env = envLookup({ CLAUDE_MODEL_PLANNING: "claude-opus-4-7-20250101" });
  try {
    const args = buildClaudeModelArgs("planning", env);
    assertEquals(args, ["--model", "claude-opus-4-7-20250101"]);
    assertEquals(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("claude executor - buildClaudeModelArgs returns model args when set", () => {
  const env = envLookup({ CLAUDE_MODEL: "claude-sonnet-4-7" });
  const args = buildClaudeModelArgs(undefined, env);
  assertEquals(args, ["--model", "claude-sonnet-4-7"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses phase-specific override", () => {
  const env = envLookup({
    CLAUDE_MODEL: "claude-sonnet-4-7",
    CLAUDE_MODEL_PLANNING: "claude-opus-4-7",
  });
  const args = buildClaudeModelArgs("planning", env);
  assertEquals(args, ["--model", "claude-opus-4-7"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses health phase override (Issue #1069)", () => {
  const env = envLookup({ CLAUDE_MODEL: "opus", CLAUDE_MODEL_HEALTH: "haiku" });
  const args = buildClaudeModelArgs("health", env);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs health phase default overrides CLAUDE_MODEL", () => {
  const env = envLookup({ CLAUDE_MODEL: "sonnet" });
  // Phase default (haiku, secondary tier) takes priority over CLAUDE_MODEL (Issue #1270)
  const args = buildClaudeModelArgs("health", env);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses refinement phase default (planning-shaped, Issue #3229)", () => {
  // Issue #3229: refinement is a planning-shaped phase → Fable 5 top tier.
  const args = buildClaudeModelArgs("refinement", NO_ENV);
  assertEquals(args, ["--model", "fable"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses issue phase default opus (Issue #2709)", () => {
  // The coding phase routes through `phase: "issue"`, which now carries the
  // Opus base-tier default (Issue #2709) rather than falling through to the
  // CLI default.
  const args = buildClaudeModelArgs("issue", NO_ENV);
  assertEquals(args, ["--model", "opus"]);
});

Deno.test("claude executor - buildClaudeModelArgs CLAUDE_MODEL_ISSUE env override beats issue phase default (Issue #2709)", () => {
  const env = envLookup({ CLAUDE_MODEL_ISSUE: "sonnet" });
  // The operator escape hatch must now actually take effect for the coding
  // phase (it was inert before #2709).
  const args = buildClaudeModelArgs("issue", env);
  assertEquals(args, ["--model", "sonnet"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses spelling_fix phase default haiku (effort-first secondary tier, Issue #2391)", () => {
  // Effort-first (#2391): spelling_fix stays on the cheaper Haiku tier
  // (secondary lever) — the trivial task does not justify the Opus premium.
  const args = buildClaudeModelArgs("spelling_fix", NO_ENV);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses ci_fix phase default (effort-first, Issue #2391)", () => {
  // Effort-first (#2391): ci_fix defaults to the single top tier.
  const args = buildClaudeModelArgs("ci_fix", NO_ENV);
  assertEquals(args, ["--model", "opus"]);
});

Deno.test("claude executor - buildClaudeModelArgs CLAUDE_MODEL_CI_FIX env override (Issue #1079)", () => {
  // Use a value distinct from the top-tier default so the override is provable.
  const env = envLookup({ CLAUDE_MODEL_CI_FIX: "haiku" });
  const args = buildClaudeModelArgs("ci_fix", env);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs ci_fix phase default overrides CLAUDE_MODEL (Issue #1079)", () => {
  // CLAUDE_MODEL set to a non-default value so the phase default is provable.
  const env = envLookup({ CLAUDE_MODEL: "haiku" });
  // Phase default (top tier) takes priority over CLAUDE_MODEL (Issue #1270, #2391)
  const args = buildClaudeModelArgs("ci_fix", env);
  assertEquals(args, ["--model", "opus"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses question phase default (Issue #1071)", () => {
  // Issue #3229: question is a planning-shaped phase → Fable 5 top tier.
  const args = buildClaudeModelArgs("question", NO_ENV);
  assertEquals(args, ["--model", "fable"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses summarise phase default (Issue #1071)", () => {
  // Effort-first (#2391): summarise stays on the cheaper Haiku tier
  // (secondary lever); #2393 escalation lifts it when an input would truncate.
  const args = buildClaudeModelArgs("summarise", NO_ENV);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses health phase default haiku (effort-first secondary tier, Issue #2391)", () => {
  // Effort-first (#2391): health stays on the cheaper Haiku tier (secondary
  // lever) — a frequent, trivial pre-flight does not justify the Opus premium.
  const args = buildClaudeModelArgs("health", NO_ENV);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs planning phase defaults to fable (Issue #2621)", () => {
  // Issue #2621 moved planning from opus to the Fable 5 top tier: a better
  // plan compounds across every downstream sub-issue.
  const args = buildClaudeModelArgs("planning", NO_ENV);
  assertEquals(args, ["--model", "fable"]);
});

Deno.test("claude executor - buildClaudeModelArgs env override takes precedence over phase default (Issue #1071)", () => {
  // Distinct from the top-tier default so the env override is provable.
  const env = envLookup({ CLAUDE_MODEL_REFINEMENT: "haiku" });
  const args = buildClaudeModelArgs("refinement", env);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs refinement phase default overrides CLAUDE_MODEL (Issue #1071)", () => {
  // CLAUDE_MODEL set to a non-default value so the phase default is provable.
  const env = envLookup({ CLAUDE_MODEL: "haiku" });
  // Phase default (Fable top tier) takes priority over CLAUDE_MODEL (#3229)
  const args = buildClaudeModelArgs("refinement", env);
  assertEquals(args, ["--model", "fable"]);
});

Deno.test("claude executor - buildClaudeModelArgs unknown phase with no env returns empty (Issue #1071)", () => {
  const args = buildClaudeModelArgs("unknown_phase", NO_ENV);
  assertEquals(args.length, 0);
});

Deno.test("claude executor - buildClaudeModelArgs uses revision phase default (effort-first, Issue #2391)", () => {
  // Issue #3229: revision is a planning-shaped phase → Fable 5 top tier.
  const args = buildClaudeModelArgs("revision", NO_ENV);
  assertEquals(args, ["--model", "fable"]);
});

Deno.test("claude executor - buildClaudeModelArgs CLAUDE_MODEL_REVISION env override (Issue #1081)", () => {
  // Distinct from the top-tier default so the env override is provable.
  const env = envLookup({ CLAUDE_MODEL_REVISION: "haiku" });
  const args = buildClaudeModelArgs("revision", env);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs revision phase default overrides CLAUDE_MODEL (Issue #1081)", () => {
  // CLAUDE_MODEL set to a non-default value so the phase default is provable.
  const env = envLookup({ CLAUDE_MODEL: "haiku" });
  // Phase default (Fable top tier) takes priority over CLAUDE_MODEL (#3229)
  const args = buildClaudeModelArgs("revision", env);
  assertEquals(args, ["--model", "fable"]);
});

Deno.test("claude executor - buildClaudeModelArgs uses pr_feedback phase default (effort-first, Issue #2391)", () => {
  // Effort-first (#2391): pr_feedback defaults to the single top tier.
  const args = buildClaudeModelArgs("pr_feedback", NO_ENV);
  assertEquals(args, ["--model", "opus"]);
});

Deno.test("claude executor - buildClaudeModelArgs CLAUDE_MODEL_PR_FEEDBACK env override (Issue #1080)", () => {
  // Distinct from the top-tier default so the env override is provable.
  const env = envLookup({ CLAUDE_MODEL_PR_FEEDBACK: "haiku" });
  const args = buildClaudeModelArgs("pr_feedback", env);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs pr_feedback phase default overrides CLAUDE_MODEL (Issue #1080)", () => {
  // CLAUDE_MODEL set to a non-default value so the phase default is provable.
  const env = envLookup({ CLAUDE_MODEL: "haiku" });
  // Phase default (top tier) takes priority over CLAUDE_MODEL (Issue #1270, #2391)
  const args = buildClaudeModelArgs("pr_feedback", env);
  assertEquals(args, ["--model", "opus"]);
});

// ---------------------------------------------------------------------------
// Phase defaults take priority over CLAUDE_MODEL (Issue #1270)
// ---------------------------------------------------------------------------

Deno.test("claude executor - buildClaudeModelArgs phase default overrides CLAUDE_MODEL (Issue #1270)", () => {
  const env = envLookup({ CLAUDE_MODEL: "haiku" });
  // Phase default (Fable top tier) should take priority over CLAUDE_MODEL (haiku) (#3229)
  const args = buildClaudeModelArgs("refinement", env);
  assertEquals(args, ["--model", "fable"]);
});

Deno.test("claude executor - buildClaudeModelArgs ci_fix phase default overrides CLAUDE_MODEL (Issue #1270)", () => {
  const env = envLookup({ CLAUDE_MODEL: "haiku" });
  // ci_fix default (top tier) should take priority over CLAUDE_MODEL (haiku)
  const args = buildClaudeModelArgs("ci_fix", env);
  assertEquals(args, ["--model", "opus"]);
});

Deno.test("claude executor - buildClaudeModelArgs health phase default overrides CLAUDE_MODEL (Issue #1270)", () => {
  const env = envLookup({ CLAUDE_MODEL: "sonnet" });
  // health default (haiku, secondary tier) should take priority over CLAUDE_MODEL (sonnet)
  const args = buildClaudeModelArgs("health", env);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs CLAUDE_MODEL used as fallback for unknown phase (Issue #1270)", () => {
  const env = envLookup({ CLAUDE_MODEL: "sonnet" });
  // Unknown phase has no default, so CLAUDE_MODEL should be used as fallback
  const args = buildClaudeModelArgs("unknown_phase", env);
  assertEquals(args, ["--model", "sonnet"]);
});

Deno.test("claude executor - buildClaudeModelArgs phase env var still overrides phase default (Issue #1270)", () => {
  const env = envLookup({
    CLAUDE_MODEL: "opus",
    CLAUDE_MODEL_SPELLING_FIX: "sonnet",
  });
  // Phase env var (sonnet) overrides both phase default (haiku) and CLAUDE_MODEL (opus)
  const args = buildClaudeModelArgs("spelling_fix", env);
  assertEquals(args, ["--model", "sonnet"]);
});

// ---------------------------------------------------------------------------
// captureTimeoutDiagnostics
// ---------------------------------------------------------------------------

Deno.test("claude executor - captureTimeoutDiagnostics captures last N lines", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`);
  const diag = captureTimeoutDiagnostics(lines.join("\n"), "test-op", 50);
  assertEquals(diag.linesCaptured, 50);
  assertStringIncludes(diag.report, "Operation: test-op");
  assertStringIncludes(diag.report, "Timeout Diagnostic Context");
});

Deno.test("claude executor - captureTimeoutDiagnostics includes error patterns", () => {
  const output = "Some output\nTypeError: bad thing happened\nMore output";
  const diag = captureTimeoutDiagnostics(output, "test-op");
  assertEquals(diag.errorPatterns.length, 1);
  assertStringIncludes(diag.report, "Detected error patterns");
});

Deno.test("claude executor - captureTimeoutDiagnostics handles clean output", () => {
  const output = "Everything went fine\nNo problems here";
  const diag = captureTimeoutDiagnostics(output, "test-op");
  assertEquals(diag.errorPatterns.length, 0);
});

Deno.test("claude executor - captureTimeoutDiagnostics handles empty output", () => {
  const diag = captureTimeoutDiagnostics("", "test-op");
  assertEquals(diag.linesCaptured, 1); // Empty string splits to [""]
  assertEquals(diag.errorPatterns.length, 0);
});

Deno.test("claude executor - buildClaudeModelArgs uses quality_fix phase default (effort-first, Issue #2391)", () => {
  // Effort-first (#2391): quality_fix defaults to the single top tier.
  const args = buildClaudeModelArgs("quality_fix", NO_ENV);
  assertEquals(args, ["--model", "opus"]);
});

Deno.test("claude executor - buildClaudeModelArgs CLAUDE_MODEL_QUALITY_FIX env override (Issue #1082)", () => {
  // Distinct from the top-tier default so the env override is provable.
  const env = envLookup({ CLAUDE_MODEL_QUALITY_FIX: "haiku" });
  const args = buildClaudeModelArgs("quality_fix", env);
  assertEquals(args, ["--model", "haiku"]);
});

Deno.test("claude executor - buildClaudeModelArgs quality_fix phase default overrides CLAUDE_MODEL (Issue #1082)", () => {
  // CLAUDE_MODEL set to a non-default value so the phase default is provable.
  const env = envLookup({ CLAUDE_MODEL: "haiku" });
  // Phase default (top tier) takes priority over CLAUDE_MODEL (Issue #1270, #2391)
  const args = buildClaudeModelArgs("quality_fix", env);
  assertEquals(args, ["--model", "opus"]);
});

// ---------------------------------------------------------------------------
// Clarification phase (Issue #1265)
// ---------------------------------------------------------------------------

Deno.test("claude executor - buildClaudeModelArgs uses clarification phase default (effort-first, Issue #2391)", () => {
  try {
    setPhaseModelConfigOverrides({});
    // Issue #3229: clarification is a planning-shaped phase → Fable 5 top tier.
    const args = buildClaudeModelArgs("clarification", NO_ENV);
    assertEquals(args, ["--model", "fable"]);
  } finally {
    setPhaseModelConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeModelArgs CLAUDE_MODEL_CLARIFICATION env override (Issue #1265)", () => {
  // Distinct from the top-tier default so the env override is provable.
  const env = envLookup({ CLAUDE_MODEL_CLARIFICATION: "haiku" });
  try {
    setPhaseModelConfigOverrides({});
    const args = buildClaudeModelArgs("clarification", env);
    assertEquals(args, ["--model", "haiku"]);
  } finally {
    setPhaseModelConfigOverrides({});
  }
});

// ---------------------------------------------------------------------------
// Config-based phase model overrides (Issue #1265)
// ---------------------------------------------------------------------------

Deno.test("claude executor - config override takes precedence over PHASE_MODEL_DEFAULTS (Issue #1265)", () => {
  try {
    setPhaseModelConfigOverrides({ health: "sonnet" });
    const args = buildClaudeModelArgs("health", NO_ENV);
    assertEquals(args, ["--model", "sonnet"]);
  } finally {
    setPhaseModelConfigOverrides({});
  }
});

Deno.test("claude executor - env var override takes precedence over config override (Issue #1265)", () => {
  const env = envLookup({ CLAUDE_MODEL_HEALTH: "opus" });
  try {
    setPhaseModelConfigOverrides({ health: "sonnet" });
    const args = buildClaudeModelArgs("health", env);
    assertEquals(args, ["--model", "opus"]);
  } finally {
    setPhaseModelConfigOverrides({});
  }
});

Deno.test("claude executor - config override takes precedence over CLAUDE_MODEL env var (Issue #1265)", () => {
  const env = envLookup({ CLAUDE_MODEL: "opus" });
  try {
    setPhaseModelConfigOverrides({ refinement: "haiku" });
    const args = buildClaudeModelArgs("refinement", env);
    assertEquals(args, ["--model", "haiku"]);
  } finally {
    setPhaseModelConfigOverrides({});
  }
});

Deno.test("claude executor - fable flows through via phase_model_overrides (Issue #2619)", () => {
  try {
    setPhaseModelConfigOverrides({ planning: "fable" });
    const args = buildClaudeModelArgs("planning", NO_ENV);
    assertEquals(args, ["--model", "fable"]);
  } finally {
    setPhaseModelConfigOverrides({});
  }
});

Deno.test("claude executor - fable flows through via CLAUDE_MODEL env var (Issue #2619)", () => {
  const env = envLookup({ CLAUDE_MODEL: "fable" });
  const args = buildClaudeModelArgs(undefined, env);
  assertEquals(args, ["--model", "fable"]);
});

Deno.test("claude executor - empty config overrides falls back to PHASE_MODEL_DEFAULTS (Issue #1265)", () => {
  try {
    setPhaseModelConfigOverrides({});
    // spelling_fix is one of the three Haiku-tier phases under effort-first (#2391).
    const args = buildClaudeModelArgs("spelling_fix", NO_ENV);
    assertEquals(args, ["--model", "haiku"]);
  } finally {
    setPhaseModelConfigOverrides({});
  }
});

// ---------------------------------------------------------------------------
// buildClaudeEffortArgs — priority chain (Issue #1403)
// ---------------------------------------------------------------------------

Deno.test("claude executor - buildClaudeEffortArgs returns phase default for planning (Issue #1403)", () => {
  try {
    setPhaseEffortConfigOverrides({});
    // Issue #3229: planning-shaped phases run at "high" (the `max` bump is
    // reserved for the #3217 pre-flight reroute to Opus).
    const args = buildClaudeEffortArgs("planning", NO_ENV);
    assertEquals(args, ["--effort", "high"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs phase-specific env var overrides all (Issue #1403)", () => {
  const env = envLookup({ CLAUDE_EFFORT_PLANNING: "low" });
  try {
    setPhaseEffortConfigOverrides({ planning: "medium" });
    const args = buildClaudeEffortArgs("planning", env);
    assertEquals(args, ["--effort", "low"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs config override takes precedence over phase default (Issue #1403)", () => {
  try {
    setPhaseEffortConfigOverrides({ health: "max" });
    const args = buildClaudeEffortArgs("health", NO_ENV);
    assertEquals(args, ["--effort", "max"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs env var overrides config override (Issue #1403)", () => {
  const env = envLookup({ CLAUDE_EFFORT_HEALTH: "max" });
  try {
    setPhaseEffortConfigOverrides({ health: "medium" });
    const args = buildClaudeEffortArgs("health", env);
    assertEquals(args, ["--effort", "max"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs config override takes precedence over global CLAUDE_EFFORT (Issue #1403)", () => {
  const env = envLookup({ CLAUDE_EFFORT: "max" });
  try {
    setPhaseEffortConfigOverrides({ refinement: "low" });
    const args = buildClaudeEffortArgs("refinement", env);
    assertEquals(args, ["--effort", "low"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs phase_effort_overrides accepts xhigh (Issue #2620)", () => {
  try {
    setPhaseEffortConfigOverrides({ issue: "xhigh" });
    const args = buildClaudeEffortArgs("issue", NO_ENV);
    assertEquals(args, ["--effort", "xhigh"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs CLAUDE_EFFORT_ISSUE env var accepts xhigh (Issue #2620)", () => {
  const env = envLookup({ CLAUDE_EFFORT_ISSUE: "xhigh" });
  try {
    setPhaseEffortConfigOverrides({});
    const args = buildClaudeEffortArgs("issue", env);
    assertEquals(args, ["--effort", "xhigh"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs falls back to global CLAUDE_EFFORT without phase (Issue #1403)", () => {
  const env = envLookup({ CLAUDE_EFFORT: "low" });
  try {
    setPhaseEffortConfigOverrides({});
    const args = buildClaudeEffortArgs(undefined, env);
    assertEquals(args, ["--effort", "low"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs falls back to DEFAULT_EFFORT without env or phase (Issue #1403)", () => {
  try {
    setPhaseEffortConfigOverrides({});
    const args = buildClaudeEffortArgs(undefined, NO_ENV);
    assertEquals(args, ["--effort", "high"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs spelling_fix phase defaults to low (Issue #1403)", () => {
  try {
    setPhaseEffortConfigOverrides({});
    const args = buildClaudeEffortArgs("spelling_fix", NO_ENV);
    assertEquals(args, ["--effort", "low"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs unknown phase falls back to global CLAUDE_EFFORT (Issue #1403)", () => {
  const env = envLookup({ CLAUDE_EFFORT: "medium" });
  try {
    setPhaseEffortConfigOverrides({});
    const args = buildClaudeEffortArgs("unknown_phase", env);
    assertEquals(args, ["--effort", "medium"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - buildClaudeEffortArgs unknown phase without global falls back to DEFAULT_EFFORT (Issue #1403)", () => {
  try {
    setPhaseEffortConfigOverrides({});
    const args = buildClaudeEffortArgs("unknown_phase", NO_ENV);
    assertEquals(args, ["--effort", "high"]);
  } finally {
    setPhaseEffortConfigOverrides({});
  }
});

// ---------------------------------------------------------------------------
// Per-repo model/effort overrides (Issue #2625)
// ---------------------------------------------------------------------------

/**
 * Clear the module-level routing overrides so a precedence test starts from a
 * clean slate.
 *
 * The environment half of that slate is the injected lookup each test passes
 * (Issue #957) — `NO_ENV` where the test wants nothing set — so there is
 * nothing here to delete from the process, and no list of phase names to keep
 * in step with the tests below.
 */
function resetRoutingOverrides(): void {
  setPhaseModelConfigOverrides({});
  setPhaseEffortConfigOverrides({});
  setActiveRepoModelEffortOverrides(undefined);
}

Deno.test("claude executor - per-repo claude_model overrides global base and phase defaults (Issue #2625)", () => {
  resetRoutingOverrides();
  try {
    setActiveRepoModelEffortOverrides({ claudeModel: "fable" });
    // Base tier wins over a phase that has a built-in PHASE_MODEL_DEFAULTS entry.
    assertEquals(buildClaudeModelArgs("planning", NO_ENV), [
      "--model",
      "fable",
    ]);
    // ...and over a phase-less call.
    assertEquals(buildClaudeModelArgs(undefined, NO_ENV), ["--model", "fable"]);
    // ...and over the issue phase's built-in PHASE_MODEL_DEFAULTS entry
    // (Opus, Issue #2709).
    assertEquals(buildClaudeModelArgs("issue", NO_ENV), ["--model", "fable"]);
  } finally {
    setActiveRepoModelEffortOverrides(undefined);
  }
});

Deno.test("claude executor - per-repo phase_model_overrides beats per-repo base (Issue #2625)", () => {
  resetRoutingOverrides();
  try {
    setActiveRepoModelEffortOverrides({
      claudeModel: "sonnet",
      phaseModelOverrides: { issue: "fable" },
    });
    // Most-specific (per-repo phase) wins for the issue phase.
    assertEquals(buildClaudeModelArgs("issue", NO_ENV), ["--model", "fable"]);
    // A phase with no per-repo phase override falls back to the per-repo base.
    assertEquals(buildClaudeModelArgs("planning", NO_ENV), [
      "--model",
      "sonnet",
    ]);
  } finally {
    setActiveRepoModelEffortOverrides(undefined);
  }
});

Deno.test("claude executor - phase-specific env var beats per-repo overrides (Issue #2625)", () => {
  resetRoutingOverrides();
  const env = envLookup({ CLAUDE_MODEL_ISSUE: "opus" });
  try {
    setActiveRepoModelEffortOverrides({
      claudeModel: "sonnet",
      phaseModelOverrides: { issue: "fable" },
    });
    // Operator escape hatch (env var) is highest precedence.
    assertEquals(buildClaudeModelArgs("issue", env), ["--model", "opus"]);
  } finally {
    setActiveRepoModelEffortOverrides(undefined);
  }
});

Deno.test("claude executor - per-repo base beats global phase_model_overrides (Issue #2625)", () => {
  resetRoutingOverrides();
  try {
    setPhaseModelConfigOverrides({ health: "haiku" });
    setActiveRepoModelEffortOverrides({ claudeModel: "fable" });
    // Per-repo base (precedence 3) wins over global phase override (precedence 4).
    assertEquals(buildClaudeModelArgs("health", NO_ENV), ["--model", "fable"]);
  } finally {
    setActiveRepoModelEffortOverrides(undefined);
    setPhaseModelConfigOverrides({});
  }
});

Deno.test("claude executor - per-repo phase_effort_overrides beats global and defaults (Issue #2625)", () => {
  resetRoutingOverrides();
  try {
    setPhaseEffortConfigOverrides({ issue: "low" });
    setActiveRepoModelEffortOverrides({
      phaseEffortOverrides: { issue: "xhigh", planning: "high" },
    });
    // Per-repo phase effort beats the global phase override...
    assertEquals(buildClaudeEffortArgs("issue", NO_ENV), ["--effort", "xhigh"]);
    // ...and beats the PHASE_EFFORT_DEFAULTS entry for planning ("max").
    assertEquals(buildClaudeEffortArgs("planning", NO_ENV), [
      "--effort",
      "high",
    ]);
  } finally {
    setActiveRepoModelEffortOverrides(undefined);
    setPhaseEffortConfigOverrides({});
  }
});

Deno.test("claude executor - phase-specific effort env var beats per-repo effort override (Issue #2625)", () => {
  resetRoutingOverrides();
  const env = envLookup({ CLAUDE_EFFORT_ISSUE: "medium" });
  try {
    setActiveRepoModelEffortOverrides({
      phaseEffortOverrides: { issue: "xhigh" },
    });
    assertEquals(buildClaudeEffortArgs("issue", env), ["--effort", "medium"]);
  } finally {
    setActiveRepoModelEffortOverrides(undefined);
  }
});

Deno.test("claude executor - switching repos replaces overrides without leaking (Issue #2625)", () => {
  resetRoutingOverrides();
  try {
    // Repo A: premium tier.
    setActiveRepoModelEffortOverrides({
      claudeModel: "fable",
      phaseEffortOverrides: { issue: "xhigh" },
    });
    assertEquals(buildClaudeModelArgs("issue", NO_ENV), ["--model", "fable"]);
    assertEquals(buildClaudeEffortArgs("issue", NO_ENV), ["--effort", "xhigh"]);

    // Repo B: economy tier — must fully replace repo A's routing.
    setActiveRepoModelEffortOverrides({
      claudeModel: "sonnet",
      phaseEffortOverrides: { issue: "medium" },
    });
    assertEquals(buildClaudeModelArgs("issue", NO_ENV), ["--model", "sonnet"]);
    assertEquals(buildClaudeEffortArgs("issue", NO_ENV), [
      "--effort",
      "medium",
    ]);

    // Repo C: no per-repo config — routing falls back to defaults, with no
    // leftover from A or B. "issue" now carries the Opus base-tier default
    // (Issue #2709); planning carries the Fable 5 top-tier default (Issue
    // #2621).
    setActiveRepoModelEffortOverrides(undefined);
    assertEquals(buildClaudeModelArgs("issue", NO_ENV), ["--model", "opus"]);
    assertEquals(buildClaudeModelArgs("planning", NO_ENV), [
      "--model",
      "fable",
    ]);
    assertEquals(buildClaudeEffortArgs("issue", NO_ENV), ["--effort", "high"]);
  } finally {
    setActiveRepoModelEffortOverrides(undefined);
  }
});

// ---------------------------------------------------------------------------
// describeRepoBaseTierOverride (Issue #2716)
// ---------------------------------------------------------------------------

Deno.test("describeRepoBaseTierOverride - empty base tier returns null (Issue #2716)", () => {
  assertEquals(describeRepoBaseTierOverride(""), null);
  assertEquals(describeRepoBaseTierOverride("   "), null);
});

Deno.test("describeRepoBaseTierOverride - sonnet base demotes planning and grill_me off Fable (Issue #2716)", () => {
  const note = describeRepoBaseTierOverride("sonnet");
  if (note === null) throw new Error("expected a note for a sonnet base tier");
  // The Fable top-tier phases are demoted.
  assertStringIncludes(note, "planning (fable→sonnet)");
  assertStringIncludes(note, "grill_me (fable→sonnet)");
  // The Haiku trivial phases are also rerouted.
  assertStringIncludes(note, "health (haiku→sonnet)");
  // The base tier itself is named.
  assertStringIncludes(note, '"sonnet"');
});

Deno.test("describeRepoBaseTierOverride - fable base promotes Haiku trivial phases (Issue #2716)", () => {
  const note = describeRepoBaseTierOverride("fable");
  if (note === null) throw new Error("expected a note for a fable base tier");
  // The cheap Haiku phases are promoted to Fable (~5× cost).
  assertStringIncludes(note, "spelling_fix (haiku→fable)");
  assertStringIncludes(note, "summarise (haiku→fable)");
  assertStringIncludes(note, "health (haiku→fable)");
  // planning/grill_me already default to Fable — they are NOT a reroute and
  // must be omitted.
  assertEquals(note.includes("planning"), false);
  assertEquals(note.includes("grill_me"), false);
});

Deno.test("describeRepoBaseTierOverride - comparison is case-insensitive (Issue #2716)", () => {
  // FABLE (upper) must still recognise planning's lowercase "fable" default as
  // equal, so planning is omitted.
  const note = describeRepoBaseTierOverride("FABLE");
  if (note === null) throw new Error("expected a note for a FABLE base tier");
  assertEquals(note.includes("planning"), false);
});

Deno.test("setActiveRepoModelEffortOverrides - logs base-tier reroute once on repo switch (Issue #2716)", () => {
  const logged: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    // A base-tier repo logs exactly one reroute note.
    setActiveRepoModelEffortOverrides({ claudeModel: "sonnet" });
    assertEquals(logged.length, 1);
    assertStringIncludes(logged[0]!, "planning (fable→sonnet)");

    // Clearing overrides (no base tier) logs nothing further.
    setActiveRepoModelEffortOverrides(undefined);
    assertEquals(logged.length, 1);

    // A repo with no base tier logs nothing.
    setActiveRepoModelEffortOverrides({
      phaseModelOverrides: { issue: "opus" },
    });
    assertEquals(logged.length, 1);
  } finally {
    console.info = originalInfo;
    setActiveRepoModelEffortOverrides(undefined);
  }
});

// ---------------------------------------------------------------------------
// The injected environment lookup (Issue #957)
// ---------------------------------------------------------------------------
//
// These are the direct tests of the seam itself. Each drives it with a value
// that is **absent from the real process environment**, so a code path that
// quietly fell back to `Deno.env.get` would fail here rather than pass on the
// ambient value — which is the failure the rest of this file could not detect
// on its own once its 318 process mutations were removed.

/** A value no process environment carries, so only the seam can supply it. */
const SENTINEL = "vibe-957-sentinel-model";

Deno.test("claude executor - both env reads go through the injected lookup, never the process (Issue #957)", () => {
  resetRoutingOverrides();
  const asked: string[] = [];
  // An unknown phase misses steps 2-5, so one call exercises step 1 (the
  // phase-specific variable) *and* step 6 (the base variable).
  const args = buildClaudeModelArgs("totally_unknown_phase", (name) => {
    asked.push(name);
    return name === "CLAUDE_MODEL" ? SENTINEL : undefined;
  });

  assertEquals(args, ["--model", SENTINEL]);
  assertEquals(asked, ["CLAUDE_MODEL_TOTALLY_UNKNOWN_PHASE", "CLAUDE_MODEL"]);
  // The sentinel is not something the process could have supplied.
  assertEquals(Deno.env.get("CLAUDE_MODEL"), undefined);
});

Deno.test("claude executor - the effort chain reads both variables through the lookup (Issue #957)", () => {
  resetRoutingOverrides();
  const asked: string[] = [];
  const args = buildClaudeEffortArgs("totally_unknown_phase", (name) => {
    asked.push(name);
    return name === "CLAUDE_EFFORT" ? "xhigh" : undefined;
  });

  assertEquals(args, ["--effort", "xhigh"]);
  assertEquals(asked, ["CLAUDE_EFFORT_TOTALLY_UNKNOWN_PHASE", "CLAUDE_EFFORT"]);
});

Deno.test("claude executor - the injected lookup decides, not the process (Issue #957)", () => {
  resetRoutingOverrides();
  // The phase-specific variable is precedence step 1, so an injected value
  // wins over the designed default — proving the value came from the lookup.
  assertEquals(
    buildClaudeModelArgs(
      "planning",
      envLookup({ CLAUDE_MODEL_PLANNING: SENTINEL }),
    ),
    ["--model", SENTINEL],
  );
  // ...and an empty lookup falls through to the designed default.
  assertEquals(buildClaudeModelArgs("planning", NO_ENV), ["--model", "fable"]);
});

Deno.test("claude executor - hasExplicitEffortOverride reads the injected lookup (Issue #957)", () => {
  resetRoutingOverrides();
  assertEquals(hasExplicitEffortOverride("issue", NO_ENV), false);
  assertEquals(
    hasExplicitEffortOverride(
      "issue",
      envLookup({ CLAUDE_EFFORT_ISSUE: "low" }),
    ),
    true,
  );
  // The global variable is the phase-less source.
  assertEquals(
    hasExplicitEffortOverride(undefined, envLookup({ CLAUDE_EFFORT: "low" })),
    true,
  );
  assertEquals(hasExplicitEffortOverride(undefined, NO_ENV), false);
});
