/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3219 — fleet PRs fixed the manuals and the comment directly above
 * the code they edited, and left doc comments in other source files
 * describing the removed behaviour: a shared constant's definition, a
 * reader's safety argument, a helper's list of callers
 * (stSoftwareAU/VibeCoder#3215, GRQ-AutoTrader#2460, #2393). The docs sweep
 * named only manuals, so nothing sent the agent to those comments.
 *
 * CODING-STANDARDS.md "A Code Change Owes a Docs Change" and its mirror in
 * the coding_guidelines prompt must both carry the same source-comment rule,
 * word for word once wrapping is ignored; the issue prompt's step 3 and the
 * pr_feedback sweep must both send the agent to source files.
 *
 * Each pinned phrase was absent from its section on the base branch
 * (checked with `deno task drift-pins-on-base`), so deleting the new rule
 * turns this suite red.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const SECTION = "A Code Change Owes a Docs Change";
const RULE_START = "- **Doc comments outside the diff go stale too.**";

/** The rule's bullet, from its bold lead-in to the next bullet or paragraph. */
function ruleBullet(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(RULE_START);
  assert(start >= 0, `could not locate the source-comment rule in ${what}`);
  const rest = sectionText.slice(start + RULE_START.length);
  const ends = [rest.indexOf("\n- "), rest.indexOf("\n\n")].filter((i) =>
    i >= 0
  );
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return flat(
    excerpt(sectionText, start, start + RULE_START.length + end),
  ).trim();
}

const RULE_PHRASES = [
  "Grep source files, not only the manuals",
  "the shared constants, types and helpers the changed code defines or calls",
  "Read every doc comment and module doc a hit lands in",
  "including in a file the diff does not otherwise touch",
];

/** The widened "unchanged name" bullet: definitions and callers, anywhere. */
const WIDENED_PHRASE =
  "the doc comments on the definitions and callers of what changed, wherever they live";

Deno.test("both standards surfaces carry the source doc-comment rule, word for word (Issue #3219)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    SECTION,
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    SECTION,
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const bullet = ruleBullet(text, surface);
    for (const phrase of RULE_PHRASES) {
      assert(
        bullet.includes(phrase),
        `${surface} is missing "${phrase}" from the source-comment rule: ${bullet}`,
      );
    }
    assert(
      flat(text).includes(WIDENED_PHRASE),
      `${surface} no longer widens the unchanged-name bullet to definitions and callers`,
    );
  }

  assertEquals(
    ruleBullet(standards, "CODING-STANDARDS.md"),
    ruleBullet(guidelines, "coding_guidelines"),
    "the source-comment rule must be identical on both surfaces",
  );
});

const PROMPT_PHRASES = [
  "Grep **source files** too, not only the manuals",
  "the shared constants, types and helpers the changed code defines or calls",
  "Read every doc comment and module doc a hit lands in",
  "including in a file the diff does not otherwise touch",
];

Deno.test("issue prompt step 3 sends the docs sweep to source doc comments (Issue #3219)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );
  for (const phrase of PROMPT_PHRASES) {
    assert(text.includes(phrase), `the issue prompt is missing "${phrase}"`);
  }
  assert(
    text.includes("and over the comment lines of its source files"),
    "the issue prompt does not say the worker re-runs the terms over source comments",
  );
});

Deno.test("pr_feedback sweep sends a fix to source doc comments (Issue #3219)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );
  for (const phrase of PROMPT_PHRASES) {
    assert(
      text.includes(phrase),
      `the pr_feedback prompt is missing "${phrase}"`,
    );
  }
});
