/**
 * Growth bound for the `/Error:(?!:)/` catch-all in `detectFailureCategory`
 * (Issue #3431). Registered in `WALL_CLOCK_TEST_FILES` so it runs in the
 * serial pass; measured by shape, never against a wall-clock constant.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import { assertLinearGrowth } from "./support/growth.ts";

Deno.test("detectFailureCategory - hostile colon runs classify in linear time (Issue #3431)", () => {
  for (
    const build of [
      (chars: number) => "AppError" + ":".repeat(chars) + "x",
      (chars: number) => "Error:".repeat(Math.ceil(chars / 6)),
    ]
  ) {
    assertLinearGrowth(
      "detectFailureCategory, hostile Error: runs",
      build,
      detectFailureCategory,
      { baseChars: 10_000 },
    );
  }
  assertEquals(
    detectFailureCategory("AppError" + ":".repeat(50_000) + "x") ===
      "internal_error",
    false,
  );
  assertEquals(
    detectFailureCategory("Error:".repeat(20_000)),
    "internal_error",
  );
});
