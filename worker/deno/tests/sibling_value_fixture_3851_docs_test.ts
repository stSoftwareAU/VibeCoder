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

const RULE_START = "**A test must be able to fail on the wrong input.**";

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
  "two similar values",
  "give the candidates different values",
  "assert the required one",
  "candidates are equal or another guard rejects both",
  "do not require inverting guards or selecting the wrong source",
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

Deno.test("wrong-input rule retains distinct sibling values", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Test coverage expectations",
    ),
    [
      "two similar values",
      "give the candidates different values",
      "assert the required one",
    ],
  );
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

Deno.test("issue prompt asks for different candidate values", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "different fixture values",
      "competing source values",
    ],
  );
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

Deno.test("manual records distinct-value assertions without source swaps", async () => {
  assertPins(
    section(
      await readRepoDoc("docs/workflows/issue-processing.md"),
      "Reproduction status on a bug fix",
    ),
    [
      "give the candidates different values",
      "assert the required source value",
    ],
  );
});
