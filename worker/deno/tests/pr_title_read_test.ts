/**
 * Tests for the PR-title read behind the Graft query (Issue #2103).
 *
 * The title is one `gh pr view --json title`, and every one of its failure
 * modes is reported rather than papered over: a throwing `gh`, and a call that
 * exits cleanly having printed nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readPrTitle } from "../lib/pr_title_read.ts";

Deno.test("readPrTitle - returns the trimmed title and asks gh for it once", async () => {
  const calls: string[][] = [];
  const result = await readPrTitle("org/repo", 42, (args: string[]) => {
    calls.push(args);
    return Promise.resolve("Fix the date parser\n");
  });

  assert(result.ok);
  assertEquals(result.value, "Fix the date parser");
  assertEquals(calls.length, 1);
  assertEquals(calls[0], [
    "pr",
    "view",
    "42",
    "--repo",
    "org/repo",
    "--json",
    "title",
    "--jq",
    ".title",
  ]);
});

Deno.test("readPrTitle - a throwing gh is reported, not swallowed", async () => {
  const result = await readPrTitle(
    "org/repo",
    42,
    () => Promise.reject(new Error("gh: HTTP 403")),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "org/repo#42");
    assertStringIncludes(result.error.message, "gh: HTTP 403");
  }
});

Deno.test("readPrTitle - an empty answer is a failure, never an empty title", async () => {
  // A blank stdout would otherwise hand Graft a query missing half its terms.
  for (const answer of ["", "   \n"]) {
    const result = await readPrTitle(
      "org/repo",
      42,
      () => Promise.resolve(answer),
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "returned nothing");
    }
  }
});
