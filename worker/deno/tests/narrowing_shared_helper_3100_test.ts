/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3100 — fleet PRs narrowed a shared helper's accepted values without
 * checking its existing callers' real inputs: VibeCoder#2881 made
 * `assertSafeGitRef` reject `feature/-wip`, a branch name an existing caller
 * could legitimately pass, and VibeCoder#3095 made `validateGhIssueJson`
 * reject `MERGED`, a state an existing caller's real `gh` output could
 * contain. CODING-STANDARDS.md and the coding_guidelines prompt must both
 * carry the same "narrowing a shared helper changes every caller" rule,
 * inside the test-coverage section, word for word once wrapping is ignored.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const PARAGRAPH_START = "**Narrowing a shared helper changes every caller.**";

function narrowingHelperParagraph(sectionText: string, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the narrowing-helper rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = end >= 0
    ? sectionText.slice(start, end)
    : sectionText.slice(start);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "list its existing callers and the real values each can receive",
  "the tool or API's actual output",
  "apply the stricter rule at the new call site",
  "an existing caller still accepts its real inputs",
  "List the callers checked in the PR summary",
  "blocking self-review finding",
];

Deno.test("both surfaces carry the narrowing-a-shared-helper rule (Issue #3100)", async () => {
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
    const paragraph = narrowingHelperParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the narrowing-helper rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    narrowingHelperParagraph(standards, "CODING-STANDARDS.md"),
    narrowingHelperParagraph(guidelines, "coding_guidelines"),
    "the narrowing-a-shared-helper rule must be identical on both surfaces",
  );
});
