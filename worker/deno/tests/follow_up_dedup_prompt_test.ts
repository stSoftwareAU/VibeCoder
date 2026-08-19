/**
 * Tests for the follow-up dedup prompt rules (Issue #2943, parent #2935).
 *
 * When the worker legitimately defers a root cause via the escape hatch, a
 * single root cause must never spawn more than ONE follow-up issue, and never a
 * duplicate of one that already exists. Before filing, the worker must search
 * the target repo for an existing open issue on the same root cause and
 * comment-on / reference it instead of opening a duplicate.
 *
 * These rules live in:
 *   - `prompts/issue/` (from v27 onward) — the issue deferral path.
 *   - `prompts/coding_guidelines/` (from v28 onward) — the central escape hatch
 *     embedded into every phase (issue, PR feedback, CI fix), so the rule
 *     applies regardless of which deferral branch is taken.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Substrings that encode the "one follow-up max + search-before-file" rule. */
const DEDUP_MARKERS = [
  "one follow-up", // at-most-one cap wording
  "root cause", // scoped to a single root cause
  "gh issue list", // the documented search command
  "--search", // search flag
  "--state open", // restricted to open issues
];

Deno.test("issue prompt - latest version is v27 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(num >= 27, true, `expected issue >= v27, got ${result.value}`);
});

Deno.test("issue prompt v27 - encodes the one-follow-up + search rule", async () => {
  const result = await loadPrompt("issue", "v27", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (const marker of DEDUP_MARKERS) {
    assertStringIncludes(result.value, marker);
  }
  // Explicit traceability to the issue and the at-most-one cap.
  assertStringIncludes(result.value, "Issue #2943");
  assertStringIncludes(result.value, "at most one");
});

Deno.test("coding_guidelines prompt - latest version is v28 or later", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 28,
    true,
    `expected coding_guidelines >= v28, got ${result.value}`,
  );
});

Deno.test("coding_guidelines prompt v28 - encodes the one-follow-up + search rule", async () => {
  const result = await loadPrompt("coding_guidelines", "v28", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (const marker of DEDUP_MARKERS) {
    assertStringIncludes(result.value, marker);
  }
  assertStringIncludes(result.value, "Issue #2943");
  assertStringIncludes(result.value, "at most one");
  // The rule must still be inside the escape-hatch section so it fires on
  // every deferral branch.
  assertStringIncludes(result.value, "Escape Hatch");
});
