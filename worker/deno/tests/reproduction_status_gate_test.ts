/**
 * Tests for the bug-fix reproduction-status gate (Issue #521).
 *
 * Every test calls the real parser/verifier with a PR summary and asserts on
 * the verdict it returns — no source-text inspection. Covers: the gate not
 * applying to a non-`bug` issue, a bug-labelled summary with no
 * `## Reproduction` block (rejected), an honest `not-run` with a reason
 * (accepted), a complete `verified` block (accepted), and the over-claim the
 * gate exists to catch — `verified` with no fail-before/pass-after observation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildReproductionGateComment,
  hasBugLabel,
  parseReproductionBlock,
  validateReproductionStatus,
} from "../lib/reproduction_status_gate.ts";

const SUMMARY_HEAD = `## Summary

Fixed the leap-year branch of the date parser. Closes #521.
`;

const TEST_PLAN = `
## Test Plan

- \`worker/deno/tests/date_parser_test.ts\`
`;

/** A complete, honest `verified` block. */
const VERIFIED_BLOCK = `
## Reproduction

- **symptom** — \`parseDate("2024-02-29")\` threw \`RangeError\` on a leap day
- **status** — \`verified\` — the regression test was observed failing against the unfixed code and passing after the fix
- **regression test** — \`worker/deno/tests/date_parser_test.ts::parses a leap day\`
`;

/** An honest `not-run` block: the status is downgraded and explained. */
const NOT_RUN_BLOCK = `
## Reproduction

- **symptom** — the nightly job aborts once a month with \`RangeError\`
- **status** — \`not-run\` — reason: the fault needs production scheduling data that is not reachable from this container
- **regression test** — \`worker/deno/tests/date_parser_test.ts::parses a leap day\`
`;

const summaryWith = (block: string) => `${SUMMARY_HEAD}${block}${TEST_PLAN}`;

const BUG_LABELS = "bug,work-on";
const PLAIN_LABELS = "enhancement,work-on";

// --- hasBugLabel ---

Deno.test("hasBugLabel - detects the whole label among others", () => {
  assertEquals(hasBugLabel("work-on,bug,top-priority"), true);
  assertEquals(hasBugLabel(" Bug "), true);
});

Deno.test("hasBugLabel - a substring is not the label", () => {
  assertEquals(hasBugLabel("bugbear,enhancement"), false);
  assertEquals(hasBugLabel("debugging"), false);
  assertEquals(hasBugLabel(""), false);
});

// --- parseReproductionBlock ---

Deno.test("parseReproductionBlock - reads every field of a verified block", () => {
  const block = parseReproductionBlock(summaryWith(VERIFIED_BLOCK));

  assertEquals(block.present, true);
  assertEquals(block.status, "verified");
  assertStringIncludes(block.symptom, "RangeError");
  assertStringIncludes(block.regressionTest, "date_parser_test.ts");
  assertEquals(block.observedFailBeforePassAfter, true);
});

Deno.test("parseReproductionBlock - reads a not-run status and its reason", () => {
  const block = parseReproductionBlock(summaryWith(NOT_RUN_BLOCK));

  assertEquals(block.status, "not-run");
  assertStringIncludes(block.reason, "production scheduling data");
});

Deno.test("parseReproductionBlock - absent block reports present=false", () => {
  const block = parseReproductionBlock(summaryWith(""));

  assertEquals(block.present, false);
  assertEquals(block.status, null);
});

Deno.test("parseReproductionBlock - reads fields written as prose lines", () => {
  const block = parseReproductionBlock(`## Reproduction

Symptom: the CLI exits 0 on a failed upload.
Status: partial — reason: only the client half could be exercised locally.
Regression test: worker/deno/tests/upload_test.ts::reports a failed upload

## Test Plan
`);

  assertEquals(block.status, "partial");
  assertStringIncludes(block.symptom, "exits 0");
  assertStringIncludes(block.reason, "client half");
});

// --- validateReproductionStatus ---

