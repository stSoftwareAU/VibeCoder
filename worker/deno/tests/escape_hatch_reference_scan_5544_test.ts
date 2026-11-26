/**
 * Tests for the linear reference scan in escape_hatch.ts (Issue #5544).
 *
 * Long failed name runs made the old global regex retry every suffix.
 * These cases preserve matching semantics and count reference-scan work;
 * they do not reproduce the archived watchdog incident.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
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

Deno.test("detectEscapeHatch - failed name runs take linear character reads", () => {
  for (
    const build of [
      (n: number) => "a".repeat(n) + "!",
      (n: number) => "a/" + "b".repeat(n) + "!",
      (n: number) => "-.".repeat(n) + "!",
      (n: number) => "a/".repeat(n) + "!",
      (n: number) => "a/b#" + "1".repeat(n) + "!",
      (n: number) => "a".repeat(n) + "/b#1",
    ]
  ) {
    const counts: number[] = [];
    for (const n of [1_000, 4_000]) {
      const message = "follow-up issue " + build(n) + " o/r#12";
      let reads = 0;
      const result = detectEscapeHatch(message, "o/r", (text, index) => {
        reads++;
        return text.charCodeAt(index);
      });
      assertEquals(result, {
        invoked: true,
        issueRef: "o/r#12",
        needsHuman: false,
      });
      assert(reads > 0, "the counter must observe the production scan");
      assert(
        reads <= 8 * message.length,
        "reference reads must be bounded by input size",
      );
      counts.push(reads);
    }
    assert(counts[1]! <= 4 * counts[0]!, "4N input must take at most 4N reads");
  }
});

Deno.test("detectEscapeHatch - reference boundaries and ordering stay compatible", () => {
  const cases: [string, string | undefined][] = [
    ["a/.-#1", "a/.-#1"],
    ["a/.b/c#2", "b/c#2"],
    ["a/!b/c#3", "b/c#3"],
    ["a/b#1c/d#2", "a/b#1"],
    ["a/b#1c/d#2 o/r#3", "o/r#3"],
    ["#1 other/repo#2 third/repo#3", "other/repo#2"],
    ["other/repo#2 O/R#3 o/r#4", "O/R#3"],
    ["éowner/repo#4", "owner/repo#4"],
    ["owner/repo#5suffix", "owner/repo#5"],
    ["(#6) [#7]", "#6"],
    ["[#7]", "#7"],
    ["\n#8", "#8"],
    ["foo#6 #7suffix", undefined],
    ["a/b#x #8", "#8"],
    ["o/r#", undefined],
    ["o/!#3", undefined],
  ];
  for (const [text, issueRef] of cases) {
    const result = detectEscapeHatch("follow-up issue " + text, "o/r");
    assertEquals(
      result,
      issueRef
        ? { invoked: true, issueRef, needsHuman: false }
        : { invoked: false, needsHuman: false },
      text,
    );
  }
});

Deno.test("detectEscapeHatch - wrapped hand-off wording keeps the existing heuristic", () => {
  assertEquals(detectEscapeHatch("follow-up\nissue o/r#12", "o/r"), {
    invoked: false,
    needsHuman: false,
  });
  assertEquals(detectEscapeHatch("follow-up issue\no/r#12", "o/r"), {
    invoked: true,
    issueRef: "o/r#12",
    needsHuman: false,
  });
});
