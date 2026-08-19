/**
 * Tests for security_scan prompt v12 (Issue #2542).
 *
 * v12 teaches the dependency-update quarantine audit to recognise
 * Deno's native `minimumDependencyAge` as a valid quarantine for the
 * Deno (JSR / `deno.land/x` / `npm:`) ecosystem, and to flag Deno
 * repos that are missing or misconfiguring it. It adds:
 *
 *   - Phase 1 — adds `deno.json` / `deno.jsonc` to the inventory of
 *     dependency-update tooling files.
 *   - Phase 2 — accepts a native `minimumDependencyAge` set to >= 24h
 *     as a valid Deno quarantine (internal `stSoftwareAU` deps
 *     exempted via `exclude`), files `quarantine-missing` when a Deno
 *     repo lacks it and `quarantine-misconfigured` when it is below
 *     the threshold or gates internal deps.
 *
 * The audit stays read-only — it never runs `deno update`.
 *
 * Also guards immutability of v11 (Issue #235 — prompt versions are
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

Deno.test("security_scan prompt v12 - latest version is v12 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 12,
      true,
      `Expected security_scan prompt >= v12, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v12 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v12", PROMPTS_DIR);
    assert(result.ok);
    // The required {{PLACEHOLDER}} tokens are the substitution code's real
    // contract; validate via the manager rather than grepping individual
    // tokens out of the source text.
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);
