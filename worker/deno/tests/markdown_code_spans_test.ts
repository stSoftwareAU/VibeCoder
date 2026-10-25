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

/**
 * Input size for the hang-sized tests (Issue #4312). A super-linear pattern at
 * this size needs on the order of 10^12 steps and never returns, so the
 * runner's own timeout is the detector. None of these tests reads a clock.
 */
const HANG_SIZE_CHARS = 1_200_000;

/**
 * Assert that `text` comes back as one prose segment holding all of it: the
 * shape the splitter yields for an input with no backtick, fence or code span.
 */
function assertHangSizedProse(text: string) {
  const segments = splitMarkdownCode(text);
  assertEquals(segments.map((s) => s.value).join(""), text);
  assertEquals(segments.filter((s) => s.inCode).length, 0);
  assertEquals(segments.length, 1);
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

// PR #3351 review: a paragraph previously only ended at a blank line, so a
// literal unmatched backtick in a list item, heading, or block quote paired
// with a backtick in a later block and hid the prose between them.

Deno.test("splitMarkdownCode resets an unclosed span at a new list item", () => {
  const text = "- item one has a lone ` backtick\n- item two has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across the list-item boundary",
  );
});

Deno.test("splitMarkdownCode resets an unclosed span at an ATX heading", () => {
  const text = "## heading has a lone ` backtick\nbody text has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across the heading boundary",
  );
});

Deno.test("splitMarkdownCode resets an unclosed span at a block quote", () => {
  const text = "plain text has a lone ` backtick\n> quoted has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across the block-quote boundary",
  );
});

Deno.test("splitMarkdownCode: a genuine span still pairs within one list item (look-alike)", () => {
  const text = "- see `docs` for details";
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment);
  assertEquals(codeSegment!.value, "`docs`");
});

// PR #3351 review (round 2): the block-start markers only matched indent
// 0-3; a 4-space (or deeper) nested list item, a GFM table row, and a
// setext/thematic-break line all failed to end the paragraph.

Deno.test("splitMarkdownCode resets an unclosed span at a 4-space nested list item", () => {
  const text =
    "    - item one has a lone ` backtick\n    - item two has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a deeply-indented list-item boundary",
  );
});

Deno.test("splitMarkdownCode resets an unclosed span at a tab-indented list item", () => {
  const text =
    "\t- item one has a lone ` backtick\n\t- item two has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a tab-indented list-item boundary",
  );
});

Deno.test("splitMarkdownCode resets an unclosed span at a table row", () => {
  const text = "| key | the ` key |\n| dep | has ` another one |";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a table-row boundary",
  );
});

Deno.test("splitMarkdownCode resets an unclosed span at a setext underline", () => {
  const text = "Handle the ` key\n---\nbody has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a setext-underline boundary",
  );
});

Deno.test("splitMarkdownCode resets an unclosed span at a thematic break", () => {
  const text = "intro has a lone ` backtick\n***\nbody has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a thematic-break boundary",
  );
});

// PR #3351 review (round 2): BLOCK_QUOTE_RE reset the paragraph on every
// `>` line, so a span could not wrap across two quoted lines even though
// CommonMark treats them as one quoted paragraph. A span wrapped across
// quoted lines must still pair, the same as it would unquoted.

Deno.test("splitMarkdownCode: a span still pairs across two consecutive block-quote lines", () => {
  const text = "> see `start of span\n> end of span` here";
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment, "expected an in-code segment spanning the quoted lines");
  assertEquals(codeSegment!.value, "`start of span\n> end of span`");
});

Deno.test("splitMarkdownCode still resets an unclosed span where a quote begins or ends", () => {
  const text = "plain text has a lone ` backtick\n> quoted has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across the quote-entry boundary",
  );
});

// PR #3351 review (round 3): the blank-line and block-start checks tested
// the raw `>`-prefixed line, so nothing inside a quote except leaving it
// ever ended a paragraph — a quoted blank line and a quoted list item,
// heading or table row never flushed, and the whole quote became one
// paragraph.

Deno.test("splitMarkdownCode resets an unclosed span at a quoted blank line", () => {
  const text = "> Handle the ` key in the parser\n>\n> see ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a quoted blank line",
  );
});

Deno.test("splitMarkdownCode resets an unclosed span at a quoted list item", () => {
  const text =
    "> - item one has a lone ` backtick\n> - item two has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a quoted list-item boundary",
  );
});

