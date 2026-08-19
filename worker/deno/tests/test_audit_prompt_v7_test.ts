/**
 * Tests for test_audit prompt v7 (Issue #3605).
 *
 * v7 adopts three test-guard rules that had no counterpart in the seven
 * v6 checks, plus one guard on the checks themselves:
 *
 *   - **check 8** — state / value objects replaced by mocks instead of
 *     real constructed instances (high severity: hides field-name typos
 *     and validation errors);
 *   - **check 9** — near-duplicate test bodies differing only in
 *     input/output literals, which should be one data-driven test;
 *   - **check 10** — tests that assert a framework or language
 *     guarantee and would still pass with the project's own code deleted;
 *   - **the sacred-regression exemption** — a test reproducing a real
 *     production incident is never a check 9 or check 10 finding.
 *
 * The load-bearing worker contracts are unchanged: the `Test-Audit` H1
 * body fingerprint, the `{{SUPPRESSED_IDS}}` / `{{KNOWN_OPEN_FINDING_IDS}}`
 * / `{{COVERAGE_GAPS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders, the
 * `BP-<12 hex>` id shape with the `"test-audit"` discriminator, the
 * `test-audit` / `severity:*` labels, the `BP- in:body` dedup search, the
 * hidden `<!-- finding-id:` marker, and the 6-issue cap.
 *
 * Also guards immutability of v6 (Issue #235 — prompt versions are
 * immutable once shipped): v6 must NOT carry the v7 checks.
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

async function loadV7(): Promise<string> {
  const result = await loadPrompt("test_audit", "v7", PROMPTS_DIR);
  assert(result.ok, "test_audit v7 must load");
  return result.ok ? result.value : "";
}

Deno.test("test_audit prompt v7 - loads via loadPrompt", async () => {
  const result = await loadPrompt("test_audit", "v7", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("test_audit prompt v7 - latest version is v7 or later", async () => {
  const result = await getLatestVersion("test_audit", PROMPTS_DIR);
  assert(result.ok);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 7,
    true,
    `Expected test_audit prompt >= v7, got ${result.value}`,
  );
});

Deno.test(
  "test_audit prompt v7 - satisfies the placeholder contract",
  async () => {
    const v = validatePromptTemplate("test_audit", await loadV7());
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "test_audit prompt v7 - keeps the Test-Audit H1 body fingerprint",
  async () => {
    // Dispatch routes wrapper issues by matching the prompt's H1 against
    // TEST_AUDIT_BODY_FINGERPRINT — the heading must remain intact.
    assert(
      TEST_AUDIT_BODY_FINGERPRINT.test(await loadV7()),
      "v7 must keep the 'Test-Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "test_audit prompt v7 - carries every substituted placeholder",
  async () => {
    const body = await loadV7();
    for (
      const placeholder of [
        "{{SUPPRESSED_IDS}}",
        "{{KNOWN_OPEN_FINDING_IDS}}",
        "{{COVERAGE_GAPS}}",
        "{{ATTRIBUTION_FOOTER}}",
      ]
    ) {
      assert(
        body.includes(placeholder),
        `v7 must keep the ${placeholder} placeholder`,
      );
    }
  },
);

Deno.test(
  "test_audit prompt v7 - check 8 flags mocked state and value objects",
  async () => {
    const body = await loadV7();
    assert(
      /###\s*8\.\s*.*mock/i.test(body),
      "v7 must add check 8 for mocked state / value objects",
    );
    for (
      const phrase of [
        "DTO",
        "field-name typo",
        "builder",
      ]
    ) {
      assert(
        body.includes(phrase),
        `check 8 must mention '${phrase}'`,
      );
    }
  },
);

Deno.test(
  "test_audit prompt v7 - check 9 flags near-duplicate test bodies",
  async () => {
    const body = await loadV7();
    assert(
      /###\s*9\.\s*.*duplicate/i.test(body),
      "v7 must add check 9 for near-duplicate test bodies",
    );
    // The data-driven replacements Claude should recommend, one per
    // ecosystem the audit covers.
    for (
      const phrase of [
        "t.step",
        "parametrize",
        "test.each",
        "DataProvider",
      ]
    ) {
      assert(body.includes(phrase), `check 9 must name '${phrase}'`);
    }
    // Genuinely different tests must not be flagged.
    assert(
      /stay silent/i.test(body),
      "check 9 must instruct silence when tests genuinely differ",
    );
  },
);

Deno.test(
  "test_audit prompt v7 - check 10 flags framework / language guarantee tests",
  async () => {
    const body = await loadV7();
    assert(
      /###\s*10\.\s*.*(framework|guarantee)/i.test(body),
      "v7 must add check 10 for framework / language guarantee tests",
    );
    // The sharp detection question from the adopted rule (the prompt is
    // hard-wrapped, so match across line breaks).
    assert(
      /would still pass if every line of the project's own code\s+were\s+deleted/i
        .test(body),
      "check 10 must state the delete-the-project's-code detection test",
    );
  },
);

Deno.test(
  "test_audit prompt v7 - exempts sacred production-regression tests",
  async () => {
    const body = await loadV7();
    assert(
      /production regression tests are sacred/i.test(body),
      "v7 must carry the sacred production-regression exemption",
    );
    // The exemption must scope to the two new checks that would
    // otherwise recommend deleting an incident's regression test.
    assert(
      /never a finding under checks 9 or 10/i.test(body),
      "the exemption must name checks 9 and 10 explicitly",
    );
  },
);

Deno.test(
  "test_audit prompt v7 - counts ten audit checks throughout",
  async () => {
    const body = await loadV7();
    assert(
      body.includes("ten audit checks"),
      "v7 must describe the combined checklist as the ten audit checks",
    );
    assert(
      !body.includes("seven audit checks"),
      "v7 must not still describe seven audit checks",
    );
  },
);

Deno.test(
  "test_audit prompt v7 - adds a stable id slug per new check",
  async () => {
    const body = await loadV7();
    for (
      const slug of [
        "mocked-state-object",
        "near-duplicate-tests",
        "framework-guarantee-test",
      ]
    ) {
      assert(
        body.includes(slug),
        `v7 must list the '${slug}' audit-check slug in the id recipe`,
      );
    }
  },
);

Deno.test(
  "test_audit prompt v7 - retains the load-bearing worker contracts",
  async () => {
    const body = await loadV7();
    for (
      const contract of [
        "BP-<12 hex>", // stable id recipe shape
        '"test-audit"', // id discriminator
        "<!-- finding-id:", // hidden dedup marker
        "BP- in:body", // live dedup search
        "--label test-audit", // dedup search scope
        "best-practice-ignore", // suppression grammar
        "severity:high|severity:medium|severity:low",
        "6 findings", // hard cap
      ]
    ) {
      assert(
        body.includes(contract),
        `v7 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "test_audit prompt v6 - immutable: does NOT carry the v7 checks (Issue #235)",
  async () => {
    const result = await loadPrompt("test_audit", "v6", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    for (
      const phrase of [
        "ten audit checks",
        "mocked-state-object",
        "near-duplicate-tests",
        "framework-guarantee-test",
      ]
    ) {
      assert(
        !result.value.includes(phrase),
        `v6 must remain the pre-v7 prompt (found '${phrase}')`,
      );
    }
  },
);
