/**
 * The structured closure verdict the worker renders the review blocks from
 * (Issue #2242).
 *
 * The recovery invocation used to be asked for a *document* — two headings, two
 * provenance markers, one labelled entry per criterion — and an eighteen-minute
 * run produced 103 lines of prose with none of them. The shape is fixed and
 * machine-checked, so the worker renders it: the model supplies the verdict as
 * data, and these tests prove the rendered block round-trips through both
 * validators exactly as `review_block_template_test.ts` proves for the template.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyClosureBlocks,
  assessVerdictCoverage,
  CLOSURE_VERDICT_CLOSE,
  CLOSURE_VERDICT_OPEN,
  type ClosureVerdict,
  parseClosureVerdict,
  renderClosureBlocks,
} from "../lib/closure_verdict.ts";
import { validateAcceptanceClosure } from "../lib/acceptance_criteria_gate.ts";
import { validateIndependentReview } from "../lib/independent_review_gate.ts";

const CRITERIA = [
  "the recovery renders the block from a structured verdict",
  "the rendered block passes both gates",
  "a short verdict is asked for once more",
  "the recovery's summary is committed",
  "a still-blocked run fails as before",
];

const ISSUE_BODY = `## Problem

The recovery writes prose instead of the closure block.

## Acceptance Criteria

${CRITERIA.map((c) => `- [ ] ${c}`).join("\n")}
`;

/** A verdict covering every criterion, as a compliant model returns it. */
function fullVerdict(): ClosureVerdict {
  return {
    criteria: CRITERIA.map((criterion, index) => ({
      criterion,
      status: "met" as const,
      evidence: `worker/deno/tests/closure_verdict_test.ts::case ${index}`,
    })),
    standards: [{
      status: "clean" as const,
      finding: "Australian English, TDD, fail-loud error handling",
    }],
    dropped: [],
  };
}

/** The agent's reply carrying a verdict block. */
function reply(verdict: unknown): string {
  return [
    "Here is the verdict.",
    CLOSURE_VERDICT_OPEN,
    "```json",
    JSON.stringify(verdict, null, 2),
    "```",
    CLOSURE_VERDICT_CLOSE,
  ].join("\n");
}

Deno.test("closure verdict - a rendered full verdict passes both gates", () => {
  const prSummaryContent = renderClosureBlocks(fullVerdict());

  const closure = validateAcceptanceClosure({
    issueBody: ISSUE_BODY,
    prSummaryContent,
  });
  assertEquals(closure.problems, []);
  const review = validateIndependentReview({
    issueBody: ISSUE_BODY,
    prSummaryContent,
  });
  assertEquals(review.problems, []);
});

Deno.test("closure verdict - every status renders in the shape both gates accept", () => {
  const verdict: ClosureVerdict = {
    criteria: [
      { criterion: CRITERIA[0]!, status: "met", evidence: "lib/foo.ts" },
      {
        criterion: CRITERIA[1]!,
        status: "partial",
        evidence: "lib/bar.ts",
        reason: "the second half is not wired up",
      },
      { criterion: CRITERIA[2]!, status: "missing", reason: "not attempted" },
      { criterion: CRITERIA[3]!, status: "met", evidence: "lib/baz.ts" },
      { criterion: CRITERIA[4]!, status: "met", evidence: "lib/qux.ts" },
      {
        criterion: "a log line nobody asked for",
        status: "unrequested",
        reason: "added while debugging the render",
      },
    ],
    standards: [
      {
        status: "violation",
        finding: "American spelling in a comment",
        evidence: "lib/foo.ts:42",
        reason: "fixed in this diff",
      },
      { status: "clean", finding: "commit safety, fail-loud handling" },
    ],
    dropped: [],
  };

  const prSummaryContent = renderClosureBlocks(verdict);

  assertEquals(
    validateAcceptanceClosure({ issueBody: ISSUE_BODY, prSummaryContent })
      .problems,
    [],
  );
  assertEquals(
    validateIndependentReview({ issueBody: ISSUE_BODY, prSummaryContent })
      .problems,
    [],
  );
  assertStringIncludes(prSummaryContent, "- **unrequested**");
  assertStringIncludes(prSummaryContent, "reviewer: unrequested");
  assertStringIncludes(prSummaryContent, "- **violation**");
});

