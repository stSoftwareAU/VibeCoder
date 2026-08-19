/**
 * Tests for security_scan prompt v14 (Issue #2844).
 *
 * v14 adds an adversarial self-verification step to Phase 3 ("Triage").
 * Detection (Phase 2) and triage (Phase 3) run in one agent context, so a
 * plausible-but-wrong candidate can survive on its own framing. v14 adds a
 * single, static refute-or-lower-confidence pass: for each surviving
 * candidate, re-open the cited file and attempt to refute reachability from
 * the static evidence alone — cannot refute → keep; partially refuted →
 * lower `confidence`; refuted → drop. Static-only, single iteration.
 *
 * The load-bearing contracts are unchanged: the `MythOS-style Security
 * Audit` H1 fingerprint, the `{{SUPPRESSED_IDS}}` /
 * `{{KNOWN_OPEN_FINDING_IDS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders, the
 * `SEC-<12 hex>` id recipe, the `security` / `severity:*` / `confidence:*`
 * labels, the `security-scan-overflow` tracker, and the 6-issue cap.
 *
 * Also guards immutability of v13 (Issue #235 — prompt versions are
 * immutable once shipped): v13 must not gain the new self-verification step.
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

Deno.test("security_scan prompt v14 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v14", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v14 - latest version is v14 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 14,
      true,
      `Expected security_scan prompt >= v14, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v14 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v14", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "security_scan",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v14 - keeps the MythOS H1 body fingerprint",
  async () => {
    const result = await loadPrompt("security_scan", "v14", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // The security-scan idle-task template routes wrapper issues by
    // matching the prompt's H1 against /^#+\s+MythOS-style Security
    // Audit\b/m — the heading must remain intact.
    assert(
      /^#+\s+MythOS-style Security Audit\b/m.test(result.value),
      "v14 must keep the 'MythOS-style Security Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "security_scan prompt v14 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("security_scan", "v14", PROMPTS_DIR);
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
        `v14 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "security_scan prompt v14 - Phase 3 adds the adversarial self-verification step",
  async () => {
    const result = await loadPrompt("security_scan", "v14", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value.toLowerCase();
    // The new step must describe a refute-based triage pass.
    assert(
      body.includes("adversarially self-verify") ||
        body.includes("self-verify"),
      "v14 Phase 3 must include an adversarial self-verification step",
    );
    assert(
      body.includes("refute"),
      "v14 Phase 3 must instruct the auditor to attempt to refute each finding",
    );
    // The three verdicts: keep / lower confidence / drop.
    assert(
      body.includes("cannot refute"),
      "v14 must describe the 'cannot refute → keep' outcome",
    );
    assert(
      body.includes("partially refuted"),
      "v14 must describe the 'partially refuted → lower confidence' outcome",
    );
    assert(
      body.includes("lower") && body.includes("confidence"),
      "v14 must instruct lowering confidence on a partial refutation",
    );
  },
);

Deno.test(
  "security_scan prompt v14 - self-verification is static-only and single-iteration",
  async () => {
    const result = await loadPrompt("security_scan", "v14", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // Collapse whitespace so line-wrapping in the prompt does not split
    // load-bearing phrases like "do not iterate".
    const body = result.value.toLowerCase().replace(/\s+/g, " ");
    // Issue #2844 scope: no sandbox, fuzzing, or dynamic execution.
    assert(
      body.includes("static only") || body.includes("static-only"),
      "v14 must mark the self-verification as static-only",
    );
    assert(
      body.includes("no code execution") ||
        body.includes("no fuzzing") ||
        body.includes("no dynamic"),
      "v14 must forbid dynamic execution in the self-verification step",
    );
    assert(
      body.includes("single") && body.includes("do not iterate"),
      "v14 must bound the self-verification to a single iteration",
    );
  },
);

Deno.test(
  "security_scan prompt v13 - immutable: has no self-verification step (Issue #235)",
  async () => {
    const result = await loadPrompt("security_scan", "v13", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.toLowerCase().includes("adversarially self-verify"),
      "v13 must remain the pre-self-verification prompt",
    );
  },
);