Deno.test("gate - does not apply to an issue without the bug label", () => {
  const result = validateReproductionStatus({
    issueLabels: PLAIN_LABELS,
    prSummaryContent: summaryWith(""),
  });

  assertEquals(result.applicable, false);
  assertEquals(result.valid, true);
  assertEquals(result.problems, []);
});

Deno.test("gate - a bug-labelled summary with no block is rejected", () => {
  const result = validateReproductionStatus({
    issueLabels: BUG_LABELS,
    prSummaryContent: summaryWith(""),
  });

  assertEquals(result.applicable, true);
  assertEquals(result.valid, false);
  assertEquals(result.problems.length, 1);
  assertStringIncludes(result.problems[0]!, "## Reproduction");
});

Deno.test("gate - an honest not-run with a reason is accepted", () => {
  const result = validateReproductionStatus({
    issueLabels: BUG_LABELS,
    prSummaryContent: summaryWith(NOT_RUN_BLOCK),
  });

  assertEquals(result.applicable, true);
  assertEquals(result.problems, []);
  assertEquals(result.valid, true);
});

Deno.test("gate - a complete verified block is accepted", () => {
  const result = validateReproductionStatus({
    issueLabels: BUG_LABELS,
    prSummaryContent: summaryWith(VERIFIED_BLOCK),
  });

  assertEquals(result.problems, []);
  assertEquals(result.valid, true);
});

Deno.test("gate - not-run without a reason is rejected", () => {
  const result = validateReproductionStatus({
    issueLabels: BUG_LABELS,
    prSummaryContent: summaryWith(`
## Reproduction

- **symptom** — the nightly job aborts once a month
- **status** — \`not-run\`
- **regression test** — \`worker/deno/tests/date_parser_test.ts::parses a leap day\`
`),
  });

  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "reason");
});

Deno.test(
  "gate - verified without a fail-before/pass-after observation is rejected",
  () => {
    const result = validateReproductionStatus({
      issueLabels: BUG_LABELS,
      prSummaryContent: summaryWith(`
## Reproduction

- **symptom** — a leap day threw \`RangeError\`
- **status** — \`verified\`
- **regression test** — \`worker/deno/tests/date_parser_test.ts::parses a leap day\`
`),
    });

    assertEquals(result.valid, false);
    assertStringIncludes(result.problems.join("\n"), "partial");
  },
);

Deno.test("gate - verified naming no regression test is rejected", () => {
  const result = validateReproductionStatus({
    issueLabels: BUG_LABELS,
    prSummaryContent: summaryWith(`
## Reproduction

- **symptom** — a leap day threw \`RangeError\`
- **status** — \`verified\` — watched it fail against the unfixed code and pass after the fix
`),
  });

  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "regression test");
});

Deno.test("gate - a block with no symptom is rejected", () => {
  const result = validateReproductionStatus({
    issueLabels: BUG_LABELS,
    prSummaryContent: summaryWith(`
## Reproduction

- **status** — \`not-run\` — reason: the fault needs production data
- **regression test** — \`worker/deno/tests/date_parser_test.ts::parses a leap day\`
`),
  });

  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "symptom");
});

Deno.test("gate - an unrecognised status word is rejected", () => {
  const result = validateReproductionStatus({
    issueLabels: BUG_LABELS,
    prSummaryContent: summaryWith(`
## Reproduction

- **symptom** — a leap day threw \`RangeError\`
- **status** — reproduced 🎉
- **regression test** — \`worker/deno/tests/date_parser_test.ts::parses a leap day\`
`),
  });

  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "not-run");
});

// --- buildReproductionGateComment ---

Deno.test("buildReproductionGateComment - names each problem and the shape", () => {
  const result = validateReproductionStatus({
    issueLabels: BUG_LABELS,
    prSummaryContent: summaryWith(""),
  });
  const comment = buildReproductionGateComment(result);

  assertStringIncludes(comment, "## Reproduction");
  assertStringIncludes(comment, "not-run");
  assertStringIncludes(comment, result.problems[0]!);
});
