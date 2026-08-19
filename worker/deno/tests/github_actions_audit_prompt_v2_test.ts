/**
 * Tests for github_actions_audit prompt v2 (Issue #2350).
 *
 * v2 adds a Supply-chain hardening check (#22): script injection via an
 * untrusted `${{ github.* }}` expression interpolated directly into a
 * shell `run:` step — GitHub's #1 Actions hardening item. The remediation
 * is to route the value through an intermediate `env:` var and reference
 * it as a quoted shell variable, which the runner never re-parses.
 *
 * Behavioural assertions only — these exercise the real
 * `loadPrompt` / `validatePromptTemplate` / `getLatestVersion` paths in
 * `prompt_manager.ts` rather than grepping the template by path.
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

Deno.test("github_actions_audit prompt - latest version is v2 or later", async () => {
  const result = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
  assert(
    result.ok,
    `latest version lookup failed: ${result.ok ? "" : result.error.message}`,
  );
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 2,
      true,
      `Expected github_actions_audit prompt >= v2, got ${result.value}`,
    );
  }
});

Deno.test("github_actions_audit prompt v2 - loadPrompt resolves v2.md", async () => {
  const result = await loadPrompt("github_actions_audit", "v2", PROMPTS_DIR);
  assert(
    result.ok,
    `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
  );
});

Deno.test(
  "github_actions_audit prompt v2 - validatePromptTemplate passes (all required placeholders present)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v2", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const validate = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(validate.ok, true);
  },
);
