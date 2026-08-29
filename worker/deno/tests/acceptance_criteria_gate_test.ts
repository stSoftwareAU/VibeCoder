/**
 * Tests for acceptance_criteria_gate.ts — the closure gate that makes a
 * criteria-bearing issue produce a PR summary stating which criteria were met
 * (Issue #518).
 *
 * Covers: criteria extraction from an issue body, the failing case (a summary
 * with no closure block), the passing case, partial coverage, unexplained gaps,
 * missing evidence, `unrequested` scope-creep entries, and issues with no
 * criteria at all (the gate must not apply).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildClosureGateComment,
  extractAcceptanceCriteria,
  parseClosureEntries,
  validateAcceptanceClosure,
} from "../lib/acceptance_criteria_gate.ts";

const ISSUE_WITH_CRITERIA = [
  "## Problem",
  "",
  "The criteria are never read again.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A new `prompts/issue/vN.md` requires the closure block.",
  "- [ ] A test drives the verifier against a summary that omits the block.",
  "",
  "## Failure detection",
  "",
  "The new test fails if the block is absent.",
].join("\n");

const ISSUE_WITHOUT_CRITERIA = [
  "## Problem",
  "",
  "Something is broken.",
  "",
  "## Failure detection",
  "",
  "A test fails.",
].join("\n");

function summary(acceptanceBlock: string[]): string {
  return [
    "## Summary",
    "",
    "Closed the loop. Closes #518.",
    "",
    ...acceptanceBlock,
    "",
    "## Test Plan",
    "",
    "- `worker/deno/tests/acceptance_criteria_gate_test.ts`",
  ].join("\n");
}

// --- extractAcceptanceCriteria ---

Deno.test("extractAcceptanceCriteria - reads checklist items under the heading", () => {
  const criteria = extractAcceptanceCriteria(ISSUE_WITH_CRITERIA);
  assertEquals(criteria.length, 2);
  assertStringIncludes(criteria[0]!, "requires the closure block");
  assertStringIncludes(criteria[1]!, "drives the verifier");
});

Deno.test("extractAcceptanceCriteria - no section means no criteria", () => {
  assertEquals(extractAcceptanceCriteria(ISSUE_WITHOUT_CRITERIA), []);
});

Deno.test("extractAcceptanceCriteria - heading with no list items yields none", () => {
  const body = "## Acceptance Criteria\n\nTo be decided.\n";
  assertEquals(extractAcceptanceCriteria(body), []);
});

// --- parseClosureEntries ---

Deno.test("parseClosureEntries - classifies each status and its fields", () => {
  const entries = parseClosureEntries(summary([
    "## Acceptance Criteria",
    "",
    "Assessed against the issue as written:",
    "",
    "- **met** — prompt v36 requires the block — evidence: `prompts/issue/v36.md`",
    "- **partial** — docs updated — evidence: `docs/PROMPTS.md` — reason: the workflow manual is still outstanding",
    "- **missing** — the CLI flag — reason: deferred to a follow-up issue",
    "- **unrequested** — bumped the lint config — reason: needed to keep the gate green",
  ]));

  assertEquals(entries.map((e) => e.status), [
    "met",
    "partial",
    "missing",
    "unrequested",
  ]);
  assertEquals(entries[0]!.hasEvidence, true);
  assertEquals(entries[0]!.hasReason, false);
  assertEquals(entries[1]!.hasEvidence, true);
  assertEquals(entries[1]!.hasReason, true);
  assertEquals(entries[2]!.hasReason, true);
  assertEquals(entries[3]!.hasReason, true);
});

Deno.test("parseClosureEntries - reads evidence from a nested continuation line", () => {
  const entries = parseClosureEntries(summary([
    "## Acceptance Criteria",
    "",
    "- **met** — the parser is wired in",
    "  - evidence: `worker/deno/lib/acceptance_criteria_gate.ts`",
  ]));
  assertEquals(entries.length, 1);
  assertEquals(entries[0]!.hasEvidence, true);
});

Deno.test("parseClosureEntries - no block yields no entries", () => {
  assertEquals(parseClosureEntries(summary([])), []);
});

// --- validateAcceptanceClosure ---

Deno.test("validateAcceptanceClosure - summary omitting the block fails the gate", () => {
  const result = validateAcceptanceClosure({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary([]),
  });

  assertEquals(result.applicable, true);
  assertEquals(result.valid, false);
  assertEquals(result.criteria.length, 2);
  assertStringIncludes(
    result.problems.join("\n"),
    "no `## Acceptance Criteria`",
  );
});

Deno.test("validateAcceptanceClosure - summary with a complete block passes", () => {
  const result = validateAcceptanceClosure({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary([
      "## Acceptance Criteria",
      "",
      "- **met** — prompt requires the block — evidence: `prompts/issue/v36.md`",
      "- **met** — verifier test added — evidence: `worker/deno/tests/acceptance_criteria_gate_test.ts`",
    ]),
  });

  assertEquals(result.applicable, true);
  assertEquals(result.valid, true);
  assertEquals(result.problems, []);
});

Deno.test("validateAcceptanceClosure - fewer entries than criteria fails", () => {
  const result = validateAcceptanceClosure({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary([
      "## Acceptance Criteria",
      "",
      "- **met** — prompt requires the block — evidence: `prompts/issue/v36.md`",
    ]),
  });

  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "only 1 of 2");
});

Deno.test("validateAcceptanceClosure - an unexplained gap is a failure", () => {
  const result = validateAcceptanceClosure({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary([
      "## Acceptance Criteria",
      "",
      "- **met** — prompt requires the block — evidence: `prompts/issue/v36.md`",
      "- **missing** — verifier test added",
    ]),
  });

  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "carries no reason");
});

Deno.test("validateAcceptanceClosure - a met entry without evidence fails", () => {
  const result = validateAcceptanceClosure({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary([
      "## Acceptance Criteria",
      "",
      "- **met** — prompt requires the block",
      "- **met** — verifier test added — evidence: `tests/acceptance_criteria_gate_test.ts`",
    ]),
  });

  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "names no evidence");
});

Deno.test("validateAcceptanceClosure - unrequested entry needs a reason", () => {
  const withoutReason = validateAcceptanceClosure({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary([
      "## Acceptance Criteria",
      "",
      "- **met** — prompt requires the block — evidence: `prompts/issue/v36.md`",
      "- **met** — verifier test added — evidence: `tests/acceptance_criteria_gate_test.ts`",
      "- **unrequested** — renamed an unrelated helper",
    ]),
  });
  assertEquals(withoutReason.valid, false);
  assertStringIncludes(withoutReason.problems.join("\n"), "`unrequested`");

  const withReason = validateAcceptanceClosure({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary([
      "## Acceptance Criteria",
      "",
      "- **met** — prompt requires the block — evidence: `prompts/issue/v36.md`",
      "- **met** — verifier test added — evidence: `tests/acceptance_criteria_gate_test.ts`",
      "- **unrequested** — renamed an unrelated helper — reason: the old name clashed with the new module",
    ]),
  });
  assertEquals(withReason.valid, true);
});

Deno.test("validateAcceptanceClosure - issue without criteria is unaffected", () => {
  const result = validateAcceptanceClosure({
    issueBody: ISSUE_WITHOUT_CRITERIA,
    prSummaryContent: summary([]),
  });

  assertEquals(result.applicable, false);
  assertEquals(result.valid, true);
  assertEquals(result.problems, []);
});

Deno.test("validateAcceptanceClosure - criterion prose mentioning a status word does not reclassify", () => {
  const result = validateAcceptanceClosure({
    issueBody: "## Acceptance Criteria\n\n- [ ] The block is present\n",
    prSummaryContent: summary([
      "## Acceptance Criteria",
      "",
      "- **met** — the closure block is no longer missing — evidence: `prompts/issue/v36.md`",
    ]),
  });

  assertEquals(result.entries[0]!.status, "met");
  assertEquals(result.valid, true);
});

// --- buildClosureGateComment ---

Deno.test("buildClosureGateComment - names each problem and the required shape", () => {
  const result = validateAcceptanceClosure({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: summary([]),
  });
  const comment = buildClosureGateComment(result);

  assertStringIncludes(comment, "Acceptance-criteria closure missing");
  assertStringIncludes(comment, result.problems[0]!);
  assertStringIncludes(comment, "evidence:");
  assertStringIncludes(comment, "unrequested");
});
