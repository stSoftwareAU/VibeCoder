/**
 * Regression tests for the super-linear regexes over untrusted text fixed by
 * Issue #3164.
 *
 * Five gate modules parse text an agent writes under instruction from an
 * issue body or a PR summary — both untrusted in the threat model these gates
 * exist to enforce — with hand-written regexes. Several of those regexes have
 * the shape `CODING-STANDARDS.md` warns against: two quantifiers that can
 * match the same characters with only an optional token between them
 * (`\s*:?\s*$`), or a `\s*` immediately before a `(.*)$` tail that a lone
 * `\r` can make fail (JavaScript's `.` does not match `\r`, so `\s` can
 * consume it but `.` cannot, and `$` then never arrives). On a long run of
 * the shared character the engine tries every split between the two
 * quantifiers before giving up, which costs quadratic time — or, where a
 * third overlapping quantifier is involved, cubic.
 *
 * Every pattern touched by the fix gets its own hostile case here, driven
 * through the exported function that actually applies it (never the regex
 * object directly), because a parser with several sibling patterns over the
 * same text can ship a fix for the one its author had in mind while a
 * sibling in the same module stays quadratic (the lesson PRs #3085 and #3160
 * left behind, per `CODING-STANDARDS.md`). A handful of accepted-input cases
 * sit alongside them, because the fix must keep accepting exactly what it did
 * before — only the hostile shapes are new.
 *
 * Uses Australian English spelling throughout (behaviour, colour,
 * organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  extractAcceptanceCriteria,
  extractAcceptedScope,
  parseClosureEntries,
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
import { assertLinearGrowth } from "./support/growth.ts";

/** A heading line that cannot close, because the trailing `x` is neither
 * whitespace nor a colon — the hostile shape for `\s*:?\s*$` tails.
 */
function hostileHeading(prefix: string, n: number): string {
  return `${prefix}${" ".repeat(n)}x`;
}

/**
 * A line that can never satisfy a trailing `(.*)$`: a lone `\r` survives
 * `split(/\r?\n/)` (it is not followed by `\n`), `\s` matches it so a `\s*`
 * run can swallow up to it, but `.` cannot cross it, so `$` never arrives no
 * matter how the engine re-splits the run before it.
 */
function hostileTail(n: number): string {
  return `${" ".repeat(n)}\rx\ry`;
}

// --- acceptance_criteria_gate.ts -------------------------------------------

Deno.test("extractAcceptanceCriteria - a hostile heading tail scales linearly (Issue #3164)", () => {
  const criteria = assertLinearGrowth(
    "ACCEPTANCE_HEADING_RE tail",
    (chars) => hostileHeading("## Acceptance Criteria", chars),
    (input) => extractAcceptanceCriteria(input),
    { baseChars: 8_000 },
  );
  assertEquals(criteria, [], "the hostile line must not be read as a heading");
});

Deno.test("extractAcceptedScope - a hostile heading tail scales linearly (Issue #3164)", () => {
  const scope = assertLinearGrowth(
    "ACCEPTED_SCOPE_HEADING_RE tail",
    (chars) => hostileHeading("## Accepted Scope So Far", chars),
    (input) => extractAcceptedScope(input),
    { baseChars: 8_000 },
  );
  assertEquals(scope, [], "the hostile line must not be read as a heading");
});

// The hostile tail sits on a *continuation* line, not on the list-item line
// itself: `LIST_ITEM_RE` anchors its own `(.*)$` at the end of the line, so a
// lone `\r` there would stop the list item being recognised at all (a
// different, already-linear, overlap) before the label pattern under test is
// ever reached.
Deno.test("parseClosureEntries - a hostile evidence label scales linearly (Issue #3164)", () => {
  const entries = assertLinearGrowth(
    "acceptance_criteria_gate LABEL_PATTERNS.evidence",
    (chars) => `## Acceptance Criteria\n- met\nevidence:${hostileTail(chars)}`,
    (input) => parseClosureEntries(input),
    { baseChars: 8_000 },
  );
  assertEquals(entries.length, 1);
  assertEquals(entries[0]?.status, "met");
  assertEquals(
    entries[0]?.hasEvidence,
    false,
    "the unclosable tail must not be read as filled evidence",
  );
});

