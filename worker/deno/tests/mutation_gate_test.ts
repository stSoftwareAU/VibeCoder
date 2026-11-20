/**
 * Unit tests for the mutation-gate helpers that remain after the automatic
 * mutation check was retired by Issue #5095 (originally Issue #3393): the
 * Markdown sanitiser the pre-push gate reply still uses.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { mdSafe } from "../lib/mutation_gate.ts";

// ---------------------------------------------------------------------------
// mdSafe — untrusted gate text written into a PR reply (pr_ci_processor.ts)
// ---------------------------------------------------------------------------

Deno.test("mdSafe - strips backticks so untrusted text cannot open a code span", () => {
  assertEquals(mdSafe("run `rm` then ``x``"), "run rm then x");
});

Deno.test("mdSafe - collapses each run of line breaks to one space", () => {
  assertEquals(mdSafe("a\r\nb\n\n\nc\rd"), "a b c d");
  assertEquals(mdSafe("a`b\r\nc"), "ab c");
});

Deno.test("mdSafe - control: plain single-line text is unchanged", () => {
  assertEquals(
    mdSafe("gate failed: exit 1 (timeout)"),
    "gate failed: exit 1 (timeout)",
  );
});
