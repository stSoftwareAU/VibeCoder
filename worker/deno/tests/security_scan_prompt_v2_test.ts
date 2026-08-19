/**
 * Tests for security_scan prompt v2 (Issue #2011).
 *
 * v2 extends the v1 four-phase audit with a "Dependency-update
 * quarantine" audit inside the Supply chain taxonomy bullet. It
 * audits the target repo's Renovate / Dependabot / bump-deps.sh
 * configuration to confirm external (non-`stSoftwareAU/*`) packages
 * are gated by at least `VIBE_BUMP_QUARANTINE_HOURS` hours before
 * being bumped — layering on top of the worker-side bump policy
 * from Issue #1613.
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

Deno.test("security_scan prompt v2 - latest version is v2 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 2,
      true,
      `Expected security_scan prompt >= v2, got ${result.value}`,
    );
  }
});

Deno.test("security_scan prompt v2 - loads via loadPrompt and has a non-empty body", async () => {
  const result = await loadPrompt("security_scan", "v2", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("security_scan prompt v2 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("security_scan", "v2", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  }
});