Deno.test("parseClosureEntries - a hostile reason label scales linearly (Issue #3164)", () => {
  const entries = assertLinearGrowth(
    "acceptance_criteria_gate LABEL_PATTERNS.reason",
    (chars) => `## Acceptance Criteria\n- met\nreason:${hostileTail(chars)}`,
    (input) => parseClosureEntries(input),
    { baseChars: 8_000 },
  );
  assertEquals(entries.length, 1);
  assertEquals(entries[0]?.status, "met");
  assertEquals(
    entries[0]?.hasReason,
    false,
    "the unclosable tail must not be read as a filled reason",
  );
});

// --- failure_detection_gate.ts ----------------------------------------------

Deno.test("validateFailureDetectionCriteria - a hostile heading tail scales linearly (Issue #3164)", () => {
  const offenders = assertLinearGrowth(
    "failure_detection_gate HEADING_RE tail",
    (chars) => hostileHeading("## Failure Detection", chars),
    (input) =>
      validateFailureDetectionCriteria([{
        number: 1,
        title: "t",
        body: input,
      }]),
    { baseChars: 8_000 },
  );
  assertEquals(offenders.length, 1);
  assertEquals(
    offenders[0]?.reason,
    "missing `## Failure Detection` section",
    "the hostile line must not be read as the heading or the bold label",
  );
});

Deno.test("validateFailureDetectionCriteria - a hostile bold label scales linearly (Issue #3164)", () => {
  const offenders = assertLinearGrowth(
    "failure_detection_gate BOLD_LABEL_RE",
    (chars) => `**failure detection**${hostileTail(chars)}`,
    (input) =>
      validateFailureDetectionCriteria([{
        number: 1,
        title: "t",
        body: input,
      }]),
    { baseChars: 8_000 },
  );
  assertEquals(offenders.length, 1);
  assertEquals(
    offenders[0]?.reason,
    "missing `## Failure Detection` section",
    "the unclosable bold label must not be read as a filled section",
  );
});

// --- failure_detection_repair.ts --------------------------------------------

Deno.test("extractDraftedContent - a hostile heading tail scales linearly (Issue #3164)", () => {
  const scaledChars = 8_000 * 4;
  const output = assertLinearGrowth(
    "failure_detection_repair HEADING_RE tail",
    (chars) => hostileHeading("## Failure Detection", chars),
    (input) => extractDraftedContent(input),
    { baseChars: 8_000 },
  );
  // Neither the heading nor the bold label is recognised, so the drafted
  // content falls back to the whole (trimmed) output, unchanged.
  assertEquals(output, hostileHeading("## Failure Detection", scaledChars));
});

Deno.test("extractDraftedContent - a hostile bold label scales linearly (Issue #3164)", () => {
  const scaledChars = 8_000 * 4;
  const output = assertLinearGrowth(
    "failure_detection_repair BOLD_LABEL_RE",
    (chars) => `**failure detection**${hostileTail(chars)}`,
    (input) => extractDraftedContent(input),
    { baseChars: 8_000 },
  );
  assertEquals(
    output,
    `**failure detection**${hostileTail(scaledChars)}`,
    "the unclosable bold label must fall back to the whole trimmed output",
  );
});

Deno.test("applyFailureDetectionSection - a hostile trailing run scales linearly (Issue #3164)", () => {
  const result = assertLinearGrowth(
    "failure_detection_repair applyFailureDetectionSection trailing-whitespace strip",
    (chars) => `a${" ".repeat(chars)}b`,
    (input) => applyFailureDetectionSection(input, "content"),
    { baseChars: 8_000 },
  );
  const scaledInput = `a${" ".repeat(8_000 * 4)}b`;
  assertEquals(result, `${scaledInput}\n\n## Failure Detection\n\ncontent\n`);
});

// --- independent_review_gate.ts ---------------------------------------------

Deno.test("parseSpecEntries - a hostile heading tail scales linearly (Issue #3164)", () => {
  const entries = assertLinearGrowth(
    "independent_review_gate SPEC_HEADING_RE tail",
    (chars) => hostileHeading("## Acceptance Criteria", chars),
    (input) => parseSpecEntries(input),
    { baseChars: 8_000 },
  );
  assertEquals(entries, [], "the hostile line must not be read as a heading");
});

Deno.test("parseStandardsEntries - a hostile heading tail scales linearly (Issue #3164)", () => {
  const entries = assertLinearGrowth(
    "independent_review_gate STANDARDS_HEADING_RE tail",
    (chars) => hostileHeading("## Standards Review", chars),
    (input) => parseStandardsEntries(input),
    { baseChars: 8_000 },
  );
  assertEquals(entries, [], "the hostile line must not be read as a heading");
});

