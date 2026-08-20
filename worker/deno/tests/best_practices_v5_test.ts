/**
 * Tests for best_practices prompt v5 (, follow-up to).
 *
 * v5 applies the Fable-5 simplification recipe: the Hard Constraints are
 * stated once, a phase-output description list is added, the Phase 2
 * recall-suppressing "prefer the smallest, most actionable finding" tone
 * is replaced with coverage-oriented language (surface every candidate;
 * rank and cap at triage), and the Phase 4 triple-negation output rule is
 * rephrased positively.
 *
 * The load-bearing worker contracts are unchanged: the `Best-Practices
 * Review` H1 body fingerprint, the `{{BUCKET}}` / `{{SUPPRESSED_IDS}}` /
 * `{{KNOWN_OPEN_FINDING_IDS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders,
 * the `BP-<12 hex>` id recipe, the `best-practices` / `lang:<bucket>` /
 * `severity:*` labels, the `BP- in:body` dedup search, the hidden
 * `<!-- finding-id:` marker, the `best-practice-ignore` suppression
 * grammar, and the 6-issue cap.
 *
 * Also guards immutability of v4.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { BEST_PRACTICES_BODY_FINGERPRINT } from "../lib/idle_task_templates/best_practices_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("best_practices prompt v5 - loads via loadPrompt", async () => {
  const result = await loadPrompt("best_practices", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("best_practices prompt v5 - latest version is v5 or later", async () => {
  const result = await getLatestVersion("best_practices", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 5,
      true,
      `Expected best_practices prompt >= v5, got ${result.value}`,
    );
  }
});

Deno.test(
  "best_practices prompt v5 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("best_practices", "v5", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "best_practices",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "best_practices prompt v5 - keeps the Best-Practices Review H1 body fingerprint",
  async () => {
    const result = await loadPrompt("best_practices", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      BEST_PRACTICES_BODY_FINGERPRINT.test(result.value),
      "v5 must keep the 'Best-Practices Review' H1 fingerprint",
    );
  },
);

Deno.test(
  "best_practices prompt v5 - carries the BUCKET and ATTRIBUTION_FOOTER placeholders",
  async () => {
    const result = await loadPrompt("best_practices", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(result.value.includes("{{BUCKET}}"), "v5 must keep {{BUCKET}}");
    assert(
      result.value.includes("{{ATTRIBUTION_FOOTER}}"),
      "v5 must keep {{ATTRIBUTION_FOOTER}}",
    );
  },
);

Deno.test(
  "best_practices prompt v5 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("best_practices", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>", // stable id recipe
        "<!-- finding-id:", // hidden dedup marker
        "BP- in:body", // live dedup search
        "--label best-practices", // dedup search scope
        "best-practice-ignore", // suppression grammar
        "suppression_comments.ts",
        "lang:{{BUCKET}}", // per-finding language label
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
  "best_practices prompt v5 - retains all three cross-bucket sections",
  async () => {
    const result = await loadPrompt("best_practices", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    for (
      const heading of [
        "### Cross-bucket: supply-chain hardening",
        "### Cross-bucket: dead dependencies",
        "### Cross-bucket: deprecated config on framework bump",
      ]
    ) {
      assert(
        result.value.includes(heading),
        `v5 must retain heading '${heading}'`,
      );
    }
  },
);

Deno.test(
  "best_practices prompt v5 - drops the recall-suppressing 'prefer the smallest' tone",
  async () => {
    const result = await loadPrompt("best_practices", "v5", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes("Prefer the smallest, most actionable finding"),
      "v5 must drop the recall-suppressing Phase 2 tone",
    );
  },
);

Deno.test(
  "best_practices prompt v4 - immutable: keeps the 'prefer the smallest' tone v5 drops",
  async () => {
    const result = await loadPrompt("best_practices", "v4", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("Prefer the smallest, most actionable finding"),
      "v4 must remain the pre-simplification prompt",
    );
  },
);
