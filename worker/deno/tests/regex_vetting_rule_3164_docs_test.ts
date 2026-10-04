/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3164 — fleet PRs vetted one regex per untrusted-text parser for
 * backtracking and shipped its siblings quadratic (VibeCoder#3085, #3160).
 * CODING-STANDARDS.md "Unit tests" and the coding_guidelines prompt's unit-test
 * section must both carry the same "vet every regex, one hostile case per
 * pattern" rule, word for word once wrapping is ignored, and the pr_feedback
 * prompt's Making Changes section must send a backtracking finding to every
 * other regex in the same module.
 *
 * Each pinned phrase was absent from its section on the base branch, so
 * deleting the new rule turns this suite red.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const RULE_START = "- **Vet every regex on untrusted text";

/** The rule's bullet, from its bold lead-in to the next bullet or paragraph. */
function ruleBullet(sectionText: string, what: string): string {
  const start = sectionText.indexOf(RULE_START);
  assert(start >= 0, `could not locate the regex-vetting rule in ${what}`);
  const rest = sectionText.slice(start + RULE_START.length);
  const ends = [rest.indexOf("\n- "), rest.indexOf("\n\n")].filter((i) =>
    i >= 0
  );
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return flat(RULE_START + rest.slice(0, end)).trim();
}

const KEY_PHRASES = [
  "Every regex a change adds or edits that runs on untrusted or agent-written text",
  "only optional tokens between them",
  "one hostile case per pattern",
  "followed by a character the pattern rejects",
  "A parser with several patterns needs a case for each",
];

Deno.test("both surfaces carry the regex-vetting rule (Issue #3164)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Unit tests",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Unit Tests vs",
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
        `${surface} is missing "${phrase}" from the regex-vetting rule: ${bullet}`,
      );
    }
  }

  assertEquals(
    ruleBullet(standards, "CODING-STANDARDS.md"),
    ruleBullet(guidelines, "coding_guidelines"),
    "the regex-vetting rule must be identical on both surfaces",
  );
});

Deno.test("pr_feedback prompt sends a backtracking finding to every sibling regex (Issue #3164)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  assert(
    text.includes("check every other regex in the same module"),
    `Making Changes is missing the every-other-regex check: ${text}`,
  );
  assert(
    text.includes("a hostile case for each"),
    `Making Changes is missing the hostile-case-for-each requirement: ${text}`,
  );
});
