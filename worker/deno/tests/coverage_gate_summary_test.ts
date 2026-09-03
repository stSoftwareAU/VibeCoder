/**
 * Issue #859: the plan-coverage log line must name the failure that occurred.
 *
 * The escalation comment has always been accurate — `buildCoverageGateReason`
 * branches on all four outcomes. The operator-facing log line did not. It
 * asserted "the published plan does not account for every ask" for every
 * outcome, including the case where **no table was posted at all**, and the
 * fields alongside it then contradicted the claim:
 *
 * ```text
 * WARNING: Plan-coverage gate: the published plan does not account for every
 *   ask — escalating to a human (Issue #520)
 *   repo=... issueNumber=794 tableFound=false asks=0 uncovered=
 * ```
 *
 * With `asks=0` and `uncovered=` empty, nothing is uncovered. A reader is
 * told a specific defect that the accompanying data disproves, which reads as
 * a false positive and costs a code dive to settle. It fired again for #863
 * on the same day, so it is not a one-off.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PlanCoverageVerdict,
  summariseCoverageGateFailure,
} from "../lib/plan_coverage_gate.ts";

const base: PlanCoverageVerdict = {
  tableFound: true,
  rowCount: 0,
  offenders: [],
  passed: false,
};

Deno.test("coverage summary - a missing table says so, not 'every ask' (Issue #859)", () => {
  // The exact shape observed for #794 and #863.
  const summary = summariseCoverageGateFailure({
    ...base,
    tableFound: false,
  });
  assertStringIncludes(summary, "no `## Plan Coverage` table was posted");
  assert(
    !summary.includes("every ask"),
    "must not assert uncovered asks when none were found",
  );
});

Deno.test("coverage summary - an unreadable parent is named as unverified (Issue #859)", () => {
  const summary = summariseCoverageGateFailure({
    ...base,
    tableFound: false,
    readFailed: true,
  });
  assertStringIncludes(summary, "could not be read");
  assertStringIncludes(summary, "unverified");
});

Deno.test("coverage summary - an empty table is distinct from a missing one (Issue #859)", () => {
  const summary = summariseCoverageGateFailure({ ...base, rowCount: 0 });
  assertStringIncludes(summary, "no ask rows");
  assert(
    !summary.includes("was posted"),
    "an empty table is not a missing table",
  );
});

Deno.test("coverage summary - genuinely uncovered asks are counted (Issue #859)", () => {
  const summary = summariseCoverageGateFailure({
    ...base,
    rowCount: 3,
    offenders: [
      { ask: "first", reason: "no sub-issue" },
      { ask: "second", reason: "no sub-issue" },
    ],
  } as PlanCoverageVerdict);
  assertStringIncludes(summary, "2 asks");
  assertStringIncludes(summary, "covering sub-issue");
});

Deno.test("coverage summary - one uncovered ask is singular (Issue #859)", () => {
  const summary = summariseCoverageGateFailure({
    ...base,
    rowCount: 2,
    offenders: [{ ask: "only", reason: "no sub-issue" }],
  } as PlanCoverageVerdict);
  assertStringIncludes(summary, "1 ask ");
  assert(!summary.includes("1 asks"), "singular, not '1 asks'");
});

Deno.test("coverage summary - the four outcomes are all distinguishable (Issue #859)", () => {
  const summaries = new Set([
    summariseCoverageGateFailure({
      ...base,
      tableFound: false,
      readFailed: true,
    }),
    summariseCoverageGateFailure({ ...base, tableFound: false }),
    summariseCoverageGateFailure({ ...base, rowCount: 0 }),
    summariseCoverageGateFailure(
      {
        ...base,
        rowCount: 1,
        offenders: [{ ask: "a", reason: "r" }],
      } as PlanCoverageVerdict,
    ),
  ]);
  assertEquals(
    summaries.size,
    4,
    "each failure mode must read differently, or the log cannot tell them apart",
  );
});
