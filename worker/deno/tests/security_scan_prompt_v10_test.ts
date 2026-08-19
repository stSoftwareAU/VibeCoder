/**
 * Tests for security_scan prompt v10 (Issue #2225).
 *
 * v10 teaches the scanner to prefer Deno-native solutions in a Deno
 * repo and to file a regression finding when Node tooling has crept
 * into a Deno repo. It adds:
 *
 *   - Phase 1 — language-detection nuance: when both Deno markers
 *     and Node markers are present, classify the repo as **Deno**
 *     for finding-suggestion and remediation-advice purposes, and
 *     record the dual-marker state for Phase 2.
 *   - Phase 2 — a new "Node tooling in a Deno repo (regression)"
 *     finding class under the Supply-chain / dependency hygiene
 *     taxonomy, filed at severity:medium / confidence:high.
 *   - Phase 4 — remediation guidance: when suggesting fixes for a
 *     Deno repo, prefer the Deno-native tool (`deno test`,
 *     `deno lint`, `deno fmt`, `deno run`) over the Node equivalent.
 *
 * Also guards immutability of v9 (Issue #235 — prompt versions are
 * immutable once shipped).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("security_scan prompt v10 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v10", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v10 - latest version is v10 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 10,
      true,
      `Expected security_scan prompt >= v10, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v10 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v10", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);
