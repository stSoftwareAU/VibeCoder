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
  "**Every outcome of a branch you add needs a test that reaches it.**";

function branchOutcomeParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the branch-outcome rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "match arm",
  "trait/interface default",
  "stub that always returns the same code",
  "Existing tests count",
  "blocking self-review finding",
  "not an automatic campaign of flipping branches or operands",
];

Deno.test("both surfaces carry the branch-outcome rule (Issue #3069)", async () => {
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
    const paragraph = branchOutcomeParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the branch-outcome rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    branchOutcomeParagraph(standards, "CODING-STANDARDS.md"),
    branchOutcomeParagraph(guidelines, "coding_guidelines"),
    "the branch-outcome rule must be identical on both surfaces",
  );
});

Deno.test("Units bullet points back at the branch-outcome rule (Issue #3069)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
  );

  assert(
    text.includes("Each outcome of a branch you add needs its own test"),
    `Choosing assertions is missing the back-reference: ${text}`,
  );
  assert(
    text.includes("stubs past the branch does not count"),
    `Choosing assertions is missing the mirrored wording: ${text}`,
  );
});

Deno.test("issue prompt assesses meaningful branch outcomes", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "independent acceptance and refusal cases of compound conditions",
      "Existing tests count",
      "No mutation campaign or per-operand flip is required",
    ],
  );
});
