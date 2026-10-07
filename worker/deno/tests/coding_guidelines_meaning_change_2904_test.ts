/**
 * Issue #2904: a state's meaning changed but a rendered label/reason string
 * kept the old wording, because the docs rule only caught renames, not a
 * meaning change hiding behind an unchanged name. Both surfaces must carry
 * the same new bullet, word for word once wrapping is ignored.
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

const DOCS_CHANGE_SECTION = "A Code Change Owes a Docs Change";

async function latestPromptText(name: string): Promise<string> {
  return await readRepoDoc(`prompts/${name}/prompt.md`);
}

function meaningBullet(text: DocSection, what: string): string {
  const found = text.match(/- When a change alters what an existing[\s\S]*$/);
  assert(found, `could not locate the meaning-change bullet in ${what}`);
  return flat(excerpt(text, found.index ?? 0));
}

Deno.test("both surfaces carry the state-meaning-change bullet (Issue #2904)", async () => {
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
    const flattened = flat(text);
    for (
      const phrase of [
        "renders or explains",
        "every case",
        "old wording",
        "enum variant",
      ]
    ) {
      assert(
        flattened.includes(phrase),
        `${surface} is missing "${phrase}" from the docs-change section: ${text}`,
      );
    }
  }

  assertEquals(
    meaningBullet(
      section(standards, DOCS_CHANGE_SECTION),
      "CODING-STANDARDS.md",
    ),
    meaningBullet(
      section(guidelines, DOCS_CHANGE_SECTION),
      "coding_guidelines",
    ),
    "the state-meaning-change bullet must be identical on both surfaces",
  );
});
