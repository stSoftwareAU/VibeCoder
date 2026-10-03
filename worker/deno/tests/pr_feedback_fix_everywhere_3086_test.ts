/**
 * Tests for the "fix the defect everywhere it lives" rule (Issue #3086).
 *
 * Fleet review fixes repeatedly patched only the spot a finding named —
 * leaving the same defect live on other code paths into the same state, or
 * the same stale claim repeated in other copies such as the PR title or the
 * archived PR summary (GRQ-AutoTrader#2279, #2227, VibeCoder#3071). Issue
 * #3086 added an explicit rule to the `pr_feedback` template requiring the
 * fix to cover every other path or copy that shares the defect, not only
 * the one the finding pointed at.
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

Deno.test("pr_feedback - fixes the defect everywhere it lives, not only where the finding points", async () => {
  const body = lower(await load("pr_feedback"));

  for (
    const required of [
      "fix the defect everywhere it lives, not only where the finding points",
      "the outcome the finding protects",
      "other code paths into the same state",
      "the pr title as well as the body",
      "the archived pr summary",
      "not the unrelated edits the scope rule excludes",
      "obvious variants",
      "which other paths or copies you checked",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("pr_feedback - Change Scope counts every other instance as needed to resolve the finding", async () => {
  const body = lower(await load("pr_feedback"));

  const start = body.indexOf("## change scope");
  assert(start !== -1, "expected a '## Change Scope' section");
  const next = body.indexOf("\n## ", start + 1);
  const section = next === -1 ? body.slice(start) : body.slice(start, next);

  for (
    const required of [
      "every other instance of the defect a finding names",
      "counts as what is needed to resolve them",
    ]
  ) {
    assertStringIncludes(section, required);
  }
});

Deno.test("pr_feedback - the 'nothing more' rule defers to fixing the defect everywhere", async () => {
  const body = lower(await load("pr_feedback"));

  assertStringIncludes(
    body,
    "wherever it lives, as **fix the defect everywhere it lives** below requires",
  );
  assert(
    !body.includes("fix the issue the comment describes and nothing more"),
    "expected the superseded 'fix the issue ... and nothing more' wording to be gone",
  );
});

Deno.test("pr_feedback - the reply names the other paths and copies checked", async () => {
  const body = lower(await load("pr_feedback"));

  assertStringIncludes(
    body,
    "for each finding the other paths and copies you checked",
  );
});
