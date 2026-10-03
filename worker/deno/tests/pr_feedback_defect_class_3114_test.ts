/**
 * Tests for the "defect as a class" rule (Issue #3114).
 *
 * Review-fix runs repeatedly fixed only the locations a finding listed and
 * left other instances of the same defect class live in the head — other
 * builders of the same shape, the other order of a race, later iterations
 * of the same loop, and the same claim repeated in test names — so the
 * re-review raised the finding again as only partly fixed
 * (VibeCoder#3066, #3068, #3065, GRQ-AutoTrader#2210, #2220). Issue #3114
 * extends the Issue #3086 rule to require stating the defect as a class and
 * checking every other instance of that class, not only the one the finding
 * named.
 *
 * The assertions run against the current template, so a later edit that
 * drops the rule fails in CI.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("pr_feedback - states the defect as a class and checks every other instance of it", async () => {
  const body = lower(await load("pr_feedback"));

  const marker =
    "**fix the defect everywhere it lives, not only where the finding points.**";
  const start = body.indexOf(marker);
  assert(start !== -1, "expected the 'fix the defect everywhere' paragraph");
  const end = body.indexOf("\n\n", start);
  const paragraph = end === -1 ? body.slice(start) : body.slice(start, end);

  for (
    const required of [
      "a finding's locations are examples, not the list",
      "state the defect as a class",
      "every caller or builder of the same shape",
      "test names",
      "walk each order of the parties, not only the one the reviewer described",
      "every window between their steps",
      "every later iteration of the same loop",
      "fix each instance or rebut it with the reason",
      "what you searched and which other instances you fixed",
      "another instance of the class left in the head is a blocking self-review finding",
    ]
  ) {
    assertStringIncludes(paragraph, required);
  }
});

Deno.test("pr_feedback - Change Scope names another caller and another order of the same race", async () => {
  const body = lower(await load("pr_feedback"));

  const start = body.indexOf("## change scope");
  assert(start !== -1, "expected a '## Change Scope' section");
  const next = body.indexOf("\n## ", start + 1);
  const section = next === -1 ? body.slice(start) : body.slice(start, next);

  for (
    const required of [
      "another caller of the same shape",
      "another order of the same race",
    ]
  ) {
    assertStringIncludes(section, required);
  }
});

Deno.test("pr_feedback - the reply names which other instances were fixed", async () => {
  const body = lower(await load("pr_feedback"));

  assertStringIncludes(
    body,
    "for each finding the other paths and copies you checked and which other instances you fixed",
  );
});
