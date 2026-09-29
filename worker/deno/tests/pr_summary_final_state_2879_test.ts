/**
 * Tests for the PR summary final-state rule (Issue #2879).
 *
 * The worker used to commit a stale `docs/archive/pr-summaries/pr-summary-
 * <issue>.md` — also the PR body — that described an earlier iteration of
 * the branch rather than its head commit. Issue #2879 added an explicit
 * final-state rule to the `issue` template (write the summary last, rewrite
 * rather than append when a later commit changes what the PR does) and a
 * matching "keep the PR summary true to the head" instruction to the
 * `pr_feedback` and `ci_fix` templates, so a commit made after independent
 * review or a CI retry refreshes the summary instead of leaving it stale.
 *
 * The assertions run against the current templates, so a later edit that
 * drops the rule fails in CI.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function load(type: string): Promise<string> {
  const result = await loadPrompt(type, PROMPTS_DIR);
  assertEquals(result.ok, true, `${type} failed to load`);
  if (!result.ok) throw new Error(`${type} failed to load`);
  return result.value;
}

function lower(text: string): string {
  return text.toLowerCase();
}

Deno.test("issue - requires the PR summary to describe the final state of the branch", async () => {
  const body = lower(await load("issue"));

  for (
    const required of [
      "final state of the branch",
      "rewrite it, never append",
      "git diff <base>...head",
      "known defect",
      "interim notes",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

for (const type of ["pr_feedback", "ci_fix"]) {
  Deno.test(`${type} - keeps the PR summary true to the head`, async () => {
    const body = lower(await load(type));

    for (
      const required of [
        "keep the pr summary true to the head",
        "docs/archive/pr-summaries/pr-summary-*.md",
        "same push",
        "known defect",
      ]
    ) {
      assertStringIncludes(body, required);
    }
  });
}
