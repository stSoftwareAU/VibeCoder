/**
 * Unit tests for the in-run summary-rule gate recovery prompt (Issue #2189).
 *
 * The orchestration is covered end to end by
 * `completion_phase_summary_rule_retry_test.ts`; this covers the pure text the
 * recovery invocation actually reads.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { buildSummaryRuleRetryPrompt } from "../lib/summary_rule_gate_retry.ts";

const VERDICT = {
  reason:
    "Acceptance criteria not closed out in the PR summary: the PR summary " +
    "carries no `## Acceptance Criteria` closure block, but the issue states " +
    "2 criteria",
  comment: "⚠️ **Acceptance-criteria closure missing.** Add a `## Acceptance " +
    "Criteria` block with one entry per criterion.",
};

Deno.test("summary-rule retry - the prompt replays the gate's own comment", () => {
  const prompt = buildSummaryRuleRetryPrompt(
    VERDICT,
    "stSoftwareAU/VibeCoder",
    2189,
  );

  assertStringIncludes(prompt, "stSoftwareAU/VibeCoder#2189");
  assertStringIncludes(prompt, "PR-SUMMARY GATE RETRY NOTICE");
  // The gate's remediation comment rides in verbatim.
  assertStringIncludes(prompt, VERDICT.comment);
  assertStringIncludes(
    prompt,
    "docs/archive/pr-summaries/pr-summary-2189.md",
  );
});

Deno.test("summary-rule retry - the prompt forbids new work and PR creation", () => {
  const prompt = buildSummaryRuleRetryPrompt(VERDICT, "org/repo", 7);

  assertStringIncludes(prompt, "do not start new work");
  assertStringIncludes(prompt, "Do not create the PR yourself");
  // The reviewer verdicts must be earned, never invented, on the retry too.
  assertStringIncludes(prompt, "reviewer sub-agents");
});

Deno.test("summary-rule retry - an unusable issue number fails loud", () => {
  assertThrows(
    () => buildSummaryRuleRetryPrompt(VERDICT, "org/repo", 0),
    Error,
    "issue number",
  );
});

Deno.test("summary-rule retry - an empty remediation comment fails loud", () => {
  assertThrows(
    () => buildSummaryRuleRetryPrompt({ reason: "r", comment: "  " }, "o/r", 1),
    Error,
    "remediation comment",
  );
});

Deno.test("summary-rule retry - the reason is stated apart from the comment", () => {
  const prompt = buildSummaryRuleRetryPrompt(VERDICT, "org/repo", 12);
  assertStringIncludes(prompt, VERDICT.reason);
  assertEquals(prompt.includes("undefined"), false);
});
