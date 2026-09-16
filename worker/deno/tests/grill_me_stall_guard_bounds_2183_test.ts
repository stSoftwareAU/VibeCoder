/**
 * Growth bounds for the grill-me stall guard's stem normalisation
 * (Issue #2183).
 *
 * `normaliseQuestionStem` stripped trailing punctuation with an unanchored
 * `[class]+$`. The regex engine retries that match at every start offset, so a
 * long run of class characters that does **not** reach the end of the string
 * costs one scan per offset — quadratic. The delta sweep of ledger slices
 * 12d–12f measured the pre-fix code at 43 ms for 10 000 characters against
 * 695 ms for 40 000: a 4x input costing 16x, well past the 8x a linear rule is
 * allowed.
 *
 * The input is attacker-supplied. Round comments are collected by heading
 * marker with no author gate (`carriesRoundMarker`, deliberately so since
 * Issue #1560), a GitHub comment body runs to 65 536 characters, and every
 * round is re-normalised on each grill-me pass.
 *
 * Measured by shape, never against a wall-clock constant — a slower host
 * inflates both readings and the ratio is unchanged (Issue #530). The file is
 * registered in `WALL_CLOCK_TEST_FILES` so it runs in the serial pass.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  isRoundStalled,
  normaliseQuestionStem,
} from "../lib/grill_me_stall_guard.ts";
import { assertLinearGrowth } from "./support/growth.ts";

/**
 * A stem whose trailing-punctuation run never reaches the end: `n` full stops
 * followed by one ordinary character, so every start offset fails at `$`.
 */
function punctuationRun(n: number): string {
  return `a${".".repeat(n)}x`;
}

Deno.test("normaliseQuestionStem - a hostile punctuation run scales linearly (Issue #2183)", () => {
  const normalised = assertLinearGrowth(
    "grill-me stem normalisation, punctuation run",
    (chars) => punctuationRun(chars),
    (input) => normaliseQuestionStem(input),
    { baseChars: 10_000 },
  );
  // The trailing `x` is not punctuation, so nothing is stripped.
  assertEquals(
    normalised,
    punctuationRun(40_000),
    "a run that does not reach the end is left intact",
  );
});

Deno.test("normaliseQuestionStem - a whitespace run is collapsed, never walked (Issue #2183)", () => {
  // Recorded so a later reader does not add a growth case for whitespace: the
  // `\s+` collapse runs first, so a space run never reaches the strip and was
  // never the hostile shape. Punctuation has no such collapse, which is why
  // the punctuation run above is the one that had to be measured.
  assertEquals(
    normaliseQuestionStem(`a${" ".repeat(10_000)}x`),
    "a x",
    "a whitespace run collapses to one space before the strip",
  );
});

Deno.test("normaliseQuestionStem - trailing punctuation is still stripped (Issue #2183)", () => {
  assertEquals(
    normaliseQuestionStem("What is the stop rule?!…  "),
    "what is the stop rule",
    "the strip must keep working after the rewrite",
  );
  assertEquals(
    normaliseQuestionStem("...."),
    "",
    "an all-punctuation stem normalises away entirely",
  );
});

Deno.test("isRoundStalled - a hostile round body scales linearly (Issue #2183)", () => {
  const stalled = assertLinearGrowth(
    "grill-me stall guard, hostile round body",
    (chars) =>
      `## Grill-Me Round 2\n\n### Questions\n\n1. ${punctuationRun(chars)}\n`,
    (body) => isRoundStalled(["## Grill-Me Round 1\n", body]),
    { baseChars: 10_000 },
  );
  assertEquals(
    stalled,
    false,
    "a stem the earlier round never asked is not a stall",
  );
});
