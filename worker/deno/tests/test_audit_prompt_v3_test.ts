/**
 * Tests for test_audit prompt v3 (Issue #2638, follow-up to #2624).
 *
 * v3 applies the Fable-5 simplification recipe: the phase-gate
 * scaffolding ("Follow the four phases below in order. Verify your own
 * output at each phase boundary…") is dropped in favour of a plain
 * description of what each phase produces, the Hard Constraints are
 * stated once, the Phase 4 triple-negation output rule is rephrased
 * positively, and the detection stage is made coverage-oriented (surface
 * every candidate; rank and cap at triage).
 *
 * The load-bearing worker contracts are unchanged: the `Test-Audit` H1
 * body fingerprint, the `{{SUPPRESSED_IDS}}` / `{{KNOWN_OPEN_FINDING_IDS}}`
 * / `{{ATTRIBUTION_FOOTER}}` placeholders, the `BP-<12 hex>` id recipe
 * with the `"test-audit"` discriminator, the `test-audit` / `severity:*`
 * labels, the `BP- in:body` dedup search, the hidden `<!-- finding-id:`
 * marker, and the 6-issue cap.
 *
 * Also guards immutability of v2 (Issue #235 — prompt versions are
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
import { TEST_AUDIT_BODY_FINGERPRINT } from "../lib/idle_task_templates/test_audit_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("test_audit prompt v3 - loads via loadPrompt", async () => {
  const result = await loadPrompt("test_audit", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("test_audit prompt v3 - latest version is v3 or later", async () => {
  const result = await getLatestVersion("test_audit", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 3,
      true,
      `Expected test_audit prompt >= v3, got ${result.value}`,
    );
  }
});

Deno.test(
  "test_audit prompt v3 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("test_audit", "v3", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "test_audit",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "test_audit prompt v3 - keeps the Test-Audit H1 body fingerprint",
  async () => {
    const result = await loadPrompt("test_audit", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // The test-audit idle-task template routes wrapper issues by matching
    // the prompt's H1 against TEST_AUDIT_BODY_FINGERPRINT — the heading
    // must remain intact.
    assert(
      TEST_AUDIT_BODY_FINGERPRINT.test(result.value),
      "v3 must keep the 'Test-Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "test_audit prompt v3 - carries the ATTRIBUTION_FOOTER placeholder",
  async () => {
    const result = await loadPrompt("test_audit", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("{{ATTRIBUTION_FOOTER}}"),
      "v3 must keep the {{ATTRIBUTION_FOOTER}} placeholder",
    );
  },
);

Deno.test(
  "test_audit prompt v3 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("test_audit", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>", // stable id recipe
        '"test-audit"', // id discriminator
        "<!-- finding-id:", // hidden dedup marker
        "BP- in:body", // live dedup search
        "--label test-audit", // dedup search scope
        "best-practice-ignore", // suppression grammar
        "suppression_comments.ts", // worker grammar reference
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
  "test_audit prompt v3 - drops the phase-gate scaffolding sentence",
  async () => {
    const result = await loadPrompt("test_audit", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes("Verify your own output at each"),
      "v3 must drop the phase-boundary gate-keeping scaffolding",
    );
  },
);

Deno.test(
  "test_audit prompt v2 - immutable: keeps the phase-gate sentence v3 drops (Issue #235)",
  async () => {
    const result = await loadPrompt("test_audit", "v2", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("Verify your own output at each"),
      "v2 must remain the pre-simplification prompt",
    );
  },
);
