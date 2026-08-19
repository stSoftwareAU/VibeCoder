/**
 * Tests for security_scan prompt v16 (Issue #3012).
 *
 * v16 re-maps the existing web/app vulnerability taxonomy onto the
 * **OWASP Top 10 2025** categories and names OWASP + the 2025 edition
 * explicitly:
 *
 * - The Phase-2 taxonomy is re-organised so every one of the ten 2025
 *   categories (`A01:2025` … `A10:2025`) is represented, each tied to
 *   concrete detection guidance, with a preamble stating the prompt targets
 *   the OWASP Top 10 2025 (https://owasp.org/Top10/2025/).
 * - Genuine gaps are filled: the new 2025 categories Insecure Design
 *   (A06), Security Logging & Alerting Failures (A09), and the brand-new
 *   Mishandling of Exceptional Conditions (A10) gain dedicated classes.
 * - Supply chain is mapped to A03 and cross-referenced to the dedicated
 *   `supply_chain_readiness` / `github_actions_audit` tasks, not duplicated.
 *
 * The load-bearing contracts are unchanged: the `MythOS-style Security
 * Audit` H1 fingerprint, the `{{SUPPRESSED_IDS}}` /
 * `{{KNOWN_OPEN_FINDING_IDS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders, the
 * `SEC-<12 hex>` id recipe, the `security` / `severity:*` / `confidence:*`
 * labels, the `security-scan-overflow` tracker, the 6-issue cap, the v14
 * adversarial self-verification step, and the v15 exposure ordering /
 * recalibration steps.
 *
 * Also guards immutability of v15 (Issue #235 — prompt versions are
 * immutable once shipped): v15 must not gain the OWASP 2025 mapping.
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

// The ten OWASP Top 10 2025 category id+name pairs that must each appear.
const OWASP_2025_CATEGORIES = [
  "A01:2025 — Broken Access Control",
  "A02:2025 — Security Misconfiguration",
  "A03:2025 — Software Supply Chain Failures",
  "A04:2025 — Cryptographic Failures",
  "A05:2025 — Injection",
  "A06:2025 — Insecure Design",
  "A07:2025 — Authentication Failures",
  "A08:2025 — Software or Data Integrity Failures",
  "A09:2025 — Security Logging and Alerting Failures",
  "A10:2025 — Mishandling of Exceptional Conditions",
];

Deno.test("security_scan prompt v16 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v16 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 16,
      true,
      `Expected security_scan prompt >= v16, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v16 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "security_scan",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v16 - keeps the MythOS H1 body fingerprint",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // The security-scan idle-task template routes wrapper issues by
    // matching the prompt's H1 against /^#+\s+MythOS-style Security
    // Audit\b/m — the heading must remain intact.
    assert(
      /^#+\s+MythOS-style Security Audit\b/m.test(result.value),
      "v16 must keep the 'MythOS-style Security Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "security_scan prompt v16 - names OWASP Top 10 2025 explicitly",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    assert(
      /OWASP Top 10 2025/.test(body),
      "v16 must name the OWASP Top 10 2025 explicitly",
    );
    assert(
      body.includes("https://owasp.org/Top10/2025/"),
      "v16 must cite the official OWASP Top 10 2025 source URL",
    );
  },
);

Deno.test(
  "security_scan prompt v16 - covers every OWASP Top 10 2025 category id+name",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (const category of OWASP_2025_CATEGORIES) {
      assert(
        body.includes(category),
        `v16 must represent OWASP 2025 category '${category}'`,
      );
    }
  },
);

Deno.test(
  "security_scan prompt v16 - fills the genuine 2025 gaps with detection guidance",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value.toLowerCase();
    // A06 Insecure Design — new dedicated class.
    assert(
      body.includes("insecure design") && body.includes("business-logic"),
      "v16 must add an Insecure Design (A06) class with business-logic guidance",
    );
    // A09 Security Logging and Alerting Failures — new dedicated class.
    assert(
      body.includes("logging") && body.includes("alerting"),
      "v16 must add a Security Logging & Alerting Failures (A09) class",
    );
    // A10 Mishandling of Exceptional Conditions — brand-new 2025 category.
    assert(
      body.includes("mishandling of exceptional conditions") &&
        body.includes("fail **open**".toLowerCase()),
      "v16 must add a Mishandling of Exceptional Conditions (A10) class",
    );
  },
);

Deno.test(
  "security_scan prompt v16 - SSRF audited under Broken Access Control (2025 merge)",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    // In the 2025 edition SSRF is merged into Broken Access Control.
    const a01 = body.indexOf("A01:2025");
    const a02 = body.indexOf("A02:2025");
    const ssrf = body.indexOf("**SSRF**");
    assert(
      a01 >= 0 && a02 > a01 && ssrf > a01 && ssrf < a02,
      "v16 must audit SSRF inside the A01 Broken Access Control section",
    );
  },
);

Deno.test(
  "security_scan prompt v16 - cross-references supply chain, does not duplicate",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    assert(
      body.includes("supply_chain_readiness") &&
        body.includes("github_actions_audit"),
      "v16 A03 must cross-reference the dedicated supply-chain tasks",
    );
  },
);

Deno.test(
  "security_scan prompt v16 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
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
        `v16 must retain the contract string '${contract}'`,
      );
    }
    const lower = body.toLowerCase();
    // v14 adversarial self-verification step is carried forward.
    assert(
      lower.includes("adversarially self-verify"),
      "v16 must retain the v14 adversarial self-verification step",
    );
    // v15 exposure ordering + recalibration are carried forward.
    assert(
      lower.includes("order the chunk plan by trust-boundary exposure"),
      "v16 must retain the v15 Phase 1 exposure ordering",
    );
    assert(
      lower.includes("recalibrate severity by trust-boundary exposure"),
      "v16 must retain the v15 Phase 3 severity recalibration",
    );
  },
);

Deno.test(
  "security_scan prompt v16 - keeps the four-phase structure",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const phase of [
        "## Phase 1 — Plan",
        "## Phase 2 — Per-chunk detection",
        "## Phase 3 — Triage",
        "## Phase 4 — File one issue per finding",
      ]
    ) {
      assert(body.includes(phase), `v16 must keep the heading '${phase}'`);
    }
  },
);

Deno.test(
  "security_scan prompt v15 - immutable: has no OWASP 2025 mapping (Issue #235)",
  async () => {
    const result = await loadPrompt("security_scan", "v15", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    assert(
      !body.includes("OWASP Top 10 2025"),
      "v15 must remain the pre-OWASP-2025-mapping prompt",
    );
    assert(
      !body.includes("A10:2025"),
      "v15 must not carry the OWASP 2025 category ids",
    );
  },
);
