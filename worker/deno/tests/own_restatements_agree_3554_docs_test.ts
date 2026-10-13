/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3554 — after #3077 added "Check the existing rules before you add
 * one", three fleet PRs still left their own restatements of a new rule
 * contradicting it (#3240, #3308, #3550); CODING-STANDARDS.md, the
 * coding-guidelines prompt, the issue prompt and the pr_feedback prompt must require every
 * restatement in the diff to give the same answer for the rule's edge case,
 * and carry an exception added in one place to every restatement.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

const STANDARDS_PINS = [
  "Every restatement of a rule gives the same answer",
  "list every place this diff states or illustrates it",
  "Name the edge case the rule decides, then read each place for that case",
  "apply it to every restatement, then search the diff for the old wording",
  "An example or parenthetical that contradicts its own rule is the same defect as two contradictory rules",
  "The rule's own restatements in this diff are held to the same standard",
];

Deno.test("CODING-STANDARDS.md Prompt Engineering Guidance requires every restatement of a new rule to agree (Issue #3554)", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Prompt Engineering Guidance",
    ),
    STANDARDS_PINS,
  );
});

const CODING_GUIDELINES_PINS = [
  "Every restatement of a rule gives the same answer",
  "list every place this diff states or illustrates it",
  "Name the edge case the rule decides, then read each place for that case",
  "apply it to every restatement, then search the diff for the old wording",
  "An example or parenthetical that contradicts its own rule is the same blocking self-review finding as two contradictory rules",
];

Deno.test("coding_guidelines prompt docs-change section requires every restatement of a new rule to agree (Issue #3554)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "A Code Change Owes a Docs Change",
    ),
    CODING_GUIDELINES_PINS,
  );
});

const ISSUE_PROMPT_PINS = [
  "list every place this diff states or illustrates the rule",
  "name the edge case the rule decides, and read each place for that case",
  "apply it to every restatement, then grep",
  "An example or parenthetical that contradicts its own rule is the same blocking self-review finding as two contradictory rules",
  "Every restatement of a rule gives the same answer",
];

Deno.test("issue prompt Instructions requires every restatement of a new rule to agree (Issue #3554)", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
    ISSUE_PROMPT_PINS,
  );
});

const PR_FEEDBACK_PINS = [
  "Every restatement of the rule gives the same answer",
  "list every place this PR states or illustrates it",
  "When the fix adds an exception, fallback or scope limit in one place, apply it to every restatement",
];

Deno.test("pr_feedback prompt Making Changes requires every restatement of a reworded rule to agree (Issue #3554)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    PR_FEEDBACK_PINS,
  );
});
