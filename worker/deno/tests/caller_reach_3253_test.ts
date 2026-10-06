/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3253 — fleet PRs wired a new argument into some callers and missed
 * one hidden by a do-nothing default or a hard-coded old value:
 * VibeCoder#3251 gave `recoverAndFinaliseExistingPr` a
 * `docsSweepHitsComment = ""` parameter that `reportSummaryRuleBlock` never
 * passed; GRQ-AutoTrader#2282 added `RunOrigin` but every production caller
 * hard-coded `RunOrigin::Scheduled`; and VibeCoder#3095 fixed two of three
 * declared hand-off outcomes and left `handOffToPlanning` unchanged.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same "a new argument or behaviour reaches every caller that needs it"
 * rule, inside the test-coverage section, word for word once wrapping is
 * ignored; and the issue prompt's Test Plan step must require listing every
 * caller and sibling route checked.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**A new argument or behaviour reaches every caller that needs it.**";

function callerReachParagraph(
  sectionText: DocSection,
  what: string,
): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the caller-reach rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "list every caller and sibling first",
  "every sibling outcome a router dispatches",
  "state in the PR summary why that caller does not need it",
  "a default that silently turns the behaviour off",
  "so the compiler or type checker names each caller you missed",
  "hard-codes the old value",
  "while no production caller passes it",
  "List the callers and siblings checked in the PR summary",
];

Deno.test("both surfaces carry the caller-reach rule (Issue #3253)", async () => {
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
    const paragraph = callerReachParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the caller-reach rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    callerReachParagraph(standards, "CODING-STANDARDS.md"),
    callerReachParagraph(guidelines, "coding_guidelines"),
    "the caller-reach rule must be identical on both surfaces",
  );
});

Deno.test("issue prompt Test Plan step requires listing callers and siblings checked (Issue #3253)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes("reaches every caller and sibling route that needs it"),
    `PR Summary File section is missing the caller-reach requirement: ${text}`,
  );
  assert(
    text.includes(
      "a caller left on the old hard-coded value is a blocking self-review finding",
    ),
    `PR Summary File section is missing the hard-coded-caller finding: ${text}`,
  );
});
