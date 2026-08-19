/**
 * Tests for the terminal title module.
 *
 * Migrated from tests/terminal-title.bats (Issue #900).
 * Issue #263: Set window title to the task currently being worked on.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildTitleSequence,
  resetWindowTitle,
  setWindowTitle,
  setWindowTitleForIssue,
  setWindowTitleForPr,
  WINDOW_TITLE_MAX_LENGTH,
} from "../lib/terminal_title.ts";

const ENABLED = { enabled: true };
const DISABLED = { enabled: false };

// =============================================================================
// buildTitleSequence
// =============================================================================

Deno.test("terminal_title - buildTitleSequence includes title text", () => {
  const result = buildTitleSequence("Issue #42 - Fix bug");
  assertStringIncludes(result, "Issue #42 - Fix bug");
});

Deno.test("terminal_title - buildTitleSequence uses OSC 0 escape sequence format", () => {
  const result = buildTitleSequence("Test Title");
  // ESC ] 0 ; ... BEL
  assertEquals(result.startsWith("\x1b]0;"), true);
  assertEquals(result.endsWith("\x07"), true);
});

// Issue #3661 (SEC-bfdd5fa86313): the title is an attacker-supplied issue
// title written straight into an OSC control sequence on the operator's
// terminal, so C0 controls must not survive into it.

Deno.test("terminal_title - buildTitleSequence strips an embedded BEL terminator", () => {
  const result = buildTitleSequence("Fix bug\x07 rogue trailing text");
  // Exactly one BEL — the sequence's own terminator, at the very end.
  assertEquals(result.split("\x07").length - 1, 1);
  assertEquals(result.endsWith("\x07"), true);
  assertStringIncludes(result, "Fix bug rogue trailing text");
});

Deno.test("terminal_title - buildTitleSequence strips an embedded ESC", () => {
  const result = buildTitleSequence("Fix bug\x1b]0;hijacked\x07");
  // Only the leading OSC introducer's ESC remains.
  assertEquals(result.split("\x1b").length - 1, 1);
  assertEquals(result.startsWith("\x1b]0;"), true);
});

Deno.test("terminal_title - buildTitleSequence strips newlines, NUL and DEL", () => {
  const result = buildTitleSequence("a\nb\r\tc\x00d\x7fe");
  assertStringIncludes(result, "abcde");
});

Deno.test("terminal_title - buildTitleSequence truncates long titles", () => {
  const longTitle = "A".repeat(200);
  const result = buildTitleSequence(longTitle);
  // Should contain truncated title (80 chars) + "..." + escape sequence overhead
  assertStringIncludes(result, "...");
  // The title portion should be 80 + 3 ("...") = 83 chars
  // Full sequence: \x1b]0; (4 chars) + title (83 chars) + \x07 (1 char) = 88
  assertEquals(result.length < 200, true);
});

Deno.test("terminal_title - buildTitleSequence does not truncate short titles", () => {
  const shortTitle = "Short";
  const result = buildTitleSequence(shortTitle);
  assertStringIncludes(result, "Short");
  assertEquals(result.includes("..."), false);
});

Deno.test("terminal_title - buildTitleSequence handles special characters", () => {
  const result = buildTitleSequence('Issue #42: Fix "quotes" & <angles>');
  assertStringIncludes(result, "Issue #42");
});

// =============================================================================
// setWindowTitle — enabled behaviour
// =============================================================================

Deno.test("terminal_title - setWindowTitle returns sequence when enabled", () => {
  const result = setWindowTitle("Issue #42 - Fix bug", ENABLED);
  assertStringIncludes(result, "Issue #42 - Fix bug");
  assertEquals(result.length > 0, true);
});

Deno.test("terminal_title - setWindowTitle returns OSC sequence when enabled", () => {
  const result = setWindowTitle("Test Title", ENABLED);
  assertEquals(result.startsWith("\x1b]0;"), true);
  assertEquals(result.endsWith("\x07"), true);
});

// =============================================================================
// setWindowTitle — disabled behaviour
// =============================================================================

Deno.test("terminal_title - setWindowTitle returns empty string when disabled", () => {
  const result = setWindowTitle("Issue #42 - Fix bug", DISABLED);
  assertEquals(result, "");
});

// =============================================================================
// resetWindowTitle
// =============================================================================

Deno.test("terminal_title - resetWindowTitle returns sequence when enabled", () => {
  const result = resetWindowTitle(ENABLED);
  assertEquals(result.length > 0, true);
  assertStringIncludes(result, "VibeCoder");
});

Deno.test("terminal_title - resetWindowTitle returns empty string when disabled", () => {
  const result = resetWindowTitle(DISABLED);
  assertEquals(result, "");
});

// =============================================================================
// setWindowTitleForIssue
// =============================================================================

Deno.test("terminal_title - setWindowTitleForIssue formats title with repo and issue number", () => {
  const result = setWindowTitleForIssue(
    "owner/repo",
    "42",
    "Fix the bug",
    ENABLED,
  );
  assertStringIncludes(result, "owner/repo");
  assertStringIncludes(result, "#42");
  assertStringIncludes(result, "Fix the bug");
});

Deno.test("terminal_title - setWindowTitleForIssue returns empty when disabled", () => {
  const result = setWindowTitleForIssue(
    "owner/repo",
    "42",
    "Fix the bug",
    DISABLED,
  );
  assertEquals(result, "");
});

// =============================================================================
// setWindowTitleForPr
// =============================================================================

Deno.test("terminal_title - setWindowTitleForPr formats title with repo and PR number", () => {
  const result = setWindowTitleForPr("owner/repo", "99", "Feedback", ENABLED);
  assertStringIncludes(result, "owner/repo");
  assertStringIncludes(result, "PR #99");
  assertStringIncludes(result, "Feedback");
});

Deno.test("terminal_title - setWindowTitleForPr returns empty when disabled", () => {
  const result = setWindowTitleForPr("owner/repo", "99", "Feedback", DISABLED);
  assertEquals(result, "");
});

// =============================================================================
// WINDOW_TITLE_MAX_LENGTH constant
// =============================================================================

Deno.test("terminal_title - WINDOW_TITLE_MAX_LENGTH is 80", () => {
  assertEquals(WINDOW_TITLE_MAX_LENGTH, 80);
});
