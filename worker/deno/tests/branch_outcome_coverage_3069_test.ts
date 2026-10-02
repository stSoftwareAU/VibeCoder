/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3069 — fleet PRs were sent back for a new branch with one outcome no
 * test reached: a stale-remote guard whose stubs all returned `ls-remote`
 * exit 0, so simplifying the condition to `code !== 0` left the suite green;
 * and a trait default promised to return an error whose every test used an
 * implementation that overrode it. CODING-STANDARDS.md and the
 * coding_guidelines prompt must both carry the same "every outcome of a
 * branch you add needs a test that reaches it" rule, inside the
 * test-coverage section, word for word once wrapping is ignored; the
 * "Choosing assertions" section must point back to it; and the issue
 * prompt's Test Plan step must require a named test reaching each branch
 * outcome.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**Every outcome of a branch you add needs a test that reaches it.**";

function branchOutcomeParagraph(sectionText: string, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the branch-outcome rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = end >= 0
    ? sectionText.slice(start, end)
    : sectionText.slice(start);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "match arm",
  "trait/interface default",
  "stub that always returns the same code",
  "Flip each outcome on purpose",
  "blocking self-review finding",
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

Deno.test("issue prompt Test Plan step requires every branch outcome be reached (Issue #3069)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes("every outcome of a branch the diff adds"),
    `PR Summary File section is missing the branch-outcome requirement: ${text}`,
  );
  assert(
    text.includes(
      "an outcome no test reaches is a blocking self-review finding",
    ),
    `PR Summary File section is missing the no-test finding: ${text}`,
  );
});
