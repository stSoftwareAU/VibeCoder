/**
 * Tests for security_scan prompt v23 (Issue #3447, parent #3440).
 *
 * v23 adds the **client-side / browser** attack classes, closing the gap
 * against Cloudflare's `security-audit-skill` `CLIENT-SIDE.md`. Nine
 * classes that only exist in code the server never executes are added under
 * a single stack-gated subsection, each mapped to the OWASP Top 10 2025
 * category it extends:
 *
 *   1. DOM-based XSS (client source→sink)      → A05 Injection
 *   2. DOM clobbering                           → A05 Injection
 *   3. postMessage origin trust                 → A05 Injection
 *   4. Cross-site WebSocket hijacking (CSWSH)   → A05 Injection
 *   5. CORS reflection with credentials         → A02 Misconfiguration
 *   6. Clickjacking                             → A02 Misconfiguration
 *   7. Reverse tabnabbing                       → A02 Misconfiguration
 *   8. Client-side open redirect / navigation   → A05 Injection
 *   9. Prototype pollution + gadget chain       → A05 (extends A08)
 *
 * Applicability is gated on Phase-1 browser-code signals (front-end
 * framework manifests, `.jsx`/`.tsx`/`.html` with DOM sinks, extension
 * manifests) and skips on absence, so a backend-only Deno/Rust service or
 * an Apps Script batch job stays silent. The precision rules are ported:
 * require a controllable client SOURCE and an executing SINK; framework
 * auto-escaping is a real mitigation (find the opt-out); a missing
 * header/attribute is only a finding with a concrete sensitive action
 * behind it; prototype pollution requires the recursive write AND a
 * reachable gadget.
 *
 * v23 carries the full v22 contract forward unchanged (four-phase flow,
 * placeholders including {{LLM_GATE}}, body fingerprint, label set, the
 * v21 HTTP/auth-protocol depth subsection, and the v22 literal sweep) and
 * does not duplicate the existing A05 DOM-XSS or A08 prototype-pollution
 * one-liners — it extends them.
 *
 * Also guards immutability of v22 (Issue #235 — prompt versions are
 * immutable once shipped): v22 must not gain the new client-side block.
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

const CLIENT_HEADING = "### Client-side / browser attack classes (stack-gated)";

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
 * Slice out just the new client-side subsection, with whitespace collapsed
 * to single spaces so the prose-marker assertions below are robust to
 * `deno fmt` reflowing a phrase across a line break.
 */
function clientSection(body: string): string {
  const start = body.indexOf(CLIENT_HEADING);
  assert(start >= 0, "client-side subsection must be present");
  const end = body.indexOf(
    "### Vulnerability taxonomy — OWASP GenAI / LLM Top 10",
    start,
  );
  assert(end > start, "LLM taxonomy must follow the client-side subsection");
  return body.slice(start, end).replace(/\s+/g, " ");
}

