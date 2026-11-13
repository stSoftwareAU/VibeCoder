/**
 * Unit tests for the mutation-gate helpers that remain after the automatic
 * mutation check was retired by Issue #5095 (originally Issue #3393): exemption
 * parsing, with the hostile-input cases that guard it, and the Markdown
 * sanitiser the pre-push gate reply still uses.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { mdSafe, parseMutationExemptions } from "../lib/mutation_gate.ts";

Deno.test("hostile - exemption parsing completes on long hostile lines", () => {
  const big = 50_000;
  parseMutationExemptions("a".repeat(big) + ":" + "exempt (untestable): x");
  parseMutationExemptions(
    "`" + "a:".repeat(1000) + "1` exempt (untestable): " + " ".repeat(big),
  );
  parseMutationExemptions("exempt (untestable):".repeat(big));
  parseMutationExemptions(" ".repeat(big) + "x:1 exempt (untestable): r");
});

// ---------------------------------------------------------------------------
// parseMutationExemptions
// ---------------------------------------------------------------------------

Deno.test("parseMutationExemptions - backticked and bare locations with a reason", () => {
  const summary = [
    "- `lib/a.ts:12` exempt (untestable): logging only",
    "lib/b.ts:7 EXEMPT (Untestable): wall clock",
  ].join("\n");
  assertEquals(parseMutationExemptions(summary), [
    { file: "lib/a.ts", line: 12, reason: "logging only" },
    { file: "lib/b.ts", line: 7, reason: "wall clock" },
  ]);
});

Deno.test("parseMutationExemptions - empty reason is not an exemption", () => {
  assertEquals(
    parseMutationExemptions("`lib/a.ts:12` exempt (untestable):   "),
    [],
  );
  assertEquals(
    parseMutationExemptions("`lib/a.ts:12` exempt (untestable):"),
    [],
  );
});

Deno.test("parseMutationExemptions - lines without the marker or a location are ignored", () => {
  assertEquals(parseMutationExemptions("`lib/a.ts:12` is fine"), []);
  assertEquals(parseMutationExemptions("exempt (untestable): reason only"), []);
  assertEquals(
    parseMutationExemptions("`lib/a.ts:x` exempt (untestable): r"),
    [],
  );
});

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
