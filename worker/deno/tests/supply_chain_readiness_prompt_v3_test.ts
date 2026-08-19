/**
 * Tests for supply_chain_readiness prompt v3 (Issue #2638, follow-up to
 * #2624).
 *
 * v3 applies the Fable-5 simplification recipe: the phase-gate
 * scaffolding ("Follow the four phases below in order. Verify your own
 * output at each phase boundary…") is dropped in favour of a plain
 * description of what each phase produces, the Hard Constraints are
 * stated once, the public/GHAS visibility gate (which v2 spent ~21 lines
 * on in Hard Constraint 6 plus repeated in Phase 1 and the SCR-DEP-REVIEW
 * rule) is consolidated to a single concise statement, the Phase 4
 * triple-negation output rule is rephrased positively, and the detection
 * stage is made coverage-oriented.
 *
 * The load-bearing worker contracts are unchanged: the H1 fingerprint,
 * the `{{SUPPRESSED_IDS}}` / `{{KNOWN_OPEN_FINDING_IDS}}` placeholders,
 * the `BP-<12 hex>` id recipe with the `"supply-chain-readiness"`
 * discriminator, the `SCR-*` check prefixes, the `supply-chain-readiness`
 * / `severity:*` labels, the `BP- in:body` dedup search, the hidden
 * `<!-- finding-id:` marker, the `best-practice-ignore` suppression
 * grammar, and the 6-issue cap.
 *
 * Also guards immutability of v2 (Issue #235).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { SUPPLY_CHAIN_READINESS_BODY_FINGERPRINT } from "../lib/idle_task_templates/supply_chain_readiness_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("supply_chain_readiness prompt v3 - loads via loadPrompt", async () => {
  const result = await loadPrompt("supply_chain_readiness", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("supply_chain_readiness prompt v3 - latest version is v3 or later", async () => {
  const result = await getLatestVersion("supply_chain_readiness", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 3,
      true,
      `Expected supply_chain_readiness prompt >= v3, got ${result.value}`,
    );
  }
});

Deno.test(
  "supply_chain_readiness prompt v3 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v3",
      PROMPTS_DIR,
    );
    assert(result.ok);
    const v = validatePromptTemplate(
      "supply_chain_readiness",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "supply_chain_readiness prompt v3 - keeps the H1 body fingerprint",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v3",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    assert(
      SUPPLY_CHAIN_READINESS_BODY_FINGERPRINT.test(result.value),
      "v3 must keep the 'Supply-chain readiness' H1 fingerprint",
    );
  },
);

Deno.test(
  "supply_chain_readiness prompt v3 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v3",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>", // stable id recipe
        '"supply-chain-readiness"', // id discriminator
        "SCR-VULN-SCAN", // catalogue prefix
        "SCR-DEP-REVIEW",
        "SCR-IGNORE-SCRIPTS",
        "<!-- finding-id:", // hidden dedup marker
        "BP- in:body", // live dedup search
        "--label supply-chain-readiness", // dedup search scope
        "best-practice-ignore", // suppression grammar
        "suppression_comments.ts",
        "severity:high|severity:medium|severity:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v3 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "supply_chain_readiness prompt v3 - keeps the public/GHAS visibility gate",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v3",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    // The visibility gate is load-bearing: it stops the scan filing a
    // dependency-review finding on a private repo where the action can
    // never pass. The lookup command and the fail-safe-to-private rule
    // must both survive the consolidation.
    assert(
      body.includes("--json visibility") || body.includes(".visibility"),
      "v3 must keep the read-only visibility lookup",
    );
    assert(
      body.includes("fail safe to private") ||
        body.includes("Fail safe to private"),
      "v3 must keep the fail-safe-to-private rule",
    );
  },
);

Deno.test(
  "supply_chain_readiness prompt v3 - drops the phase-gate scaffolding sentence",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v3",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes("Verify your own output at each"),
      "v3 must drop the phase-boundary gate-keeping scaffolding",
    );
  },
);

Deno.test(
  "supply_chain_readiness prompt v2 - immutable: keeps the phase-gate sentence v3 drops (Issue #235)",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v2",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("Verify your own output at each"),
      "v2 must remain the pre-simplification prompt",
    );
  },
);
