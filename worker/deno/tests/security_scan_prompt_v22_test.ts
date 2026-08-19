/**
 * Tests for security_scan prompt v22 (Issue #3450, parent #3440).
 *
 * v22 adds the "obvious things" literal-sweep block, closing the gap
 * against Cloudflare's `ATTACK-CLASSES.md` class 9 ("Obvious things" — the
 * dumb stuff that is easy to overlook because everyone assumes someone else
 * already checked it). Six cheap, high-signal literal checks are added
 * under a single universally-applicable subsection, each mapped to the
 * OWASP Top 10 2025 category it extends:
 *
 *   1. Security-referencing TODO/FIXME/HACK/XXX  → A06 Insecure Design
 *   2. Committed secret files & .gitignore        → A04 Cryptographic Failures
 *   3. Prod-reachable fixture credentials         → A07 Authentication Failures
 *   4. Exposed debug/introspection endpoints      → A02 Misconfiguration
 *   5. Dynamic code execution with dynamic input  → A05 Injection
 *   6. Cookie-flag hygiene                         → A02 Misconfiguration
 *
 * Each check self-gates on artefact presence (no cookies → no cookie check;
 * no HTTP routes → no debug-endpoint check) and traces the full code path
 * to a reachable impact before filing — no bare-flag findings and no
 * "not present" findings.
 *
 * v22 carries the full v21 contract forward unchanged (four-phase flow,
 * placeholders including {{LLM_GATE}}, body fingerprint, label set) and
 * does not duplicate the existing A04 hard-coded-secret or A05 eval lines.
 *
 * Also guards immutability of v21 (Issue #235 — prompt versions are
 * immutable once shipped): v21 must not gain the new literal-sweep block.
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

const SWEEP_HEADING =
  '### "Obvious things" literal sweep (universally applicable)';

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

/** Slice out just the new literal-sweep subsection. */
function sweepSection(body: string): string {
  const start = body.indexOf(SWEEP_HEADING);
  assert(start >= 0, "literal-sweep subsection must be present");
  const end = body.indexOf(
    "### Vulnerability taxonomy — OWASP GenAI / LLM Top 10",
    start,
  );
  assert(end > start, "LLM taxonomy must follow the literal-sweep subsection");
  return body.slice(start, end);
}

