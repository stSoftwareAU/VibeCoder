/**
 * Tests for security_scan prompt v28 (Issue #3613).
 *
 * `worker/deno/lib/security_sarif.ts` (Issue #3538) emits the
 * GitHub-recognised `external/cwe/cwe-<n>` SARIF rule tag whenever a filed
 * `security` issue body carries a `<!-- cwe: CWE-<n> -->` marker — but no
 * prompt version ever instructed the scanner to emit that marker, so every
 * uploaded rule carried the generic `security` tag alone and the CWE metadata
 * gap G3 of the #3535 analysis was meant to consume was never produced.
 *
 * v28 closes that loop: Phase 3 gains step 8, which assigns exactly one
 * most-specific CWE id to each surviving finding (chains take their entry-hop
 * weakness, no confident mapping means no marker), and Phase 4 emits the
 * `<!-- cwe: CWE-<n> -->` body marker directly under the finding-id marker.
 * The final sort step renumbers from 8 to 9. `security_sarif.ts` is unchanged.
 *
 * The round-trip test below is the behavioural one: it builds an issue body in
 * the exact shape v28 documents and pushes it through the real parser and
 * SARIF builder, asserting the CWE tag lands on the rule.
 *
 * Also guards immutability of v27 (prompt versions are frozen once shipped):
 * v27 must not gain the CWE marker instruction.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import {
  buildSecuritySarif,
  parseSecurityFinding,
} from "../lib/security_sarif.ts";
import { SECURITY_SCAN_BODY_FINGERPRINT } from "../lib/idle_task_templates/security_scan_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The literal marker template v28 must teach the scanner to emit. */
const CWE_MARKER_TEMPLATE = "<!-- cwe: CWE-<n> -->";

async function loadBody(version: string): Promise<string> {
  const result = await loadPrompt("security_scan", version, PROMPTS_DIR);
  assert(result.ok, `${version} must load`);
  return result.ok ? result.value : "";
}

/** Phase 3 triage section with whitespace collapsed to single spaces. */
function phase3Section(body: string): string {
  const start = body.indexOf("## Phase 3 — Triage");
  assert(start >= 0, "Phase 3 must be present");
  const end = body.indexOf("## Phase 4", start);
  assert(end > start, "Phase 4 must follow Phase 3");
  return body.slice(start, end).replace(/\s+/g, " ");
}

/** Phase 4 (filing) section with whitespace collapsed. */
function phase4Section(body: string): string {
  const start = body.indexOf("## Phase 4");
  assert(start >= 0, "Phase 4 must be present");
  return body.slice(start).replace(/\s+/g, " ");
}

