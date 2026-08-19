/**
 * Tests for github_actions_audit prompt v5 (Issue #2356).
 *
 * v5 adds a new check covering **over-broad secret passing to reusable
 * workflows**. `secrets: inherit` on a `uses:` reusable-workflow call
 * forwards every secret available to the calling workflow into the
 * callee, instead of an explicit per-secret allowlist. This widens blast
 * radius — a reusable workflow (especially a cross-repo one, or one that
 * later changes hands) receives secrets it does not need, violating
 * least privilege.
 *
 * Severity guidance (per the issue):
 *
 *   - `severity:medium` when the callee is a same-repo reusable
 *     workflow (`uses: ./.github/workflows/foo.yml`).
 *   - `severity:high` when the callee is a cross-repo reusable workflow
 *     pinned to a tag rather than a SHA — combines the over-broad
 *     secret passing with the supply-chain risk that check #13 catches.
 *
 * Stable id: generic `BP-<12 hex>` recipe.
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

Deno.test(
  "github_actions_audit prompt - latest version is v5 or later",
  async () => {
    const result = await getLatestVersion(
      "github_actions_audit",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 5,
        true,
        `Expected github_actions_audit prompt >= v5, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v5 - loadPrompt resolves v5.md",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v5", PROMPTS_DIR);
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "github_actions_audit prompt v5 - validatePromptTemplate passes (placeholder contract holds)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v5", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(v.ok, true);
  },
);
