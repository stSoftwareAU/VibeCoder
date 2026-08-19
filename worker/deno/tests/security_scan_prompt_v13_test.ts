/**
 * Tests for security_scan prompt v13 (Issue #2624).
 *
 * v13 simplifies the prompt for Fable 5: the phase-gate scaffolding
 * ("Follow the four phases below in order. Verify your own output at
 * each phase boundary…") is dropped in favour of a plain description of
 * what each phase produces, the repeated dedup / attribution-footer
 * instructions are stated once, the Phase 4 triple-negation
 * output-format rule is rephrased positively, and the detection stage is
 * made coverage-oriented (surface every candidate; rank and cap at
 * triage).
 *
 * The load-bearing contracts are unchanged: the `MythOS-style Security
 * Audit` H1 fingerprint, the `{{SUPPRESSED_IDS}}` /
 * `{{KNOWN_OPEN_FINDING_IDS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders,
 * the `SEC-<12 hex>` id recipe, the `security` / `severity:*` /
 * `confidence:*` labels, the `security-scan-overflow` tracker, and the
 * 6-issue cap.
 *
 * Also guards immutability of v12 (Issue #235 — prompt versions are
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

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("security_scan prompt v13 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v13", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v13 - latest version is v13 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 13,
      true,
      `Expected security_scan prompt >= v13, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v13 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v13", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "security_scan",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v13 - keeps the MythOS H1 body fingerprint",
  async () => {
    const result = await loadPrompt("security_scan", "v13", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // The security-scan idle-task template routes wrapper issues by
    // matching the prompt's H1 against /^#+\s+MythOS-style Security
    // Audit\b/m — the heading must remain intact.
    assert(
      /^#+\s+MythOS-style Security Audit\b/m.test(result.value),
      "v13 must keep the 'MythOS-style Security Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "security_scan prompt v13 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("security_scan", "v13", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "SEC-<12 hex>", // stable id recipe
        "security_finding_id.ts", // worker recipe reference
        "security-scan-overflow", // overflow tracker label
        "<!-- finding-id:", // hidden dedup marker
        "SEC- in:body", // live dedup search
        "severity:critical|severity:high|severity:medium|severity:low",
        "confidence:high|confidence:medium|confidence:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v13 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "security_scan prompt v13 - drops the phase-gate scaffolding sentence",
  async () => {
    const result = await loadPrompt("security_scan", "v13", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes(
        "Verify your own output at each\nphase boundary",
      ) &&
        !result.value.includes("Verify your own output at each phase boundary"),
      "v13 must drop the phase-boundary gate-keeping scaffolding",
    );
  },
);

Deno.test(
  "security_scan prompt v12 - immutable: keeps the phase-gate sentence v13 drops (Issue #235)",
  async () => {
    const result = await loadPrompt("security_scan", "v12", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("Verify your own output at each"),
      "v12 must remain the pre-simplification prompt",
    );
  },
);
