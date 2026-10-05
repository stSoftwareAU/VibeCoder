/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3060 — fleet PRs were sent back for negative tests whose fixture
 * never held the forbidden value, so the test passed with or without the
 * guard it was meant to protect. CODING-STANDARDS.md and the
 * coding_guidelines prompt must both carry the same "a negative test must be
 * able to fail" rule, inside the test-coverage section, word for word once
 * wrapping is ignored; the "Choosing assertions" section must point back to
 * it; and the issue prompt's Test Plan step must require seeing the guard's
 * red run before counting a negative test.
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

const PARAGRAPH_START = "**A negative test must be able to fail.**";

function negativeTestParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the negative-test rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "fixture that contains the forbidden thing",
  "break the guard on purpose",
  "confirm it goes red",
  "blocking self-review finding",
];

Deno.test("both surfaces carry the negative-test-must-fail rule (Issue #3060)", async () => {
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
    const paragraph = negativeTestParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the negative-test rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    negativeTestParagraph(standards, "CODING-STANDARDS.md"),
    negativeTestParagraph(guidelines, "coding_guidelines"),
    "the negative-test-must-fail rule must be identical on both surfaces",
  );
});

Deno.test("Choosing assertions points back at the negative-test rule (Issue #3060)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
  );

  assert(
    text.includes("A negative test must be able to fail"),
    `Choosing assertions is missing the back-reference: ${text}`,
  );
  assert(
    text.includes("if the guard it protects were removed"),
    `Choosing assertions is missing the mirrored question: ${text}`,
  );
});

Deno.test("issue prompt Test Plan step requires seeing the guard go red (Issue #3060)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes("go red with its guard broken on purpose"),
    `PR Summary File section is missing the red-run requirement: ${text}`,
  );
  assert(
    text.includes(
      "stays green without its guard is a blocking self-review finding",
    ),
    `PR Summary File section is missing the green-without-guard finding: ${text}`,
  );
});
