/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3167 — fleet PRs inserted a new branch, guard, capture or hand-off
 * below an existing early exit that a realistic input for the new case fires
 * first, and tested it with a fixture that never tripped that exit:
 * GRQ#5105 put the run-start test-mode guard after the roster `exit 0`
 * paths; VibeCoder#3134 put the unassigned-gap capture below
 * `if (subjectWordSet.size === 0) continue;`; and VibeCoder#3159 left the
 * self-filed-dependency hand-off below the retry, short-output and
 * `detectRunInterrupted` exits across two review-fix rounds.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same "a new branch must be reachable by the input it exists for" rule,
 * inside the test-coverage section, word for word once wrapping is ignored;
 * the "Choosing assertions" section must point back to it; and the issue
 * prompt's Test Plan step and the pr_feedback prompt must both require it.
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

const RULE_NAME = "A new branch must be reachable by the input it exists for";
const PARAGRAPH_START = `**${RULE_NAME}.**`;

function reachableParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the reachable-branch rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "list each exit above the insertion point and what fires it",
  "a realistic input for the new case can fire it first",
  "Free-text heuristics",
  "A real infrastructure signal can justify that; a wording guess cannot",
  "also trips each earlier exit the new branch now precedes",
  "confirm the test goes red",
  "blocking self-review finding",
];

Deno.test("both surfaces carry the reachable-branch rule (Issue #3167)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = reachableParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the reachable-branch rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    reachableParagraph(standards, "CODING-STANDARDS.md"),
    reachableParagraph(guidelines, "coding_guidelines"),
    "the reachable-branch rule must be identical on both surfaces",
  );
});

Deno.test("Choosing assertions points back at the reachable-branch rule (Issue #3167)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
  );

  assert(
    text.includes(RULE_NAME),
    `Choosing assertions is missing the back-reference: ${text}`,
  );
});

Deno.test("issue prompt Test Plan step requires a reachable new branch (Issue #3167)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes(RULE_NAME),
    `PR Summary File section is missing the reachable-branch requirement: ${text}`,
  );
  assert(
    text.includes(
      "a new branch that a realistic input for its own case cannot reach is a blocking self-review finding",
    ),
    `PR Summary File section is missing the unreachable-branch finding: ${text}`,
  );
});

Deno.test("PR-feedback prompt points at the reachable-branch rule (Issue #3167)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  assert(
    text.includes(RULE_NAME),
    `Making Changes section is missing the reachable-branch reference: ${text}`,
  );
  assert(
    text.includes("leaving it below the next"),
    `Making Changes section is missing the one-exit-at-a-time warning: ${text}`,
  );
});
