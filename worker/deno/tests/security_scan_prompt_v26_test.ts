/**
 * Tests for security_scan prompt v26 (Issue #3537, follow-up from #3535 G1).
 *
 * v26 adds an **independent** adversarial verification / consensus-voting
 * gate to Phase 3 triage, the highest-value transfer from the Anthropic
 * `defending-code-reference-harness` (`/triage --votes`, a separate Verify
 * grader agent) and Visa VVAH (S6 adversarial reviewer + multi-agent
 * deterministic voting). The existing Phase 3 step 4 self-refutes each
 * candidate, but detection (Phase 2) and triage (Phase 3) share the same
 * agent context, so the detector's confirmation bias leaks into the verdict.
 *
 * The new step 6 (inserted between severity recalibration and the final sort)
 * re-checks each surviving **high/critical** finding with N independent
 * verifiers running in a fresh context that never saw the Phase 2 detection
 * reasoning, each prompted to refute-unless-proven (default refuted on
 * doubt), keeping only findings a majority cannot refute. It is:
 *   - cost-aware: gated on post-recalibration severity, so low/medium
 *     findings stay single-pass;
 *   - static-only: verifiers inherit the read-only / no-code-execution Hard
 *     Constraints;
 *   - a single consensus round, mirroring the step-4 "partially refuted"
 *     confidence-lowering rule on a bare-majority split.
 *
 * v26 carries the full v25 contract forward unchanged (four-phase flow,
 * placeholders including {{LLM_GATE}}, body fingerprint, label set, and every
 * v21–v24 taxonomy subsection) and renumbers the final sort step from 6 to 7.
 *
 * Also guards immutability of v25 (prompt versions are immutable once
 * shipped): v25 must not gain the new independent-verification block.
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

const VERIFY_HEADING =
  "**Independent adversarial verification / consensus voting";

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

Deno.test("security_scan prompt v26 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v26 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 26,
      true,
      `Expected security_scan prompt >= v26, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v26 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "security_scan prompt v26 - preserves the v25 invariants (gate, taxonomy, sweeps, fingerprint, labels)",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // Four-phase flow preserved.
    for (const phase of ["Plan", "Detect", "Triage", "File"]) {
      assert(body.includes(phase), `v26 must retain the ${phase} phase`);
    }

    // {{LLM_GATE}} placeholder and gate verdicts carried forward.
    assert(
      body.includes("{{LLM_GATE}}"),
      "v26 must carry the {{LLM_GATE}} placeholder forward",
    );
    assert(
      body.includes("LLM-using = YES") && body.includes("LLM-using = NO"),
      "v26 must carry the gate verdicts forward",
    );

    // Full LLM Top 10 taxonomy carried forward.
    assert(
      body.includes("OWASP GenAI / LLM Top 10") &&
        body.includes("LLM01:2025") &&
        body.includes("LLM10:2025"),
      "v26 must carry the full LLM Top 10 taxonomy forward",
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
        `v26 must carry the subsection forward: ${heading}`,
      );
    }

    // Body fingerprint (idle-task wrapper routing) unchanged.
    assert(
      SECURITY_SCAN_BODY_FINGERPRINT.test(body),
      "v26 body must still match the security-scan wrapper fingerprint",
    );

    // Required label set unchanged.
    assert(
      body.includes("security") &&
        body.includes("severity:<level>") &&
        body.includes("confidence:<level>"),
      "v26 must retain the documented label set",
    );
  },
);

Deno.test(
  "security_scan prompt v26 - adds the independent verification / consensus-voting step to Phase 3",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    // The new step is present and framed as independent + severity-gated.
    assert(
      phase3.includes(
        "Independent adversarial verification / consensus voting",
      ),
      "Phase 3 must add the independent verification / consensus-voting step",
    );
    assert(
      /severity-gated/i.test(phase3),
      "the new step must be severity-gated",
    );

    // Independent second pass that never saw the detection reasoning.
    assert(
      /independent/i.test(phase3) &&
        /never saw the Phase 2 detection reasoning/i.test(phase3),
      "the verifier must be independent and never have seen the Phase 2 reasoning",
    );

    // Fresh context / sub-agent.
    assert(
      /fresh context/i.test(phase3) && /sub-agent/i.test(phase3),
      "the verifier must run in a fresh context / sub-agent",
    );

    // Withhold the detector's framing (evidence narrative / exploit sketch).
    assert(
      /the neutral finding coordinates/i.test(phase3) &&
        /withhold/i.test(phase3),
      "the verifier must receive only neutral coordinates, withholding the detector's framing",
    );
  },
);

Deno.test(
  "security_scan prompt v26 - refute-unless-proven with default-refuted-on-doubt",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    assert(
      /refute the finding unless the static\s*evidence proves/i.test(phase3),
      "the verifier must refute unless the static evidence proves reachability",
    );
    assert(
      /default to refuted on doubt/i.test(phase3),
      "the verifier must default to refuted on doubt",
    );
    // Binary verdict values named.
    assert(
      /`refuted`/.test(phase3) && /`not-refuted`/.test(phase3),
      "the verifier must return a binary refuted / not-refuted verdict",
    );
  },
);

Deno.test(
  "security_scan prompt v26 - N-vote majority consensus for high/critical findings",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    // N independent verifiers, default N = 3.
    assert(
      /N independent verifiers/i.test(phase3) && /N = 3/.test(phase3),
      "the consensus vote must run N independent verifiers (default N = 3)",
    );
    // Keep only findings a majority cannot refute; ceil(N/2) threshold.
    assert(
      /majority\s*cannot refute/i.test(phase3) &&
        /ceil\(N \/ 2\)/.test(phase3),
      "keep only findings a majority cannot refute (ceil(N/2) not-refuted)",
    );
    // Majority-refute drops the finding.
    assert(
      /majority \*\*refute\*\* it, \*\*drop\*\*/i.test(phase3),
      "a majority-refute verdict must drop the finding",
    );
    // Bare-majority split lowers confidence (mirrors step-4 partial rule).
    assert(
      /lower its `confidence`/i.test(phase3) &&
        /`high` → `medium`/.test(phase3),
      "a bare-majority split must lower the finding's confidence one level",
    );
  },
);

