/**
 * Tests for security_scan prompt v15 (Issue #2853).
 *
 * v15 makes the audit exposure-aware in two places:
 *
 * - **Phase 1** orders the chunk plan by trust-boundary exposure so the
 *   highest-exposure boundaries (internet-facing / unauthenticated /
 *   untrusted-input-first) are audited before low-exposure internal ones.
 *   The ordering is a priority hint only — no chunk is dropped.
 * - **Phase 3** adds a severity-recalibration step that re-weights each
 *   surviving finding's severity against the exposure band of the trust
 *   boundary it sits on (raise on an unauthenticated internet-facing route,
 *   lower behind an internal-only boundary). At most a one-level adjustment,
 *   static-only.
 *
 * The load-bearing contracts are unchanged: the `MythOS-style Security
 * Audit` H1 fingerprint, the `{{SUPPRESSED_IDS}}` /
 * `{{KNOWN_OPEN_FINDING_IDS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders, the
 * `SEC-<12 hex>` id recipe, the `security` / `severity:*` / `confidence:*`
 * labels, the `security-scan-overflow` tracker, the 6-issue cap, and the
 * v14 adversarial self-verification step.
 *
 * Also guards immutability of v14 (Issue #235 — prompt versions are
 * immutable once shipped): v14 must not gain the new exposure steps.
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

Deno.test("security_scan prompt v15 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v15", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v15 - latest version is v15 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 15,
      true,
      `Expected security_scan prompt >= v15, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v15 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v15", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "security_scan",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v15 - keeps the MythOS H1 body fingerprint",
  async () => {
    const result = await loadPrompt("security_scan", "v15", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // The security-scan idle-task template routes wrapper issues by
    // matching the prompt's H1 against /^#+\s+MythOS-style Security
    // Audit\b/m — the heading must remain intact.
    assert(
      /^#+\s+MythOS-style Security Audit\b/m.test(result.value),
      "v15 must keep the 'MythOS-style Security Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "security_scan prompt v15 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("security_scan", "v15", PROMPTS_DIR);
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
        `v15 must retain the contract string '${contract}'`,
      );
    }
    // v14 adversarial self-verification step is carried forward.
    assert(
      body.toLowerCase().includes("adversarially self-verify"),
      "v15 must retain the v14 adversarial self-verification step",
    );
  },
);

Deno.test(
  "security_scan prompt v15 - Phase 1 orders the chunk plan by exposure",
  async () => {
    const result = await loadPrompt("security_scan", "v15", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value.toLowerCase();
    assert(
      body.includes("order the chunk plan by trust-boundary exposure"),
      "v15 Phase 1 must order the chunk plan by trust-boundary exposure",
    );
    // Highest-exposure-first ordering must be described.
    assert(
      body.includes("internet-facing") && body.includes("unauthenticated"),
      "v15 must rank internet-facing / unauthenticated boundaries highest",
    );
    assert(
      body.includes("untrusted-input-first"),
      "v15 must order untrusted-input-first within an exposure band",
    );
    // The ordering must not drop any chunk — it is a priority hint only.
    assert(
      body.includes("does **not** drop any chunk".toLowerCase()) ||
        body.includes("does not drop any chunk"),
      "v15 chunk ordering must remain a priority hint that drops no chunk",
    );
  },
);

Deno.test(
  "security_scan prompt v15 - Phase 3 recalibrates severity by exposure",
  async () => {
    const result = await loadPrompt("security_scan", "v15", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // Collapse whitespace so line-wrapping does not split phrases.
    const body = result.value.toLowerCase().replace(/\s+/g, " ");
    assert(
      body.includes("recalibrate severity by trust-boundary exposure"),
      "v15 Phase 3 must add a severity-recalibration step keyed to exposure",
    );
    // Raise on an unauthenticated internet-facing route; lower behind an
    // internal boundary.
    assert(
      body.includes("raise it one level"),
      "v15 must raise severity for an exposed unauthenticated boundary",
    );
    assert(
      body.includes("lower the severity one level"),
      "v15 must lower severity for an internal-only boundary",
    );
    // KISS: bounded to a single one-level adjustment, static-only.
    assert(
      body.includes("one-level") && body.includes("never above `critical`"),
      "v15 must cap the recalibration at one level, never above critical",
    );
    assert(
      body.includes("never below `low`"),
      "v15 must floor the recalibration at low",
    );
  },
);

Deno.test(
  "security_scan prompt v15 - exposure steps are static-only (no dynamic analysis)",
  async () => {
    const result = await loadPrompt("security_scan", "v15", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value.toLowerCase().replace(/\s+/g, " ");
    // Issue #2853 scope: prompt-level, static-only — no sandbox, fuzzing,
    // or dynamic execution introduced by the new steps.
    assert(
      body.includes("static only") || body.includes("static-only"),
      "v15 exposure recalibration must be static-only",
    );
  },
);

Deno.test(
  "security_scan prompt v14 - immutable: has no exposure recalibration step (Issue #235)",
  async () => {
    const result = await loadPrompt("security_scan", "v14", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value.toLowerCase();
    assert(
      !body.includes("recalibrate severity by trust-boundary exposure"),
      "v14 must remain the pre-exposure-recalibration prompt",
    );
    assert(
      !body.includes("order the chunk plan by trust-boundary exposure"),
      "v14 must not order the chunk plan by exposure",
    );
  },
);
