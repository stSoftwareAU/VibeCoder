/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3093 — fleet PRs added the regression test a fix or review asked for
 * without running it against the unfixed code, so it passed either way
 * (VibeCoder#3091, #3085, #3079, GRQ-AutoTrader#2218). CODING-STANDARDS.md and
 * the coding_guidelines prompt must both carry the same "a new test must go
 * red without its change" rule, inside the test-coverage section, word for
 * word once wrapping is ignored; the "Documentation-drift tests" section must
 * require a phrase new to the rule; the "Unit tests" section's super-linearity
 * guard must be built from the slow input; the "Choosing assertions" section
 * must point back to the new-test rule; the pr_feedback prompt's Making
 * Changes section must require quoting the reverted run; and the issue
 * prompt's Test Plan step must require the change-removed red run.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const PARAGRAPH_START = "**A new test must go red without its change.**";

function newTestParagraph(sectionText: string, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the new-test-must-go-red rule in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = end >= 0
    ? sectionText.slice(start, end)
    : sectionText.slice(start);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "when only that change is removed",
  "a phrase the section already held before the change",
  "see it fail, then restore it",
  "stays green without its change",
];

Deno.test("both surfaces carry the new-test-must-go-red rule (Issue #3093)", async () => {
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
    const paragraph = newTestParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the new-test-must-go-red rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    newTestParagraph(standards, "CODING-STANDARDS.md"),
    newTestParagraph(guidelines, "coding_guidelines"),
    "the new-test-must-go-red rule must be identical on both surfaces",
  );
});

Deno.test("Documentation-drift tests require a phrase new to the rule (Issue #3093)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Documentation-drift tests",
    ),
  );

  assert(
    text.includes("all four conditions"),
    `Documentation-drift tests is missing the four-conditions requirement: ${text}`,
  );
  assert(
    text.includes("The pinned phrase occurs only in the rule being added"),
    `Documentation-drift tests is missing the pinned-phrase condition: ${text}`,
  );
  assert(
    text.includes("absent from the base branch's version of that section"),
    `Documentation-drift tests is missing the base-branch check: ${text}`,
  );
});

Deno.test("super-linearity guard is built from the slow input (Issue #3093)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Unit tests"),
  );

  assert(
    text.includes("build the test from the input shape that was slow"),
    `Unit tests is missing the slow-input-shape requirement: ${text}`,
  );
  assert(
    text.includes("run it against the unfixed pattern"),
    `Unit tests is missing the unfixed-pattern requirement: ${text}`,
  );
});

Deno.test("Choosing assertions points back at the new-test rule (Issue #3093)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
  );

  assert(
    text.includes("would it fail if only that change were removed"),
    `Choosing assertions is missing the back-reference to the new-test rule: ${text}`,
  );
});

Deno.test("pr_feedback prompt requires quoting the reverted run (Issue #3093)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  assert(
    text.includes("revert the fix locally"),
    `Making Changes is missing the revert-the-fix-locally requirement: ${text}`,
  );
  assert(
    text.includes("quote the failing line in `.pr_response_message`"),
    `Making Changes is missing the quote-the-failing-line requirement: ${text}`,
  );
});

Deno.test("issue prompt Test Plan step requires the change-removed red run (Issue #3093)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes("go red with only its change removed"),
    `PR Summary File section is missing the change-removed red-run requirement: ${text}`,
  );
  assert(
    text.includes("stays green without its change"),
    `PR Summary File section is missing the stays-green-without-its-change finding: ${text}`,
  );
});
