/**
 * Tests for github_actions_audit prompt v1 (Issue #2255, parent #2243).
 *
 * The github-actions-audit prompt is the single-bucket orchestrating
 * prompt for the weekly GitHub Actions audit. It mirrors the structure
 * of `prompts/best_practices/v2.md` and `prompts/test_audit/v1.md`:
 * four-phase, read-only, outcome-only, files at most six findings per
 * run. Scope is always `.github/workflows/*.yml` and composite actions
 * under `.github/actions/` — there is no `{{BUCKET}}` placeholder.
 *
 * Behavioural assertions only — these tests exercise the real
 * `loadPrompt` / `validatePromptTemplate` paths in `prompt_manager.ts`
 * rather than grepping the template by path.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  getRequiredPlaceholders,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("github_actions_audit prompt - latest version resolves to v1 or later", async () => {
  const result = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
  assert(
    result.ok,
    `latest version lookup failed: ${result.ok ? "" : result.error.message}`,
  );
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 1,
      true,
      `Expected github_actions_audit prompt >= v1, got ${result.value}`,
    );
  }
});

Deno.test("github_actions_audit prompt - loadPrompt resolves v1.md", async () => {
  const result = await loadPrompt("github_actions_audit", "v1", PROMPTS_DIR);
  assert(
    result.ok,
    `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
  );
});

Deno.test("github_actions_audit prompt - REQUIRED_PLACEHOLDERS registers all four placeholders", () => {
  const result = getRequiredPlaceholders("github_actions_audit");
  assert(
    result.ok,
    `getRequiredPlaceholders failed: ${result.ok ? "" : result.error.message}`,
  );
  if (result.ok) {
    assertEquals(
      [...result.value].sort(),
      [
        "ACTIONS_CATALOGUE_TABLE",
        "EOL_RUNTIMES_TABLE",
        "KNOWN_OPEN_FINDING_IDS",
        "SUPPRESSED_IDS",
      ],
    );
  }
});

Deno.test(
  "github_actions_audit prompt v1 - validatePromptTemplate passes (all required placeholders present)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v1", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const validate = validatePromptTemplate("github_actions_audit", load.value);
    assert(
      validate.ok,
      `validatePromptTemplate failed: ${
        validate.ok ? "" : validate.error.message
      }`,
    );
  },
);
