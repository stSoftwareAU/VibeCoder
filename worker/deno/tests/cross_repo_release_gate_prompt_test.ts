/**
 * Tests for the cross-repo internal-dependency release-gating prompt rules
 * (Issue #2944, parent #2935).
 *
 * Once the worker has opened a PR in an internal `stSoftwareAU/*` dependency's
 * own repo, two boundaries must hold:
 *
 *   1. No auto-release — the worker must NOT auto-merge/publish the dependency,
 *      and must NOT bump the consumer to a raw commit/git-ref or a pre-release
 *      to pull the fix in early.
 *   2. Human-gated release is the ONE legitimate deferral after the dep PR is
 *      open, handled via exactly one follow-up whose placement (consumer OR
 *      dependency repo, whichever is reachable) is specified and which is
 *      cross-linked to the open dep PR.
 *
 * These rules live in the latest versions of:
 *   - `prompts/coding_guidelines/` (from v29 onward) — central, every phase.
 *   - `prompts/issue/` (from v28 onward) — the issue-fix path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Substrings that encode the no-auto-release + human-gated-release rule. */
const RELEASE_GATE_MARKERS = [
  "auto-merge", // forbid auto-merging the dep PR
  "publish", // forbid publishing the dep
  "commit/git-ref", // forbid raw-ref consumer bump
  "pre-release", // forbid pre-release consumer bump
  "human to release", // human-gated release is the deferral trigger
  "cross-link", // mandatory cross-link to the open dep PR
];

async function loadLatest(promptName: string): Promise<string> {
  const latest = await getLatestVersion(promptName, PROMPTS_DIR);
  assertEquals(latest.ok, true, `could not resolve latest ${promptName}`);
  if (!latest.ok) return "";
  const loaded = await loadPrompt(promptName, latest.value, PROMPTS_DIR);
  assertEquals(loaded.ok, true, `could not load ${promptName} ${latest.value}`);
  return loaded.ok ? loaded.value : "";
}

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

Deno.test("issue prompt - latest version is v28 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(num >= 28, true, `expected issue >= v28, got ${result.value}`);
});

Deno.test("coding_guidelines latest - encodes the release-gating rule", async () => {
  const body = await loadLatest("coding_guidelines");
  for (const marker of RELEASE_GATE_MARKERS) {
    assertStringIncludes(body, marker);
  }
  // Traceability and the placement choice (consumer OR dep repo).
  assertStringIncludes(body, "Issue #2944");
  assertStringIncludes(body, "consuming");
  assertStringIncludes(body, "dependency repo");
  // The single-follow-up cap is reused from the dedup rule (#2943).
  assertStringIncludes(body, "one");
});

Deno.test("issue latest - encodes the release-gating rule", async () => {
  const body = await loadLatest("issue");
  for (const marker of RELEASE_GATE_MARKERS) {
    assertStringIncludes(body, marker);
  }
  assertStringIncludes(body, "Issue #2944");
  assertStringIncludes(body, "consuming");
  assertStringIncludes(body, "dependency repo");
});
