/**
 * Tests for lib/launcher_source.ts — comment stripping per launcher dialect
 * (Issues #4147, #4). The contract judges host-execution markers on the
 * executable lines only, so a comment naming `run-entrypoint` must vanish
 * while parameter expansion and code survive.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import { executableLines } from "../lib/launcher_source.ts";

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

Deno.test("executableLines - strips bash comments but keeps parameter expansion", () => {
  assertEquals(
    executableLines(
      [
        "# native mode lives here",
        'echo "${PATH#/usr}" # trailing note',
        "run_it",
      ].join("\n"),
      "bash",
    ),
    ["", 'echo "${PATH#/usr}" ', "run_it"],
  );
});

Deno.test("executableLines - strips PowerShell line and block comments", () => {
  assertEquals(
    executableLines(
      [
        "<#",
        ".SYNOPSIS",
        "    A block comment mentioning native { braces }",
        "#>",
        "$RunMode = 'container' # trailing note",
      ].join("\n"),
      "powershell",
    ),
    ["", "", "", "", "$RunMode = 'container' "],
  );
});
