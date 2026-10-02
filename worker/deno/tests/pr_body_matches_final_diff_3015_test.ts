/**
 * Tests for the PR-body-matches-final-diff rule (Issue #3015).
 *
 * Issue #2879 made the PR summary describe the final state of the branch
 * rather than the history of the run. That was not enough: a PR body could
 * still describe work the final head no longer contained — a merge from the
 * base branch superseded the fix, or an abandoned design iteration's
 * description survived into the summary — because "the change exists at the
 * head" is not the same claim as "the change is in this PR's own diff".
 * Issue #3015 ties the Summary, Evidence and Acceptance Criteria sections to
 * `git diff <base>...HEAD` directly: every file or behaviour the body claims
 * must appear in that diff, and a body that contradicts the diff is a
 * blocking self-review finding, across the `issue`, `pr_feedback`, `ci_fix`
 * and `merge_conflict` templates and `CODING-STANDARDS.md`.
 *
 * The assertions run against the current templates, so a later edit that
 * drops the rule fails in CI.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

async function load(type: string): Promise<string> {
  const result = await loadPrompt(type, PROMPTS_DIR);
  assertEquals(result.ok, true, `${type} failed to load`);
  if (!result.ok) throw new Error(`${type} failed to load`);
  return result.value;
}

/** Flatten whitespace so a line wrap does not break a substring match. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ");
}

Deno.test("Issue #3015 - issue prompt re-derives the PR summary from the final diff", async () => {
  const body = await load("issue");

  for (
    const required of [
      "must appear in `git diff <base>...HEAD`",
      "a merge from the base branch",
      "abandoned",
      "A body that contradicts the diff",
      "blocking self-review finding",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

for (const type of ["pr_feedback", "ci_fix"]) {
  Deno.test(`Issue #3015 - ${type} ties the PR summary to the final diff`, async () => {
    const body = await load(type);

    for (
      const required of [
        "must appear in that diff",
        "abandoned iteration",
        "base-branch merge",
      ]
    ) {
      assertStringIncludes(body, required);
    }
  });
}

Deno.test("Issue #3015 - merge_conflict keeps the PR summary true to the head", async () => {
  const body = await load("merge_conflict");

  for (
    const required of [
      "Keep the PR summary true to the head",
      "git diff <base>...HEAD",
      "superseded",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("Issue #3015 - CODING-STANDARDS.md ties the PR summary to the final diff", async () => {
  const standards = normalise(
    await Deno.readTextFile(`${REPO_ROOT}CODING-STANDARDS.md`),
  );

  for (
    const required of [
      "must appear in `git diff <base>...HEAD`",
      "A summary that contradicts the diff is a blocking self-review finding",
      "merge-conflict run",
    ]
  ) {
    assertStringIncludes(standards, required);
  }
});
