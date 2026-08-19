/**
 * Tests for security_scan prompt v19 (Issue #3020, parent #3009).
 *
 * v19 strengthens the OWASP A09:2025 (Security Logging and Alerting
 * Failures) section with concrete, evidence-citable static signals:
 * silently swallowed auth/authz denials, privileged endpoints with no
 * audit-log call, logging frameworks configured to drop security events,
 * secrets/PII in logs (cross-referenced to A04, filed once), and log
 * sinks with no integrity protection. Guidance stays precision-first
 * (skip on absence, no blanket "no logging found" finding).
 *
 * v19 carries the full v18 contract forward unchanged (four-phase flow,
 * placeholders including {{LLM_GATE}}, body fingerprint, label set).
 *
 * Also guards immutability of v18 (Issue #235 — prompt versions are
 * immutable once shipped): v18 must not gain the expanded A09 signals.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { SECURITY_SCAN_BODY_FINGERPRINT } from "../lib/idle_task_templates/security_scan_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("security_scan prompt v19 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v19", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v19 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 19,
      true,
      `Expected security_scan prompt >= v19, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v19 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v19", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v19 - preserves the v18 invariants (gate, taxonomy, fingerprint, labels)",
  async () => {
    const result = await loadPrompt("security_scan", "v19", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // Four-phase flow preserved.
    for (const phase of ["Plan", "Detect", "Triage", "File"]) {
      assert(body.includes(phase), `v19 must retain the ${phase} phase`);
    }

    // {{LLM_GATE}} placeholder and gate verdicts carried forward from v18.
    assert(
      body.includes("{{LLM_GATE}}"),
      "v19 must carry the {{LLM_GATE}} placeholder forward",
    );
    assert(
      body.includes("LLM-using = YES") && body.includes("LLM-using = NO"),
      "v19 must carry the gate verdicts forward",
    );

    // Full LLM Top 10 taxonomy carried forward.
    assert(
      body.includes("OWASP GenAI / LLM Top 10") &&
        body.includes("LLM01:2025") &&
        body.includes("LLM10:2025"),
      "v19 must carry the full LLM Top 10 taxonomy forward",
    );

    // Body fingerprint (idle-task wrapper routing) unchanged.
    assert(
      SECURITY_SCAN_BODY_FINGERPRINT.test(body),
      "v19 body must still match the security-scan wrapper fingerprint",
    );

    // Required label set unchanged.
    assert(
      body.includes("security") &&
        body.includes("severity:<level>") &&
        body.includes("confidence:<level>"),
      "v19 must retain the documented label set",
    );
  },
);

Deno.test(
  "security_scan prompt v19 - expands the A09 logging/alerting coverage",
  async () => {
    const result = await loadPrompt("security_scan", "v19", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // The A09 heading is retained.
    assert(
      body.includes("A09:2025 — Security Logging and Alerting Failures"),
      "v19 must retain the A09 section heading",
    );

    // Slice out just the A09 section so assertions are scoped to it.
    const a09Start = body.indexOf(
      "#### A09:2025 — Security Logging and Alerting Failures",
    );
    assert(a09Start >= 0, "A09 section must be present");
    const a10Start = body.indexOf("#### A10:2025", a09Start);
    assert(a10Start > a09Start, "A10 section must follow A09");
    const a09 = body.slice(a09Start, a10Start);

    // Each concrete static signal from the acceptance criteria.
    assert(
      /catch|except|rescue/.test(a09) &&
        /denial|forbidden|unauthor/i.test(a09),
      "A09 must cover swallowed auth/authz denials",
    );
    assert(
      /audit.?log/i.test(a09) &&
        /(privileged|state-changing)/i.test(a09),
      "A09 must cover privileged/state-changing endpoints with no audit-log call",
    );
    assert(
      /(level|appender|handler|sink)/i.test(a09) &&
        /(drop|disabled|above|null)/i.test(a09),
      "A09 must cover a logging framework configured to drop security events",
    );
    assert(
      /(secret|PII|credential|token)/i.test(a09) &&
        /A04/.test(a09) &&
        /once/i.test(a09),
      "A09 must cross-reference A04 for secrets/PII in logs and file it once",
    );
    assert(
      /integrity/i.test(a09) && /(forge|erase|tamper)/i.test(a09),
      "A09 must cover log sinks with no integrity protection",
    );

    // Precision-first posture: skip on absence, no blanket finding.
    assert(
      /skip on absence/i.test(a09),
      "A09 must keep the precision-first skip-on-absence posture",
    );
    assert(
      /blanket/i.test(a09) && /no logging found/i.test(a09),
      "A09 must forbid a blanket 'no logging found' finding",
    );
    assert(
      /cite/i.test(a09),
      "A09 must require every finding to cite a concrete code path",
    );
  },
);

Deno.test(
  "security_scan prompt v18 - does NOT carry the expanded A09 signals (immutability)",
  async () => {
    const result = await loadPrompt("security_scan", "v18", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(
      result.value.includes("Silently swallowed auth/authz denial"),
      false,
      "v18 must remain frozen — the expanded A09 signals are a v19 addition",
    );
  },
);
