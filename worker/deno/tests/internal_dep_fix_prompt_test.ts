/**
 * Tests for the internal-dependency cross-repo fix rules (Issue #2942,
 * parent #2935).
 *
 * The default for a root cause living in an internal `stSoftwareAU/*`
 * dependency the worker can access is to FIX it cross-repo in the same run —
 * raise a PR in the dependency's own repo AND bring the fix into the consuming
 * repo — not to defer it via a follow-up issue. The blanket #1826 escape hatch
 * is narrowed: deferral is acceptable only for external deps, genuine
 * human-only decisions, or a cross-repo fix genuinely too big for one run (which
 * still requires a draft/WIP PR in the dependency repo).
 *
 * These rules live in:
 *   - `prompts/issue/` (from v28 onward) — the issue handling path.
 *   - `prompts/coding_guidelines/` (from v29 onward) — the central escape hatch
 *     embedded into every phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Substrings that encode the internal-dep cross-repo fix default. */
const INTERNAL_FIX_MARKERS = [
  "stSoftwareAU/*", // the internal classification
  "internal", // internal vs external wording
  "external", // the narrowed deferral branch
  "cross-repo", // fix it in the dep's own repo + consuming repo
  "transitive", // recurse to where the root cause lives
  "draft", // draft/WIP PR requirement for the too-big branch
  "Issue #2942", // traceability
  "#1613", // reuses the existing classification
];

Deno.test("issue prompt - latest version is v28 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(num >= 28, true, `expected issue >= v28, got ${result.value}`);
});

Deno.test("issue prompt v28 - encodes the internal-dep cross-repo fix default", async () => {
  const result = await loadPrompt("issue", "v28", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (const marker of INTERNAL_FIX_MARKERS) {
    assertStringIncludes(result.value, marker);
  }
  // The "can access" definition is reused from the capability work.
  assertStringIncludes(result.value, "Can access");
  // The fix must not be deferred to a follow-up issue by default.
  assertStringIncludes(result.value, "Do NOT defer it to a follow-up issue");
});

Deno.test("coding_guidelines prompt - latest version is v29 or later", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 29,
    true,
    `expected coding_guidelines >= v29, got ${result.value}`,
  );
});

Deno.test("coding_guidelines prompt v29 - encodes the internal-dep cross-repo fix default", async () => {
  const result = await loadPrompt("coding_guidelines", "v29", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (const marker of INTERNAL_FIX_MARKERS) {
    assertStringIncludes(result.value, marker);
  }
  // The narrowed escape hatch must still be present and tie back to #1826.
  assertStringIncludes(result.value, "Escape Hatch");
  assertStringIncludes(result.value, "Issue #1826");
  // The too-big branch must require a draft/WIP PR rather than a pure deferral.
  assertStringIncludes(result.value, "draft/WIP PR");
});