Deno.test("security_scan prompt v23 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v23", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v23 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 23,
      true,
      `Expected security_scan prompt >= v23, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v23 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v23", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v23 - preserves the v22 invariants (gate, taxonomy, sweeps, fingerprint, labels)",
  async () => {
    const result = await loadPrompt("security_scan", "v23", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // Four-phase flow preserved.
    for (const phase of ["Plan", "Detect", "Triage", "File"]) {
      assert(body.includes(phase), `v23 must retain the ${phase} phase`);
    }

    // {{LLM_GATE}} placeholder and gate verdicts carried forward.
    assert(
      body.includes("{{LLM_GATE}}"),
      "v23 must carry the {{LLM_GATE}} placeholder forward",
    );
    assert(
      body.includes("LLM-using = YES") && body.includes("LLM-using = NO"),
      "v23 must carry the gate verdicts forward",
    );

    // Full LLM Top 10 taxonomy carried forward.
    assert(
      body.includes("OWASP GenAI / LLM Top 10") &&
        body.includes("LLM01:2025") &&
        body.includes("LLM10:2025"),
      "v23 must carry the full LLM Top 10 taxonomy forward",
    );

    // The v21 HTTP/auth-protocol depth subsection is carried forward.
    assert(
      body.includes(
        "### HTTP-protocol & authentication-protocol depth (stack-gated)",
      ),
      "v23 must carry the v21 HTTP/auth-protocol depth subsection forward",
    );

    // The v22 "obvious things" literal sweep is carried forward.
    assert(
      body.includes(
        '### "Obvious things" literal sweep (universally applicable)',
      ),
      "v23 must carry the v22 literal-sweep subsection forward",
    );

    // Body fingerprint (idle-task wrapper routing) unchanged.
    assert(
      SECURITY_SCAN_BODY_FINGERPRINT.test(body),
      "v23 body must still match the security-scan wrapper fingerprint",
    );

    // Required label set unchanged.
    assert(
      body.includes("security") &&
        body.includes("severity:<level>") &&
        body.includes("confidence:<level>"),
      "v23 must retain the documented label set",
    );
  },
);

Deno.test(
  "security_scan prompt v23 - adds the nine client-side classes mapped to OWASP 2025",
  async () => {
    const result = await loadPrompt("security_scan", "v23", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const client = clientSection(result.value);

    // Each of the nine client-side classes, mapped to its OWASP 2025 category.
    const checks: Array<[string, RegExp]> = [
      [
        "DOM-based XSS client source→sink",
        /DOM-based XSS — client source→sink \(A05:2025/,
      ],
      ["DOM clobbering", /DOM clobbering \(A05:2025/],
      ["postMessage origin trust", /postMessage origin trust \(A05:2025/],
      [
        "cross-site WebSocket hijacking",
        /Cross-site WebSocket hijacking — CSWSH \(A05:2025/,
      ],
      [
        "CORS reflection with credentials",
        /CORS reflection with credentials \(A02:2025/,
      ],
      ["clickjacking", /Clickjacking \(A02:2025/],
      ["reverse tabnabbing", /Reverse tabnabbing \(A02:2025/],
      [
        "client-side open redirect",
        /Client-side open redirect \/ navigation \(A05:2025/,
      ],
      [
        "prototype pollution + gadget chain",
        /Prototype pollution \+ gadget chain \(A05:2025/,
      ],
    ];
    for (const [name, re] of checks) {
      assert(re.test(client), `client-side subsection must cover ${name}`);
    }

    // Concrete evidence-citable markers, not just headings.
    assert(
      /postMessage/.test(client) && /event\.origin/.test(client),
      "postMessage class must name event.origin",
    );
    assert(
      /CSWSH/.test(client) && /WebSocket/.test(client),
      "CSWSH class must name WebSocket",
    );
    assert(
      /frame-ancestors/.test(client) && /X-Frame-Options/.test(client),
      "clickjacking class must name frame-ancestors and X-Frame-Options",
    );
    assert(
      /rel="noopener"/.test(client),
      'reverse-tabnabbing class must name rel="noopener"',
    );
    assert(
      /dangerouslySetInnerHTML/.test(client) && /v-html/.test(client) &&
        /bypassSecurityTrust/.test(client),
      "DOM-XSS class must name the framework escape hatches",
    );
    assert(
      /location\.hash/.test(client) && /window\.name/.test(client) &&
        /document\.referrer/.test(client),
      "DOM-XSS class must name concrete client sources",
    );
    assert(
      /__proto__/.test(client) && /gadget/.test(client),
      "prototype-pollution class must name __proto__ and a gadget",
    );
  },
);

Deno.test(
  "security_scan prompt v23 - gates on Phase-1 browser signals and skips on absence",
  async () => {
    const result = await loadPrompt("security_scan", "v23", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const client = clientSection(result.value);

    // Stack-gated on Phase-1 browser-code signals, skip on absence.
    assert(
      /Applicability gate/i.test(client) &&
        /Phase-1 browser-code signals/i.test(client) &&
        /skip on absence/i.test(client),
      "client-side subsection must gate on Phase-1 browser signals and skip on absence",
    );

    // Concrete browser signals named.
    assert(
      /\.jsx/.test(client) && /\.tsx/.test(client) &&
        /manifest/.test(client),
      "client-side gate must name concrete browser-code signals",
    );

    // Backend-only repos stay silent.
    assert(
      /backend-only/i.test(client) &&
        /stays silent/i.test(client),
      "client-side subsection must state backend-only repos stay silent",
    );
  },
);

Deno.test(
  "security_scan prompt v23 - ports source-AND-sink and framework-auto-escaping discipline",
  async () => {
    const result = await loadPrompt("security_scan", "v23", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const client = clientSection(result.value);

    // Require a controllable client SOURCE and an executing SINK.
    assert(
      /client source→sink discipline/i.test(client) &&
        /controllable client \*\*SOURCE\*\*/.test(client) &&
        /executing \*\*SINK\*\*/.test(client),
      "client-side subsection must require a client SOURCE and an executing SINK",
    );

    // Framework auto-escaping is a real mitigation — find the opt-out.
    assert(
      /Framework auto-escaping is a real mitigation/i.test(client) &&
        /opt-out/i.test(client),
      "client-side subsection must state framework auto-escaping is a mitigation",
    );

    // A bare missing header/attribute is not a finding without a sensitive action.
    assert(
      /missing header/i.test(client) &&
        /concrete sensitive action/i.test(client),
      "client-side subsection must forbid bare missing-header findings",
    );
  },
);

Deno.test(
  "security_scan prompt v23 - prototype pollution requires recursive write AND a reachable gadget",
  async () => {
    const result = await loadPrompt("security_scan", "v23", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const client = clientSection(result.value);

    assert(
      /recursive \/ nested write/i.test(client) &&
        /Object\.prototype/.test(client),
      "prototype-pollution class must require a recursive write landing on Object.prototype",
    );
    assert(
      /reachable \*\*gadget\*\*/.test(client) &&
        /is \*\*not\*\* a finding on its own/.test(client),
      "prototype-pollution class must require a reachable gadget (write-only is not a finding)",
    );
  },
);

Deno.test(
  "security_scan prompt v23 - extends, does not duplicate, the A05 DOM-XSS and A08 prototype-pollution lines",
  async () => {
    const result = await loadPrompt("security_scan", "v23", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // The pre-existing generic A05 DOM-XSS line stays single-occurrence.
    assertEquals(
      countOccurrences(
        body,
        "XSS (reflected, stored, DOM-based)",
      ),
      1,
      "the generic A05 DOM-XSS line must not be duplicated by the client-side subsection",
    );

    // The client-side subsection must explicitly extend, not fork, A05/A08.
    const client = clientSection(body);
    assert(
      /extend them, never fork them/i.test(client),
      "client-side subsection must extend the existing A05/A08 lines",
    );
  },
);

Deno.test(
  "security_scan prompt v22 - does NOT carry the new client-side block (immutability)",
  async () => {
    const result = await loadPrompt("security_scan", "v22", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(
      result.value.includes(CLIENT_HEADING),
      false,
      "v22 must remain frozen — the client-side attack-class block is a v23 addition",
    );
  },
);