// PR #3351 review (round 4): the quote check tracked only *whether* a line
// was quoted, so a nested quote opening inside a quote (`> > ...` after
// `> ...`) did not end the outer quote's paragraph. Depth now matters: a
// change of depth ends the paragraph, the same depth still joins.

Deno.test("splitMarkdownCode resets an unclosed span where a nested quote opens", () => {
  const text = "> outer has a lone ` backtick\n> > nested has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a quote-depth increase",
  );
});

Deno.test("splitMarkdownCode resets an unclosed span where a nested quote closes", () => {
  const text = "> > nested has a lone ` backtick\n> outer has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a quote-depth decrease",
  );
});

Deno.test("splitMarkdownCode: a span still pairs across two lines at the same nested quote depth", () => {
  const text = "> > see `start of span\n> > end of span` here";
  const codeSegment = splitMarkdownCode(text).find((s) => s.inCode);
  assert(codeSegment, "expected an in-code segment spanning the nested lines");
  assertEquals(codeSegment!.value, "`start of span\n> > end of span`");
});

// PR #3351 review (round 3): a line starting an HTML comment (`<!--`) was
// not treated as a block start, so a stray backtick before it paired with
// a backtick in or after the comment.

Deno.test("splitMarkdownCode resets an unclosed span at an HTML comment line", () => {
  const text =
    "intro has a lone ` backtick\n<!-- a comment -->\nbody has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across an HTML-comment boundary",
  );
});

Deno.test("splitMarkdownCode resets an unclosed span at a multi-line HTML comment", () => {
  const text =
    "intro has a lone ` backtick\n<!-- a\nmulti-line comment -->\nbody has ` another one";
  const segments = splitMarkdownCode(text);
  assert(
    segments.every((s) => !s.inCode),
    "the backticks must not pair across a multi-line HTML-comment boundary",
  );
});

Deno.test("splitMarkdownCode: a stray backtick before an HTML comment does not pair into it", () => {
  // Without the comment boundary, the stray backtick before "backtick" would
  // pair with the backtick right before "lexer", masking the `<!--` marker
  // itself as code. With the boundary, the stray backtick stays unmatched
  // prose, and `lexer` pairs with itself inside the comment as intended.
  const text =
    'before has a lone ` backtick\n<!-- vibe-x reason="split `lexer`" -->';
  const segments = splitMarkdownCode(text);
  const codeSegment = segments.find((s) => s.inCode);
  assert(codeSegment, "expected the self-contained `lexer` span");
  assertEquals(codeSegment!.value, "`lexer`");
  assertEquals(segments.map((s) => s.value).join(""), text);
});

// ---------------------------------------------------------------------------
// parseFenceLine / isClosingFence (exported for blocked_outcome.ts)
// ---------------------------------------------------------------------------

Deno.test("parseFenceLine recognises a backtick and a tilde fence", () => {
  assertEquals(parseFenceLine("```js"), { char: "`", length: 3, rest: "js" });
  assertEquals(parseFenceLine("~~~~"), { char: "~", length: 4, rest: "" });
  assertEquals(parseFenceLine("not a fence"), null);
});

// PR #3351 review: `.` does not match a lone CR or a Unicode line/paragraph
// separator, so a `(.*)$` tail after the fence run backtracked through every
// run length on a line where one of those characters follows the run.
Deno.test("parseFenceLine reads the rest of the line through a lone CR", () => {
  const parsed = parseFenceLine("```\rjs");
  assertEquals(parsed, { char: "`", length: 3, rest: "\rjs" });
});

