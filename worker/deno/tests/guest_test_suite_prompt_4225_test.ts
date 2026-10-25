/**
 * The one instruction for how a coding agent runs a test suite (Issue #4225).
 *
 * The merge-conflict template, the issue prompt's pre-PR validation, and
 * the coding-guidelines targeted-test section each state it. A second
 * wording would be the drift this test fails on.
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assertStringIncludes } from "@std/assert";

const REPO = new URL("../../../", import.meta.url).pathname;

const SENTENCE =
  "run one test suite at a time, in the foreground, never with `run_in_background`, and only for the crates or packages the change touched";

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

Deno.test("guest test suites are one at a time, in the foreground, and scoped to the touched crates (Issue #4225)", async () => {
  for (
    const path of [
      "prompts/merge_conflict/prompt.md",
      "prompts/issue/prompt.md",
      "prompts/coding_guidelines/prompt.md",
    ]
  ) {
    const text = flatten(await Deno.readTextFile(`${REPO}${path}`));
    assertStringIncludes(text, SENTENCE, path);
  }
});
