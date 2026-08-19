/**
 * Tests for escape_hatch.ts (Issue #1826).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { detectEscapeHatch } from "../lib/escape_hatch.ts";

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

Deno.test("detectEscapeHatch - undefined message returns invoked=false", () => {
  const result = detectEscapeHatch(undefined, "stSoftwareAU/foo");
  assertEquals(result.invoked, false);
  assertEquals(result.needsHuman, false);
});

Deno.test("detectEscapeHatch - empty message returns invoked=false", () => {
  const result = detectEscapeHatch("", "stSoftwareAU/foo");
  assertEquals(result.invoked, false);
});

Deno.test("detectEscapeHatch - whitespace-only message returns invoked=false", () => {
  const result = detectEscapeHatch("   \n  \n", "stSoftwareAU/foo");
  assertEquals(result.invoked, false);
});

Deno.test("detectEscapeHatch - issue link without follow-up wording returns false", () => {
  // A regular fix reply that mentions an issue is NOT the escape hatch.
  const message =
    "I've pushed the fix for the typo. See #42 for related context.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, false);
});

Deno.test("detectEscapeHatch - follow-up wording without issue link returns false", () => {
  const message =
    "This is out of scope of the current PR but I cannot raise a follow-up.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, false);
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

Deno.test("detectEscapeHatch - same-repo full reference + follow-up wording", () => {
  const message =
    "This change is out of scope of the current PR. I've opened follow-up issue stSoftwareAU/foo#101 to track the work.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "stSoftwareAU/foo#101");
  assertEquals(result.needsHuman, false);
});

Deno.test("detectEscapeHatch - bare hash reference + follow-up wording", () => {
  const message =
    "Out-of-scope for this PR — opened a new issue (#202) capturing what's blocking.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "#202");
});

Deno.test("detectEscapeHatch - case-insensitive repo slug match", () => {
  const message =
    "I've raised a follow-up issue STSOFTWAREAU/FOO#303 because the change is too large.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "STSOFTWAREAU/FOO#303");
});

Deno.test("detectEscapeHatch - cross-repo reference still detected as fallback", () => {
  // Even if the slug doesn't match, the escape hatch is invoked when
  // wording + a fully-qualified reference are present.
  const message =
    "Tracked separately in someorg/other#7. Handing off — needs human review.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "someorg/other#7");
  assertEquals(result.needsHuman, true);
});

Deno.test("detectEscapeHatch - detects needs-human in prose", () => {
  const message =
    "Out of scope — opened follow-up issue #404. Adding the needs-human label so a person can triage.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, true);
  assertEquals(result.needsHuman, true);
});

Deno.test("detectEscapeHatch - detects backticked needs-human", () => {
  const message =
    "Filed a follow-up issue stSoftwareAU/foo#555 — added `needs-human`.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, true);
  assertEquals(result.needsHuman, true);
});

Deno.test("detectEscapeHatch - prefers same-repo full ref over bare hash", () => {
  const message =
    "Opened follow-up issue stSoftwareAU/foo#999 — see also #1 for context.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "stSoftwareAU/foo#999");
});

Deno.test("detectEscapeHatch - 'escape hatch' wording alone with link is enough", () => {
  const message = "Invoking the escape hatch — see stSoftwareAU/foo#700.";
  const result = detectEscapeHatch(message, "stSoftwareAU/foo");
  assertEquals(result.invoked, true);
  assertEquals(result.issueRef, "stSoftwareAU/foo#700");
});
