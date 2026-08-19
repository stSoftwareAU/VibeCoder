/**
 * Tests for security_scan prompt v24 (Issue #3449, parent #3440).
 *
 * v24 adds the **feature-abuse & data-leakage** design lens, closing the gap
 * against Cloudflare's `security-audit-skill` `ATTACK-CLASSES.md` class 6
 * ("Feature abuse and data leakage" — *don't look for bugs in the code, look
 * for bugs in the design*). Six classes that hunt legitimate features used
 * for unintended purposes are added under a single stack-gated subsection,
 * each mapped to the OWASP Top 10 2025 category it extends (A01 Broken Access
 * Control, which absorbs SSRF in 2025, and A06 Insecure Design):
 *
 *   1. Export / backup as exfiltration      → A01 (extends A06)
 *   2. Import / restore as injection         → A01 (extends A06)
 *   3. Search / filter / sort as oracle      → A01
 *   4. Enumeration through side effects      → A01 (A07 cross-ref)
 *   5. Preview / draft / staging leakage     → A01
 *   6. Notification / webhook as SSRF        → A01 (SSRF, cross-linked)
 *
 * Applicability is gated on Phase-1 multi-user/tenant feature signals
 * (auth/session modules, tenant-scoping code, export/import/search endpoints,
 * user-configurable webhook/callback URLs) and skips on absence, so a
 * single-tenant internal batch job or a static site stays silent. The
 * design-lens discipline is ported: cite the concrete code path and the
 * boundary the feature crosses, and trace the impact before reporting (a flag
 * is not a finding). The webhook-SSRF class cross-links the A01 SSRF line
 * rather than double-filing it.
 *
 * v24 carries the full v23 contract forward unchanged (four-phase flow,
 * placeholders including {{LLM_GATE}}, body fingerprint, label set, the v21
 * HTTP/auth-protocol depth subsection, the v22 literal sweep, and the v23
 * client-side subsection) and does not duplicate the existing A01 SSRF or A06
 * insecure-design lines — it extends them.
 *
 * Also guards immutability of v23 (Issue #235 — prompt versions are immutable
 * once shipped): v23 must not gain the new feature-abuse block.
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

const FEATURE_HEADING =
  "### Feature-abuse & data-leakage design lens (stack-gated)";

/** Count non-overlapping occurrences of a literal substring. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

/**
 * Slice out just the new feature-abuse subsection, with whitespace collapsed
 * to single spaces so the prose-marker assertions below are robust to
 * `deno fmt` reflowing a phrase across a line break.
 */
function featureSection(body: string): string {
  const start = body.indexOf(FEATURE_HEADING);
  assert(start >= 0, "feature-abuse subsection must be present");
  const end = body.indexOf(
    "### Vulnerability taxonomy — OWASP GenAI / LLM Top 10",
    start,
  );
  assert(end > start, "LLM taxonomy must follow the feature-abuse subsection");
  return body.slice(start, end).replace(/\s+/g, " ");
}

