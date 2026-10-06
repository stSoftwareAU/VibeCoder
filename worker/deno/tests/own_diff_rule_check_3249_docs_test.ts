/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3249 — three fleet PRs added a rule their own diff broke: one
 * required each `Branch outcomes:` line to state that flipping it went red
 * while its own list did not (#3160); one offered a model sentence about the
 * not-planned scan as the correctly scoped wording, and that sentence
 * over-claimed what the scan covered (#3236); one called any drift test
 * reaching for `flatWholeFile` a finding while its own drift tests called it
 * on pinned-phrase literals and the helper's own doc comment allowed exactly
 * that (#3240). CODING-STANDARDS.md, the coding-guidelines prompt, the issue
 * prompt and the pr_feedback prompt must all require applying a new or
 * changed rule to this PR's own diff before the PR is raised.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const STANDARDS_KEY_PHRASES = [
  "Apply a new rule to your own diff",
  "apply it to this PR's own diff",
  "any helper doc comment that says when to use the thing the rule governs",
  "An example offered as the correct way must itself pass the rule",
  "says you applied the rule to the PR's own diff",
];

Deno.test("CODING-STANDARDS.md Prompt Engineering Guidance requires applying a new rule to this PR's own diff (Issue #3249)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Prompt Engineering Guidance",
    ),
  );

  for (const phrase of STANDARDS_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Prompt Engineering Guidance is missing "${phrase}": ${text}`,
    );
  }
});

const CODING_GUIDELINES_KEY_PHRASES = [
  "apply it to this PR's own diff",
  "any helper doc comment that says when to use what the rule governs",
  "An example offered as the correct way must itself pass the rule",
  "Say in the PR body that you applied the rule to the PR's own diff",
];

Deno.test("coding_guidelines prompt docs-change section requires applying a new rule to this PR's own diff (Issue #3249)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "A Code Change Owes a Docs Change",
    ),
  );

  for (const phrase of CODING_GUIDELINES_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `A Code Change Owes a Docs Change is missing "${phrase}": ${text}`,
    );
  }
});

const ISSUE_PROMPT_KEY_PHRASES = [
  "apply the new or changed rule to this PR's own diff",
  "any helper doc comment that says when to use what the rule governs",
  "an example offered as the correct way must itself pass the rule",
  "says you applied the rule to the PR's own diff",
];

Deno.test("issue prompt Instructions requires applying a new rule to this PR's own diff (Issue #3249)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );

  for (const phrase of ISSUE_PROMPT_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Instructions is missing "${phrase}": ${text}`,
    );
  }
});

const PR_FEEDBACK_KEY_PHRASES = [
  "A rule you add or reword applies to this PR first",
  "apply it to this PR's own diff",
  "any helper doc comment that says when to use what the rule governs",
  "say you applied the rule to the PR's own diff",
];

Deno.test("pr_feedback prompt Making Changes requires applying a new rule to this PR's own diff (Issue #3249)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  for (const phrase of PR_FEEDBACK_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Making Changes is missing "${phrase}": ${text}`,
    );
  }
});
