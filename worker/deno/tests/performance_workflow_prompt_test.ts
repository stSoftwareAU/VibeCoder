/**
 * Structural-contract tests for the performance-workflow prompt templates
 * (Issue #1428; tightened for test-audit finding BP-de8bd2d78e3a, Issue #3282).
 *
 * These tests assert only observable, load-bearing behaviour:
 *   - prompt version resolution advances past a known floor
 *     (exercises `getLatestVersion`), and
 *   - the assembled `issue` prompt preserves the placeholder tokens its
 *     renderer depends on (the structural contract with the consumer).
 *
 * The previous free-prose grep assertions — `benchmark`/`before`/`after`,
 * "close the issue", "negative-result", "do not raise a PR", the
 * "Performance Task Workflow" heading, and the "document … in the PR"
 * regression check — were removed. They asserted specific wording in the
 * *latest, mutable* Markdown prompts rather than any behaviour a caller can
 * observe, so a harmless reword of the guidance reddened the suite with zero
 * behaviour change. `coding_guidelines` is one of the most actively
 * refactored prompts in the repo, so those HOW-tests got in the way of every
 * prose tidy-up. Prompt prose is documentation content: if it must be pinned
 * at all, pin it against a frozen `vN` file, not the mutable latest.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- prompt version resolution (exercises getLatestVersion) ---

Deno.test("performance workflow - coding_guidelines latest is v9 or later", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 9,
      true,
      `Expected coding_guidelines >= v9, got ${result.value}`,
    );
  }
});

Deno.test("performance workflow - issue prompt latest is v11 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 11,
      true,
      `Expected issue prompt >= v11, got ${result.value}`,
    );
  }
});

// --- structural placeholder contract (exercises loadPrompt assembly) ---

Deno.test("performance workflow - issue prompt retains required placeholders", async () => {
  const result = await loadPrompt("issue", undefined, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "{{ISSUE_NUMBER}}");
    assertStringIncludes(result.value, "{{QUALITY_INSTRUCTIONS}}");
    // Issue #3813: {{CODING_GUIDELINES}} was dropped from issue v31 — the
    // guidelines ride in the system prompt and the placeholder rendered empty.
  }
});
