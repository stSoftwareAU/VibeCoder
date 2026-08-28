/**
 * Tests for coding_guidelines v42 (Issue #373).
 *
 * `buildCodingGuidelines()` loads the *latest* `coding_guidelines` version for
 * every run, whichever provider serves it — so a section headed after one
 * model generation ("Opus 5 Working Style", v34–v41) told the Codex and Gemini
 * providers they were a Claude generation and that they "self-verify as you
 * work". v42 keeps all four working-style directives and drops the
 * generation-specific framing; the observations that justified it live in
 * `docs/MODEL-AND-CACHING.md` § "Model-generation prompt tuning".
 *
 * The assertions below run against the *latest* version, not v42 alone, so a
 * future copy-forward that re-introduces a model name — or quietly drops a
 * directive — fails in CI.
 *
 * Australian English throughout (behaviour, generalisation).
 */

import { assertEquals } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { findModelGenerationNames } from "../lib/model_generation_name_check.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Load a coding_guidelines version, failing loudly when it is missing. */
async function loadGuidelines(version?: string): Promise<string> {
  const result = await loadPrompt("coding_guidelines", version, PROMPTS_DIR);
  assertEquals(
    result.ok,
    true,
    `coding_guidelines ${version ?? "latest"} failed to load`,
  );
  if (!result.ok) throw new Error("coding_guidelines failed to load");
  return result.value;
}

Deno.test("latest coding_guidelines - names no Claude model generation", async () => {
  const text = await loadGuidelines();
  const hits = findModelGenerationNames("coding_guidelines (latest)", text);
  assertEquals(
    hits.length,
    0,
    `Latest coding_guidelines names a model generation: ${
      hits.map((h) => `line ${h.line} "${h.name}": ${h.content}`).join("; ")
    }`,
  );
});
