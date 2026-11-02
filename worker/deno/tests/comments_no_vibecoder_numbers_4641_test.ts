/**
 * Regression tests for Issue #4641: comments and PR-body text the worker posts
 * in a TARGET repository must not carry a VibeCoder issue number as `(Issue #N)`.
 * GitHub resolves a bare `#N` against the repo the text is posted in, so the
 * suffix links to an unrelated issue there. Provenance stays in code comments.
 *
 * Each posted builder is driven through its real code path and every `#<digits>`
 * token is checked. The only `#N` a posted string may carry is the target issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkClaimChurn } from "../lib/claim_issue.ts";
import { buildQuestionFailureComment } from "../lib/label_question_failure.ts";
import { buildMissingCriteriaPrNote } from "../lib/missing_criterion_close_guard.ts";
import {
  buildIndependentReviewComment,
  validateIndependentReview,
} from "../lib/independent_review_gate.ts";

/** The issue number the comment is posted against; the only `#N` a comment may carry. */
const TARGET_ISSUE = 42;

/** Every `#<digits>` token in the text, in order. */
function hashNumbers(text: string): string[] {
  return text.match(/#\d+/g) ?? [];
}

/** The `--body` argument of the first `issue comment` call the function made. */
function commentBody(calls: string[][]): string {
  const commentCall = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  if (!commentCall) return "";
  const bodyIdx = commentCall.indexOf("--body");
  return bodyIdx >= 0 ? commentCall[bodyIdx + 1] ?? "" : "";
}

// --- claim churn comment (lib/claim_issue.ts) ---

Deno.test("claim churn comment - names no VibeCoder number and only the target issue (Issue #4641)", async () => {
  const minutesAgo = (m: number) =>
    new Date(Date.now() - m * 60 * 1000).toISOString();
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: minutesAgo(55),
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: minutesAgo(40),
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: minutesAgo(25),
    },
  ]);

  const calls: string[][] = [];
  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("/events")) return events;
    return "";
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: TARGET_ISSUE,
    githubUser: "testuser",
    threshold: 3,
    ghCommandFn,
  });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.escalated, true);

  const body = commentBody(calls);
  // Guard against a vacuous pass: the churn comment must actually have been posted.
  assertStringIncludes(body, "## Claim Churn Detected");
  const stray = hashNumbers(body).filter((n) => n !== `#${TARGET_ISSUE}`);
  assertEquals(
    stray,
    [],
    `churn comment carries a VibeCoder number: ${stray.join(", ")}`,
  );
});

// --- question failure comment (lib/label_question_failure.ts) ---

Deno.test("question failure comment - first failure names no VibeCoder number (Issue #4641)", () => {
  const comment = buildQuestionFailureComment(
    "The run ended without a usable result",
    false,
  );
  assertStringIncludes(comment, "## Question Answering Failed");
  assertEquals(
    hashNumbers(comment),
    [],
    `first-failure comment carries a number: ${comment}`,
  );
});

Deno.test("question failure comment - repeat failure names no VibeCoder number (Issue #4641)", () => {
  const comment = buildQuestionFailureComment(
    "The run ended without a usable result",
    true,
  );
  assertStringIncludes(
    comment,
    "## Question Answering Failed (Repeat Attempt)",
  );
  assertStringIncludes(comment, "failed more than once");
  assertEquals(
    hashNumbers(comment),
    [],
    `repeat-failure comment carries a number: ${comment}`,
  );
});

// --- missing criteria PR note (lib/missing_criterion_close_guard.ts) ---

Deno.test("missing criteria PR note - names only the target issue (Issue #4641)", () => {
  const note = buildMissingCriteriaPrNote(TARGET_ISSUE, [
    "The retry path is covered by a test",
  ]);
  assertStringIncludes(note, `## Not closing #${TARGET_ISSUE}`);
  const stray = hashNumbers(note).filter((n) => n !== `#${TARGET_ISSUE}`);
  assertEquals(
    stray,
    [],
    `missing-criteria note carries a VibeCoder number: ${stray.join(", ")}`,
  );
});

// --- independent review blocking comment (lib/independent_review_gate.ts) ---

const ISSUE_WITH_CRITERIA = [
  "## Problem",
  "",
  "The author judges their own work.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A Spec reviewer sub-agent judges the criteria.",
].join("\n");

const ISSUE_WITHOUT_CRITERIA = [
  "## Problem",
  "",
  "Something is broken.",
].join("\n");

const STANDARDS_MARKER =
  '<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->';

/** A PR summary whose Standards block carries one `violation` the gate refuses. */
const VIOLATION_SUMMARY = [
  "## Summary",
  "",
  "One axis. Closes #663.",
  "",
  "## Standards Review",
  "",
  STANDARDS_MARKER,
  "",
  "- **violation** — x — evidence: `src/creature/EvolveTeardown.ts:103` — " +
  "reason: not fixed in this diff",
  "",
  "## Test Plan",
  "",
  "- the gate tests",
].join("\n");

Deno.test("independent review comment - criteria-stated branch names no VibeCoder number (Issue #4641)", () => {
  // No Spec or Standards block is recorded, so the gate refuses with problems.
  const result = validateIndependentReview({
    issueBody: ISSUE_WITH_CRITERIA,
    prSummaryContent: VIOLATION_SUMMARY,
  });
  assertEquals(result.criteriaStated, true);
  assertEquals(result.valid, false);
  assert(result.problems.length > 0, "the refusal must name its problems");

  const comment = buildIndependentReviewComment(result);
  assertStringIncludes(comment, "## Standards Review");
  assertStringIncludes(comment, "Independent review missing");
  const stray = hashNumbers(comment);
  assertEquals(
    stray,
    [],
    `criteria-stated review comment carries a VibeCoder number: ${
      stray.join(", ")
    }`,
  );
});

Deno.test("independent review comment - no-criteria branch names no VibeCoder number (Issue #4641)", () => {
  const result = validateIndependentReview({
    issueBody: ISSUE_WITHOUT_CRITERIA,
    prSummaryContent: VIOLATION_SUMMARY,
  });
  assertEquals(result.criteriaStated, false);
  assertEquals(result.valid, false);
  assert(result.problems.length > 0, "the refusal must name its problems");

  const comment = buildIndependentReviewComment(result);
  assertStringIncludes(comment, "Standards violation left standing");
  const stray = hashNumbers(comment);
  assertEquals(
    stray,
    [],
    `no-criteria review comment carries a VibeCoder number: ${
      stray.join(", ")
    }`,
  );
});
