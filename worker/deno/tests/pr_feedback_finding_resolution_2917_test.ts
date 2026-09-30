/**
 * Tests for the change-request finding resolution rule (Issue #2917).
 *
 * PR-feedback runs used to leave `CHANGES_REQUESTED` findings unfixed —
 * parked in the PR summary as a "known limitation" or "follow-up", or fixed
 * only in the local worktree and never pushed, then reported to the
 * reviewer as "addressed". Issue #2917 added an explicit rule to the
 * `pr_feedback` template requiring every finding to end fixed (and pushed)
 * or rebutted, and requiring the fix to be confirmed on the remote before
 * the reply claims it is addressed.
 *
 * The assertions run against the current template, so a later edit that
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

Deno.test("pr_feedback - requires every change-request finding to end fixed or rebutted", async () => {
  const body = lower(await load("pr_feedback"));

  for (
    const required of [
      "every change-request finding ends fixed or rebutted",
      "commit pushed to this pr's branch",
      "rebutted",
      "known limitation",
      "open violation",
      "delete that text in the same push",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("pr_feedback - requires the fix to be on the remote before replying addressed", async () => {
  const body = lower(await load("pr_feedback"));

  for (
    const required of [
      "confirm the fix is on the remote",
      "git fetch origin <branch>",
      "git merge-base --is-ancestor",
      "only in the local worktree",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});
