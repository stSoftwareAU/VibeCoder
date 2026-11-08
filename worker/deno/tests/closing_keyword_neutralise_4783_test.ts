/**
 * Unit tests for `neutraliseOtherIssueClosingKeywords` (Issue #4783): a PR
 * summary's closing keyword for another issue is code-wrapped so GitHub does
 * not close that issue on merge.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { neutraliseOtherIssueClosingKeywords } from "../lib/missing_criterion_close_guard.ts";

const GOVERNING = 4637;

Deno.test("neutraliseOtherIssueClosingKeywords - leaves a keyword inside inline code or a fenced block byte-identical", () => {
  const text =
    "See `Closes #4674` here.\n\n```\nFixes #4674\n```\n\nDo not close #4674.";
  assertEquals(
    neutraliseOtherIssueClosingKeywords(text, GOVERNING),
    "See `Closes #4674` here.\n\n```\nFixes #4674\n```\n\nDo not `close` #4674.",
  );
});

Deno.test("neutraliseOtherIssueClosingKeywords - neutralises a qualified reference to another repository", () => {
  assertEquals(
    neutraliseOtherIssueClosingKeywords("Fixes other/repo#9 today.", GOVERNING),
    "`Fixes` other/repo#9 today.",
  );
});

Deno.test("neutraliseOtherIssueClosingKeywords - cross-repo identity keeps the governing issue and neutralises the PR-repo reference", () => {
  const identity = { prRepo: "a/pr", issueRepo: "b/issue" };
  assertEquals(
    neutraliseOtherIssueClosingKeywords(
      "Closes b/issue#4637 and Closes #4637.",
      GOVERNING,
      identity,
    ),
    "Closes b/issue#4637 and `Closes` #4637.",
  );
});

Deno.test("neutraliseOtherIssueClosingKeywords - neutralises a keyword whose #N is hard-wrapped onto the next line", () => {
  assertEquals(
    neutraliseOtherIssueClosingKeywords(
      "This will close\n#12 today.",
      GOVERNING,
    ),
    "This will `close`\n#12 today.",
  );
});

Deno.test("neutraliseOtherIssueClosingKeywords - leaves a hostile long run of spaces unchanged", () => {
  const text = "close" + " ".repeat(20000) + "x";
  assertEquals(neutraliseOtherIssueClosingKeywords(text, GOVERNING), text);
});
