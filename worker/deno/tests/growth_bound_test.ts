/**
 * Tests for the shape-based super-linearity detector (Issue #530).
 *
 * The detector replaces absolute wall-clock bounds in unit tests, so the two
 * properties that matter are: a uniformly slower host must stay green, and a
 * genuinely super-linear rule must still fail loudly. Both are asserted here
 * against a fake clock, so the tests themselves carry no timing dependency,
 * plus one end-to-end case driving real quadratic work.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { AssertionError } from "@std/assert";
import {
  assertLinearGrowth,
  exceedsGrowthBound,
  growthAllowanceMs,
  measureGrowth,
} from "./support/growth.ts";

/** A clock returning the supplied readings in order. */
function fakeClock(readings: number[]): () => number {
  let index = 0;
  return () => {
    const value = readings[index++];
    if (value === undefined) throw new Error("fake clock ran out of readings");
    return value;
  };
}

Deno.test("growthAllowanceMs - a linear run may take slack x the size factor", () => {
  assertEquals(growthAllowanceMs(100, 4, { slack: 2, graceMs: 0 }), 800);
});

Deno.test("growthAllowanceMs - the grace is a floor, not a ceiling", () => {
  // Tiny base measurement: the grace dominates.
  assertEquals(growthAllowanceMs(0.5, 4, { slack: 2, graceMs: 50 }), 50);
  // Large base measurement: the proportional allowance dominates.
  assertEquals(growthAllowanceMs(500, 4, { slack: 2, graceMs: 50 }), 4000);
});

Deno.test("growthAllowanceMs - rejects nonsensical inputs loudly", () => {
  assertThrows(() => growthAllowanceMs(-1, 4), RangeError, "baseMs");
  assertThrows(() => growthAllowanceMs(10, 1), RangeError, "sizeFactor");
  assertThrows(() => growthAllowanceMs(10, NaN), RangeError, "sizeFactor");
  assertThrows(
    () => growthAllowanceMs(10, 4, { slack: 0.5 }),
    RangeError,
    "slack",
  );
  assertThrows(
    () => growthAllowanceMs(10, 4, { graceMs: -1 }),
    RangeError,
    "graceMs",
  );
  assertThrows(() => exceedsGrowthBound(10, -5, 4), RangeError, "scaledMs");
});

Deno.test("exceedsGrowthBound - a uniformly slower host is not a regression", () => {
  // The same linear shape measured on hosts 1x, 10x and 100x slower: the
  // ratio never changes, so none of them is reported as super-linear. This
  // is the Issue #530 failure an absolute 2000 ms bound produced.
  for (const hostFactor of [1, 10, 100]) {
    assertEquals(
      exceedsGrowthBound(250 * hostFactor, 1_050 * hostFactor, 4),
      false,
      `a host ${hostFactor}x slower must not fail a linear rule`,
    );
  }
});

Deno.test("exceedsGrowthBound - quadratic growth still fails loudly", () => {
  // Quadratic costs sizeFactor squared: 4x the input, 16x the time.
  assertEquals(exceedsGrowthBound(250, 4_000, 4), true);
  // And it fails on a fast host too, where the absolute numbers are small.
  assertEquals(exceedsGrowthBound(30, 480, 4, { graceMs: 20 }), true);
});

Deno.test("exceedsGrowthBound - noise below the grace is never a regression", () => {
  // 0.4 ms to 6 ms is a 15x ratio, but both readings are scheduler noise.
  assertEquals(exceedsGrowthBound(0.4, 6, 4, { graceMs: 50 }), false);
});

Deno.test("exceedsGrowthBound - the allowance boundary is exclusive", () => {
  assertEquals(exceedsGrowthBound(100, 800, 4, { graceMs: 0 }), false);
  assertEquals(exceedsGrowthBound(100, 800.1, 4, { graceMs: 0 }), true);
});

Deno.test("measureGrowth - reports the measured pair and a linear verdict", () => {
  // repeats = 1: one reading pair per size.
  const m = measureGrowth(
    (chars) => "a".repeat(chars),
    (input) => input.length,
    {
      baseChars: 1_000,
      sizeFactor: 4,
      repeats: 1,
      graceMs: 0,
      now: fakeClock([0, 200, 1_000, 1_900]),
    },
  );
  assertEquals(m.baseChars, 1_000);
  assertEquals(m.scaledChars, 4_000);
  assertEquals(m.sizeFactor, 4);
  assertEquals(m.baseMs, 200);
  assertEquals(m.scaledMs, 900);
  assertEquals(m.allowedMs, 1_600);
  assertEquals(m.superLinear, false);
  assertEquals(m.output, 4_000);
});