Deno.test("security_scan prompt v28 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v28", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v28 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 28,
      true,
      `Expected security_scan prompt >= v28, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v28 - satisfies the placeholder contract",
  async () => {
    const body = await loadBody("v28");
    const v = validatePromptTemplate("security_scan", body);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v28 - preserves the v27 invariants (phases, gate, chaining, taxonomy, fingerprint, labels)",
  async () => {
    const body = await loadBody("v28");

    for (const phase of ["Plan", "Detect", "Triage", "File"]) {
      assert(body.includes(phase), `v28 must retain the ${phase} phase`);
    }

    assert(
      body.includes("{{LLM_GATE}}"),
      "v28 must carry the {{LLM_GATE}} placeholder forward",
    );
    assert(
      body.includes("LLM-using = YES") && body.includes("LLM-using = NO"),
      "v28 must carry the gate verdicts forward",
    );
    assert(
      body.includes(
        "Independent adversarial verification / consensus voting",
      ) &&
        body.includes("N independent verifiers"),
      "v28 must carry the v26 independent-verification consensus vote forward",
    );
    assert(
      body.includes("7. **Vulnerability chaining") &&
        body.includes('class = "exploit-chain"'),
      "v28 must carry the v27 vulnerability-chaining step forward",
    );
    assert(
      body.includes("OWASP GenAI / LLM Top 10") &&
        body.includes("LLM01:2025") &&
        body.includes("LLM10:2025"),
      "v28 must carry the full LLM Top 10 taxonomy forward",
    );
    for (
      const heading of [
        "### HTTP-protocol & authentication-protocol depth (stack-gated)",
        '### "Obvious things" literal sweep (universally applicable)',
        "### Client-side / browser attack classes (stack-gated)",
        "### Feature-abuse & data-leakage design lens (stack-gated)",
      ]
    ) {
      assert(
        body.includes(heading),
        `v28 must carry the subsection forward: ${heading}`,
      );
    }
    assert(
      SECURITY_SCAN_BODY_FINGERPRINT.test(body),
      "v28 body must still match the security-scan wrapper fingerprint",
    );
    assert(
      body.includes("security") &&
        body.includes("severity:<level>") &&
        body.includes("confidence:<level>"),
      "v28 must retain the documented label set",
    );
  },
);

Deno.test(
  "security_scan prompt v28 - adds the CWE-tagging step to Phase 3",
  async () => {
    const phase3 = phase3Section(await loadBody("v28"));

    assert(
      /8\. \*\*Tag each surviving finding with a CWE id/.test(phase3),
      "Phase 3 must add the CWE-tagging step as step 8",
    );
    assert(
      /most specific/i.test(phase3) && /CWE-89/.test(phase3),
      "the step must ask for the most specific CWE id, with concrete mappings",
    );
    assert(
      /[Ee]xactly one CWE per finding/.test(phase3),
      "exactly one CWE id may be assigned per finding",
    );
    assert(
      /entry-hop/i.test(phase3),
      "a composed chain must take its entry-hop weakness",
    );
    assert(
      /precision-first/i.test(phase3) && /omit the marker/i.test(phase3),
      "no confident mapping must mean no marker rather than a guess",
    );
    assert(
      /external\/cwe\/cwe-<n>/.test(phase3),
      "the step must explain that the marker becomes the external/cwe SARIF rule tag",
    );
  },
);

Deno.test(
  "security_scan prompt v28 - Phase 4 emits the hidden cwe body marker",
  async () => {
    const phase4 = phase4Section(await loadBody("v28"));

    assert(
      phase4.includes(CWE_MARKER_TEMPLATE),
      `Phase 4 must instruct the filer to emit ${CWE_MARKER_TEMPLATE}`,
    );
    assert(
      phase4.includes("<!-- cwe: CWE-89 -->"),
      "Phase 4 must show a concrete rendered example of the marker",
    );
    assert(
      /finding-id: <id> -->` on its own line at the top, immediately followed/
        .test(phase4),
      "the cwe marker must sit directly under the finding-id marker",
    );
    assert(
      /at most one\*\* cwe marker per issue/i.test(phase4),
      "at most one cwe marker may be emitted per issue",
    );
    assert(
      /carries its `<!-- cwe: CWE-<n> -->` marker verbatim/.test(phase4),
      "the pre-exit checklist must verify the cwe marker",
    );
  },
);

Deno.test(
  "security_scan prompt v28 - renumbers the final sort step to 9",
  async () => {
    const body = await loadBody("v28");

    assert(
      body.includes("9. **Sort surviving findings.**"),
      "the final sort step must be renumbered to step 9",
    );
    assert(
      !body.includes("8. **Sort surviving findings.**"),
      "the sort step must no longer be numbered 8",
    );
  },
);

Deno.test(
  "security_scan prompt v28 - a body in the documented shape yields the external/cwe SARIF tag",
  async () => {
    const body = await loadBody("v28");
    // Render the documented marker template with a concrete CWE id, exactly
    // as the filer would: this is the contract between prompt and emitter.
    assert(
      body.includes(CWE_MARKER_TEMPLATE),
      "v28 must document the cwe marker template",
    );
    const marker = CWE_MARKER_TEMPLATE.replace("<n>", "89");

    const finding = parseSecurityFinding({
      title: "🟠 SQL injection in src/api/orders.ts:47",
      body: [
        "<!-- finding-id: SEC-0123456789ab -->",
        marker,
        "",
        "Unparameterised query built from request input.",
      ].join("\n"),
      labels: ["security", "severity:high"],
    });

    assert(finding, "a body in the documented shape must parse as a finding");
    assertEquals(finding.cwe, "CWE-89");

    const sarif = buildSecuritySarif([finding]);
    const run = sarif.runs[0];
    assert(run, "the SARIF document must carry a run");
    const rules = (run.tool as {
      driver: { rules: Array<{ properties: { tags: string[] } }> };
    }).driver.rules;
    assertEquals(rules.length, 1);
    const tags = rules[0]?.properties.tags ?? [];
    assert(
      tags.includes("external/cwe/cwe-89"),
      `expected the external/cwe tag, got ${JSON.stringify(tags)}`,
    );
  },
);

Deno.test(
  "security_scan prompt v27 - does NOT carry the cwe marker instruction (immutability)",
  async () => {
    const body = await loadBody("v27");
    assert(
      !body.includes("<!-- cwe:"),
      "v27 must remain frozen — the cwe body marker is a v28 addition",
    );
    assert(
      !body.includes("Tag each surviving finding with a CWE id"),
      "v27 must remain frozen — the CWE-tagging step is a v28 addition",
    );
  },
);
