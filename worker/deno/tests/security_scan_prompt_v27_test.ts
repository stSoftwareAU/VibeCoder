/**
 * Tests for security_scan prompt v27 (Issue #3539, follow-up from #3535 G3).
 *
 * v27 adds a **vulnerability-chaining** pass to Phase 3 triage — the highest
 * remaining transfer from Visa VVAH's S8 (exploit-chain / CWE-relationship
 * construction) and Anthropic's Report stage (escalation-path write-up).
 * VibeCoder filed every finding in isolation, so two individually-lower
 * findings that compose into a higher-severity path (an open redirect feeding
 * an SSRF, a leaked debug endpoint feeding an auth bypass) were never reported
 * as the chain they form.
 *
 * The new step 7 (inserted between the independent-verification consensus vote
 * and the final sort) composes surviving findings that share a reachable
 * data/trust path into **one combined exploit-chain finding** at the composed
 * severity, cross-linking its constituents (which remain filed individually).
 * It is:
 *   - static-only: the chain is asserted from code paths already read, never
 *     executed, inheriting the read-only / no-code-execution Hard Constraints;
 *   - severity-composing: filed at the combined-path severity, which may
 *     exceed the highest single constituent, never below it;
 *   - cap-disciplined: one chain counts as a single issue against the 6-issue
 *     Phase 4 cap.
 *
 * v27 carries the full v26 contract forward unchanged (four-phase flow,
 * placeholders including {{LLM_GATE}}, the independent-verification consensus
 * vote, body fingerprint, label set, and every v21–v26 taxonomy subsection)
 * and renumbers the final sort step from 7 to 8.
 *
 * Also guards immutability of v26 (prompt versions are immutable once
 * shipped): v26 must not gain the new chaining block.
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

const CHAIN_HEADING = "**Vulnerability chaining";

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
 * Slice out the Phase 3 triage section with whitespace collapsed to single
 * spaces, so prose-marker assertions are robust to `deno fmt` reflowing a
 * phrase across a line break.
 */
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

