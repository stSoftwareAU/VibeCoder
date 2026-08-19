/**
 * Tests for security_scan prompt v18 (Issue #3014, parent #3009).
 *
 * v18 makes the OWASP GenAI / LLM Top 10 (2025) section gate on the
 * worker's **deterministic** LLM-usage verdict rather than Claude's own
 * Phase-1 self-detection. The executor (`security_scanner.ts`) runs the
 * precision-first detector — including the always-on allowlist floor — and
 * substitutes the authoritative verdict into the new `{{LLM_GATE}}`
 * placeholder. v18 carries the full v17 LLM taxonomy forward unchanged.
 *
 * Also guards immutability of v17 (Issue #235 — prompt versions are
 * immutable once shipped): v17 must not gain the `{{LLM_GATE}}`
 * placeholder.
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

Deno.test("security_scan prompt v18 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v18", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v18 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 18,
      true,
      `Expected security_scan prompt >= v18, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v18 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v18", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v18 - carries the {{LLM_GATE}} placeholder",
  async () => {
    const result = await loadPrompt("security_scan", "v18", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("{{LLM_GATE}}"),
      "v18 must carry the {{LLM_GATE}} placeholder the executor substitutes",
    );
  },
);

Deno.test(
  "security_scan prompt v18 - gates the LLM taxonomy on the worker verdict",
  async () => {
    const result = await loadPrompt("security_scan", "v18", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("LLM-using = YES"),
      "v18 must reference the YES gate verdict",
    );
    assert(
      result.value.includes("LLM-using = NO"),
      "v18 must reference the NO gate verdict",
    );
    assert(
      result.value.includes("OWASP GenAI / LLM Top 10") &&
        result.value.includes("LLM01:2025") &&
        result.value.includes("LLM10:2025"),
      "v18 must carry the full LLM Top 10 taxonomy forward from v17",
    );
  },
);

Deno.test(
  "security_scan prompt v17 - does NOT carry the {{LLM_GATE}} placeholder (immutability)",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(
      result.value.includes("{{LLM_GATE}}"),
      false,
      "v17 must remain frozen — the gate placeholder is a v18 addition",
    );
  },
);