Deno.test(
  "security_scan prompt v26 - cost-aware severity gate keeps low/medium single-pass",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    // Gate uses post-recalibration severity.
    assert(
      /post-recalibration\*\* severity/i.test(phase3),
      "the severity gate must use post-recalibration severity",
    );
    // Low/medium stay single-pass; only high/critical continue.
    assert(
      /low\*\* or \*\*medium\*\* severity stay \*\*single-pass\*\*/i.test(
        phase3,
      ),
      "low/medium findings must stay single-pass",
    );
    assert(
      /high\*\* and \*\*critical\*\* findings continue/i.test(phase3),
      "only high/critical findings continue to the consensus vote",
    );
    assert(
      /cost-aware/i.test(phase3),
      "the severity gate must be framed as cost-aware",
    );
  },
);

Deno.test(
  "security_scan prompt v26 - verifiers inherit the static-only Hard Constraints",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    assert(
      /same Hard\s*Constraints/i.test(phase3) &&
        /read-only, static analysis only, no\s*code execution/i.test(phase3),
      "verifiers must inherit the read-only / static-only / no-code-execution constraints",
    );
    // A single consensus round; do not iterate.
    assert(
      /single\*\* consensus round/i.test(phase3) &&
        /do not iterate/i.test(phase3),
      "the consensus pass must be a single round, not iterated",
    );
  },
);

Deno.test(
  "security_scan prompt v26 - renumbers the final sort step to 7",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    assert(
      body.includes("7. **Sort surviving findings.**"),
      "the final sort step must be renumbered to step 7",
    );
    // The old step-6 sort numbering must be gone from Phase 3.
    assert(
      !body.includes("6. **Sort surviving findings.**"),
      "the sort step must no longer be numbered 6",
    );
  },
);

Deno.test(
  "security_scan prompt v26 - generalises to the other LLM scans but applies here only",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    assert(
      /best-practices/i.test(phase3) && /test-audit/i.test(phase3) &&
        /documentation-audit/i.test(phase3),
      "the step must note it generalises to the other LLM-driven scans",
    );
    assert(
      /this run\s*applies it to `security-scan` only/i.test(phase3),
      "the step must state this run applies to security-scan only",
    );
  },
);

Deno.test(
  "security_scan prompt v26 - self-verify step is now labelled the same-context first pass",
  async () => {
    const result = await loadPrompt("security_scan", "v26", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const phase3 = phase3Section(result.value);

    assert(
      /same-context\s*first pass/i.test(phase3),
      "step 4 must be labelled the same-context first pass",
    );
  },
);

Deno.test(
  "security_scan prompt v25 - does NOT carry the new independent-verification block (immutability)",
  async () => {
    const result = await loadPrompt("security_scan", "v25", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(
      countOccurrences(result.value, VERIFY_HEADING),
      0,
      "v25 must remain frozen — the independent-verification block is a v26 addition",
    );
  },
);
