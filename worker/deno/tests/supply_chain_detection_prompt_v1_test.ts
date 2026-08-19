/**
 * Tests for supply_chain_detection prompt v1 (Issue #2443, parent #2406).
 *
 * The supply-chain detection prompt is the orchestrating prompt for the
 * forthcoming idle-task template (#6) that scans each monitored repo's
 * declared and locked dependency set for active malicious-dependency
 * signals. It is the active-detection counterpart to the posture audit
 * run by `supply_chain_readiness` (#5), and mirrors that prompt's shape:
 * four-phase, read-only, static-evidence only, outcome-only, at most six
 * findings per run.
 *
 * Behavioural assertions only — these tests exercise the real
 * `loadPrompt` / `validatePromptTemplate` / `getRequiredPlaceholders`
 * paths in `prompt_manager.ts` rather than grepping the template by path.
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

Deno.test("supply_chain_detection prompt - latest version resolves to v1 or later", async () => {
  const result = await getLatestVersion("supply_chain_detection", PROMPTS_DIR);
  assert(result.ok, result.ok ? "" : result.error.message);
  if (result.ok) {
    assertEquals(parseInt(result.value.replace("v", ""), 10) >= 1, true);
  }
});

Deno.test(
  "supply_chain_detection prompt - REQUIRED_PLACEHOLDERS registers the two dedup lists",
  () => {
    const result = getRequiredPlaceholders("supply_chain_detection");
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertEquals(
        [...result.value].sort(),
        ["KNOWN_OPEN_FINDING_IDS", "SUPPRESSED_IDS"],
      );
    }
  },
);

Deno.test(
  "supply_chain_detection prompt v1 - validatePromptTemplate passes",
  async () => {
    const result = await loadPrompt(
      "supply_chain_detection",
      "v1",
      PROMPTS_DIR,
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    const validate = validatePromptTemplate(
      "supply_chain_detection",
      result.ok ? result.value : "",
    );
    assertEquals(validate.ok, true);
  },
);
