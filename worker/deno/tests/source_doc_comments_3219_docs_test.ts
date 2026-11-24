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
 * the coding_guidelines prompt must both carry the same docs-change paragraph,
 * word for word once wrapping is ignored; the issue prompt's step 3 and the
 * pr_feedback sweep must both send the agent to source files.
 *
 * The consolidated paragraph retains source comments and files outside the
 * diff; the pr_feedback sweep keeps its existing source-comment guidance.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  DocSection,
  excerpt,
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const SECTION = "A Code Change Owes a Docs Change";
const RULE_START = "When a change renames or removes something,";

/** The consolidated paragraph, excluding the retained sibling rules. */
function ruleParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(RULE_START);
  assert(start >= 0, `could not locate the docs-change paragraph in ${what}`);
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
  "grep README, `docs/`, prompts and agent instructions, source doc comments and user-visible strings",
  "Read the sentence around every hit and fix each one the change makes false",
  "including in a file the diff does not otherwise touch",
];

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
    const paragraph = ruleParagraph(text, surface);
    for (const phrase of RULE_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the docs-change paragraph: ${paragraph}`,
      );
    }
  }

  assertEquals(
    ruleParagraph(standards, "CODING-STANDARDS.md"),
    ruleParagraph(guidelines, "coding_guidelines"),
    "the docs-change paragraph must be identical on both surfaces",
  );
});

const PROMPT_PHRASES = [
  "Grep **source files** too, not only the manuals",
  "the shared constants, types and helpers the changed code defines or calls",
  "Read every doc comment and module doc a hit lands in",
  "including in a file the diff does not otherwise touch",
];

Deno.test("issue prompt step 3 sends the docs sweep to source doc comments (Issue #3219)", async () => {
  const issue = await readRepoDoc("prompts/issue/prompt.md");
  const instructions = section(issue, "Instructions");
  const start = instructions.indexOf("3. Update the documentation");
  const end = instructions.indexOf("\n4. ", start);
  assert(start >= 0 && end > start, "could not locate issue prompt step 3");
  const text = flat(excerpt(instructions, start, end));
  const paragraph = ruleParagraph(
    section(await readRepoDoc("CODING-STANDARDS.md"), SECTION),
    "CODING-STANDARDS.md",
  );
  assert(
    text.includes(paragraph),
    "issue prompt step 3 must carry the same docs-change paragraph",
  );
  for (
    const phrase of [
      "see **A Code Change Owes a Docs Change** in `CODING-STANDARDS.md`",
      "find the **manual section** that documents the surface you changed by grepping for the surface's own name",
      "read that section through and fix every sentence the change makes false",
    ]
  ) {
    assert(text.includes(phrase), `the issue prompt is missing "${phrase}"`);
  }
  assertEquals(
    flatWholeFile(issue).includes(
      "Name the section you read and the doc files you updated in the PR summary",
    ),
    false,
    "the issue prompt must drop the redundant docs-summary requirement",
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