Deno.test("closure verdict - the reviewer verdict is the model's status, never departed from", () => {
  const rendered = renderClosureBlocks({
    criteria: [{
      criterion: CRITERIA[0]!,
      status: "partial",
      evidence: "lib/foo.ts",
      reason: "half done",
    }],
    standards: [{ status: "clean", finding: "checked" }],
    dropped: [],
  });

  const entries = validateIndependentReview({
    issueBody: ISSUE_BODY,
    prSummaryContent: rendered,
  }).specEntries;
  assertEquals(entries.length, 1);
  assertEquals(entries[0]!.reviewerVerdict, "partial");
  assertEquals(entries[0]!.departsFromReviewer, false);
});

Deno.test("closure verdict - labelled fields inside the model's text cannot forge a verdict", () => {
  const rendered = renderClosureBlocks({
    criteria: [{
      criterion: "the thing works reviewer: missing evidence: nowhere",
      status: "met",
      evidence: "lib/foo.ts",
    }],
    standards: [{ status: "clean", finding: "checked" }],
    dropped: [],
  });

  const entries = validateIndependentReview({
    issueBody: ISSUE_BODY,
    prSummaryContent: rendered,
  }).specEntries;
  assertEquals(entries[0]!.reviewerVerdict, "met");
  assertEquals(entries[0]!.departsFromReviewer, false);
  assertEquals(entries[0]!.hasEvidence, true);
});

