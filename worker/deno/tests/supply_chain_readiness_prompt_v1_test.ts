/**
 * Tests for supply_chain_readiness prompt v1 (Issue #2397, parent #2396).
 *
 * The supply-chain readiness prompt is the orchestrating prompt for the
 * idle-task template that audits each monitored repo's posture for
 * surviving and responding to a supply-chain compromise. It mirrors the
 * shape of `prompts/test_audit/v1.md` and
 * `prompts/best_practices/v3.md`: four-phase, read-only, outcome-only,
 * files at most six findings per run.
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

Deno.test("supply_chain_readiness prompt - latest version resolves to v1 or later", async () => {
  const result = await getLatestVersion("supply_chain_readiness", PROMPTS_DIR);
  assert(
    result.ok,
    `latest version lookup failed: ${result.ok ? "" : result.error.message}`,
  );
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 1,
      true,
      `Expected supply_chain_readiness prompt >= v1, got ${result.value}`,
    );
  }
});

Deno.test(
  "supply_chain_readiness prompt - loadPrompt('supply_chain_readiness') resolves v1.md",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v1",
      PROMPTS_DIR,
    );
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "supply_chain_readiness prompt - REQUIRED_PLACEHOLDERS registers SUPPRESSED_IDS and KNOWN_OPEN_FINDING_IDS",
  () => {
    const result = getRequiredPlaceholders("supply_chain_readiness");
    assert(
      result.ok,
      `getRequiredPlaceholders failed: ${
        result.ok ? "" : result.error.message
      }`,
    );
    if (result.ok) {
      assertEquals(
        [...result.value].sort(),
        ["KNOWN_OPEN_FINDING_IDS", "SUPPRESSED_IDS"],
      );
    }
  },
);

Deno.test(
  "supply_chain_readiness prompt v1 - validatePromptTemplate passes (required placeholders present)",
  async () => {
    const load = await loadPrompt("supply_chain_readiness", "v1", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("supply_chain_readiness", load.value);
    assertEquals(v.ok, true);
  },
);
