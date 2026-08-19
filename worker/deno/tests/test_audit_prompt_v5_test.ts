/**
 * Tests for test_audit prompt v5 (Issue #3479).
 *
 * v5 revises the audit's terminology to lead with industry-standard
 * software-testing language while retaining the memorable WHAT/HOW names
 * as explicitly-defined informal project aliases:
 *
 *   - **behaviour-based test** (WHAT-test) / **implementation-coupled
 *     test** (HOW-test) presented as a project heuristic, not industry
 *     taxonomy.
 *   - the combined checklist is the **seven audit checks** — checks 1–6
 *     are **test-maintainability smells**, check 7 is a **potential
 *     behavioural coverage gap** ("Potentially untested public API"),
 *     not a "test anti-pattern".
 *   - static symbol-reference results are described conservatively (no
 *     dynamically-measured-coverage claims), and generated finding
 *     titles use cautious "no direct test found" wording.
 *
 * The load-bearing worker contracts are unchanged: the `Test-Audit` H1
 * body fingerprint, the `{{SUPPRESSED_IDS}}` / `{{KNOWN_OPEN_FINDING_IDS}}`
 * / `{{COVERAGE_GAPS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders, the
 * `BP-<12 hex>` id shape with the `"test-audit"` discriminator, the
 * `test-audit` / `severity:*` labels, the `BP- in:body` dedup search, the
 * hidden `<!-- finding-id:` marker, and the 6-issue cap.
 *
 * Also guards immutability of v4 (Issue #235 — prompt versions are
 * immutable once shipped): v4 must NOT carry the v5 terminology.
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

Deno.test("test_audit prompt v5 - loads via loadPrompt", async () => {
  const result = await loadPrompt("test_audit", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("test_audit prompt v5 - latest version is v5 or later", async () => {
  const result = await getLatestVersion("test_audit", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 5,
      true,
      `Expected test_audit prompt >= v5, got ${result.value}`,
    );
  }
});

Deno.test(
  "test_audit prompt v5 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("test_audit", "v5", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "test_audit",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "test_audit prompt v5 - keeps the Test-Audit H1 body fingerprint",
  async () => {
    const result = await loadPrompt("test_audit", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // Dispatch routes wrapper issues by matching the prompt's H1 against
    // TEST_AUDIT_BODY_FINGERPRINT — the heading must remain intact so no
    // template / dispatch change is required.
    assert(
      TEST_AUDIT_BODY_FINGERPRINT.test(result.value),
      "v5 must keep the 'Test-Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "test_audit prompt v5 - carries every substituted placeholder",
  async () => {
    const result = await loadPrompt("test_audit", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    for (
      const placeholder of [
        "{{SUPPRESSED_IDS}}",
        "{{KNOWN_OPEN_FINDING_IDS}}",
        "{{COVERAGE_GAPS}}",
        "{{ATTRIBUTION_FOOTER}}",
      ]
    ) {
      assert(
        result.value.includes(placeholder),
        `v5 must keep the ${placeholder} placeholder`,
      );
    }
  },
);

Deno.test(
  "test_audit prompt v5 - leads with industry-standard terminology",
  async () => {
    const result = await loadPrompt("test_audit", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const phrase of [
        "behaviour-based test", // WHAT-test, industry term
        "implementation-coupled test", // HOW-test, industry term
        "seven audit checks", // no longer "seven anti-patterns"
        "test-maintainability smell", // checks 1–6
        "Potentially untested public API", // renamed check 7
        "static test-suite maintainability", // overall audit name
        "public API surface", // no longer just "public surface"
      ]
    ) {
      assert(
        body.includes(phrase),
        `v5 must use the industry-standard term '${phrase}'`,
      );
    }
  },
);

Deno.test(
  "test_audit prompt v5 - retains WHAT/HOW as informal project aliases",
  async () => {
    const result = await loadPrompt("test_audit", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    // WHAT-test / HOW-test remain, but explicitly framed as this audit's
    // informal names, not established industry taxonomy.
    assert(body.includes("WHAT-test"), "v5 must retain the WHAT-test alias");
    assert(body.includes("HOW-test"), "v5 must retain the HOW-test alias");
    assert(
      /informal|heuristic|in this audit|alias/i.test(body),
      "v5 must frame WHAT/HOW as an informal project heuristic",
    );
  },
);

Deno.test(
  "test_audit prompt v5 - does not claim dynamically measured coverage",
  async () => {
    const result = await loadPrompt("test_audit", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    // The static scan must describe check-7 results conservatively rather
    // than asserting categorical, measured coverage.
    assert(
      body.includes("No direct test found for public function"),
      "v5 must use cautious 'No direct test found' finding titles",
    );
    // Must not instruct categorical 'Untested public function' titling.
    assert(
      !body.includes("Untested public function"),
      "v5 must avoid categorical 'Untested public function' wording",
    );
  },
);

Deno.test(
  "test_audit prompt v5 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("test_audit", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>", // stable id recipe shape
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
        `v5 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "test_audit prompt v4 - immutable: does NOT carry the v5 terminology (Issue #235)",
  async () => {
    const result = await loadPrompt("test_audit", "v4", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes("seven audit checks"),
      "v4 must remain the pre-terminology-revision prompt",
    );
    assert(
      !result.value.includes("implementation-coupled test"),
      "v4 must remain the pre-terminology-revision prompt",
    );
  },
);