Deno.test("parseFenceLine finishes on a long run followed by a character `.` rejects (hang-sized input, Issue #4312)", () => {
  // A long backtick run followed by a lone CR and then more text: `.` cannot
  // cross the CR, so the old `(.*)$` tail backtracked the run length over and
  // over, re-scanning to the end of the line each time — quadratic in the run
  // length. At hang size that never returns, so the runner's timeout is the
  // detector; no clock is read. The CR must not be the line's last character
  // — `trim()` would strip it from the edge and hide the defect — so a
  // trailing "x" keeps it in the middle.
  const input = "`".repeat(HANG_SIZE_CHARS - 2) + "\rx";
  assertEquals(parseFenceLine(input), {
    char: "`",
    length: HANG_SIZE_CHARS - 2,
    rest: "\rx",
  });
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
// Hostile input: hang-sized where the output is pinned, growth where timed
// ---------------------------------------------------------------------------

Deno.test("splitMarkdownCode scales linearly on many distinct-length unmatched runs", () => {
  // Many distinct-length unmatched backtick runs (lengths 2, 3, 4, ...,
  // never repeating, so none ever finds a closer), followed by many
  // single-backtick runs that pair harmlessly with each other. This is the
  // pathological shape for a forward per-opener scan: each unmatched run
  // scans past every later single-backtick run looking in vain for its own
  // length, which costs about n^1.5 (sqrt(n) openers, each scanning about n
  // runs) but is linear for the backward next-same-length map this module
  // uses.
  //
  // This is the one stopwatch left in this file, and the reason the file stays
  // in WALL_CLOCK_TEST_FILES (Issue #4312). It cannot be made hang-sized: the
  // openers are distinct-length, so there are at most about sqrt(2n) of them,
  // and an n^1.5 scan finishes at 1.2M chars well inside a runner timeout.
  // Only growth can see it. The allowance is 2 x sizeFactor x the base time,
  // so a linear rule at 64x (ratio 64) is held to 128, while the n^1.5 scan
  // (ratio 64^1.5 = 512) is four times over; at the old 16x it was 64 against
  // an allowance of 32, twice over. The larger factor widens the gap the test
  // can see, not the 2x slack on the linear side.
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
    { baseChars: 150_000, sizeFactor: 64, repeats: 3 },
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

// PR #3351 review (round 2): hostile cases for the block-start markers
// widened from `^ {0,3}` to `^[ \t]*`, and for the new table-row /
// setext-or-thematic-break patterns — one per pattern, as
// "Vet every regex on untrusted text" (CODING-STANDARDS.md) requires.

Deno.test("splitMarkdownCode finishes on a long non-matching indent before an ATX/list/table probe (hang-sized input, Issue #4312)", () => {
  // Many leading spaces then a character none of ATX_HEADING_RE,
  // LIST_ITEM_RE or TABLE_ROW_RE accept: each pattern's widened `[ \t]*`
  // prefix must fully unwind without ever finding a match, on every line.
  // A super-linear prefix never returns at this size, so the runner's timeout
  // is the detector and no clock is read. The assertion pins what the code
  // yields: one prose segment holding the whole input.
  assertHangSizedProse(`${" ".repeat(HANG_SIZE_CHARS - 1)}x`);
});

Deno.test("splitMarkdownCode finishes on a long block-quote-marker run (hang-sized input, Issue #4312)", () => {
  // Many leading spaces before `>`: QUOTE_PREFIX_RE's widened `[ \t]*` prefix
  // must match without backtracking on every line. A super-linear match never
  // returns at this size, so the runner's timeout is the detector and no clock
  // is read. The assertion pins one prose segment for the whole input.
  assertHangSizedProse(`${" ".repeat(HANG_SIZE_CHARS - 1)}>`);
});

Deno.test("splitMarkdownCode finishes on a long dash run rejected by a trailing character (hang-sized input, Issue #4312)", () => {
  // SETEXT_OR_THEMATIC_BREAK_RE's `\1*` backtracks down a long matching run
  // once, and the disjoint trailing `[ \t]*$` never re-matches the same
  // characters as `\1*` — so a long run of `-` followed by a rejecting
  // character stays linear rather than quadratic. A quadratic backtrack never
  // returns at this size, so the runner's timeout is the detector and no clock
  // is read. The assertion pins one prose segment for the whole input.
  assertHangSizedProse(`${"-".repeat(HANG_SIZE_CHARS - 1)}x`);
});

// PR #3351 review (round 3): QUOTE_PREFIX_RE's outer `+` repeats a group
// that must itself consume a `>` each time — a long run of `>` markers with
// no separating spaces must still unwind in one linear pass per line.
Deno.test("splitMarkdownCode finishes on a long block-quote-prefix run (hang-sized input, Issue #4312)", () => {
  // A quadratic match never returns at this size, so the runner's timeout is
  // the detector and no clock is read. The assertion pins one prose segment
  // for the whole input.
  assertHangSizedProse(`${">".repeat(HANG_SIZE_CHARS - 1)}x`);
});
