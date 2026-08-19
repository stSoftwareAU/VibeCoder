/**
 * Tests for coding_guidelines v26 (Issue #2543).
 *
 * v26 adds Deno-specific dependency-bump guidance: in a Deno repo the
 * worker bumps Deno deps via the native Deno CLI minimum-age support
 * (`deno update` / `deno outdated --minimum-dependency-age`) honouring
 * `deno.json` `minimumDependencyAge`, and must not write bespoke
 * quarantine code. The 24h-external / 0h-internal (`@stsoftware/*`)
 * split is stated using the #2539 config/flag shape. Non-Deno guidance
 * (`VIBE_BUMP_QUARANTINE_HOURS`, per-tool audit) is preserved. v25 stays
 * immutable.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("coding_guidelines v26 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v26", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v26 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 26,
      true,
      `Expected coding_guidelines >= v26, got ${result.value}`,
    );
  }
});

Deno.test("coding_guidelines v26 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v26", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});
