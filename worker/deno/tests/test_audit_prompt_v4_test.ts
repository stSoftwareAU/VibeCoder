/**
 * Tests for test_audit prompt v4 (Issue #2916, parent #2903).
 *
 * v4 extends the WHAT-vs-HOW test-audit with **coverage-gap detection**:
 * a seventh check that enumerates exported / public functions
 * (Deno-native `deno doc`, never Node tooling — #2222) and flags those
 * with no referencing test, reported alongside the existing quality
 * findings in the same audit. It adds the optional `{{COVERAGE_GAPS}}`
 * input placeholder, fed by the template's static pre-pass.
 *
 * The load-bearing worker contracts are unchanged: the `Test-Audit` H1
 * body fingerprint, the `{{SUPPRESSED_IDS}}` / `{{KNOWN_OPEN_FINDING_IDS}}`
 * / `{{ATTRIBUTION_FOOTER}}` placeholders, the `BP-<12 hex>` id recipe
 * with the `"test-audit"` discriminator, the `test-audit` / `severity:*`
 * labels, the `BP- in:body` dedup search, the hidden `<!-- finding-id:`
 * marker, and the 6-issue cap.
 *
 * Also guards immutability of v3 (Issue #235 — prompt versions are
 * immutable once shipped): v3 must NOT carry the v4 coverage-gap content.
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

Deno.test("test_audit prompt v4 - loads via loadPrompt", async () => {
  const result = await loadPrompt("test_audit", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("test_audit prompt v4 - latest version is v4 or later", async () => {
  const result = await getLatestVersion("test_audit", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected test_audit prompt >= v4, got ${result.value}`,
    );
  }
});

Deno.test(
  "test_audit prompt v4 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("test_audit", "v4", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "test_audit",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "test_audit prompt v4 - keeps the Test-Audit H1 body fingerprint",
  async () => {
    const result = await loadPrompt("test_audit", "v4", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // Dispatch routes wrapper issues by matching the prompt's H1 against
    // TEST_AUDIT_BODY_FINGERPRINT — the heading must remain intact so no
    // template / dispatch change is required (Issue #2916 acceptance).
    assert(
      TEST_AUDIT_BODY_FINGERPRINT.test(result.value),
      "v4 must keep the 'Test-Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "test_audit prompt v4 - carries the COVERAGE_GAPS and ATTRIBUTION_FOOTER placeholders",
  async () => {
    const result = await loadPrompt("test_audit", "v4", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("{{COVERAGE_GAPS}}"),
      "v4 must add the {{COVERAGE_GAPS}} placeholder",
    );
    assert(
      result.value.includes("{{ATTRIBUTION_FOOTER}}"),
      "v4 must keep the {{ATTRIBUTION_FOOTER}} placeholder",
    );
  },
);

Deno.test(
  "test_audit prompt v4 - adds the coverage-gap (check 7) detection",
  async () => {
    const result = await loadPrompt("test_audit", "v4", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const phrase of [
        "Coverage gaps", // the new concern is named
        "deno doc", // Deno-native enumeration (no Node tooling)
        "untested public", // the check's subject
        "seven-anti-pattern", // checklist grew from six to seven
      ]
    ) {
      assert(
        body.includes(phrase),
        `v4 must mention coverage-gap content: '${phrase}'`,
      );
    }
  },
);

Deno.test(
  "test_audit prompt v4 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("test_audit", "v4", PROMPTS_DIR);
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
        `v4 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "test_audit prompt v3 - immutable: does NOT carry the v4 coverage-gap content (Issue #235)",
  async () => {
    const result = await loadPrompt("test_audit", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes("{{COVERAGE_GAPS}}"),
      "v3 must remain the pre-coverage-gap prompt",
    );
  },
);
