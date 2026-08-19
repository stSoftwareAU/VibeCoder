/**
 * Tests for security_scan prompt v21 (Issue #3446, parent #3440).
 *
 * v21 adds the HTTP-protocol & authentication-protocol **depth** the
 * class-level lines only named generically, closing the coverage gap
 * against Cloudflare's `WEB-PROTOCOL-AND-AUTH.md`. Eight class groups are
 * added under a stack-gated subsection, each mapped to the OWASP Top 10
 * 2025 category it extends:
 *
 *   1. HTTP request smuggling / desync         → A05 Injection
 *   2. Web cache poisoning                      → A05 Injection
 *   3. Web cache deception                      → A02 Misconfiguration
 *   4. Host / forwarded-header trust            → A01 Broken Access Control
 *   5. JWT verification defects                 → A01 (+ A04 secret strength)
 *   6. OAuth / OIDC flow defects                → A07 Authentication Failures
 *   7. SAML assertion defects                   → A02/XXE + A07
 *   8. Session-management & password-reset      → A07 (+ A04 token entropy)
 *
 * Applicability is gated on Phase-1 stack signals (skip on absence), the
 * client-vs-server role gate is required before filing OAuth/OIDC
 * AS-side controls, and a source-visibility caveat ("requires deployment
 * testing") stops unconfirmable framing/cache findings being filed as
 * confirmed.
 *
 * v21 carries the full v20 contract forward unchanged (four-phase flow,
 * placeholders including {{LLM_GATE}}, body fingerprint, label set) and
 * does not duplicate the existing A05 CRLF or A01 SSRF/JWT lines.
 *
 * Also guards immutability of v20 (Issue #235 — prompt versions are
 * immutable once shipped): v20 must not gain the new depth subsection.
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

Deno.test("security_scan prompt v21 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v21", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v21 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 21,
      true,
      `Expected security_scan prompt >= v21, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v21 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v21", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v21 - preserves the v20 invariants (gate, taxonomy, fingerprint, labels)",
  async () => {
    const result = await loadPrompt("security_scan", "v21", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // Four-phase flow preserved.
    for (const phase of ["Plan", "Detect", "Triage", "File"]) {
      assert(body.includes(phase), `v21 must retain the ${phase} phase`);
    }

    // {{LLM_GATE}} placeholder and gate verdicts carried forward.
    assert(
      body.includes("{{LLM_GATE}}"),
      "v21 must carry the {{LLM_GATE}} placeholder forward",
    );
    assert(
      body.includes("LLM-using = YES") && body.includes("LLM-using = NO"),
      "v21 must carry the gate verdicts forward",
    );

    // Full LLM Top 10 taxonomy carried forward.
    assert(
      body.includes("OWASP GenAI / LLM Top 10") &&
        body.includes("LLM01:2025") &&
        body.includes("LLM10:2025"),
      "v21 must carry the full LLM Top 10 taxonomy forward",
    );

    // Body fingerprint (idle-task wrapper routing) unchanged.
    assert(
      SECURITY_SCAN_BODY_FINGERPRINT.test(body),
      "v21 body must still match the security-scan wrapper fingerprint",
    );

    // Required label set unchanged.
    assert(
      body.includes("security") &&
        body.includes("severity:<level>") &&
        body.includes("confidence:<level>"),
      "v21 must retain the documented label set",
    );
  },
);

Deno.test(
  "security_scan prompt v21 - adds the eight HTTP/auth-protocol class groups mapped to OWASP 2025",
  async () => {
    const result = await loadPrompt("security_scan", "v21", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // The dedicated depth subsection heading is present.
    assert(
      body.includes(
        "### HTTP-protocol & authentication-protocol depth (stack-gated)",
      ),
      "v21 must add the HTTP-protocol & auth-protocol depth subsection",
    );

    // Slice out just the new subsection so assertions are scoped to it and
    // do not accidentally match the generic class-level lines above.
    const start = body.indexOf(
      "### HTTP-protocol & authentication-protocol depth (stack-gated)",
    );
    assert(start >= 0, "depth subsection must be present");
    const end = body.indexOf(
      "### Vulnerability taxonomy — OWASP GenAI / LLM Top 10",
      start,
    );
    assert(end > start, "LLM taxonomy must follow the depth subsection");
    const depth = body.slice(start, end);

    // Each of the eight class groups, mapped to its OWASP 2025 category.
    const groups: Array<[string, RegExp]> = [
      ["smuggling/desync", /HTTP request smuggling \/ desync \(A05:2025/],
      ["cache poisoning", /Web cache poisoning \(A05:2025/],
      ["cache deception", /Web cache deception \(A02:2025/],
      [
        "host/forwarded-header trust",
        /Host \/ forwarded-header trust \(A01:2025/,
      ],
      ["JWT verification", /JWT verification defects \(A01:2025/],
      ["OAuth / OIDC flow", /OAuth \/ OIDC flow defects \(A07:2025/],
      ["SAML assertions", /SAML assertion defects \(A02:2025/],
      [
        "session + password-reset",
        /Session-management & password-reset defects \(A07:2025/,
      ],
    ];
    for (const [name, re] of groups) {
      assert(re.test(depth), `depth subsection must cover ${name}`);
    }

    // JWT + password-reset/session depth also touches A04 (token entropy).
    assert(
      /A04:2025/.test(depth),
      "token-entropy depth must map JWT/password-reset secret strength to A04",
    );

    // Concrete evidence-citable detail present (not just headings).
    assert(
      /CL\.TE/.test(depth) && /TE\.CL/.test(depth) &&
        /(H2\.CL|H2→HTTP\/1\.1)/.test(depth),
      "smuggling group must name concrete desync variants",
    );
    assert(
      /alg:none/.test(depth) && /RS256→HS256/.test(depth) &&
        /(jku|kid|x5u)/.test(depth),
      "JWT group must name concrete verification defects",
    );
    assert(
      /(XSW|signature wrapping)/.test(depth) && /InResponseTo/.test(depth),
      "SAML group must name concrete assertion defects",
    );
    assert(
      /redirect_uri/.test(depth) && /PKCE/.test(depth),
      "OAuth/OIDC group must name concrete flow defects",
    );

    // Every class in the subsection must require a citation.
    assert(/Cite/.test(depth), "depth classes must require a citation");
  },
);

Deno.test(
  "security_scan prompt v21 - gates applicability on Phase-1 stack signals and requires the OAuth role gate",
  async () => {
    const result = await loadPrompt("security_scan", "v21", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    const start = body.indexOf(
      "### HTTP-protocol & authentication-protocol depth (stack-gated)",
    );
    const end = body.indexOf(
      "### Vulnerability taxonomy — OWASP GenAI / LLM Top 10",
      start,
    );
    const depth = body.slice(start, end);

    // Stack-signal gating language (skip on absence).
    assert(
      /Phase-1 stack signals/i.test(depth) && /skip on absence/i.test(depth),
      "depth subsection must gate on Phase-1 stack signals and skip on absence",
    );
    assert(
      /HTTP-framing signals/.test(depth) && /Auth-protocol signals/.test(depth),
      "depth subsection must name the framing and auth-protocol gating signals",
    );

    // A repo without the surface stays silent (concrete non-applicable examples).
    assert(
      /(Rust batch job|Apps Script|static dashboard)/.test(depth),
      "depth subsection must name a non-applicable example that stays silent",
    );

    // Source-visibility caveat: unconfirmable framing/cache findings are not filed.
    assert(
      /requires deployment testing/.test(depth),
      "depth subsection must carry the 'requires deployment testing' caveat",
    );
    assert(
      /not.*file it as a confirmed finding/is.test(depth),
      "source-visibility caveat must forbid filing unconfirmable findings as confirmed",
    );

    // Client-vs-server role establishment required before OAuth/OIDC filing.
    assert(
      /client-vs-server role first \(required\)/.test(depth),
      "OAuth/OIDC group must require client-vs-server role establishment first",
    );
    assert(
      /authorisation server owns/.test(depth),
      "role gate must warn against faulting a client for AS-side controls",
    );
  },
);

Deno.test(
  "security_scan prompt v21 - does not duplicate the existing A05 CRLF or A01 SSRF/JWT lines",
  async () => {
    const result = await loadPrompt("security_scan", "v21", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // Extend-don't-fork: the pre-existing generic lines stay single-occurrence.
    assertEquals(
      countOccurrences(body, "header injection (CRLF)"),
      1,
      "the A05 CRLF line must not be duplicated by the smuggling depth class",
    );
    assertEquals(
      countOccurrences(body, "outbound HTTP to a user-controlled URL"),
      1,
      "the A01 SSRF line must not be duplicated",
    );
    assertEquals(
      countOccurrences(body, "none-alg, no expiry, predictable IDs"),
      1,
      "the A01 JWT line must not be duplicated by the JWT verification depth class",
    );
  },
);

Deno.test(
  "security_scan prompt v20 - does NOT carry the new depth subsection (immutability)",
  async () => {
    const result = await loadPrompt("security_scan", "v20", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(
      result.value.includes(
        "### HTTP-protocol & authentication-protocol depth (stack-gated)",
      ),
      false,
      "v20 must remain frozen — the HTTP/auth-protocol depth is a v21 addition",
    );
  },
);
