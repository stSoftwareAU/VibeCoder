/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
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
  "Assert that this input reaches the intended new outcome",
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
