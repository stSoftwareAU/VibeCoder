/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3100 — fleet PRs narrowed a shared helper's accepted values without
 * checking its existing callers' real inputs: VibeCoder#2881 made
 * `assertSafeGitRef` reject `feature/-wip`, a branch name an existing caller
 * could legitimately pass, and VibeCoder#3095 made `validateGhIssueJson`
 * reject `MERGED`, a state an existing caller's real `gh` output could
 * contain. CODING-STANDARDS.md and the coding_guidelines prompt must both
 * carry the same "changing what a shared helper returns, refuses or finds
 * changes every caller" rule, inside the test-coverage section, word for word
 * once wrapping is ignored. Issue #3779 widened it from narrowing to any change
 * in what the helper returns, refuses or finds, and requires a test through
 * each touched caller, after VibeCoder#3353 and a private fleet PR regressed an
 * existing caller.
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

const PARAGRAPH_START =
  "**Changing what a shared helper returns, refuses or finds changes every caller.**";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Index of the rule's bold title in the raw section text. The title wraps
 * across lines in the source, so each space in it matches any whitespace run.
 */
function paragraphStartIndex(sectionText: DocSection): number {
  const pattern = new RegExp(
    PARAGRAPH_START.split(" ").map(escapeRegExp).join("\\s+"),
  );
  return pattern.exec(sectionText)?.index ?? -1;
}

function sharedHelperRuleParagraph(
  sectionText: DocSection,
  what: string,
): string {
  const start = paragraphStartIndex(sectionText);
  assert(
    start >= 0,
    `could not locate the changing-a-shared-helper rule in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "list its existing callers and the real values each can receive",
  "the tool or API's actual output",
  "a lookup that gains a fallback",
  "a routine that gains a refusal or precondition",
  'reads "nothing found" as "leave it alone"',
  "Add a test that exercises each existing caller whose behaviour the change touches",
  "a callers-checked list alone does not count",
  "List the callers checked in the PR summary",
  "left without a verdict, or reported `regressed`, blocks the PR",
  "A changed shared helper with no test through an existing caller whose behaviour it touches",
];

Deno.test("both surfaces carry the changing-a-shared-helper rule (Issues #3100, #3779)", async () => {
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
    const paragraph = sharedHelperRuleParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the changing-a-shared-helper rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    sharedHelperRuleParagraph(standards, "CODING-STANDARDS.md"),
    sharedHelperRuleParagraph(guidelines, "coding_guidelines"),
    "the changing-a-shared-helper rule must be identical on both surfaces",
  );
});
