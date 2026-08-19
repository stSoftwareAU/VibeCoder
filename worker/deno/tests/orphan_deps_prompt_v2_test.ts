/**
 * Tests for the orphan_deps prompt v2 (Issue #2908, parent #2902).
 *
 * v2 adds the dedup / suppression / noise-control contracts on top of v1:
 *   - the precise `BP-<12 hex>` finding-id recipe with the
 *     `ecosystem:package` dependency component and the `"orphan-deps"`
 *     discriminator, naming the shared worker helper;
 *   - the `orphan-deps-ignore: BP-…` suppression synonym;
 *   - the retained known-open / suppressed placeholders and 6-finding cap.
 *
 * v1's contracts are asserted by orphan_deps_prompt_v1_test.ts and are
 * unchanged (v1 is immutable). Australian English spelling throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("orphan_deps prompt - loadPrompt resolves v2 as the latest", async () => {
  const latest = await getLatestVersion("orphan_deps", PROMPTS_DIR);
  assert(latest.ok);
  if (latest.ok) {
    const num = parseInt(latest.value.replace("v", ""), 10);
    assertEquals(
      num >= 2,
      true,
      `expected orphan_deps >= v2, got ${latest.value}`,
    );
  }
});

Deno.test("orphan_deps prompt v2 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("orphan_deps", "v2", PROMPTS_DIR);
  assert(result.ok);
  const v = validatePromptTemplate(
    "orphan_deps",
    result.ok ? result.value : "",
  );
  assertEquals(v.ok, true);
});

Deno.test("orphan_deps prompt v2 - documents the precise finding-id recipe", async () => {
  const result = await loadPrompt("orphan_deps", "v2", PROMPTS_DIR);
  assert(result.ok);
  if (!result.ok) return;
  const body = result.value;
  for (
    const contract of [
      '"orphan-deps"', // the discriminator
      "ecosystem:package", // the dependency component
      "computeOrphanDepsFindingId", // the shared worker helper
      "orphan_deps_finding_id.ts",
    ]
  ) {
    assert(
      body.includes(contract),
      `v2 must document the recipe contract '${contract}'`,
    );
  }
});

Deno.test("orphan_deps prompt v2 - honours the orphan-deps-ignore synonym", async () => {
  const result = await loadPrompt("orphan_deps", "v2", PROMPTS_DIR);
  assert(result.ok);
  if (!result.ok) return;
  const body = result.value;
  assert(
    body.includes("orphan-deps-ignore"),
    "v2 must document the orphan-deps-ignore suppression synonym",
  );
  // The 6-finding cap and known-open / suppressed contracts survive.
  for (
    const contract of ["6", "{{SUPPRESSED_IDS}}", "{{KNOWN_OPEN_FINDING_IDS}}"]
  ) {
    assert(body.includes(contract), `v2 must retain '${contract}'`);
  }
});
