/**
 * Growth bounds for the grill-me stall guard's stem normalisation
 * (Issue #2183).
 *
 * `normaliseQuestionStem` strips trailing punctuation with an unanchored
 * `[class]+$`. The regex engine retries that match at every start offset, so a
 * long run of class characters that does **not** reach the end of the string
 * costs one scan per offset — quadratic. The delta sweep of ledger slices
 * 12d–12f measured 18 ms at 5 000 characters and 695 ms at 40 000, a ratio of
 * roughly 13x for a 4x input, well past the 8x a linear rule is allowed.
 *
 * The input is attacker-supplied: round comments are collected by heading
 * marker with no author gate (`carriesRoundMarker`, deliberately so since
 * Issue #1560), a GitHub comment body runs to 65 536 characters, and every
 * round is re-normalised on each grill-me pass.
 *
 * Measured by shape, never against a wall-clock constant — a slower host
 * inflates both readings and the ratio is unchanged (Issue #530).
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

/** The same shape in whitespace, which the `\s+` collapse does not remove. */
function whitespaceRun(n: number): string {
  return `a${" ".repeat(n)}x`;
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

Deno.test("normaliseQuestionStem - a hostile space run scales linearly (Issue #2183)", () => {
  assertLinearGrowth(
    "grill-me stem normalisation, whitespace run",
    (chars) => whitespaceRun(chars),
    (input) => normaliseQuestionStem(input),
    { baseChars: 10_000 },
  );
});

Deno.test("normaliseQuestionStem - trailing punctuation is still stripped (Issue #2183)", () => {
  assertEquals(
    normaliseQuestionStem("What is the stop rule?!…  "),
    "what is the stop rule",
    "the strip must keep working after the bound is imposed",
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
