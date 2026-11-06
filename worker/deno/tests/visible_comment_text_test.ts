/**
 * Tests for `hasVisibleText` — whether a comment body has text outside HTML
 * comments (Issue #4673).
 *
 * The review-fleet-prs claim is a comment whose only content is a hidden
 * marker. The helper must call that empty, call an unclosed opener visible,
 * and finish promptly on a hostile body of unclosed openers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { hasVisibleText } from "../lib/visible_comment_text.ts";

const CLAIM_MARKER =
  "<!-- vibe-review-claim sha=abc host=h expires=2026-11-01T22:00:00Z -->";

Deno.test("hasVisibleText - marker-only body has no visible text (Issue #4673)", () => {
  assertEquals(hasVisibleText(CLAIM_MARKER), false);
});

Deno.test("hasVisibleText - empty and whitespace-only bodies have no visible text", () => {
  assertEquals(hasVisibleText(""), false);
  assertEquals(hasVisibleText("   \n\t  "), false);
});

Deno.test("hasVisibleText - marker followed by visible text is visible", () => {
  assertEquals(
    hasVisibleText(`${CLAIM_MARKER}\nPlease fix the lint error.`),
    true,
  );
});

Deno.test("hasVisibleText - visible text followed by marker is visible", () => {
  assertEquals(
    hasVisibleText(`Please fix the lint error.\n${CLAIM_MARKER}`),
    true,
  );
});

Deno.test("hasVisibleText - two markers with only whitespace between have no visible text", () => {
  assertEquals(hasVisibleText("<!-- a -->\n\n  <!-- b -->"), false);
});

Deno.test("hasVisibleText - text between two markers is visible", () => {
  assertEquals(hasVisibleText("<!-- a --> fix this <!-- b -->"), true);
});

Deno.test("hasVisibleText - unclosed opener followed by text is visible (fails towards acting)", () => {
  assertEquals(hasVisibleText("<!-- never closed, please fix"), true);
});

Deno.test("hasVisibleText - hostile body of 30000 unclosed openers finishes and is visible", () => {
  assertEquals(hasVisibleText("<!--".repeat(30000)), true);
});

Deno.test("hasVisibleText - 30000 complete markers with nothing else have no visible text", () => {
  assertEquals(hasVisibleText("<!-- a -->".repeat(30000)), false);
});
