/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3374 — fleet PRs changed an expected value in an existing test
 * because the issue required it, and the test then passed whether or not the
 * code its name says it guards still worked (VibeCoder#3372,
 * GRQ-AutoTrader#2408). CODING-STANDARDS.md and the coding_guidelines prompt
 * must both carry the same "an edited expectation must still go red without
 * its guard" rule, between the new-test rule and the negative-test rule, word
 * for word once wrapping is ignored; TDD rule 3 must point at the red-check;
 * and the issue prompt's Change-only rule, Test Plan step and Standards
 * reviewer brief must each ask for it.
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
  "**An edited expectation must still go red without its guard.**";
const PREVIOUS_START = "**A new test must go red without its change.**";
const NEXT_START = "**A negative test must be able to fail.**";

function editedParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the edited-expectation rule in ${what}`,
  );
  const previous = sectionText.indexOf(PREVIOUS_START);
  const next = sectionText.indexOf(NEXT_START);
  assert(
    previous >= 0 && previous < start,
    `${what}: the edited-expectation rule must follow the new-test rule`,
  );
  assert(
    next > start,
    `${what}: the edited-expectation rule must precede the negative-test rule`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "the code its name says it guards is broken",
  "a de-duplicated list",
  "move the lost check to a test that still covers it",
  "Record the red-check result per edited expectation",
  "An edited test that stays green without its guard",
];

Deno.test("both surfaces carry the edited-expectation rule (Issue #3374)", async () => {
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
    const paragraph = editedParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the edited-expectation rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    editedParagraph(standards, "CODING-STANDARDS.md"),
    editedParagraph(guidelines, "coding_guidelines"),
    "the edited-expectation rule must be identical on both surfaces",
  );
});

Deno.test("rule 3 points edited expectations at the red-check (Issue #3374)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Test-Driven Development (TDD)",
    ),
  );
  const phrase = "each edited expectation also owes the red-check";
  assert(
    text.includes(phrase),
    `TDD section is missing "${phrase}": ${text}`,
  );
});

Deno.test("issue prompt Change-only rule asks for the red-check (Issue #3374)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );
  const phrase = "not that the edited test still guards anything";
  assert(
    text.includes(phrase),
    `Instructions section is missing "${phrase}": ${text}`,
  );
});

Deno.test("issue prompt Test Plan step records a red-check per edited expectation (Issue #3374)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );
  const phrase = "record one red-check line per edited expectation";
  assert(
    text.includes(phrase),
    `PR Summary File section is missing "${phrase}": ${text}`,
  );
});

Deno.test("Standards reviewer brief asks whether an edited test still fails (Issue #3374)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "Independent Review Before the PR",
    ),
  );
  const phrase = "still fails without the code it is named for";
  assert(
    text.includes(phrase),
    `Independent Review section is missing "${phrase}": ${text}`,
  );
});