Deno.test("security_scan prompt v24 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v24", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v24 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 24,
      true,
      `Expected security_scan prompt >= v24, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v24 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v24", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v24 - preserves the v23 invariants (gate, taxonomy, sweeps, fingerprint, labels)",
  async () => {
    const result = await loadPrompt("security_scan", "v24", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // Four-phase flow preserved.
    for (const phase of ["Plan", "Detect", "Triage", "File"]) {
      assert(body.includes(phase), `v24 must retain the ${phase} phase`);
    }

    // {{LLM_GATE}} placeholder and gate verdicts carried forward.
    assert(
      body.includes("{{LLM_GATE}}"),
      "v24 must carry the {{LLM_GATE}} placeholder forward",
    );
    assert(
      body.includes("LLM-using = YES") && body.includes("LLM-using = NO"),
      "v24 must carry the gate verdicts forward",
    );

    // Full LLM Top 10 taxonomy carried forward.
    assert(
      body.includes("OWASP GenAI / LLM Top 10") &&
        body.includes("LLM01:2025") &&
        body.includes("LLM10:2025"),
      "v24 must carry the full LLM Top 10 taxonomy forward",
    );

    // The v21 HTTP/auth-protocol depth subsection is carried forward.
    assert(
      body.includes(
        "### HTTP-protocol & authentication-protocol depth (stack-gated)",
      ),
      "v24 must carry the v21 HTTP/auth-protocol depth subsection forward",
    );

    // The v22 "obvious things" literal sweep is carried forward.
    assert(
      body.includes(
        '### "Obvious things" literal sweep (universally applicable)',
      ),
      "v24 must carry the v22 literal-sweep subsection forward",
    );

    // The v23 client-side subsection is carried forward.
    assert(
      body.includes(
        "### Client-side / browser attack classes (stack-gated)",
      ),
      "v24 must carry the v23 client-side subsection forward",
    );

    // Body fingerprint (idle-task wrapper routing) unchanged.
    assert(
      SECURITY_SCAN_BODY_FINGERPRINT.test(body),
      "v24 body must still match the security-scan wrapper fingerprint",
    );

    // Required label set unchanged.
    assert(
      body.includes("security") &&
        body.includes("severity:<level>") &&
        body.includes("confidence:<level>"),
      "v24 must retain the documented label set",
    );
  },
);

Deno.test(
  "security_scan prompt v24 - adds the six feature-abuse / data-leakage classes mapped to OWASP 2025",
  async () => {
    const result = await loadPrompt("security_scan", "v24", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const feature = featureSection(result.value);

    // Each of the six feature-abuse classes, mapped to its OWASP 2025 category.
    const checks: Array<[string, RegExp]> = [
      [
        "export / backup as exfiltration",
        /Export \/ backup as exfiltration \(A01:2025/,
      ],
      [
        "import / restore as injection",
        /Import \/ restore as injection \(A01:2025/,
      ],
      [
        "search / filter / sort as oracle",
        /Search \/ filter \/ sort as oracle \(A01:2025/,
      ],
      [
        "enumeration through side effects",
        /Enumeration through side effects \(A01:2025/,
      ],
      [
        "preview / draft / staging leakage",
        /Preview \/ draft \/ staging leakage \(A01:2025/,
      ],
      [
        "notification / webhook as SSRF",
        /Notification \/ webhook as SSRF \(A01:2025/,
      ],
    ];
    for (const [name, re] of checks) {
      assert(re.test(feature), `feature-abuse subsection must cover ${name}`);
    }

    // Concrete evidence-citable markers, not just headings.
    assert(
      /other users' or other tenants' data/.test(feature) &&
        /deleted \/ draft \/ pruned/.test(feature),
      "export class must name over-scope data (other tenants, deleted/draft)",
    );
    assert(
      /does restore respect the UI's permission model/.test(feature),
      "import class must ask whether restore respects the UI permission model",
    );
    assert(
      /sort-by-hidden-field/.test(feature) &&
        /reveals whether inaccessible content \*\*exists\*\*/.test(feature),
      "search-oracle class must name sort-by-hidden-field and existence leakage",
    );
    assert(
      /distinguishes "doesn't exist" from "no access"/.test(feature) &&
        /password-reset \/ invite \/ registration/.test(feature),
      "enumeration class must name the doesn't-exist vs no-access delta and reset/invite flows",
    );
    assert(
      /sitemap/.test(feature) && /preview token/.test(feature) &&
        /CDN/.test(feature),
      "preview class must name preview tokens, sitemap discovery, and CDN caching",
    );
    assert(
      /169\.254\.169\.254/.test(feature) &&
        /not re-validated after a redirect/.test(feature),
      "webhook-SSRF class must name metadata IP and post-redirect re-validation",
    );
  },
);

Deno.test(
  "security_scan prompt v24 - gates on Phase-1 multi-user/tenant signals and skips on absence",
  async () => {
    const result = await loadPrompt("security_scan", "v24", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const feature = featureSection(result.value);

    // Stack-gated on Phase-1 multi-user/tenant feature signals, skip on absence.
    assert(
      /Applicability gate/i.test(feature) &&
        /Phase-1 multi-user\/tenant feature signals/i.test(feature) &&
        /skip on absence/i.test(feature),
      "feature-abuse subsection must gate on Phase-1 multi-user/tenant signals and skip on absence",
    );

    // Concrete feature signals named.
    assert(
      /tenant-scoping/.test(feature) && /webhook/.test(feature) &&
        /export/.test(feature),
      "feature-abuse gate must name concrete multi-user/tenant feature signals",
    );

    // Single-tenant / no-feature-surface repos stay silent.
    assert(
      /single-tenant/i.test(feature) &&
        /stays silent/i.test(feature),
      "feature-abuse subsection must state single-tenant repos stay silent",
    );
  },
);

Deno.test(
  "security_scan prompt v24 - ports the design-lens discipline (cite code path, trace impact)",
  async () => {
    const result = await loadPrompt("security_scan", "v24", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const feature = featureSection(result.value);

    // Design review, not a code-smell grep.
    assert(
      /design\*\* review, not a code-smell grep/i.test(feature),
      "feature-abuse subsection must frame itself as a design review, not a grep",
    );

    // Cite the concrete code path and the boundary crossed.
    assert(
      /cite the concrete\s+\*\*code path\*\*/i.test(feature) &&
        /boundary the feature\s+crosses/i.test(feature),
      "feature-abuse subsection must require citing the code path and the boundary crossed",
    );

    // Trace impact before reporting — a flag is not a finding.
    assert(
      /Trace the impact\s+before reporting/i.test(feature) &&
        /a flag is not a finding/i.test(feature),
      "feature-abuse subsection must require tracing impact (a flag is not a finding)",
    );

    // Extends, not forks, the existing A01/A06 lines.
    assert(
      /extend them, never fork them/i.test(feature),
      "feature-abuse subsection must extend the existing A01/A06 lines",
    );
  },
);

Deno.test(
  "security_scan prompt v24 - webhook SSRF cross-links A01 rather than double-filing",
  async () => {
    const result = await loadPrompt("security_scan", "v24", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const feature = featureSection(result.value);

    assert(
      /cross-reference the A01 SSRF line, do not duplicate/i.test(feature),
      "webhook-SSRF class heading must cross-reference the A01 SSRF line",
    );
    assert(
      /cross-link A01, do not double-file/i.test(feature),
      "webhook-SSRF class must instruct cross-linking A01, not double-filing",
    );
  },
);

Deno.test(
  "security_scan prompt v24 - does not duplicate the generic A01 SSRF line",
  async () => {
    const result = await loadPrompt("security_scan", "v24", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // The pre-existing generic A01 SSRF taxonomy line stays single-occurrence.
    assertEquals(
      countOccurrences(
        body,
        "**SSRF** — outbound HTTP to a user-controlled URL",
      ),
      1,
      "the generic A01 SSRF line must not be duplicated by the feature-abuse subsection",
    );
  },
);

Deno.test(
  "security_scan prompt v23 - does NOT carry the new feature-abuse block (immutability)",
  async () => {
    const result = await loadPrompt("security_scan", "v23", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(
      result.value.includes(FEATURE_HEADING),
      false,
      "v23 must remain frozen — the feature-abuse attack-class block is a v24 addition",
    );
  },
);
