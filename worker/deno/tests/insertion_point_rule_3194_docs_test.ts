/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3194 — fleet PRs inserted new code or prose between existing text
 * and the thing it describes: a new function between another function's doc
 * comment and that function (GRQ-AutoTrader#2218, #2413), and a new paragraph
 * in front of a sentence reading "Both paragraphs above …"
 * (GRQ-AutoTrader#2478). The docs sweep misses it, because the sentence made
 * wrong is one the diff neither adds nor edits.
 *
 * CODING-STANDARDS.md "A Code Change Owes a Docs Change" and its mirror in
 * the coding_guidelines prompt must both carry the same "check where you
 * insert" rule, word for word once wrapping is ignored, and the issue
 * prompt's PR-summary self-review list must carry the matching step.
 *
 * Each pinned phrase was absent from its section on the base branch, so
 * deleting the new rule turns this suite red.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const RULE_START = "- **Check where you insert.**";

/** The rule's bullet, from its bold lead-in to the next bullet or paragraph. */
function ruleBullet(sectionText: string, what: string): string {
  const start = sectionText.indexOf(RULE_START);
  assert(start >= 0, `could not locate the insertion-point rule in ${what}`);
  const rest = sectionText.slice(start + RULE_START.length);
  const ends = [rest.indexOf("\n- "), rest.indexOf("\n\n")].filter((i) =>
    i >= 0
  );
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return flat(RULE_START + rest.slice(0, end)).trim();
}

const KEY_PHRASES = [
  "read the lines directly above and below the insertion point",
  "insert above the doc comment, never between it and its item",
  "A following sentence that points back",
  "insert after it, or reword it to name what it means",
  "first and last context lines of every hunk that adds a block",
];

Deno.test("both standards surfaces carry the insertion-point rule (Issue #3194)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "A Code Change Owes a Docs Change",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "A Code Change Owes a Docs Change",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const bullet = ruleBullet(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        bullet.includes(phrase),
        `${surface} is missing "${phrase}" from the insertion-point rule: ${bullet}`,
      );
    }
  }

  assertEquals(
    ruleBullet(standards, "CODING-STANDARDS.md"),
    ruleBullet(guidelines, "coding_guidelines"),
    "the insertion-point rule must be identical on both surfaces",
  );
});

Deno.test("issue prompt's self-review list checks where the diff inserts (Issue #3194)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Summary File",
    ),
  );

  for (
    const phrase of [
      "read the lines directly above and below each insertion point",
      "never between a doc comment, attribute or decorator and its item",
      "still points at what it meant",
      "first and last context lines of every hunk that adds a block",
    ]
  ) {
    assert(
      text.includes(phrase),
      `the issue prompt's PR Summary File section is missing "${phrase}": ${text}`,
    );
  }
});
