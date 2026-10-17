/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3771 — fleet guards treated an absent optional input as "off" on a
 * production path that never supplied it: VibeCoder#3318 gave `classifyIssues`
 * sub-issue blocking through an optional `subIssuesSummary?` field, and a
 * third production caller, `repoHasStartableWork`, built its rows without it;
 * a private fleet PR's retry check read a deadline that only one of two
 * session constructors supplied. The #3253 caller-reach rule covered new
 * parameters but not an optional field on a row or struct, or state an object
 * is built with. CODING-STANDARDS.md and the coding_guidelines prompt must both
 * carry the widened rule word for word once wrapping is ignored; the shared
 * review brief must ask every row mapping and constructor for the input; the
 * issue prompt's PR Summary File section must list each builder; and the
 * issue-processing manual must explain the rule.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import {
  assertPins,
  type DocSection,
  excerpt,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**A new argument or behaviour reaches every caller that needs it.**";

/** The paragraph opening at PARAGRAPH_START, up to the next blank line. */
function callerReachParagraph(
  sectionText: DocSection,
  what: string,
): DocSection {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the caller-reach rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  return excerpt(sectionText, start, end >= 0 ? end : undefined);
}

const WIDENED_RULE_PHRASES = [
  "or let its absence turn it off",
  "`field?`",
  "a field on a row or struct, and state an object is built with",
  "each row mapping or constructor that leaves it out",
  "When absence must stay legal",
  "say for each one why the guard may be off there",
  "a grep for the guard's name finds only the guard",
];

Deno.test("both surfaces carry the widened caller-reach rule (Issue #3771)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    assertPins(callerReachParagraph(text, surface), WIDENED_RULE_PHRASES);
  }
});

Deno.test("review brief asks every builder of an optional guard input (Issue #3771)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_review_brief/prompt.md"),
      "Review Mode — one change against its linked issue",
    ),
    [
      "find every place that builds that input",
      "A path where the guard is silently off although the linked issue needs it there is a finding",
    ],
  );
});

Deno.test("issue prompt PR Summary File lists each builder of an optional input (Issue #3771)", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "required rather than defaulted or left absent in a way that turns the behaviour off",
      "is listed with why the guard may be off there",
    ],
  );
});

Deno.test("issue-processing manual explains the absent-input rule (Issue #3771)", async () => {
  assertPins(
    section(
      await readRepoDoc("docs/workflows/issue-processing.md"),
      "Reproduction status on a bug fix",
    ),
    [
      "Grepping the guard's name finds only the guard",
      "An absent input must not switch a guard off unnoticed",
    ],
  );
});
