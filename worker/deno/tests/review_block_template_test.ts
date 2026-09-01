/**
 * Round-trip tests for the PR-summary gates' remediation templates (Issue #751).
 *
 * The two gates run back to back in `phases/completion_phase.ts`: the
 * acceptance-criteria gate first, the independent-review gate immediately
 * after. Each posts a remediation comment printing the shape it wants, and a
 * blocked run writes its next summary from that comment. So the templates are
 * not decoration — they are the instruction the next attempt follows, and a
 * template that satisfies one gate but not the other is a loop: Issue #728 died
 * in `completion` four times, each attempt copying the closure gate's
 * `unrequested` line, which omitted the `reviewer:` field the independent gate
 * then demanded.
 *
 * These tests close that loop by construction: the block each comment prints is
 * fed back through both validators, so a future edit to either template that
 * drifts from either gate's rules fails here rather than on a live issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildClosureGateComment,
  validateAcceptanceClosure,
} from "../lib/acceptance_criteria_gate.ts";
import {
  buildIndependentReviewComment,
  validateIndependentReview,
} from "../lib/independent_review_gate.ts";
import { REVIEW_BLOCK_TEMPLATE } from "../lib/review_block_template.ts";

/** An issue stating as many criteria as the template shows assessments. */
const ISSUE_BODY = `Something is broken.

## Acceptance Criteria

- [ ] the first thing works
- [ ] the second thing works
- [ ] the third thing works
`;

/** The markdown block a blocked run copies out of a gate's comment. */
function fencedBlock(comment: string): string {
  const match = comment.match(/```markdown\n([\s\S]*?)```/);
  assert(match, `the comment prints no markdown block:\n${comment}`);
  return match[1]!;
}

/** The comment the acceptance-criteria gate posts on an empty summary. */
function closureComment(): string {
  const blocked = validateAcceptanceClosure({
    issueBody: ISSUE_BODY,
    prSummaryContent: "# A summary with no closure block\n",
  });
  assert(blocked.applicable && !blocked.valid, "the gate must have blocked");
  return buildClosureGateComment(blocked);
}

/** The comment the independent-review gate posts on an empty summary. */
function reviewComment(): string {
  const blocked = validateIndependentReview({
    issueBody: ISSUE_BODY,
    prSummaryContent: "# A summary with no review blocks\n",
  });
  assert(blocked.applicable && !blocked.valid, "the gate must have blocked");
  return buildIndependentReviewComment(blocked);
}

Deno.test("gate templates - the closure gate's template satisfies both gates (Issue #751)", () => {
  const prSummaryContent = fencedBlock(closureComment());

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

Deno.test("gate templates - the independent-review gate's template satisfies both gates (Issue #751)", () => {
  const prSummaryContent = fencedBlock(reviewComment());

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

Deno.test("gate templates - both gates print the one shared block (Issue #751)", () => {
  assertEquals(fencedBlock(closureComment()), REVIEW_BLOCK_TEMPLATE);
  assertEquals(fencedBlock(reviewComment()), REVIEW_BLOCK_TEMPLATE);
});

Deno.test("gate templates - the block shows the two entry shapes the gates reject on (Issue #751)", () => {
  // `unrequested` with no `reviewer:` and `violation` with unlabelled evidence
  // are what Issue #728's four dead attempts were blocked on.
  assertStringIncludes(REVIEW_BLOCK_TEMPLATE, "- **unrequested**");
  assertStringIncludes(REVIEW_BLOCK_TEMPLATE, "reviewer: unrequested");
  assertStringIncludes(REVIEW_BLOCK_TEMPLATE, "- **violation**");
  assertStringIncludes(REVIEW_BLOCK_TEMPLATE, "evidence: `lib/foo.ts:42`");
});

Deno.test("gate templates - every status the gates parse is demonstrated (Issue #751)", () => {
  for (
    const status of [
      "met",
      "partial",
      "missing",
      "unrequested",
      "violation",
      "clean",
    ]
  ) {
    assertStringIncludes(REVIEW_BLOCK_TEMPLATE, `- **${status}**`);
  }
});