Deno.test("security_scan prompt v27 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v27 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 27,
      true,
      `Expected security_scan prompt >= v27, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v27 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v27 - preserves the v26 invariants (gate, verification, taxonomy, fingerprint, labels)",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // Four-phase flow preserved.
    for (const phase of ["Plan", "Detect", "Triage", "File"]) {
      assert(body.includes(phase), `v27 must retain the ${phase} phase`);
    }

    // {{LLM_GATE}} placeholder and gate verdicts carried forward.
    assert(
      body.includes("{{LLM_GATE}}"),
      "v27 must carry the {{LLM_GATE}} placeholder forward",
    );
    assert(
      body.includes("LLM-using = YES") && body.includes("LLM-using = NO"),
      "v27 must carry the gate verdicts forward",
    );

    // v26 independent-verification consensus vote carried forward.
    assert(
      body.includes(
        "Independent adversarial verification / consensus voting",
      ) && body.includes("N independent verifiers"),
      "v27 must carry the v26 independent-verification consensus vote forward",
    );

    // Full LLM Top 10 taxonomy carried forward.
    assert(
      body.includes("OWASP GenAI / LLM Top 10") &&
        body.includes("LLM01:2025") &&
        body.includes("LLM10:2025"),
      "v27 must carry the full LLM Top 10 taxonomy forward",
    );

    // Every v21–v24 subsection is carried forward.
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
        `v27 must carry the subsection forward: ${heading}`,
      );
    }

    // Body fingerprint (idle-task wrapper routing) unchanged.
    assert(
      SECURITY_SCAN_BODY_FINGERPRINT.test(body),
      "v27 body must still match the security-scan wrapper fingerprint",
    );

    // Required label set unchanged.
    assert(
      body.includes("security") &&
        body.includes("severity:<level>") &&
        body.includes("confidence:<level>"),
      "v27 must retain the documented label set",
    );
  },
);

Deno.test(
  "security_scan prompt v27 - adds the vulnerability-chaining step to Phase 3",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    // The new step is present and framed around a shared reachable path.
    assert(
      phase3.includes("Vulnerability chaining"),
      "Phase 3 must add the vulnerability-chaining step",
    );
    assert(
      phase3.includes("combined exploit-path findings"),
      "the step must compose findings into combined exploit-path findings",
    );
    assert(
      phase3.includes("reachable data or trust path"),
      "the chain requires findings that share a reachable data/trust path",
    );
    // Cites the VVAH S8 / Anthropic Report provenance.
    assert(
      /S8/.test(phase3) && /Report/.test(phase3),
      "the step must cite the VVAH S8 / Anthropic Report provenance",
    );
  },
);

Deno.test(
  "security_scan prompt v27 - chain is asserted statically, never executed",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    assert(
      /static-only/i.test(phase3),
      "the chaining step must be static-only",
    );
    assert(
      /never execute it/i.test(phase3),
      "the chain must be asserted from code already read, never executed",
    );
    assert(
      /no chain.*do not speculate/i.test(phase3),
      "an untraceable hand-off means no chain — no speculation",
    );
  },
);

Deno.test(
  "security_scan prompt v27 - composes severity above the highest constituent",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    assert(
      /combined exploit path/i.test(phase3) && /exceed/i.test(phase3),
      "the chain is filed at the combined-path severity, which may exceed the highest constituent",
    );
    assert(
      /two `medium` findings that compose into a critical path are filed as one `critical` chain/i
        .test(phase3),
      "two mediums composing into a critical path must file as one critical chain",
    );
    assert(
      /[Nn]ever file the chain \*\*below\*\* its highest constituent/.test(
        phase3,
      ),
      "the chain must never be filed below its highest constituent",
    );
  },
);

Deno.test(
  "security_scan prompt v27 - constituents remain filed individually and are cross-linked",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    assert(
      /Constituents remain filed individually/i.test(phase3),
      "each constituent must remain filed as its own issue",
    );
    assert(
      /cross-link/i.test(phase3),
      "the chain must cross-link its constituents",
    );
    // Distinct from step-2 dedup (compose distinct root causes, not collapse one).
    assert(
      /Distinct from step-2 dedup/i.test(phase3) &&
        /composes[_*] \*\*distinct\*\* root causes/i.test(phase3),
      "chaining must be distinguished from step-2 root-cause dedup",
    );
  },
);

Deno.test(
  "security_scan prompt v27 - a chain counts as one issue against the 6-issue cap",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    assert(
      /One chain = one issue against the 6-issue cap/i.test(phase3),
      "a composed chain must count as a single issue against the cap",
    );
    assert(
      /does \*\*not\*\* get a free slot/i.test(phase3),
      "the chain must not get a free slot on top of the six",
    );
  },
);

Deno.test(
  "security_scan prompt v27 - chain has a stable id via the exploit-chain class",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    assert(
      body.includes('class = "exploit-chain"'),
      "the chain must use class = exploit-chain in the stable-id recipe",
    );
  },
);

Deno.test(
  "security_scan prompt v27 - Phase 4 files and cross-links the exploit chain",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase4 = phase4Section(result.value);

    assert(
      phase4.includes("Combined exploit-chain findings"),
      "Phase 4 must describe filing combined exploit-chain findings",
    );
    assert(
      /File the constituents first/i.test(phase4),
      "Phase 4 must file the constituents before the chain so they can be cross-linked",
    );
    assert(
      phase4.includes("## Exploit chain"),
      "the chain body must carry a `## Exploit chain` section listing the hops",
    );
  },
);

Deno.test(
  "security_scan prompt v27 - renumbers the final sort step to 8",
  async () => {
    const result = await loadPrompt("security_scan", "v27", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    assert(
      body.includes("8. **Sort surviving findings.**"),
      "the final sort step must be renumbered to step 8",
    );
    assert(
      body.includes("7. **Vulnerability chaining"),
      "the chaining step must be numbered 7",
    );
    // The old step-7 sort numbering must be gone from Phase 3.
    assert(
      !body.includes("7. **Sort surviving findings.**"),
      "the sort step must no longer be numbered 7",
    );
  },
);

Deno.test(
  "security_scan prompt v26 - does NOT carry the new chaining block (immutability)",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(
      countOccurrences(result.value, CHAIN_HEADING),
      0,
      "v26 must remain frozen — the vulnerability-chaining block is a v27 addition",
    );
  },
);