Deno.test("measureGrowth - keeps the fastest of the repeated runs", () => {
  // Two readings per size; the second base run is descheduled for 900 ms and
  // must be discarded in favour of the 100 ms one.
  const m = measureGrowth(
    (chars) => "a".repeat(chars),
    (input) => input.length,
    {
      baseChars: 100,
      sizeFactor: 4,
      repeats: 2,
      graceMs: 0,
      now: fakeClock([0, 100, 100, 1_000, 1_000, 1_500, 1_500, 1_900]),
    },
  );
  assertEquals(m.baseMs, 100);
  assertEquals(m.scaledMs, 400);
  assertEquals(m.superLinear, false);
});

Deno.test("measureGrowth - uses the built lengths, not the requested sizes", () => {
  // A ragged builder rounds down to whole units, so the actual factor differs
  // from the requested one and the allowance must follow the actual factor.
  const unit = "x".repeat(30) + "\n";
  const m = measureGrowth(
    (chars) => unit.repeat(Math.floor(chars / unit.length)),
    (input) => input.length,
    {
      baseChars: 100,
      sizeFactor: 4,
      repeats: 1,
      graceMs: 0,
      now: fakeClock([0, 10, 10, 40]),
    },
  );
  assertEquals(m.baseChars, 93);
  assertEquals(m.scaledChars, 372);
  assertEquals(m.sizeFactor, 4);
  assertEquals(m.superLinear, false);
});

Deno.test("measureGrowth - rejects nonsensical sizes and repeats loudly", () => {
  const noop = (input: string) => input.length;
  assertThrows(
    () => measureGrowth((c) => "a".repeat(c), noop, { baseChars: 0 }),
    RangeError,
    "baseChars",
  );
  assertThrows(
    () =>
      measureGrowth((c) => "a".repeat(c), noop, {
        baseChars: 10,
        repeats: 0,
      }),
    RangeError,
    "repeats",
  );
  assertThrows(
    () => measureGrowth(() => "", noop, { baseChars: 10 }),
    RangeError,
    "empty base input",
  );
});

Deno.test("assertLinearGrowth - returns the scaled output when growth is linear", () => {
  const out = assertLinearGrowth(
    "linear work",
    (chars) => "a".repeat(chars),
    (input) => input.toUpperCase(),
    {
      baseChars: 10,
      sizeFactor: 4,
      repeats: 1,
      graceMs: 0,
      now: fakeClock([0, 5, 5, 25]),
    },
  );
  assertEquals(out, "A".repeat(40));
});

Deno.test("assertLinearGrowth - names the shape and both measurements when it fails", () => {
  const error = assertThrows(
    () =>
      assertLinearGrowth(
        "quadratic work",
        (chars) => "a".repeat(chars),
        (input) => input.length,
        {
          baseChars: 1_000,
          sizeFactor: 4,
          repeats: 1,
          graceMs: 0,
          now: fakeClock([0, 100, 100, 1_700]),
        },
      ),
    AssertionError,
    "quadratic work",
  );
  const message = (error as AssertionError).message;
  assert(message.includes("1600 ms"), `missing scaled reading: ${message}`);
  assert(message.includes("super-linear"), `missing verdict: ${message}`);
});

Deno.test("assertLinearGrowth - catches genuinely quadratic work on a real clock", () => {
  // Nested scan over the input: 4x the characters costs ~16x the time on any
  // host, so the detector fires without an absolute budget anywhere in it.
  const quadratic = (input: string): number => {
    let hits = 0;
    for (let i = 0; i < input.length; i++) {
      for (let j = 0; j < input.length; j++) if (input[i] === input[j]) hits++;
    }
    return hits;
  };
  assertThrows(
    () =>
      assertLinearGrowth(
        "nested scan",
        (chars) => "ab".repeat(chars / 2),
        quadratic,
        { baseChars: 2_000, sizeFactor: 4, repeats: 1, graceMs: 5 },
      ),
    AssertionError,
    "super-linear",
  );
});
