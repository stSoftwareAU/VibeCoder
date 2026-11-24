/**
 * Issue #2904: a state's meaning changed but a rendered label/reason string
 * kept the old wording, because the docs rule only caught renames, not a
 * meaning change hiding behind an unchanged name. Both surfaces must carry
 * the consolidated docs-change paragraph, word for word ignoring wrapping.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  type DocSection,
  flat,
  readRepoDoc,
  section,
  splitSection,
} from "./support/markdown_docs.ts";

const DOCS_CHANGE_SECTION = "A Code Change Owes a Docs Change";

async function latestPromptText(name: string): Promise<string> {
  return await readRepoDoc(`prompts/${name}/prompt.md`);
}

function meaningParagraph(text: DocSection, what: string): string {
  const paragraph = splitSection(text, "\n\n").find((part) =>
    part.trim().length > 0
  );
  assert(paragraph, `could not locate the docs-change paragraph in ${what}`);
  return flat(paragraph).trim();
}

Deno.test("both surfaces carry the consolidated meaning-change paragraph (Issue #2904)", async () => {
  const [standards, guidelines] = await Promise.all([
    readRepoDoc("CODING-STANDARDS.md"),
    latestPromptText("coding_guidelines"),
  ]);

  for (
    const [surface, text] of [
      [
        "CODING-STANDARDS.md",
        section(standards, DOCS_CHANGE_SECTION),
      ],
      [
        "coding_guidelines",
        section(guidelines, DOCS_CHANGE_SECTION),
      ],
    ] as const
  ) {
    const flattened = meaningParagraph(text, surface);
    for (
      const phrase of [
        "When a change renames or removes something",
        "changes the behaviour, meaning, default or value of something a doc or comment describes",
        'for the old name **and** for the stem of the old wording or value (`replac\\w*`, not "replaces")',
        "The old wording includes each doc line your own diff removed or rewrote",
        "Then re-run the grep on the final head",
      ]
    ) {
      assert(
        flattened.includes(phrase),
        `${surface} is missing "${phrase}" from the docs-change paragraph: ${flattened}`,
      );
    }
  }

  assertEquals(
    meaningParagraph(
      section(standards, DOCS_CHANGE_SECTION),
      "CODING-STANDARDS.md",
    ),
    meaningParagraph(
      section(guidelines, DOCS_CHANGE_SECTION),
      "coding_guidelines",
    ),
    "the docs-change paragraph must be identical on both surfaces",
  );
});
