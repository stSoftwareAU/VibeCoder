/**
 * Tests for the removal-aware docs sweep (Issue #2952).
 *
 * Fleet PRs that removed or changed behaviour left docs/ manuals stale
 * because the docs step only covered additions — "update README.md or other
 * documentation if your changes ... add new features" never told agents to
 * check for stale wording describing behaviour that no longer exists. The
 * `issue` (and `pr_feedback`) templates now require a removal-aware docs
 * sweep before committing, and a one-line **Docs sweep** entry in the PR
 * summary recording the grep terms and the doc files updated (or `no hits`).
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

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

Deno.test("issue - step 3 owes a docs change for additions, changes and removals", async () => {
  const body = normalise(await load("issue"));

  for (
    const required of [
      "adds, changes or removes",
      "a code change owes a docs change",
      "excluding `docs/archive/`",
      "`*/readme.md`",
      "user-visible wording",
      "fix every hit",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("issue - PR summary requires a Docs sweep line", async () => {
  const body = normalise(await load("issue"));

  assertStringIncludes(body, "**docs sweep**");
  assertStringIncludes(body, "`no hits`");
});

Deno.test("pr_feedback - a fix runs the same docs sweep", async () => {
  const body = normalise(await load("pr_feedback"));

  for (
    const required of [
      "adds, changes or removes",
      "a code change owes a docs change",
      "excluding `docs/archive/`",
      "user-visible wording",
      "**docs sweep**",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});
