/**
 * Tests for the Docs sweep re-run guidance (Issue #3172).
 *
 * Fleet PRs passed the docs-sweep gate with hits of their own declared grep
 * terms still stating removed behaviour — a missed inflection
 * ("replaced or removed" against a grep for "replaces or removes") or a
 * second passage in a file the sweep listed as updated. The `issue`
 * template now asks for stem greps, a re-run on the final head, and every
 * remaining hit recorded as `file:line — still true because …`, and says the
 * worker re-runs the terms itself.
 *
 * The assertions run against the current template, so a later edit that
 * drops the rule fails in CI.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadIssuePrompt(): Promise<string> {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(result.ok, true, "issue failed to load");
  if (!result.ok) throw new Error("issue failed to load");
  return result.value.toLowerCase().replace(/\s+/g, " ");
}

Deno.test("issue - docs sweep greps the stem of a behavioural claim", async () => {
  const body = await loadIssuePrompt();
  assertStringIncludes(body, "grep for the **stem** of a behavioural claim");
  assertStringIncludes(body, "replac\\w* or remov\\w*");
});

Deno.test("issue - docs sweep is re-run on the final head and each remaining hit is recorded", async () => {
  const body = await loadIssuePrompt();
  assertStringIncludes(body, "on the final head, after editing");
  assertStringIncludes(body, "file:line — still true because");
});

Deno.test("issue - docs sweep reads every passage in a file it lists as updated", async () => {
  const body = await loadIssuePrompt();
  assertStringIncludes(
    body,
    "in every file you list as updated, read every passage that mentions the changed surface",
  );
});

Deno.test("issue - the template says the worker re-runs the line's quoted terms", async () => {
  const body = await loadIssuePrompt();
  assertStringIncludes(body, "the worker re-runs the line's quoted terms");
});
