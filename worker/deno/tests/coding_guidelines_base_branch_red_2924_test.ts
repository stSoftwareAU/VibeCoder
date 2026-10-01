/**
 * Issue #2924: fleet runs claimed bug fixes whose regression test went red
 * only against the PR's own modified fake/fixture and passed on the base
 * branch, while others changed durable formats or production behaviour on an
 * unverified diagnosis. CODING-STANDARDS.md and the coding_guidelines prompt
 * must both carry the same base-branch-red rule, inside the test-coverage
 * section, word for word once wrapping is ignored.
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

const PARAGRAPH_START = "**A red run counts only against the base branch.**";

function redRunParagraph(text: string, what: string): string {
  const start = text.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the base-branch-red rule in ${what}`);
  const end = text.indexOf("\n\n", start);
  assert(
    end > start,
    `could not find end of the base-branch-red rule in ${what}`,
  );
  return flatten(text.slice(start, end));
}

function assertInsideTestCoverageSection(
  text: string,
  headingRegex: RegExp,
  what: string,
) {
  const headingMatch = text.match(headingRegex);
  assert(headingMatch, `could not locate the test-coverage heading in ${what}`);
  const headingIndex = headingMatch.index!;
  const paragraphIndex = text.indexOf(PARAGRAPH_START);
  assert(
    paragraphIndex >= 0,
    `could not locate the base-branch-red rule in ${what}`,
  );
  assert(
    paragraphIndex > headingIndex,
    `base-branch-red rule appears before the test-coverage heading in ${what}`,
  );

  const level = headingMatch[0].match(/^#+/)![0].length;
  const nextHeadingRegex = new RegExp(`\\n#{1,${level}}\\s`, "g");
  nextHeadingRegex.lastIndex = headingIndex + headingMatch[0].length;
  const nextHeading = nextHeadingRegex.exec(text);
  if (nextHeading) {
    assert(
      paragraphIndex < nextHeading.index,
      `base-branch-red rule appears after the next heading of the same level in ${what}`,
    );
  }
}

const KEY_PHRASES = [
  "base-branch production code",
  "test doubles",
  "proves nothing",
  "durable format",
  "undiagnosed or already fixed",
  "logged error line",
  "quote the line",
];

Deno.test("both surfaces carry the base-branch-red rule (Issue #2924)", async () => {
  const [standards, guidelines] = await Promise.all([
    readStandards(),
    latestPromptText("coding_guidelines"),
  ]);

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = redRunParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the base-branch-red rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    redRunParagraph(standards, "CODING-STANDARDS.md"),
    redRunParagraph(guidelines, "coding_guidelines"),
    "the base-branch-red rule must be identical on both surfaces",
  );
});

Deno.test("the base-branch-red rule sits in the test-coverage section on both surfaces (Issue #2924)", async () => {
  const [standards, guidelines] = await Promise.all([
    readStandards(),
    latestPromptText("coding_guidelines"),
  ]);

  assertInsideTestCoverageSection(
    standards,
    /^### Test coverage expectations$/m,
    "CODING-STANDARDS.md",
  );
  assertInsideTestCoverageSection(
    guidelines,
    /^## Test Coverage Expectations$/m,
    "coding_guidelines",
  );
});
