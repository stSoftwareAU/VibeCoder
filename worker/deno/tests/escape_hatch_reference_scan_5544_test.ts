/**
 * Tests for the linear reference scan in escape_hatch.ts (Issue #5544).
 *
 * The old global regex was quadratic on long runs of name characters and
 * blocked the worker's event loop. These cases must return quickly and
 * keep the old matching semantics.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { detectEscapeHatch } from "../lib/escape_hatch.ts";

// ---------------------------------------------------------------------------
// Hostile inputs (Issue #5544)
// ---------------------------------------------------------------------------

Deno.test("detectEscapeHatch - long name run with bare fallback (Issue #5544)", () => {
  const message = "follow-up issue " + "a".repeat(1_000_000) + " see #12";
  const result = detectEscapeHatch(message, "o/r");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "#12");
});

Deno.test("detectEscapeHatch - long run after slash then full ref (Issue #5544)", () => {
  const message = "follow-up issue x/" + "b".repeat(1_000_000) + " then o/r#7";
  const result = detectEscapeHatch(message, "o/r");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "o/r#7");
});

Deno.test("detectEscapeHatch - long run of dashes and dots then full ref (Issue #5544)", () => {
  const message = "follow-up issue " + "-.".repeat(500_000) + "owner/repo#5";
  const result = detectEscapeHatch(message, "owner/repo");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "owner/repo#5");
});

Deno.test("detectEscapeHatch - many short slash segments then full ref (Issue #5544)", () => {
  const message = "follow-up issue " + "a/".repeat(500_000) + " o/r#9";
  const result = detectEscapeHatch(message, "o/r");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "o/r#9");
});

// ---------------------------------------------------------------------------
// Matching semantics (Issue #5544)
// ---------------------------------------------------------------------------

Deno.test("detectEscapeHatch - leading dash before owner is not part of the slug (Issue #5544)", () => {
  const result = detectEscapeHatch(
    "follow-up issue -owner/repo#5",
    "owner/repo",
  );
  assertEquals(result.issueRef, "owner/repo#5");
});

Deno.test("detectEscapeHatch - nested slashes match from the last segment (Issue #5544)", () => {
  const result = detectEscapeHatch("follow-up issue a/b/c#1", "x/y");
  assertEquals(result.issueRef, "b/c#1");
});

Deno.test("detectEscapeHatch - scan resumes right after previous digits (Issue #5544)", () => {
  const result = detectEscapeHatch(
    "follow-up issue a/b#12owner/repo#3",
    "owner/repo",
  );
  assertEquals(result.issueRef, "owner/repo#3");
});

Deno.test("detectEscapeHatch - same-repo ref preferred over earlier other-repo ref (Issue #5544)", () => {
  const result = detectEscapeHatch(
    "follow-up issue other/thing#4 and Owner/Repo#8",
    "owner/repo",
  );
  assertEquals(result.issueRef, "Owner/Repo#8");
});

// ---------------------------------------------------------------------------
// Negative control (Issue #5544)
// ---------------------------------------------------------------------------

Deno.test("detectEscapeHatch - long run and full ref without follow-up wording is not invoked (Issue #5544)", () => {
  const message = "x".repeat(1_000_000) + " o/r#2";
  const result = detectEscapeHatch(message, "o/r");
  assertEquals(result.invoked, false);
});
