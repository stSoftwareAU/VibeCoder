/**
 * Issue #3137: the docs-change rule fired on renames and meaning changes but
 * not on a purely additive change (a new field, enum variant, kind or
 * column), so the doc listing the set's members was left one short; the new
 * member's name is in no doc yet, so the stale list is found only by
 * grepping an existing sibling member.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

function additiveMemberBullet(text: DocSection, what: string): string {
  const found = text.match(
    /- \*\*Adding a member owes a docs change too\.\*\*[\s\S]*?(?=\n- |$)/,
  );
  assert(
    found,
    `could not locate the additive-member bullet in ${what}: ${text}`,
  );
  return flat(
    excerpt(text, found.index ?? 0, (found.index ?? 0) + found[0].length),
  );
}

Deno.test("both surfaces carry the additive-member bullet, word for word (Issue #3137)", async () => {
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
    const flattened = additiveMemberBullet(text, surface);
    for (
      const phrase of [
        "existing sibling members",
        "not the new one",
        "reads as complete",
        "enum variant",
      ]
    ) {
      assert(
        flattened.includes(phrase),
        `${surface} is missing "${phrase}" from the additive-member bullet: ${flattened}`,
      );
    }
  }

  assertEquals(
    additiveMemberBullet(
      section(standards, DOCS_CHANGE_SECTION),
      "CODING-STANDARDS.md",
    ),
    additiveMemberBullet(
      section(guidelines, DOCS_CHANGE_SECTION),
      "coding_guidelines",
    ),
    "the additive-member bullet must be identical on both surfaces",
  );
});

Deno.test("issue prompt's docs step asks for a sibling-member grep on an additive change (Issue #3137)", async () => {
  const issuePrompt = await latestPromptText("issue");
  const normalised = flat(section(issuePrompt, "Instructions")).toLowerCase();

  assertStringIncludes(normalised, "existing sibling members");
  assertStringIncludes(normalised, "no longer reads as complete");
});
