/**
 * Tests for supply_chain_detection prompt v2 (Issue #2638, follow-up to
 * #2624).
 *
 * v2 applies the Fable-5 simplification recipe: the phase-gate
 * scaffolding ("Follow the four phases below in order. Verify your own
 * output at each phase boundary…") is dropped in favour of a plain
 * description of what each phase produces, the Hard Constraints are
 * stated once, the Phase 4 triple-negation output rule is rephrased
 * positively, and the detection stage is made coverage-oriented.
 *
 * The load-bearing worker contracts are unchanged: the H1 fingerprint,
 * the `{{SUPPRESSED_IDS}}` / `{{KNOWN_OPEN_FINDING_IDS}}` placeholders,
 * the `SEC-<12 hex>` id recipe with the `"supply-chain-detection"`
 * discriminator, the `SCD-*` check prefixes, the `security` / `severity:*`
 * labels, the `SEC- in:body` dedup search, the hidden `<!-- finding-id:`
 * marker, the `security-scan-ignore` suppression grammar, and the
 * 6-issue cap.
 *
 * Also guards immutability of v1 (Issue #235).
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

Deno.test("supply_chain_detection prompt v2 - loads via loadPrompt", async () => {
  const result = await loadPrompt("supply_chain_detection", "v2", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("supply_chain_detection prompt v2 - latest version is v2 or later", async () => {
  const result = await getLatestVersion("supply_chain_detection", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 2,
      true,
      `Expected supply_chain_detection prompt >= v2, got ${result.value}`,
    );
  }
});

Deno.test(
  "supply_chain_detection prompt v2 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt(
      "supply_chain_detection",
      "v2",
      PROMPTS_DIR,
    );
    assert(result.ok);
    const v = validatePromptTemplate(
      "supply_chain_detection",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "supply_chain_detection prompt v2 - keeps the H1 body fingerprint",
  async () => {
    const result = await loadPrompt(
      "supply_chain_detection",
      "v2",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    assert(
      /^#+\s+Supply-chain detection\b/m.test(result.value),
      "v2 must keep the 'Supply-chain detection' H1 fingerprint",
    );
  },
);

Deno.test(
  "supply_chain_detection prompt v2 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt(
      "supply_chain_detection",
      "v2",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "SEC-<12 hex>", // stable id recipe
        '"supply-chain-detection"', // id discriminator
        "SCD-INSTALL-SCRIPT", // catalogue prefix
        "SCD-DEP-CONFUSION",
        "SCD-TYPOSQUAT",
        "SCD-FLOATING-PIN",
        "SCD-UNVERIFIED-SOURCE",
        "<!-- finding-id:", // hidden dedup marker
        "SEC- in:body", // live dedup search
        "security-scan-ignore", // suppression grammar
        "suppression_comments.ts",
        "severity:high|severity:medium|severity:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v2 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "supply_chain_detection prompt v2 - drops the phase-gate scaffolding sentence",
  async () => {
    const result = await loadPrompt(
      "supply_chain_detection",
      "v2",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes("Verify your own output at each"),
      "v2 must drop the phase-boundary gate-keeping scaffolding",
    );
  },
);

Deno.test(
  "supply_chain_detection prompt v1 - immutable: keeps the phase-gate sentence v2 drops (Issue #235)",
  async () => {
    const result = await loadPrompt(
      "supply_chain_detection",
      "v1",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("Verify your own output at each"),
      "v1 must remain the pre-simplification prompt",
    );
  },
);
