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
import { loadPrompt } from "../lib/prompt_manager.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const readStandards = () =>
  Deno.readTextFile(`${REPO_ROOT}CODING-STANDARDS.md`);

async function latestPromptText(name: string): Promise<string> {
  const result = await loadPrompt(name, PROMPTS_DIR);
  assert(result.ok, `${name} prompt failed to load`);
  return result.value;
}

/** Prose with its line wrapping flattened away. */
const flatten = (text: string) => text.replace(/\s+/g, " ").trim();

function section(text: string, what: string): string {
  const found = text.match(
    /## A Code Change Owes a Docs Change\n[\s\S]*?(?=\n## )/,
  );
  assert(found, `could not locate the docs-change section in ${what}`);
  return found[0];
}

function additiveMemberBullet(text: string, what: string): string {
  const found = text.match(
    /- \*\*Adding a member owes a docs change too\.\*\*[\s\S]*?(?=\n- |$)/,
  );
  assert(
    found,
    `could not locate the additive-member bullet in ${what}: ${text}`,
  );
  return flatten(found[0]);
}

Deno.test("both surfaces carry the additive-member bullet, word for word (Issue #3137)", async () => {
  const [standards, guidelines] = await Promise.all([
    readStandards(),
    latestPromptText("coding_guidelines"),
  ]);

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", section(standards, "CODING-STANDARDS.md")],
      ["coding_guidelines", section(guidelines, "coding_guidelines")],
    ] as const
  ) {
    const flat = additiveMemberBullet(text, surface);
    for (
      const phrase of [
        "existing sibling members",
        "not the new one",
        "reads as complete",
        "enum variant",
      ]
    ) {
      assert(
        flat.includes(phrase),
        `${surface} is missing "${phrase}" from the additive-member bullet: ${flat}`,
      );
    }
  }

  assertEquals(
    additiveMemberBullet(
      section(standards, "CODING-STANDARDS.md"),
      "CODING-STANDARDS.md",
    ),
    additiveMemberBullet(
      section(guidelines, "coding_guidelines"),
      "coding_guidelines",
    ),
    "the additive-member bullet must be identical on both surfaces",
  );
});

Deno.test("issue prompt's docs step asks for a sibling-member grep on an additive change (Issue #3137)", async () => {
  const issuePrompt = await latestPromptText("issue");
  const normalised = flatten(issuePrompt.toLowerCase());

  assertStringIncludes(normalised, "existing sibling members");
  assertStringIncludes(normalised, "no longer reads as complete");
});
