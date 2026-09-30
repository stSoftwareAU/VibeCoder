/**
 * Issue #2904: a state's meaning changed but a rendered label/reason string
 * kept the old wording, because the docs rule only caught renames, not a
 * meaning change hiding behind an unchanged name. Both surfaces must carry
 * the same new bullet, word for word once wrapping is ignored.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
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

function meaningBullet(text: string, what: string): string {
  const found = text.match(
    /- When a change alters what an existing[\s\S]*$/,
  );
  assert(found, `could not locate the meaning-change bullet in ${what}`);
  return flatten(found[0]);
}

Deno.test("both surfaces carry the state-meaning-change bullet (Issue #2904)", async () => {
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
    const flat = flatten(text);
    for (
      const phrase of [
        "renders or explains",
        "every case",
        "old wording",
        "enum variant",
      ]
    ) {
      assert(
        flat.includes(phrase),
        `${surface} is missing "${phrase}" from the docs-change section: ${text}`,
      );
    }
  }

  assertEquals(
    meaningBullet(
      section(standards, "CODING-STANDARDS.md"),
      "CODING-STANDARDS.md",
    ),
    meaningBullet(
      section(guidelines, "coding_guidelines"),
      "coding_guidelines",
    ),
    "the state-meaning-change bullet must be identical on both surfaces",
  );
});