Deno.test("security_scan prompt v22 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v22", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v22 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 22,
      true,
      `Expected security_scan prompt >= v22, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v22 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v22", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v22 - preserves the v21 invariants (gate, taxonomy, fingerprint, labels)",
  async () => {
    const result = await loadPrompt("security_scan", "v22", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // Four-phase flow preserved.
    for (const phase of ["Plan", "Detect", "Triage", "File"]) {
      assert(body.includes(phase), `v22 must retain the ${phase} phase`);
    }

    // {{LLM_GATE}} placeholder and gate verdicts carried forward.
    assert(
      body.includes("{{LLM_GATE}}"),
      "v22 must carry the {{LLM_GATE}} placeholder forward",
    );
    assert(
      body.includes("LLM-using = YES") && body.includes("LLM-using = NO"),
      "v22 must carry the gate verdicts forward",
    );

    // Full LLM Top 10 taxonomy carried forward.
    assert(
      body.includes("OWASP GenAI / LLM Top 10") &&
        body.includes("LLM01:2025") &&
        body.includes("LLM10:2025"),
      "v22 must carry the full LLM Top 10 taxonomy forward",
    );

    // The v21 HTTP/auth-protocol depth subsection is carried forward.
    assert(
      body.includes(
        "### HTTP-protocol & authentication-protocol depth (stack-gated)",
      ),
      "v22 must carry the v21 HTTP/auth-protocol depth subsection forward",
    );

    // Body fingerprint (idle-task wrapper routing) unchanged.
    assert(
      SECURITY_SCAN_BODY_FINGERPRINT.test(body),
      "v22 body must still match the security-scan wrapper fingerprint",
    );

    // Required label set unchanged.
    assert(
      body.includes("security") &&
        body.includes("severity:<level>") &&
        body.includes("confidence:<level>"),
      "v22 must retain the documented label set",
    );
  },
);

Deno.test(
  "security_scan prompt v22 - adds the six 'obvious things' literal checks mapped to OWASP 2025",
  async () => {
    const result = await loadPrompt("security_scan", "v22", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const sweep = sweepSection(result.value);

    // Each of the six literal checks, mapped to its OWASP 2025 category.
    const checks: Array<[string, RegExp]> = [
      [
        "security-referencing TODO/FIXME/HACK/XXX",
        /Security-referencing TODO\/FIXME\/HACK\/XXX comments \(A06:2025/,
      ],
      [
        "committed secret files & .gitignore",
        /Committed secret files & `\.gitignore` coverage \(A04:2025/,
      ],
      [
        "prod-reachable fixture credentials",
        /Test \/ example \/ seed credentials reachable in production \(A07:2025/,
      ],
      [
        "debug/introspection endpoints",
        /Exposed debug \/ introspection endpoints \(A02:2025/,
      ],
      [
        "dynamic code execution",
        /Dynamic code execution with dynamic input \(A05:2025/,
      ],
      ["cookie-flag hygiene", /Cookie-flag hygiene \(A02:2025/],
    ];
    for (const [name, re] of checks) {
      assert(re.test(sweep), `literal sweep must cover ${name}`);
    }

    // Concrete evidence-citable detail present (not just headings).
    assert(
      /\.env/.test(sweep) && /\.gitignore/.test(sweep) && /\*\.pem/.test(sweep),
      "committed-secret check must name concrete secret-file artefacts",
    );
    assert(
      /HttpOnly/.test(sweep) && /Secure/.test(sweep) && /SameSite/.test(sweep),
      "cookie-flag check must name the three cookie flags",
    );
    assert(
      /eval\(/.test(sweep) && /child_process/.test(sweep) &&
        /vm\.runInContext/.test(sweep),
      "dynamic-exec check must name concrete execution sinks",
    );
    assert(
      /\/debug/.test(sweep) && /\/metrics/.test(sweep) && /\/env/.test(sweep),
      "debug-endpoint check must name concrete introspection routes",
    );
    assert(
      /TODO/.test(sweep) && /FIXME/.test(sweep) && /HACK/.test(sweep) &&
        /XXX/.test(sweep),
      "security-TODO check must name the four comment markers",
    );
  },
);

Deno.test(
  "security_scan prompt v22 - self-gates on artefact presence and traces impact before filing",
  async () => {
    const result = await loadPrompt("security_scan", "v22", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const sweep = sweepSection(result.value);

    // "A flag is not a finding — trace the full code path before reporting."
    assert(
      /a flag is not a finding/i.test(sweep) &&
        /trace the full code path/i.test(sweep),
      "literal sweep must carry the 'flag is not a finding — trace the path' rule",
    );

    // Self-gate on artefact presence — stay silent when the surface is absent.
    assert(
      /self-gate/i.test(sweep) && /artefact presence/i.test(sweep),
      "literal sweep must self-gate on artefact presence",
    );
    assert(
      /No cookies set\s+→\s+skip/.test(sweep) &&
        /No HTTP\s+routes\s+→\s+skip/.test(sweep),
      "literal sweep must skip a check when its artefact is absent",
    );

    // No "not present" findings.
    assert(
      /Never file a "no cookies found"/.test(sweep) &&
        /stays \*\*silent\*\*/.test(sweep),
      "literal sweep must forbid 'no X found' / not-present findings",
    );

    // Universally-applicable framing (stack-agnostic, no hard repo-type gate).
    assert(
      /universally applicable|stack-agnostic/i.test(sweep),
      "literal sweep must be framed as the universally-applicable cluster",
    );
  },
);

Deno.test(
  "security_scan prompt v22 - does not duplicate the existing A04 secret or A05 eval lines",
  async () => {
    const result = await loadPrompt("security_scan", "v22", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // Extend-don't-fork: the pre-existing A04 hard-coded-secret line stays
    // single-occurrence (the literal sweep cross-references, never re-files).
    assertEquals(
      countOccurrences(body, "hard-coded credentials, API keys committed to"),
      1,
      "the A04 hard-coded-secret line must not be duplicated by the file sweep",
    );

    // The literal sweep must explicitly cross-reference, not fork, A04/A05.
    const sweep = sweepSection(body);
    assert(
      /cross-reference/i.test(sweep),
      "literal sweep must cross-reference the existing A04/A05 lines",
    );
  },
);

Deno.test(
  "security_scan prompt v21 - does NOT carry the new literal-sweep block (immutability)",
  async () => {
    const result = await loadPrompt("security_scan", "v21", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(
      result.value.includes(SWEEP_HEADING),
      false,
      "v21 must remain frozen — the 'obvious things' literal sweep is a v22 addition",
    );
  },
);
