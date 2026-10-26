/**
 * Tests for degraded_delivery.ts — the pure scope assessment: which scope an
 * issue states (including a grill-me `### Accepted scope so far` list, which
 * the acceptance-criteria gate does not read), and which of it a PR summary
 * shows as `met` (Issues #2562, #3128).
 *
 * Since Issue #4146 its main consumer is the unmet-criteria gate, which
 * blocks the PR on any shortfall; the follow-up filing these tests also used
 * to pin is gone.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { extractAcceptedScope } from "../lib/acceptance_criteria_gate.ts";
import {
  assessScopeShortfalls,
  UNSTATED_SCOPE_ITEM,
} from "../lib/degraded_delivery.ts";

/** The `partial`/`missing` gaps a summary reports (Issue #3506's verdict). */
function assessReportedGaps(issueBody: string, prBody: string) {
  const { delivered, shortfalls } = assessScopeShortfalls(issueBody, prBody);
  return {
    degraded: false,
    delivered,
    shortfalls: shortfalls.filter((s) => s.status !== "unassessed"),
  };
}

const ISSUE_WITH_CRITERIA = `## Problem

Two things are wrong.

## Acceptance Criteria

- [ ] The router sends planning to opus.
- [ ] The docs table lists opus for planning.
- [ ] The release floor is 1.9.0.
`;

/** A grill-me issue body, shaped like #2543 and #2560. */
const GRILL_ME_ISSUE = `<!-- GRILL-ME-UNDERSTANDING-START -->
## Current Understanding

Finish the switch.

### Accepted scope so far

- Route the eight planning phases to \`opus\`. Observable: config resolves opus.
- Raise the Claude Code pin. Observable: \`claude --version\` prints it.
- Bump the release floor to 1.9.0.

### Open questions

None.

### Assumptions

- This is not a scope item.
`;

const ISSUE_WITHOUT_SCOPE = `## Problem

The parser mishandles a leap year.
`;

// ---------------------------------------------------------------------------
// extractAcceptedScope
// ---------------------------------------------------------------------------

Deno.test("extractAcceptedScope - acceptance criteria are the scope when stated", () => {
  assertEquals(extractAcceptedScope(ISSUE_WITH_CRITERIA), [
    "The router sends planning to opus.",
    "The docs table lists opus for planning.",
    "The release floor is 1.9.0.",
  ]);
});

Deno.test("extractAcceptedScope - reads a grill-me 'Accepted scope so far' list and nothing after it", () => {
  const scope = extractAcceptedScope(GRILL_ME_ISSUE);
  assertEquals(scope.length, 3);
  assertStringIncludes(scope[0]!, "Route the eight planning phases");
  assertStringIncludes(scope[2]!, "Bump the release floor");
  assert(!scope.some((s) => s.includes("not a scope item")));
});

Deno.test("extractAcceptedScope - an issue stating neither yields no scope", () => {
  assertEquals(extractAcceptedScope(ISSUE_WITHOUT_SCOPE), []);
});

const MET_SUMMARY = `## Acceptance Criteria

- **met** — the export works — evidence: \`x_test.ts\` — reviewer: met
`;
const PARTIAL_SUMMARY = MET_SUMMARY.replace("**met**", "**partial**").replace(
  "reviewer: met",
  "reviewer: partial",
);
const EXPORT_ISSUE = "## Acceptance Criteria\n\n- the export works\n";

Deno.test("assessScopeShortfalls - matches scope against the closure block", () => {
  assertEquals(assessScopeShortfalls(EXPORT_ISSUE, MET_SUMMARY), {
    delivered: ["the export works"],
    shortfalls: [],
  });
  assertEquals(assessScopeShortfalls(EXPORT_ISSUE, PARTIAL_SUMMARY), {
    delivered: [],
    shortfalls: [{ criterion: "the export works", status: "partial" }],
  });
});

Deno.test("assessScopeShortfalls - a heading ending in acceptance criteria yields the same verdict as the plain heading (Issue #4107)", () => {
  const scopeHeadingIssue =
    "## Scope and acceptance criteria\n\n- the export works\n";

  // The plain heading yields a partial shortfall; the new heading must match it.
  const plainVerdict = assessScopeShortfalls(EXPORT_ISSUE, PARTIAL_SUMMARY);
  assertEquals(plainVerdict, {
    delivered: [],
    shortfalls: [{ criterion: "the export works", status: "partial" }],
  });
  assertEquals(
    assessScopeShortfalls(scopeHeadingIssue, PARTIAL_SUMMARY),
    plainVerdict,
  );

  assertEquals(assessScopeShortfalls(scopeHeadingIssue, MET_SUMMARY), {
    delivered: ["the export works"],
    shortfalls: [],
  });
});

