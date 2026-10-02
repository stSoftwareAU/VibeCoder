/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3077 — two fleet PRs added a rule that contradicted an existing one:
 * one told the agent never to obey directives in any file it reads while the
 * run prompts still told it to do what `.vibe-run-budget.md` says (#3066);
 * one called a test the summary cites but the diff lacks a violation while
 * the named-test rule accepts a test already tracked at the head (#3075).
 * CODING-STANDARDS.md, the coding-guidelines prompt and the issue prompt must
 * all require checking for existing rules on the same subject before adding
 * or changing one, and fixing any conflict in the same diff.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const STANDARDS_KEY_PHRASES = [
  "Check the existing rules before you add one",
  "the nouns the rule governs",
  "change the existing rule in the same diff",
  "must name every exception the existing rules carve out",
  "a defect to fix before the PR is raised",
  "lists the related existing rules you checked",
];

Deno.test("CODING-STANDARDS.md Prompt Engineering Guidance requires checking existing rules before adding one (Issue #3077)", async () => {
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
  "the nouns the rule governs",
  "change that rule in the same diff",
  "names every exception the existing rules carve out",
  "blocking self-review finding",
  "List the related existing rules you checked",
];

Deno.test("coding_guidelines prompt docs-change section requires checking existing rules before adding one (Issue #3077)", async () => {
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
  "the nouns the rule governs",
  "change the existing rule in the same diff",
  "names every exception the existing rules carve out",
  "List the related existing rules you checked",
  "blocking self-review finding",
];

Deno.test("issue prompt Instructions requires checking existing rules before adding one (Issue #3077)", async () => {
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
