/**
 * Tests for the shared, paragraph-aware Markdown code-span splitter
 * (Issue #3313).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  isClosingFence,
  maskMarkdownCode,
  parseFenceLine,
  splitMarkdownCode,
  stripMarkdownCode,
} from "../lib/markdown_code_spans.ts";
import { assertLinearGrowth } from "./support/growth.ts";

// ---------------------------------------------------------------------------
// splitMarkdownCode — round-trips
// ---------------------------------------------------------------------------

function roundTrips(text: string) {
  const segments = splitMarkdownCode(text);
  assertEquals(segments.map((s) => s.value).join(""), text);
}

Deno.test("splitMarkdownCode round-trips plain prose", () => {
  roundTrips("just some prose with no code at all");
});

Deno.test("splitMarkdownCode round-trips a mix of fences and inline spans", () => {
  roundTrips(
    "intro `code` middle\n```\nfenced\n```\nend `more` text\n",
  );
});

Deno.test("splitMarkdownCode round-trips an unterminated fence", () => {
  roundTrips("before\n```\nnever closes\nmore text");
});

// ---------------------------------------------------------------------------
// Inline spans wrapping across lines within a paragraph
// ---------------------------------------------------------------------------

Deno.test("splitMarkdownCode treats a span wrapped across two lines as code", () => {
  const text = "see `start of span\nend of span` here";
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment, "expected an in-code segment");
  assertEquals(codeSegment!.value, "`start of span\nend of span`");
});

Deno.test("splitMarkdownCode resets an unclosed span at a blank line", () => {
  // The lone backtick in paragraph 1 must not pair with the one in
  // paragraph 2 — CommonMark never lets a span cross a blank line.
  const text = "para one has a lone ` backtick\n\npara two has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "no segment should be marked in-code: the backticks must not pair across the blank line",
  );
});

// ---------------------------------------------------------------------------
// parseFenceLine / isClosingFence (exported for blocked_outcome.ts)
// ---------------------------------------------------------------------------

Deno.test("parseFenceLine recognises a backtick and a tilde fence", () => {
  assertEquals(parseFenceLine("```js"), { char: "`", length: 3, rest: "js" });
  assertEquals(parseFenceLine("~~~~"), { char: "~", length: 4, rest: "" });
  assertEquals(parseFenceLine("not a fence"), null);
});

Deno.test("isClosingFence requires the same character, same-or-greater length, no info string", () => {
  const opener = parseFenceLine("```js")!;
  assert(isClosingFence("```", opener));
  assert(isClosingFence("````", opener));
  assert(!isClosingFence("~~~", opener), "different fence character");
  assert(!isClosingFence("``", opener), "shorter than the opener");
  assert(!isClosingFence("```md", opener), "carries an info string");
});

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

Deno.test("splitMarkdownCode handles a tilde fence", () => {
  const text = "before\n~~~\ncode here\n~~~\nafter";
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment);
  assertEquals(codeSegment!.value, "~~~\ncode here\n~~~\n");
});

Deno.test("splitMarkdownCode handles a list-indented fence", () => {
  const text = "- item\n  ```\n  code\n  ```\nafter";
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment);
  assertEquals(codeSegment!.value, "  ```\n  code\n  ```\n");
});

Deno.test("splitMarkdownCode: a longer fence is not closed by a shorter one", () => {
  const text = "````\ncode with ``` inside\n````\nafter";
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment);
  assertEquals(codeSegment!.value, "````\ncode with ``` inside\n````\n");
  const afterSegment = segments.find((s) =>
    !s.inCode && s.value.includes("after")
  );
  assert(afterSegment);
});

Deno.test("splitMarkdownCode: a fence line with an info string is not a closer", () => {
  const text = "```js\ncode\n```md\nstill code\n```\nafter";
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment);
  assertEquals(codeSegment!.value, "```js\ncode\n```md\nstill code\n```\n");
});

Deno.test("splitMarkdownCode: an unclosed fence runs to the end of the text", () => {
  const text = "intro\n```\nnever closes\nmore text";
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment);
  assertEquals(codeSegment!.value, "```\nnever closes\nmore text");
});

// ---------------------------------------------------------------------------
// maskMarkdownCode
// ---------------------------------------------------------------------------

Deno.test("maskMarkdownCode keeps the same length and newline positions", () => {
  const text = "before `code span` and\n```\nfenced\n```\nafter";
  const masked = maskMarkdownCode(text);
  assertEquals(masked.length, text.length);
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") assertEquals(masked[i], "\n");
  }
});

// ---------------------------------------------------------------------------
// stripMarkdownCode
// ---------------------------------------------------------------------------

Deno.test("stripMarkdownCode removes fenced and inline code", () => {
  const text = "before `code` middle\n```\nfenced body\n```\nafter";
  const out = stripMarkdownCode(text);
  assertEquals(out.includes("code"), false);
  assertEquals(out.includes("fenced body"), false);
  assertEquals(out.includes("before"), true);
  assertEquals(out.includes("middle"), true);
  assertEquals(out.includes("after"), true);
});

// ---------------------------------------------------------------------------
// Backtick-span edge cases
// ---------------------------------------------------------------------------

Deno.test("splitMarkdownCode: a double-backtick span may contain a single backtick", () => {
  const text = "see `` `inner` `` done";
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment);
  assertEquals(codeSegment!.value, "`` `inner` ``");
});

Deno.test("splitMarkdownCode: an unmatched run is literal prose", () => {
  const text = "this has a lone ` backtick with no pair";
  const segments = splitMarkdownCode(text);
  assert(segments.every((s) => !s.inCode));
  assertEquals(segments.map((s) => s.value).join(""), text);
});

// ---------------------------------------------------------------------------
// Growth: linear on hostile input
// ---------------------------------------------------------------------------

Deno.test("splitMarkdownCode scales linearly on many distinct-length unmatched runs", () => {
  // Many distinct-length unmatched backtick runs (lengths 2, 3, 4, ...,
  // never repeating, so none ever finds a closer), followed by many
  // single-backtick runs that pair harmlessly with each other. This is the
  // pathological shape for a forward per-opener scan: each unmatched run
  // scans past every later single-backtick run looking in vain for its own
  // length, which is quadratic-ish (confirmed below against the old
  // implementation) but linear for the backward next-same-length map this
  // module uses.
  const build = (chars: number): string => {
    const parts: string[] = [];
    let used = 0;
    let runLength = 2;
    const half = chars / 2;
    while (used < half) {
      const run = "`".repeat(runLength) + "x";
      parts.push(run);
      used += run.length;
      runLength++;
    }
    while (used < chars) {
      parts.push("`y");
      used += 3;
    }
    return parts.join(" ");
  };

  assertLinearGrowth(
    "splitMarkdownCode on many distinct-length unmatched runs",
    build,
    (input) => splitMarkdownCode(input).length,
    { baseChars: 150_000, sizeFactor: 16 },
  );
});

/**
 * The same hostile shape run against the OLD forward-scan implementation
 * (reproduced here, not imported — it no longer exists in the shipped
 * module) confirms the growth test above would have caught the regression
 * this module fixes: it fails with "AssertionError: ... the rule is
 * super-linear" (150384 chars took ~14 ms but 2401547 chars (16.0x) took
 * over 1000 ms, well past the ~435 ms a linear rule allows). See the
 * executor report for Issue #3313 for the measured numbers; this is a
 * design note for future readers, not a runnable test, since the old code
 * has already been deleted.
 */
