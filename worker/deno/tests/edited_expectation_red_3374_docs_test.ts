/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertPins,
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**An edited expectation must still go red without its guard.**";
const PREVIOUS_START = "**A new test must go red without its change.**";
const NEXT_START = "**A test must be able to fail on the wrong input.**";

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
    `${what}: the edited-expectation rule must precede the wrong-input rule`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "A de-duplicated list",
  "move the lost check to a test that still covers it",
  "Record the remaining coverage",
  "Losing meaningful regression protection",
  "a synthetic break of each edited expectation is not required",
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

Deno.test("TDD preserves meaningful coverage when expectations change", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Test-Driven Development (TDD)",
    ),
    [
      "remaining coverage",
      "An edited expectation must still go red without its guard",
    ],
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

Deno.test("issue prompt records changed requirements and remaining coverage", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "edited expectation",
      "remaining coverage",
    ],
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
