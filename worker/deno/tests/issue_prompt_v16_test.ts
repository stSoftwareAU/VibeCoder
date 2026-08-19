/**
 * Tests for issue prompt v16 (Issue #1629).
 *
 * Issue #1629 ("This is wrong, the vibe coder has access") reported that the
 * worker was falsely escalating workflow-file changes to `needs-human` based
 * on stale prompt text claiming the worker lacks the `workflow` OAuth scope.
 *
 * The remaining stale text in the issue prompt was a Self-Verification
 * Checkpoint line that flagged "workflow YAML files" as sensitive files that
 * must NOT be staged. Workflow YAML files are not secrets — the worker has
 * the `workflow` scope (verified at startup in `run_core.sh`). v16 removes
 * this incorrect listing while keeping genuine secret patterns intact.
 *
 * This test guards:
 *  - v16 is the latest issue prompt version
 *  - v16 loads via loadPrompt
 *  - v16 satisfies the issue placeholder contract
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("issue prompt v16 - latest issue version is v16 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 16,
      true,
      `Expected issue prompt >= v16, got ${result.value}`,
    );
  }
});

Deno.test("issue prompt v16 - loads via loadPrompt", async () => {
  const result = await loadPrompt("issue", "v16", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("issue prompt v16 - satisfies the issue placeholder contract", async () => {
  const result = await loadPrompt("issue", "v16", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("issue", result.value);
    assertEquals(v.ok, true);
  }
});
