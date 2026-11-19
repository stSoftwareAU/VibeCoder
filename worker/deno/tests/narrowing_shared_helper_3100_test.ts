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
 * existing caller. Issue #5235 shortened it: the sentence promising that the
 * pre-PR verifier's caller verdicts block the PR (advisory since #4234), the
 * PR-summary callers list, and the parenthetical lists of helper kinds were
 * removed.
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
  "decide for each existing caller whether its behaviour changes under the new result",
  "using the real values that caller can receive",
  "keep the shared helper as it was and apply the new behaviour at the new call site, or change that caller too",
  "Add a test that exercises each existing caller whose behaviour the change touches, under the new result",
  "A changed shared helper with no test through an existing caller whose behaviour it touches is a blocking self-review finding",
];

// Issue #5235 removed these: the verifier's caller verdicts are advisory since #4234, and a self-written callers list is no evidence.
const RETIRED_PHRASES = [
  "blocks the PR",
  "List the callers checked in the PR summary",
  "a callers-checked list alone does not count",
];

Deno.test("both surfaces carry the changing-a-shared-helper rule (Issues #3100, #3779, #5235)", async () => {
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
    for (const phrase of RETIRED_PHRASES) {
      assert(
        !paragraph.includes(phrase),
        `${surface} still carries retired "${phrase}" in the changing-a-shared-helper rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    sharedHelperRuleParagraph(standards, "CODING-STANDARDS.md"),
    sharedHelperRuleParagraph(guidelines, "coding_guidelines"),
    "the changing-a-shared-helper rule must be identical on both surfaces",
  );
});
