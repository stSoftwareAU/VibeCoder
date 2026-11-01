/**
 * Tests for the Issue #4613 live fields on `parsePrLiveFields` and the
 * `classifyCheckRollup` helper behind them.
 *
 * `reviewSatisfied` and `checks` feed the auto-merge sweep's ready-to-merge
 * test. Unknown is never satisfied: every shape the parser cannot read leaves
 * both fields absent, so a sweep that reads them as "not present" holds back.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  classifyCheckRollup,
  parsePrLiveFields,
} from "../lib/pr_branch_update.ts";

/** A `gh pr view --json` payload with the fields a PR always carries. */
function payload(fields: Record<string, unknown>): string {
  return JSON.stringify({
    state: "OPEN",
    mergeable: "MERGEABLE",
    autoMergeRequest: null,
    mergeStateStatus: "CLEAN",
    ...fields,
  });
}

/** A completed CheckRun with the given conclusion. */
function checkRun(conclusion: string | null): Record<string, unknown> {
  return {
    __typename: "CheckRun",
    name: "ci",
    status: "COMPLETED",
    conclusion,
  };
}

/** A StatusContext with the given state. */
function statusContext(state: string): Record<string, unknown> {
  return { __typename: "StatusContext", context: "ci/legacy", state };
}

/** The `checks` outcome for a rollup, through the real parser. */
function checksOf(rollup: unknown): unknown {
  return parsePrLiveFields(payload({ statusCheckRollup: rollup })).checks;
}

// =============================================================================
// reviewSatisfied — parsePrLiveFields (Issue #4613)
// =============================================================================

Deno.test("parsePrLiveFields - reviewSatisfied is true when reviewDecision is APPROVED (Issue #4613)", () => {
  const fields = parsePrLiveFields(payload({ reviewDecision: "APPROVED" }));
  assertEquals(fields.reviewSatisfied, true);
});

Deno.test("parsePrLiveFields - reviewSatisfied is true when reviewDecision is an empty string, which GitHub reports when no review is required (Issue #4613)", () => {
  const fields = parsePrLiveFields(payload({ reviewDecision: "" }));
  assertEquals(fields.reviewSatisfied, true);
});

Deno.test("parsePrLiveFields - reviewSatisfied is true when reviewDecision is null, which GitHub reports when no review is required (Issue #4613)", () => {
  const fields = parsePrLiveFields(payload({ reviewDecision: null }));
  assertEquals(fields.reviewSatisfied, true);
});

Deno.test("parsePrLiveFields - reviewSatisfied is absent when reviewDecision is REVIEW_REQUIRED (Issue #4613)", () => {
  const fields = parsePrLiveFields(
    payload({ reviewDecision: "REVIEW_REQUIRED" }),
  );
  assertEquals("reviewSatisfied" in fields, false);
});

Deno.test("parsePrLiveFields - reviewSatisfied is absent when reviewDecision is CHANGES_REQUESTED (Issue #4613)", () => {
  const fields = parsePrLiveFields(
    payload({ reviewDecision: "CHANGES_REQUESTED" }),
  );
  assertEquals("reviewSatisfied" in fields, false);
});

Deno.test("parsePrLiveFields - reviewSatisfied is absent for an unrecognised reviewDecision string (Issue #4613)", () => {
  const fields = parsePrLiveFields(payload({ reviewDecision: "approved" }));
  assertEquals("reviewSatisfied" in fields, false);
});

Deno.test("parsePrLiveFields - reviewSatisfied is absent when the reviewDecision key is missing (Issue #4613)", () => {
  const fields = parsePrLiveFields(payload({}));
  assertEquals("reviewSatisfied" in fields, false);
});

Deno.test("parsePrLiveFields - reviewSatisfied is absent for a bare state string (Issue #4613)", () => {
  const fields = parsePrLiveFields("OPEN");
  assertEquals("reviewSatisfied" in fields, false);
});

Deno.test("parsePrLiveFields - reviewSatisfied is absent for an unparseable payload (Issue #4613)", () => {
  const fields = parsePrLiveFields("{not json");
  assertEquals("reviewSatisfied" in fields, false);
});

// =============================================================================
// checks — classifyCheckRollup and parsePrLiveFields (Issue #4613)
// =============================================================================

Deno.test("classifyCheckRollup - a completed CheckRun with SUCCESS, NEUTRAL or SKIPPED passes (Issue #4613)", () => {
  assertEquals(classifyCheckRollup([checkRun("SUCCESS")]), "passed");
  assertEquals(classifyCheckRollup([checkRun("NEUTRAL")]), "passed");
  assertEquals(classifyCheckRollup([checkRun("SKIPPED")]), "passed");
});

Deno.test("classifyCheckRollup - a StatusContext with SUCCESS passes (Issue #4613)", () => {
  assertEquals(classifyCheckRollup([statusContext("SUCCESS")]), "passed");
});

Deno.test("classifyCheckRollup - an empty rollup passes (Issue #4613)", () => {
  assertEquals(classifyCheckRollup([]), "passed");
});

Deno.test("classifyCheckRollup - a CheckRun still in progress is pending (Issue #4613)", () => {
  assertEquals(
    classifyCheckRollup([{
      __typename: "CheckRun",
      status: "IN_PROGRESS",
      conclusion: null,
    }]),
    "pending",
  );
});