const TWO_CRITERIA_ISSUE =
  "## Acceptance Criteria\n\n- the export works\n- the import works\n";
const EXPORT_MET_IMPORT_PARTIAL = `## Acceptance Criteria

- **met** — the export works — evidence: \`x_test.ts\` — reviewer: met
- **partial** — the import works — evidence: \`y_test.ts\` — reviewer: partial — reason: no retry
`;

Deno.test("assessReportedGaps - a partial entry is a shortfall and a met one is delivered (Issue #3506)", () => {
  assertEquals(
    assessReportedGaps(TWO_CRITERIA_ISSUE, EXPORT_MET_IMPORT_PARTIAL),
    {
      degraded: false,
      delivered: ["the export works"],
      shortfalls: [{ criterion: "the import works", status: "partial" }],
    },
  );
});

Deno.test("assessReportedGaps - every entry met leaves no shortfall (Issue #3506)", () => {
  assertEquals(assessReportedGaps(EXPORT_ISSUE, MET_SUMMARY), {
    degraded: false,
    delivered: ["the export works"],
    shortfalls: [],
  });
});

Deno.test("assessReportedGaps - unassessed items are dropped but an unassigned partial gap is kept (Issue #3506)", () => {
  const unassessed = assessReportedGaps(
    TWO_CRITERIA_ISSUE,
    "## Acceptance Criteria\n\n- **met** — the export works — evidence: \`x_test.ts\` — reviewer: met\n",
  );
  assertEquals(unassessed.shortfalls, []);

  const gap = assessReportedGaps(
    EXPORT_ISSUE,
    MET_SUMMARY +
      "- **partial** — quarterly invoice emailer — reviewer: partial — reason: not started\n",
  );
  assertEquals(gap.shortfalls, [
    { criterion: "quarterly invoice emailer —", status: "partial" },
  ]);
});

Deno.test("assessReportedGaps - an issue stating no criteria keeps each partial or missing entry, named by its subject (PR #3676 review)", () => {
  assertEquals(
    assessReportedGaps(ISSUE_WITHOUT_SCOPE, PARTIAL_SUMMARY),
    {
      degraded: false,
      delivered: [],
      shortfalls: [{ criterion: "the export works —", status: "partial" }],
    },
  );
  const missing = assessReportedGaps(
    ISSUE_WITHOUT_SCOPE,
    MET_SUMMARY +
      "- **missing** — the quarterly emailer — reviewer: missing — reason: not started\n",
  );
  assertEquals(missing.shortfalls, [
    { criterion: "the quarterly emailer —", status: "missing" },
  ]);
  // A `met` entry alone is no gap, so a healthy run with no residue files nothing.
  assertEquals(
    assessReportedGaps(ISSUE_WITHOUT_SCOPE, MET_SUMMARY).shortfalls,
    [],
  );
});

Deno.test("assessScopeShortfalls - an issue stating no criteria lists its met entries as delivered and keeps its partial gap (PR #3676 review)", () => {
  const verdict = assessScopeShortfalls(
    ISSUE_WITHOUT_SCOPE,
    MET_SUMMARY +
      "- **partial** — the quarterly emailer — reviewer: partial — reason: not wired up\n",
  );
  assertEquals(verdict.delivered.length, 1);
  assertStringIncludes(verdict.delivered[0]!, "the export works");
  assertEquals(verdict.shortfalls.length, 2);
  assertEquals(verdict.shortfalls[0], {
    criterion: UNSTATED_SCOPE_ITEM,
    status: "unassessed",
  });
  assertStringIncludes(verdict.shortfalls[1]!.criterion, "quarterly emailer");
  assertEquals(verdict.shortfalls[1]!.status, "partial");
});

Deno.test("observed CI remains delivered while the separate code review is pending (Issue #3961)", () => {
  const verdict = assessReportedGaps(
    "## Acceptance Criteria\n\n- required CI\n",
    "## Acceptance Criteria\n\n- **met** — required CI — evidence: required CI passed — reviewer: met — reason: awaiting code review\n",
  );
  assertEquals(verdict.delivered, ["required CI"]);
  assertEquals(verdict.shortfalls, []);
});

Deno.test("unreported required checks remain unassessed rather than implicitly pending (Issue #3961)", () => {
  const verdict = assessScopeShortfalls(
    "## Acceptance Criteria\n\n- required CI\n",
    "## Summary\n\nImplemented the parser.",
  );
  assertEquals(verdict, {
    delivered: [],
    shortfalls: [{ criterion: "required CI", status: "unassessed" }],
  });
});
