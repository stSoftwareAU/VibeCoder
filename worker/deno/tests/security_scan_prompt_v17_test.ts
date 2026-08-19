/**
 * Tests for security_scan prompt v17 (Issue #3013, parent #3009).
 *
 * v17 extends the web/app OWASP Top 10 2025 taxonomy (added in v16) with
 * the **OWASP GenAI / LLM Top 10 (2025)** risk classes, applied to repos
 * that self-identify as **LLM-using** via the shared detection rule
 * (`worker/deno/lib/llm_usage_detection.ts`):
 *
 * - A new Phase-2 taxonomy section covers all ten `LLM0N:2025` classes
 *   with detection guidance and example sinks, gated on the Phase-1
 *   LLM-usage verdict (skip on absence — precision-first).
 * - VibeCoder's four priority surfaces (untrusted issue/comment
 *   ingestion → prompt, prompt-template construction, tool-call/agent
 *   scope + label security, secret handling) are explicitly called out.
 * - The web OWASP Top 10 2025 mapping from v16 and every load-bearing
 *   worker contract are carried forward unchanged.
 *
 * Also guards immutability of v16 (Issue #235 — prompt versions are
 * immutable once shipped): v16 must not gain the LLM/GenAI classes.
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

// The ten OWASP GenAI / LLM Top 10 2025 id+name pairs that must each appear.
const LLM_2025_CATEGORIES = [
  "LLM01:2025 — Prompt Injection",
  "LLM02:2025 — Sensitive Information Disclosure",
  "LLM03:2025 — Supply Chain",
  "LLM04:2025 — Data and Model Poisoning",
  "LLM05:2025 — Improper Output Handling",
  "LLM06:2025 — Excessive Agency",
  "LLM07:2025 — System Prompt Leakage",
  "LLM08:2025 — Vector and Embedding Weaknesses",
  "LLM09:2025 — Misinformation",
  "LLM10:2025 — Unbounded Consumption",
];

// The web OWASP Top 10 2025 categories carried forward from v16.
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

Deno.test("security_scan prompt v17 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v17 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 17,
      true,
      `Expected security_scan prompt >= v17, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v17 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "security_scan",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v17 - keeps the MythOS H1 body fingerprint",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      /^#+\s+MythOS-style Security Audit\b/m.test(result.value),
      "v17 must keep the 'MythOS-style Security Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "security_scan prompt v17 - names the OWASP GenAI / LLM Top 10 2025 explicitly",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    assert(
      /OWASP GenAI \/ LLM Top 10/.test(body),
      "v17 must name the OWASP GenAI / LLM Top 10 explicitly",
    );
    assert(
      body.includes("https://genai.owasp.org/llm-top-10/"),
      "v17 must cite the official OWASP GenAI / LLM Top 10 source URL",
    );
  },
);

Deno.test(
  "security_scan prompt v17 - covers every OWASP LLM Top 10 2025 class id+name",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (const category of LLM_2025_CATEGORIES) {
      assert(
        body.includes(category),
        `v17 must represent OWASP LLM 2025 class '${category}'`,
      );
    }
  },
);

Deno.test(
  "security_scan prompt v17 - gates the LLM section on LLM-usage detection",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    const lower = body.toLowerCase();
    // The section applies only to LLM-using repos and shares the detection
    // mechanism module (not a hardcoded repo name).
    assert(
      lower.includes(
        "apply this section only when phase 1 identified the repo as llm-using",
      ),
      "v17 LLM section must be gated on the Phase-1 LLM-usage verdict",
    );
    assert(
      body.includes("worker/deno/lib/llm_usage_detection.ts"),
      "v17 must point at the shared LLM-usage detection module",
    );
    // Precision-first: skip on absence, and never key off the repo name.
    assert(
      lower.includes("skip on absence"),
      "v17 must instruct skipping the LLM section when no signal is present",
    );
    assert(
      lower.includes("no repo name is special-cased") ||
        lower.includes("never on prose, the repo **name**".toLowerCase()),
      "v17 must avoid special-casing a repo name (detection, not allowlist)",
    );
  },
);

Deno.test(
  "security_scan prompt v17 - calls out VibeCoder's four priority LLM surfaces",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    // LLM01 — untrusted issue/comment ingestion via the BOUNDARY wrap.
    assert(
      body.includes("BOUNDARY_") && body.includes("prompt_"),
      "v17 must call out untrusted ingestion → prompt (LLM01)",
    );
    // LLM06 — tool-call / agent scope + label-security enforcement.
    assert(
      body.includes("worker/deno/lib/label_security.ts"),
      "v17 must call out label-security enforcement (LLM06)",
    );
    // The four-surface block names the priority surfaces explicitly.
    const lower = body.toLowerCase();
    assert(
      lower.includes("four priority surfaces"),
      "v17 must enumerate VibeCoder's four priority LLM surfaces",
    );
    assert(
      lower.includes("secret handling"),
      "v17 must call out secret handling (LLM02)",
    );
  },
);

Deno.test(
  "security_scan prompt v17 - carries forward the web OWASP Top 10 2025 mapping",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    assert(
      /OWASP Top 10 2025/.test(body),
      "v17 must retain the web OWASP Top 10 2025 naming from v16",
    );
    assert(
      body.includes("https://owasp.org/Top10/2025/"),
      "v17 must retain the web OWASP Top 10 2025 source URL",
    );
    for (const category of OWASP_2025_CATEGORIES) {
      assert(
        body.includes(category),
        `v17 must retain web OWASP 2025 category '${category}'`,
      );
    }
  },
);

Deno.test(
  "security_scan prompt v17 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "SEC-<12 hex>",
        "security_finding_id.ts",
        "security-scan-overflow",
        "<!-- finding-id:",
        "SEC- in:body",
        "severity:critical|severity:high|severity:medium|severity:low",
        "confidence:high|confidence:medium|confidence:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v17 must retain the contract string '${contract}'`,
      );
    }
    const lower = body.toLowerCase();
    assert(
      lower.includes("adversarially self-verify"),
      "v17 must retain the v14 adversarial self-verification step",
    );
    assert(
      lower.includes("order the chunk plan by trust-boundary exposure"),
      "v17 must retain the v15 Phase 1 exposure ordering",
    );
    assert(
      lower.includes("recalibrate severity by trust-boundary exposure"),
      "v17 must retain the v15 Phase 3 severity recalibration",
    );
  },
);

Deno.test(
  "security_scan prompt v17 - keeps the four-phase structure",
  async () => {
    const result = await loadPrompt("security_scan", "v17", PROMPTS_DIR);
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
      assert(body.includes(phase), `v17 must keep the heading '${phase}'`);
    }
  },
);

Deno.test(
  "security_scan prompt v16 - immutable: has no OWASP LLM 2025 classes (Issue #235)",
  async () => {
    const result = await loadPrompt("security_scan", "v16", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    assert(
      !body.includes("LLM01:2025"),
      "v16 must remain the pre-LLM-Top-10 prompt",
    );
    assert(
      !body.includes("https://genai.owasp.org/llm-top-10/"),
      "v16 must not carry the OWASP GenAI / LLM Top 10 source URL",
    );
  },
);