Deno.test("classifyCheckRollup - a queued CheckRun with an empty conclusion is pending (Issue #4613)", () => {
  assertEquals(
    classifyCheckRollup([{
      __typename: "CheckRun",
      status: "QUEUED",
      conclusion: "",
    }]),
    "pending",
  );
});

Deno.test("classifyCheckRollup - a COMPLETED CheckRun with no conclusion yet is pending (Issue #4613)", () => {
  assertEquals(classifyCheckRollup([checkRun(null)]), "pending");
});

Deno.test("classifyCheckRollup - a StatusContext in PENDING or EXPECTED is pending (Issue #4613)", () => {
  assertEquals(classifyCheckRollup([statusContext("PENDING")]), "pending");
  assertEquals(classifyCheckRollup([statusContext("EXPECTED")]), "pending");
});

Deno.test("classifyCheckRollup - each failing CheckRun conclusion fails the rollup (Issue #4613)", () => {
  for (
    const conclusion of [
      "FAILURE",
      "TIMED_OUT",
      "CANCELLED",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
    ]
  ) {
    assertEquals(
      classifyCheckRollup([checkRun(conclusion)]),
      "failed",
      conclusion,
    );
  }
});

Deno.test("classifyCheckRollup - a StatusContext in FAILURE or ERROR fails the rollup (Issue #4613)", () => {
  assertEquals(classifyCheckRollup([statusContext("FAILURE")]), "failed");
  assertEquals(classifyCheckRollup([statusContext("ERROR")]), "failed");
});

Deno.test("classifyCheckRollup - a failure beats a pending check in the same rollup (Issue #4613)", () => {
  assertEquals(
    classifyCheckRollup([
      statusContext("PENDING"),
      checkRun("FAILURE"),
      checkRun("SUCCESS"),
    ]),
    "failed",
  );
});

Deno.test("classifyCheckRollup - a pending check beats a passing one in the same rollup (Issue #4613)", () => {
  assertEquals(
    classifyCheckRollup([
      checkRun("SUCCESS"),
      statusContext("EXPECTED"),
    ]),
    "pending",
  );
});

Deno.test("classifyCheckRollup - matches conclusions and states case-insensitively after trimming (Issue #4613)", () => {
  assertEquals(classifyCheckRollup([checkRun(" success ")]), "passed");
  assertEquals(classifyCheckRollup([statusContext("failure")]), "failed");
  assertEquals(classifyCheckRollup([statusContext(" pending ")]), "pending");
});

Deno.test("classifyCheckRollup - a non-array rollup is unknown, so it returns undefined (Issue #4613)", () => {
  assertEquals(classifyCheckRollup(undefined), undefined);
  assertEquals(classifyCheckRollup(null), undefined);
  assertEquals(classifyCheckRollup("SUCCESS"), undefined);
  assertEquals(classifyCheckRollup({ state: "SUCCESS" }), undefined);
});

Deno.test("classifyCheckRollup - an entry that is neither a finished CheckRun nor a StatusContext is pending, never passed (Issue #4613)", () => {
  assertEquals(classifyCheckRollup([null]), "pending");
  assertEquals(classifyCheckRollup([{}]), "pending");
});

Deno.test("parsePrLiveFields - checks is passed for a green rollup (Issue #4613)", () => {
  assertEquals(
    checksOf([checkRun("SUCCESS"), statusContext("SUCCESS")]),
    "passed",
  );
});

Deno.test("parsePrLiveFields - checks is pending for an unfinished rollup (Issue #4613)", () => {
  assertEquals(checksOf([checkRun(null), checkRun("SUCCESS")]), "pending");
});

Deno.test("parsePrLiveFields - checks is failed for a rollup with a failure (Issue #4613)", () => {
  assertEquals(checksOf([checkRun("TIMED_OUT")]), "failed");
});

Deno.test("parsePrLiveFields - checks is absent when statusCheckRollup is missing (Issue #4613)", () => {
  const fields = parsePrLiveFields(payload({}));
  assertEquals("checks" in fields, false);
});

Deno.test("parsePrLiveFields - checks is absent when statusCheckRollup is not an array (Issue #4613)", () => {
  assertEquals(
    "checks" in parsePrLiveFields(payload({ statusCheckRollup: "SUCCESS" })),
    false,
  );
  assertEquals(
    "checks" in parsePrLiveFields(payload({ statusCheckRollup: {} })),
    false,
  );
  assertEquals(
    "checks" in parsePrLiveFields(payload({ statusCheckRollup: null })),
    false,
  );
});

Deno.test("parsePrLiveFields - checks is absent for a bare state string (Issue #4613)", () => {
  assertEquals("checks" in parsePrLiveFields("MERGED"), false);
});

Deno.test("parsePrLiveFields - checks is absent for an unparseable payload (Issue #4613)", () => {
  assertEquals("checks" in parsePrLiveFields("{not json"), false);
});

Deno.test("parsePrLiveFields - an empty statusCheckRollup array reads as checks passed (Issue #4613)", () => {
  assertEquals(checksOf([]), "passed");
});

Deno.test("parsePrLiveFields - reviewSatisfied and checks come from the same payload alongside the existing fields (Issue #4613)", () => {
  const fields = parsePrLiveFields(payload({
    reviewDecision: "APPROVED",
    statusCheckRollup: [checkRun("SUCCESS")],
  }));
  assertEquals(fields.state, "OPEN");
  assertEquals(fields.mergeable, "MERGEABLE");
  assertEquals(fields.reviewSatisfied, true);
  assertEquals(fields.checks, "passed");
});
