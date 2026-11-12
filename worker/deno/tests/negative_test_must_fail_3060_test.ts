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

const PARAGRAPH_START = "**A test must be able to fail on the wrong input.**";

function negativeTestParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the negative-test rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "fixture containing the forbidden thing",
  "Pair it with an allowed case",
  "actual result or specific refusal",
  "blocking self-review finding",
  "do not require inverting guards",
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
    text.includes("A test must be able to fail on the wrong input"),
    `Choosing assertions is missing the back-reference: ${text}`,
  );
  assert(
    text.includes("if the guard it protects were removed"),
    `Choosing assertions is missing the mirrored question: ${text}`,
  );
});

Deno.test("issue prompt asks for discriminating negative-test inputs", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "negative test must contain the forbidden input",
      "Do not require deliberate code breaks",
    ],
  );
});
