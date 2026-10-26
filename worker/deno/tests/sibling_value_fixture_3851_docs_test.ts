/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3851 — fleet tests that pinned which of two similar values the code
 * reads (a percentage stated against one of two bases, a displayed and a
 * derived figure meant to read the same record) used fixtures where both
 * candidates were equal, so they passed whichever value the code read; one
 * stayed green while the code really read the wrong record.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same wrong-input rule, which covers the sibling-value case, word for word
 * once wrapping is ignored; the new-test rule must point to it; the "Choosing
 * assertions" section must ask the sibling-value question; and the issue
 * prompt's Test Plan step, the shared review brief and the issue-processing
 * manual must each carry it too.
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

const RULE_START = "**A test must be able to fail on the wrong input.**";
const NEW_TEST_START = "**A new test must go red without its change.**";

/** The paragraph opening at `opening`, up to the next blank line, flattened. */
function paragraphAt(
  sectionText: DocSection,
  opening: string,
  what: string,
): string {
  const start = sectionText.indexOf(opening);
  assert(start >= 0, `could not locate "${opening}" in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  return flat(excerpt(sectionText, start, end >= 0 ? end : undefined)).trim();
}

const KEY_PHRASES = [
  "pins which of two similar values the code uses",
  "its fixture gives the candidates different values",
  "the break is to read the sibling value",
  "reads base B instead of A → red",
  "A fixture where the candidates are equal is a blocking self-review finding",
];

Deno.test("both surfaces carry the sibling-value rule (Issue #3851)", async () => {
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
    const paragraph = paragraphAt(text, RULE_START, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the wrong-input rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    paragraphAt(standards, RULE_START, "CODING-STANDARDS.md"),
    paragraphAt(guidelines, RULE_START, "coding_guidelines"),
    "the wrong-input rule must be identical on both surfaces",
  );
});

Deno.test("the new-test rule points to the wrong-input rule (Issue #3851)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );
  const phrase =
    "able to fail on the wrong input** below is this rule for an assertion that something does *not* happen or for which of two similar values the code reads";

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = paragraphAt(text, NEW_TEST_START, surface);
    assert(
      paragraph.includes(phrase),
      `${surface} new-test rule is missing "${phrase}": ${paragraph}`,
    );
  }
});

Deno.test("Choosing assertions asks the sibling-value question (Issue #3851)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
  );
  const phrase = "would fail if the code read the sibling value";
  assert(
    text.includes(phrase),
    `Choosing assertions section is missing "${phrase}": ${text}`,
  );
});

Deno.test("issue prompt Test Plan step requires the sibling-value break (Issue #3851)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );
  for (
    const phrase of [
      "go red with the code pointed at the sibling value",
      "a fixture where the candidates are equal is a blocking self-review finding",
    ]
  ) {
    assert(
      text.includes(phrase),
      `PR Summary File section is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("review brief checks the candidates differ (Issue #3851)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_review_brief/prompt.md"),
      "Review Mode — one change against its linked issue",
    ),
  );
  const phrase = "check that its fixture gives the candidates different values";
  assert(
    text.includes(phrase),
    `Review Mode section is missing "${phrase}": ${text}`,
  );
});

Deno.test("issue-processing manual records the sibling-value rule (Issue #3851)", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/workflows/issue-processing.md"),
      "Reproduction status on a bug fix",
    ),
  );
  const phrase = "point the code at the sibling value";
  assert(
    text.includes(phrase),
    `issue-processing section is missing "${phrase}": ${text}`,
  );
});
