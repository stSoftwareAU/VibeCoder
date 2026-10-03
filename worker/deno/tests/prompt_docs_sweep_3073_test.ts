/**
 * Tests for the manual-section docs sweep (Issue #3073).
 *
 * Fleet PRs still left the manual for the changed surface stale: the grep
 * terms were internal identifiers that missed prose, hits were dismissed by
 * the file's topic without reading the sentence, and a behaviour change that
 * kept every name had nothing to grep, so the manual still described the old
 * behaviour. The `issue` and `pr_feedback` templates now also require
 * finding the manual section that documents the changed surface by its own
 * name, reading it through, and naming that section in the **Docs sweep**
 * line. The `issue` template additionally gates PR creation on that line
 * being present.
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

Deno.test("issue - docs sweep also finds the manual section by the surface's own name", async () => {
  const body = normalise(await load("issue"));

  for (
    const required of [
      "manual section",
      "surface's own name",
      "read that section through",
      "never by the file's topic",
      "section:",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("issue - worker gates PR creation on the Docs sweep line", async () => {
  const body = normalise(await load("issue"));

  assertStringIncludes(body, "worker will not raise the pr without that line");
  assertStringIncludes(body, "a second miss fails the run");
});

Deno.test("pr_feedback - docs sweep also finds the manual section by the surface's own name", async () => {
  const body = normalise(await load("pr_feedback"));

  for (
    const required of [
      "manual section",
      "surface's own name",
      "read that section through",
      "never by the file's topic",
      "section:",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});
