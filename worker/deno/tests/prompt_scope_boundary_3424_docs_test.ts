/**
 * Tests that each mode prompt states its run's scope right under its mode
 * heading (Issue #3424), so the boundary is read before the rules.
 *
 * Runs drifted past their scope: `pr_feedback` fixes patched only the named
 * sentence (stSoftwareAU/VibeCoder#3075) and rewrote a PR summary's scope (#3143);
 * `ci_fix` runs deleted an unrelated CodeQL workflow (TagsTS#88), loosened
 * an unrelated smoke test (#3478) and rewrote a shared sentinel rule
 * (GRQ-AutoTrader#2699). The `issue` prompt points to its existing Change
 * Scope section instead of restating it.
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

/** Lowercased, whitespace-normalised text from `heading` to the next `## `. */
function openingBlock(body: string, heading: string): string {
  const start = body.indexOf(heading);
  assert(start >= 0, `heading not found: ${heading}`);
  const end = body.indexOf("\n## ", start + heading.length);
  const block = end === -1 ? body.slice(start) : body.slice(start, end);
  return lower(block).replace(/\s+/g, " ");
}

Deno.test("pr_feedback - states the run's scope under its mode heading", async () => {
  const block = openingBlock(
    await load("pr_feedback"),
    "## PR Feedback Mode",
  );
  for (
    const required of [
      "**this run's scope.** this run answers the review comments on this pr",
      "every other instance of the same defect",
      "only where this push made it false",
      "keeps the scope that summary states",
      "mentions in passing goes to a follow-up issue",
    ]
  ) {
    assertStringIncludes(block, required, `pr_feedback scope: ${required}`);
  }
});

Deno.test("ci_fix - states the run's scope under its mode heading", async () => {
  const block = openingBlock(await load("ci_fix"), "## CI Fix Mode");
  for (
    const required of [
      "**this run's scope.** this run fixes the one failing check it was started for",
      "reported in `.pr_response_message` and left as it is",
      "only as far as that fix needs",
      "two sections below set their own scope",
    ]
  ) {
    assertStringIncludes(block, required, `ci_fix scope: ${required}`);
  }
});

Deno.test("issue - points to Change Scope under its mode heading", async () => {
  const block = openingBlock(
    await load("issue"),
    "## Issue Implementation Mode",
  );
  assertStringIncludes(
    block,
    "**this run's scope** is what the issue asks, as **change scope** below defines it",
    "issue prompt must point to Change Scope right under its mode heading",
  );
});