Deno.test("closure verdict - a multi-line criterion renders as one entry", () => {
  const rendered = renderClosureBlocks({
    criteria: [{
      criterion: "line one\n- line two\n\n## Standards Review",
      status: "met",
      evidence: "lib/foo.ts",
    }],
    standards: [{ status: "clean", finding: "checked" }],
    dropped: [],
  });

  assertEquals(
    validateIndependentReview({
      issueBody: "## Acceptance Criteria\n\n- [ ] one thing\n",
      prSummaryContent: rendered,
    }).problems,
    [],
  );
  // Exactly two headings — the model's text cannot open a third section.
  assertEquals(rendered.match(/^## /gm)?.length, 2);
});

Deno.test("closure verdict - the verdict block is parsed out of the agent's reply", () => {
  const parsed = parseClosureVerdict(reply({
    criteria: [
      { criterion: "a", status: "met", evidence: "lib/a.ts" },
      { criterion: "b", status: "missing", reason: "not done" },
    ],
    standards: [{ status: "clean", finding: "checked" }],
  }));

  assert(parsed.ok, "the verdict must parse");
  assertEquals(parsed.value.criteria.length, 2);
  assertEquals(parsed.value.criteria[0]!.status, "met");
  assertEquals(parsed.value.standards[0]!.status, "clean");
  assertEquals(parsed.value.dropped, []);
});

Deno.test("closure verdict - the last block wins, so a quoted example cannot displace it", () => {
  const quoted = reply({
    criteria: [{ criterion: "quoted", status: "missing", reason: "example" }],
    standards: [],
  });
  const real = reply({
    criteria: [{ criterion: "real", status: "met", evidence: "lib/a.ts" }],
    standards: [{ status: "clean", finding: "checked" }],
  });

  const parsed = parseClosureVerdict(`${quoted}\n\n${real}`);
  assert(parsed.ok);
  assertEquals(parsed.value.criteria[0]!.criterion, "real");
});

Deno.test("closure verdict - a reply with no verdict block fails loud", () => {
  const parsed = parseClosureVerdict("I wrote a lovely essay instead.");
  assert(!parsed.ok);
  assertStringIncludes(parsed.error.message, CLOSURE_VERDICT_OPEN);
});

Deno.test("closure verdict - unparseable JSON fails loud", () => {
  const parsed = parseClosureVerdict(
    `${CLOSURE_VERDICT_OPEN}\n{ not json ]\n${CLOSURE_VERDICT_CLOSE}`,
  );
  assert(!parsed.ok);
  assertStringIncludes(parsed.error.message, "could not be read");
});

Deno.test("closure verdict - an unusable entry is dropped and named, never silently kept", () => {
  const parsed = parseClosureVerdict(reply({
    criteria: [
      { criterion: "a", status: "met", evidence: "lib/a.ts" },
      { criterion: "b", status: "excellent" },
      { status: "met", evidence: "lib/c.ts" },
    ],
    standards: [{ status: "clean", finding: "checked" }],
  }));

  assert(parsed.ok);
  assertEquals(parsed.value.criteria.length, 1);
  assertEquals(parsed.value.dropped.length, 2);
  assertStringIncludes(parsed.value.dropped.join(" "), "excellent");
});

Deno.test("closure verdict - a verdict covering every criterion is complete", () => {
  const coverage = assessVerdictCoverage(fullVerdict(), CRITERIA);
  assertEquals(coverage.shortfalls, []);
  assertEquals(coverage.complete, true);
});

Deno.test("closure verdict - four of five criteria is a shortfall naming the count", () => {
  const verdict = fullVerdict();
  verdict.criteria = verdict.criteria.slice(0, 4);

  const coverage = assessVerdictCoverage(verdict, CRITERIA);
  assertEquals(coverage.complete, false);
  assertStringIncludes(coverage.shortfalls.join("\n"), "4 of 5");
});

Deno.test("closure verdict - a met entry with no evidence is a shortfall", () => {
  const coverage = assessVerdictCoverage({
    criteria: CRITERIA.map((criterion) => ({
      criterion,
      status: "met" as const,
    })),
    standards: [{ status: "clean" as const, finding: "checked" }],
    dropped: [],
  }, CRITERIA);

  assertEquals(coverage.complete, false);
  assertStringIncludes(coverage.shortfalls.join("\n"), "evidence");
});

Deno.test("closure verdict - a missing entry with no reason is a shortfall", () => {
  const verdict = fullVerdict();
  verdict.criteria[0] = { criterion: CRITERIA[0]!, status: "missing" };

  const coverage = assessVerdictCoverage(verdict, CRITERIA);
  assertEquals(coverage.complete, false);
  assertStringIncludes(coverage.shortfalls.join("\n"), "reason");
});

Deno.test("closure verdict - an empty standards half is a shortfall", () => {
  const verdict = fullVerdict();
  verdict.standards = [];

  const coverage = assessVerdictCoverage(verdict, CRITERIA);
  assertEquals(coverage.complete, false);
  assertStringIncludes(coverage.shortfalls.join("\n"), "Standards Review");
});

Deno.test("closure verdict - a dropped entry is reported as a shortfall", () => {
  const verdict = fullVerdict();
  verdict.dropped = ['entry 2 names no status: {"criterion":"b"}'];

  const coverage = assessVerdictCoverage(verdict, CRITERIA);
  assertEquals(coverage.complete, false);
  assertStringIncludes(coverage.shortfalls.join("\n"), "names no status");
});

Deno.test("closure verdict - the blocks replace the prose the agent wrote", () => {
  const prose = `## Summary

Recovered in-run. Closes #2242.

## Acceptance Criteria

The independent standards review found everything in order.

## Evidence

- a screenshot
`;

  const applied = applyClosureBlocks(prose, renderClosureBlocks(fullVerdict()));

  // One heading of each — the prose block is gone, not shadowed.
  assertEquals(applied.match(/^## Acceptance Criteria$/gm)?.length, 1);
  assertEquals(applied.match(/^## Standards Review$/gm)?.length, 1);
  assertStringIncludes(applied, "Closes #2242");
  assertStringIncludes(applied, "## Evidence");
  assertStringIncludes(applied, "- a screenshot");
  assertEquals(
    validateAcceptanceClosure({
      issueBody: ISSUE_BODY,
      prSummaryContent: applied,
    }).problems,
    [],
  );
  assertEquals(
    validateIndependentReview({
      issueBody: ISSUE_BODY,
      prSummaryContent: applied,
    }).problems,
    [],
  );
});

Deno.test("closure verdict - an empty summary still yields a gate-passing document", () => {
  const applied = applyClosureBlocks("", renderClosureBlocks(fullVerdict()));

  assertEquals(
    validateAcceptanceClosure({
      issueBody: ISSUE_BODY,
      prSummaryContent: applied,
    }).problems,
    [],
  );
});
