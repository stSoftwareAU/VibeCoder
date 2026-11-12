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

function branchParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the branch-outcome rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  return flat(excerpt(sectionText, start, end >= 0 ? end : undefined)).trim();
}

const KEY_PHRASES = [
  "compound conditions",
  "each independent reason for acceptance or refusal",
  "Existing tests count",
  "not an automatic campaign of flipping branches or operands",
];

Deno.test("both surfaces carry the compound-condition rule (Issue #3376)", async () => {
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
    const paragraph = branchParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the branch-outcome rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    branchParagraph(standards, "CODING-STANDARDS.md"),
    branchParagraph(guidelines, "coding_guidelines"),
    "the branch-outcome rule must be identical on both surfaces",
  );
});

Deno.test("issue prompt checks independent input conditions without flips", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "independent acceptance and refusal cases of compound conditions",
      "No mutation campaign or per-operand flip is required",
    ],
  );
});

Deno.test("feedback reviews compound conditions without mutation results", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    [
      "Do not flip each operand or require mutation results",
    ],
  );
});

Deno.test("issue-processing manual records the compound-condition rule (Issue #3376)", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/workflows/issue-processing.md"),
      "Reproduction status on a bug fix",
    ),
  );
  const phrase = "Each operand of a compound condition is its own outcome";
  assert(
    text.includes(phrase),
    `issue-processing section is missing "${phrase}": ${text}`,
  );
});