// --- reproduction_status_gate.ts --------------------------------------------

Deno.test("parseReproductionBlock - a hostile heading tail scales linearly (Issue #3164)", () => {
  const block = assertLinearGrowth(
    "reproduction_status_gate REPRODUCTION_HEADING_RE tail",
    (chars) => hostileHeading("## Reproduction", chars),
    (input) => parseReproductionBlock(input),
    { baseChars: 8_000 },
  );
  assertEquals(
    block.present,
    false,
    "the hostile line must not be read as the heading",
  );
});

Deno.test("parseReproductionBlock - a hostile symptom field scales linearly (Issue #3164)", () => {
  const block = assertLinearGrowth(
    "reproduction_status_gate FIELD_PATTERNS.symptom",
    (chars) => `## Reproduction\n- symptom:${hostileTail(chars)}`,
    (input) => parseReproductionBlock(input),
    { baseChars: 8_000 },
  );
  assertEquals(block.present, true);
  assertEquals(
    block.symptom,
    "",
    "the unclosable tail must not be read as a value",
  );
});

Deno.test("parseReproductionBlock - a hostile status field scales linearly (Issue #3164)", () => {
  const block = assertLinearGrowth(
    "reproduction_status_gate FIELD_PATTERNS.status",
    (chars) => `## Reproduction\n- status:${hostileTail(chars)}`,
    (input) => parseReproductionBlock(input),
    { baseChars: 8_000 },
  );
  assertEquals(block.present, true);
  assertEquals(
    block.status,
    null,
    "the unclosable tail must not be read as a value",
  );
});

Deno.test("parseReproductionBlock - a hostile regression-test field scales linearly (Issue #3164)", () => {
  const block = assertLinearGrowth(
    "reproduction_status_gate FIELD_PATTERNS.regressionTest",
    (chars) => `## Reproduction\n- test:${hostileTail(chars)}`,
    (input) => parseReproductionBlock(input),
    { baseChars: 8_000 },
  );
  assertEquals(block.present, true);
  assertEquals(
    block.regressionTest,
    "",
    "the unclosable tail must not be read as a value",
  );
});

Deno.test("parseReproductionBlock - a hostile reason field scales linearly (Issue #3164)", () => {
  const block = assertLinearGrowth(
    "reproduction_status_gate REASON_RE",
    (chars) => `## Reproduction\n- reason:${hostileTail(chars)}`,
    (input) => parseReproductionBlock(input),
    { baseChars: 8_000 },
  );
  assertEquals(block.present, true);
  assertEquals(
    block.reason,
    "",
    "the unclosable tail must not be read as a value",
  );
});

// --- accepted variants still parse (behaviour unchanged) --------------------

Deno.test("accepted heading variants still parse (Issue #3164)", () => {
  for (
    const heading of [
      "## Acceptance Criteria",
      "## Acceptance Criteria:",
      "## Acceptance Criteria :",
      "## Acceptance Criteria :   ",
    ]
  ) {
    const body = `${heading}\n- first\n- second`;
    assertEquals(
      extractAcceptanceCriteria(body),
      ["first", "second"],
      `heading variant "${heading}" must still be recognised`,
    );
  }
});

Deno.test("accepted bold failure-detection label variants still parse (Issue #3164)", () => {
  for (
    const line of [
      "**Failure detection:** A new test covers this.",
      "**Failure detection**: A new test covers this.",
    ]
  ) {
    const offenders = validateFailureDetectionCriteria([
      { number: 1, title: "t", body: line },
    ]);
    assertEquals(
      offenders,
      [],
      `bold-label variant "${line}" must still be read as filled`,
    );
  }
});

Deno.test("accepted evidence/reason/symptom fields still capture without leading whitespace (Issue #3164)", () => {
  const closure = parseClosureEntries(
    "## Acceptance Criteria\n- met — evidence: foo — reason: bar",
  );
  assertEquals(closure[0]?.hasEvidence, true);
  assertEquals(closure[0]?.hasReason, true);

  const block = parseReproductionBlock(
    "## Reproduction\n- symptom:   foo bar\n- status: verified\n- test: tests/foo_test.ts",
  );
  assertEquals(block.symptom, "foo bar");
  assertEquals(block.status, "verified");
  assertEquals(block.regressionTest, "tests/foo_test.ts");
});
