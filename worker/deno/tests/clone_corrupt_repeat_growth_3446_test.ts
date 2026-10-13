/**
 * Growth guard for the line-anchored `clone-corrupt-repeat` regex (Issue
 * #3446).
 *
 * The release path scans setup failure messages, which quote git output, for
 * the worker's own `clone-corrupt-repeat: {json}` line. Only a growth
 * measurement separates a linear scan from a backtracking one on hostile
 * input, so this lives in its own wall-clock test file.
 */

import { assertEquals } from "@std/assert";
import { parseCloneCorruptRepeat } from "../lib/corrupt_clone_recovery.ts";
import { assertLinearGrowth } from "./support/growth.ts";

Deno.test("parseCloneCorruptRepeat - hostile unterminated payload lines grow linearly (Issue #3446)", () => {
  for (
    const build of [
      (chars: number) =>
        ("clone-corrupt-repeat: {" + "x".repeat(50) + "\n").repeat(
          Math.ceil(chars / 74),
        ),
      (chars: number) => "clone-corrupt-repeat: {" + "x".repeat(chars),
    ]
  ) {
    const result = assertLinearGrowth(
      "parseCloneCorruptRepeat, hostile unterminated payloads",
      build,
      parseCloneCorruptRepeat,
      { baseChars: 10_000 },
    );
    assertEquals(result, null);
  }
});
