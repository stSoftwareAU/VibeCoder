/**
 * Tests for independent_review_gate.ts — the two-axis review gate (Issue #663).
 *
 * The acceptance-criteria closure block used to be self-assessed by the agent
 * that wrote the code, in the same context that produced it. This gate makes
 * the Spec axis carry an *independent* reviewer's verdict per criterion, and
 * keeps the Standards axis on its own heading so neither can mask the other.
 *
 * Covers: applicability, both provenance markers, the per-entry `reviewer:`
 * verdict, a recorded departure from that verdict, the Standards section rules,
 * axis separation in both directions, and the blocking comment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIndependentReviewComment,
  parseStandardsEntries,
  validateIndependentReview,
} from "../lib/independent_review_gate.ts";

const ISSUE_WITH_CRITERIA = [
  "## Problem",
  "",
  "The author judges their own work.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A Spec reviewer sub-agent judges the criteria.",
  "- [ ] The Standards axis is reported separately.",
].join("\n");

const ISSUE_WITHOUT_CRITERIA = [
  "## Problem",
  "",
  "Something is broken.",
].join("\n");

const SPEC_MARKER = '<!-- vibe-spec-review inputs="diff+issue-body" -->';
const STANDARDS_MARKER =
  '<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->';

const GOOD_SPEC_BLOCK = [
  "## Acceptance Criteria",
  "",
  SPEC_MARKER,
  "",
  "- **met** — A Spec reviewer sub-agent judges the criteria — evidence: " +
  "`worker/deno/tests/independent_review_gate_test.ts` — reviewer: met",
  "- **met** — The Standards axis is reported separately — evidence: " +
  "`worker/deno/lib/independent_review_gate.ts` — reviewer: met",
];

const GOOD_STANDARDS_BLOCK = [
  "## Standards Review",
  "",
  STANDARDS_MARKER,
  "",
  "- **clean** — Australian English, KISS/DRY, fail-loud error handling",
];

function summary(...blocks: string[][]): string {
  const body = ["## Summary", "", "Two axes. Closes #663.", ""];
  for (const block of blocks) body.push(...block, "");
  body.push("## Test Plan", "", "- the gate tests");
  return body.join("\n");
}

// --- applicability ---

Deno.test("independent review - does not apply when the issue states no criteria", () => {
  const result = validateIndependentReview({
    issueBody: ISSUE_WITHOUT_CRITERIA,
    prSummaryContent: summary(["## Evidence", "", "- tests pass"]),
  });
  assertEquals(result.applicable, false);
  assertEquals(result.valid, true);
  assertEquals(result.problems, []);
});

Deno.test("independent review - passes on both axes reported independently", () => {
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(GOOD_SPEC_BLOCK, GOOD_STANDARDS_BLOCK),
  });
  assertEquals(result.applicable, true);
  assertEquals(result.problems, []);
  assertEquals(result.valid, true);
  assertEquals(result.specEntries.length, 2);
  assertEquals(result.standardsEntries.length, 1);
});

// --- provenance ---

Deno.test("independent review - a self-assessed criteria block is blocked", () => {
  const selfAssessed = GOOD_SPEC_BLOCK.filter((line) => line !== SPEC_MARKER);
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(selfAssessed, GOOD_STANDARDS_BLOCK),
  });
  assertEquals(result.valid, false);
  assertEquals(result.specProvenance, false);
  assert(
    result.problems.some((p) => p.includes("vibe-spec-review")),
    `expected a spec-provenance problem, got ${
      JSON.stringify(result.problems)
    }`,
  );
});

Deno.test("independent review - a provenance marker with no inputs does not count", () => {
  const vague = GOOD_SPEC_BLOCK.map((line) =>
    line === SPEC_MARKER ? '<!-- vibe-spec-review inputs="" -->' : line
  );
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(vague, GOOD_STANDARDS_BLOCK),
  });
  assertEquals(result.specProvenance, false);
  assertEquals(result.valid, false);
});

Deno.test("independent review - the standards block needs its own provenance", () => {
  const unsourced = GOOD_STANDARDS_BLOCK.filter((l) => l !== STANDARDS_MARKER);
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(GOOD_SPEC_BLOCK, unsourced),
  });
  assertEquals(result.standardsProvenance, false);
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("vibe-standards-review")));
});

// --- the reviewer's verdict per entry ---

Deno.test("independent review - an entry with no reviewer verdict is blocked", () => {
  const noVerdict = [
    "## Acceptance Criteria",
    "",
    SPEC_MARKER,
    "",
    "- **met** — A Spec reviewer sub-agent judges the criteria — evidence: " +
    "`tests/foo_test.ts`",
    "- **met** — The Standards axis is reported separately — evidence: " +
    "`lib/foo.ts` — reviewer: met",
  ];
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(noVerdict, GOOD_STANDARDS_BLOCK),
  });
  assertEquals(result.valid, false);
  assert(
    result.problems.some((p) => p.includes("names no `reviewer:` verdict")),
    `got ${JSON.stringify(result.problems)}`,
  );
  assertEquals(result.specEntries[0]!.reviewerVerdict, null);
  assertEquals(result.specEntries[1]!.reviewerVerdict, "met");
});

Deno.test("independent review - an unrecognised reviewer verdict is blocked", () => {
  const bogus = GOOD_SPEC_BLOCK.map((line) =>
    line.replace("reviewer: met", "reviewer: looks fine")
  );
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(bogus, GOOD_STANDARDS_BLOCK),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("reviewer:")));
});

Deno.test("independent review - departing from the reviewer needs a reason", () => {
  const silentDeparture = [
    "## Acceptance Criteria",
    "",
    SPEC_MARKER,
    "",
    "- **met** — A Spec reviewer sub-agent judges the criteria — evidence: " +
    "`tests/foo_test.ts` — reviewer: missing",
    "- **met** — The Standards axis is reported separately — evidence: " +
    "`lib/foo.ts` — reviewer: met",
  ];
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(silentDeparture, GOOD_STANDARDS_BLOCK),
  });
  assertEquals(result.valid, false);
  assert(
    result.problems.some((p) => p.includes("departs from the Spec reviewer")),
    `got ${JSON.stringify(result.problems)}`,
  );
});

Deno.test("independent review - a recorded departure passes", () => {
  const recorded = [
    "## Acceptance Criteria",
    "",
    SPEC_MARKER,
    "",
    "- **met** — A Spec reviewer sub-agent judges the criteria — evidence: " +
    "`tests/foo_test.ts` — reviewer: missing — reason: the reviewer saw only " +
    "the diff and missed the pre-existing helper it reuses",
    "- **met** — The Standards axis is reported separately — evidence: " +
    "`lib/foo.ts` — reviewer: met",
  ];
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(recorded, GOOD_STANDARDS_BLOCK),
  });
  assertEquals(result.problems, []);
  assertEquals(result.valid, true);
  assertEquals(result.specEntries[0]!.reviewerVerdict, "missing");
  assertEquals(result.specEntries[0]!.departsFromReviewer, true);
});

// --- the Standards axis ---

Deno.test("independent review - a missing standards section is blocked", () => {
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(GOOD_SPEC_BLOCK),
  });
  assertEquals(result.valid, false);
  assert(
    result.problems.some((p) => p.includes("## Standards Review")),
    `got ${JSON.stringify(result.problems)}`,
  );
});

Deno.test("independent review - an empty standards section is blocked", () => {
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(GOOD_SPEC_BLOCK, [
      "## Standards Review",
      "",
      STANDARDS_MARKER,
      "",
      "Nothing to report.",
    ]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.standardsEntries.length, 0);
});

Deno.test("independent review - a violation must name evidence and its outcome", () => {
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(GOOD_SPEC_BLOCK, [
      "## Standards Review",
      "",
      STANDARDS_MARKER,
      "",
      "- **violation** — American spelling in the new module",
    ]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.problems.length, 2);
  assert(result.problems.some((p) => p.includes("no evidence")));
  assert(result.problems.some((p) => p.includes("no reason")));
});

Deno.test("independent review - a fixed violation passes", () => {
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(GOOD_SPEC_BLOCK, [
      "## Standards Review",
      "",
      STANDARDS_MARKER,
      "",
      "- **violation** — American spelling — evidence: `lib/foo.ts:12` — " +
      "reason: corrected to `behaviour` in this diff",
    ]),
  });
  assertEquals(result.problems, []);
  assertEquals(result.valid, true);
});

// --- axis separation ---

Deno.test("independent review - a standards finding inside the criteria block is a merge", () => {
  const merged = [
    ...GOOD_SPEC_BLOCK,
    "- **violation** — American spelling — evidence: `lib/foo.ts:12` — " +
    "reason: corrected",
  ];
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(merged, GOOD_STANDARDS_BLOCK),
  });
  assertEquals(result.valid, false);
  assert(
    result.problems.some((p) => p.includes("Standards finding")),
    `got ${JSON.stringify(result.problems)}`,
  );
});

Deno.test("independent review - a criterion inside the standards block is a merge", () => {
  const merged = [
    ...GOOD_STANDARDS_BLOCK,
    "- **missing** — the tablet breakpoint — reason: no viewport in the matrix",
  ];
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(GOOD_SPEC_BLOCK, merged),
  });
  assertEquals(result.valid, false);
  assert(
    result.problems.some((p) => p.includes("acceptance-criteria entry")),
    `got ${JSON.stringify(result.problems)}`,
  );
});

Deno.test("independent review - prose mentioning another axis is not a merge", () => {
  // "clean" and "violation" appear inside the criterion text, not as its
  // leading status — classification is by the leading token only, so prose
  // never trips the separation rule.
  const prose = [
    "## Acceptance Criteria",
    "",
    SPEC_MARKER,
    "",
    "- **met** — the gate reports a clean run with no violation merged in — " +
    "evidence: `tests/foo_test.ts` — reviewer: met",
    "- **met** — The Standards axis is reported separately — evidence: " +
    "`lib/foo.ts` — reviewer: met",
  ];
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(prose, GOOD_STANDARDS_BLOCK),
  });
  assertEquals(result.problems, []);
  assertEquals(result.valid, true);
});

// --- parseStandardsEntries ---

Deno.test("parseStandardsEntries - reads statuses, evidence and reasons", () => {
  const entries = parseStandardsEntries([
    "## Standards Review",
    "",
    "- **violation** — no test for the error path — evidence: `lib/a.ts` — " +
    "reason: added one",
    "- **clean** — commit safety, no hidden paths staged",
  ].join("\n"));
  assertEquals(entries.length, 2);
  assertEquals(entries[0]!.status, "violation");
  assertEquals(entries[0]!.hasEvidence, true);
  assertEquals(entries[0]!.hasReason, true);
  assertEquals(entries[1]!.status, "clean");
  assertEquals(entries[1]!.hasEvidence, false);
});

Deno.test("parseStandardsEntries - no section yields no entries", () => {
  assertEquals(parseStandardsEntries("## Summary\n\nNothing here.\n"), []);
});

// --- the blocking comment ---

Deno.test("buildIndependentReviewComment - names every problem and the shape", () => {
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary(["## Acceptance Criteria", "", "- **met** — x"]),
  });
  const comment = buildIndependentReviewComment(result);
  for (const problem of result.problems) {
    assertStringIncludes(comment, problem);
  }
  assertStringIncludes(comment, "vibe-spec-review");
  assertStringIncludes(comment, "vibe-standards-review");
  assertStringIncludes(comment, "## Standards Review");
  assertStringIncludes(comment, "reviewer:");
});
