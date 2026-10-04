/**
 * Every section-heading regex that reads agent-written text gets its own
 * hostile case (Issue #3164).
 *
 * VibeCoder#3160 fixed `BRANCH_OUTCOMES_HEADING_RE`, whose `\s*:?\s*$` tail let
 * two unbounded whitespace runs split one run of spaces in every possible way:
 * a heading followed by a long run of spaces and then any character the
 * pattern rejects backtracked quadratically. The same tail sat on nine sibling
 * patterns in five other parsers, none of which had a hostile case. Measured
 * against the unfixed patterns, a heading plus 20 000 spaces plus `x` cost
 * about 140 ms per line; at the 199 000 spaces fed here, about a minute.
 *
 *   - `acceptance_criteria_gate.ts` — `ACCEPTANCE_HEADING_RE` and
 *     `ACCEPTED_SCOPE_HEADING_RE` (issue body, no scan cap).
 *   - `failure_detection_gate.ts` and `failure_detection_repair.ts` —
 *     `HEADING_RE` and `BOLD_LABEL_RE` (sub-issue body and agent output, no
 *     scan cap). The bold label's `\s*:?\s*\*\*` is the same shape: the `**`
 *     that follows can fail just as `$` can.
 *   - `failure_detection_repair.ts` again — `applyFailureDetectionSection`
 *     stripped trailing whitespace with an unanchored `/\s+$/`, which restarts
 *     at every space of a run that a non-space then ends: about 17 s on the
 *     hostile body here. It is now `trimEnd()`.
 *   - `independent_review_gate.ts` — `SPEC_HEADING_RE` and
 *     `STANDARDS_HEADING_RE` (PR summary, 200 000-char cap).
 *   - `reproduction_status_gate.ts` — `REPRODUCTION_HEADING_RE` (PR summary,
 *     200 000-char cap).
 *
 * Nothing here reads a clock (CODING-STANDARDS.md, "Guard super-linearity by
 * behaviour first"). Each case feeds the hostile line and asserts what the
 * parser produces: the near-miss line is not taken for a heading, and a real
 * heading after it is still found, so a rewrite cannot buy speed by dropping
 * the match. On the unfixed patterns each case does not return in any time a
 * test run would wait for.
 *
 * Uses Australian English throughout (behaviour, recognise).
 */

import { assert, assertEquals } from "@std/assert";
import {
  extractAcceptanceCriteria,
  extractAcceptedScope,
} from "../lib/acceptance_criteria_gate.ts";
import { validateFailureDetectionCriteria } from "../lib/failure_detection_gate.ts";
import {
  applyFailureDetectionSection,
  extractDraftedContent,
} from "../lib/failure_detection_repair.ts";
import {
  parseSpecEntries,
  parseStandardsEntries,
} from "../lib/independent_review_gate.ts";
import { parseReproductionBlock } from "../lib/reproduction_status_gate.ts";

/**
 * A run of spaces long enough that a quadratic tail never returns, yet short
 * enough that the hostile line stays inside the 200 000-char scan caps.
 */
const RUN = 199_000;

/** `prefix`, a long run of spaces, then a character no heading tail accepts. */
function hostile(prefix: string): string {
  return `${prefix}${" ".repeat(RUN)}x`;
}

Deno.test("3164 - acceptance-criteria heading: a padded near-miss is rejected and a real heading still read", () => {
  const body = [
    hostile("## Acceptance Criteria"),
    "- not a criterion",
    "",
    "## Acceptance Criteria :  ",
    "- [ ] the real criterion",
  ].join("\n");
  assertEquals(extractAcceptanceCriteria(body), ["the real criterion"]);
});

Deno.test("3164 - accepted-scope heading: a padded near-miss is rejected and a real heading still read", () => {
  const body = [
    hostile("### Accepted scope so far"),
    "- not in scope",
    "",
    "### Accepted scope so far:",
    "- the settled scope",
  ].join("\n");
  assertEquals(extractAcceptedScope(body), ["the settled scope"]);
});

Deno.test("3164 - failure-detection gate heading: a padded near-miss is not a section", () => {
  const offenders = validateFailureDetectionCriteria([
    {
      number: 1,
      title: "t",
      body: `${hostile("## Failure Detection")}\nA test.`,
    },
  ]);
  assertEquals(offenders.map((o) => o.reason), [
    "missing `## Failure Detection` section",
  ]);
  assertEquals(
    validateFailureDetectionCriteria([
      { number: 2, title: "t", body: "## Failure Detection :  \nA test." },
    ]),
    [],
  );
});

Deno.test("3164 - failure-detection gate bold label: a padded near-miss is not a section", () => {
  const offenders = validateFailureDetectionCriteria([
    { number: 1, title: "t", body: hostile("**Failure detection") },
  ]);
  assertEquals(offenders.map((o) => o.reason), [
    "missing `## Failure Detection` section",
  ]);
  assertEquals(
    validateFailureDetectionCriteria([
      { number: 2, title: "t", body: "**Failure detection :  ** A test." },
    ]),
    [],
  );
});

Deno.test("3164 - failure-detection repair heading: a padded near-miss is not stripped or read", () => {
  const near = hostile("## Failure Detection");
  assertEquals(
    extractDraftedContent(`${near}\n## Failure Detection:\nA test.`),
    "A test.",
  );
  const repaired = applyFailureDetectionSection(near, "A test.");
  assert(repaired.startsWith(near), "the near-miss line must survive repair");
});

Deno.test("3164 - failure-detection repair bold label: a padded near-miss is not stripped or read", () => {
  const near = hostile("**Failure detection");
  assertEquals(
    extractDraftedContent(`${near}\n**Failure detection :  ** A test.`),
    "A test.",
  );
  const repaired = applyFailureDetectionSection(near, "A test.");
  assert(repaired.startsWith(near), "the near-miss line must survive repair");
});

Deno.test("3164 - failure-detection repair trailing strip: a padded body keeps its text and loses only trailing space", () => {
  // `applyFailureDetectionSection` stripped trailing whitespace with an
  // unanchored `/\s+$/`, which restarts at every space of a run that a
  // non-space then ends: 17 s on this body before the fix.
  const body = `${" ".repeat(RUN)}x \n\n  `;
  assertEquals(
    applyFailureDetectionSection(body, "A test."),
    `${" ".repeat(RUN)}x\n\n## Failure Detection\n\nA test.\n`,
  );
});

Deno.test("3164 - independent-review Spec heading: a padded near-miss is rejected and a real heading still read", () => {
  const summary = [
    hostile("## Acceptance Criteria"),
    "- partial — not an entry",
    "",
    "## Acceptance Criteria :",
    "- met — the real entry",
  ].join("\n");
  assertEquals(parseSpecEntries(summary).map((e) => e.status), ["met"]);
});

Deno.test("3164 - independent-review Standards heading: a padded near-miss is rejected and a real heading still read", () => {
  const summary = [
    hostile("## Standards Review"),
    "- violation — not an entry",
    "",
    "## Standards Review:",
    "- clean — the real entry",
  ].join("\n");
  assertEquals(parseStandardsEntries(summary).map((e) => e.status), ["clean"]);
});

Deno.test("3164 - reproduction heading: a padded near-miss is rejected and a real heading still read", () => {
  assertEquals(
    parseReproductionBlock(hostile("## Reproduction Status")).present,
    false,
  );
  const block = parseReproductionBlock(
    "## Reproduction :  \n- status: verified",
  );
  assertEquals(block.present, true);
  assertEquals(block.status, "verified");
});
