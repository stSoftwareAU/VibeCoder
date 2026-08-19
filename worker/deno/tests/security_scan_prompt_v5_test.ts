/**
 * Tests for security_scan prompt v5 (Issue #2097).
 *
 * v5 retires the fenced JSON block plus Markdown summary in favour of
 * an outcome-only Phase 4: Claude files one GitHub issue per
 * surviving finding via `gh issue create` and emits no JSON, no
 * Executive summary, no Coverage map, and no Suggested next scans.
 * The executor verifies success by diffing the repo's open
 * `security`-labelled issues before and after the run.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("security_scan prompt v5 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v5 - latest version is v5 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 5,
      true,
      `Expected security_scan prompt >= v5, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v5 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v5", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      const v = validatePromptTemplate("security_scan", result.value);
      assertEquals(v.ok, true);
    }
  },
);
