/**
 * Tests for grill-me prompt v8 (Issue #2064).
 *
 * v8 keeps every v7 behaviour and lifts the prompt-level restriction
 * against adding the `needs-human` label for the **completion step
 * only** (Step 5b). When grilling converges, Claude must add
 * `needs-human` immediately after posting the Ready comment and
 * removing the `grill-me` label, so the user sees the issue as
 * awaiting their pick of next-phase label.
 *
 * Adding `needs-human` during an in-progress round (Step 5a) remains
 * forbidden — the worker manages the per-round turn signal itself.
 */

import { assertEquals } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("grill-me prompt v8 - latest version is v8 or later", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 8,
      true,
      `Expected grill-me prompt >= v8, got ${result.value}`,
    );
  }
});

Deno.test("grill-me prompt v8 - loads via loadPrompt", async () => {
  const result = await loadPrompt("grill-me", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});
