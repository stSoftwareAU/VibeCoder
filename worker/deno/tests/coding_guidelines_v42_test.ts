/**
 * Tests for the model-generation neutrality of coding_guidelines (Issue #373).
 *
 * `buildCodingGuidelines()` loads the `coding_guidelines` template for every
 * run, whichever provider serves it — so a section headed after one model
 * generation ("Opus 5 Working Style") told the Codex and Gemini providers they
 * were a Claude generation and that they "self-verify as you work". Issue #373
 * kept all four working-style directives and dropped the generation-specific
 * framing; the observations that justified it live in
 * `docs/MODEL-AND-CACHING.md` § "Model-generation prompt tuning".
 *
 * The assertion below runs against the template the worker actually loads, so
 * a future edit that re-introduces a model name fails in CI.
 *
 * Australian English throughout (behaviour, generalisation).
 */

import { assertEquals } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { findModelGenerationNames } from "../lib/model_generation_name_check.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Load the coding_guidelines template, failing loudly when it is missing. */
async function loadGuidelines(): Promise<string> {
  const result = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true, "coding_guidelines failed to load");
  if (!result.ok) throw new Error("coding_guidelines failed to load");
  return result.value;
}

Deno.test("coding_guidelines - names no Claude model generation", async () => {
  const text = await loadGuidelines();
  const hits = findModelGenerationNames("coding_guidelines", text);
  assertEquals(
    hits.length,
    0,
    `coding_guidelines names a model generation: ${
      hits.map((h) => `line ${h.line} "${h.name}": ${h.content}`).join("; ")
    }`,
  );
});
