/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3162 — fleet refusal tests passed on a refusal from another rule
 * (GRQ-AutoTrader#2386, #2393, VibeCoder#3079): they asserted only that
 * something refused, so the rule they were named for was never reached.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same "a refusal test must be refused by the rule it names" rule, inside
 * the test-coverage section, word for word once wrapping is ignored; the
 * issue prompt's Test Plan step and the pr_feedback prompt's Making Changes
 * section must point at it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**A refusal test must be refused by the rule it names.**";

function refusalTestParagraph(sectionText: string, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the refusal-test rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = end >= 0
    ? sectionText.slice(start, end)
    : sectionText.slice(start);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "assert the specific error variant or rule",
  "with only the probed value made legal is accepted",
  "the on-target base value is accepted by both sides",
  "confirm each still reaches it",
  "one that now stops earlier is a blocking self-review finding",
];

Deno.test("both surfaces carry the refusal-test rule (Issue #3162)", async () => {
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
    const paragraph = refusalTestParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the refusal-test rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    refusalTestParagraph(standards, "CODING-STANDARDS.md"),
    refusalTestParagraph(guidelines, "coding_guidelines"),
    "the refusal-test rule must be identical on both surfaces",
  );
});

Deno.test("issue prompt Test Plan step points at the refusal-test rule (Issue #3162)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes("A refusal test must be refused by the rule it names"),
    `PR Summary File section is missing the refusal-test rule: ${text}`,
  );
  assert(
    text.includes(
      "the same input with only the probed value made legal is accepted",
    ),
    `PR Summary File section is missing the made-legal check: ${text}`,
  );
  assert(
    text.includes(
      "one that now stops earlier is a blocking self-review finding",
    ),
    `PR Summary File section is missing the stops-earlier finding: ${text}`,
  );
});

Deno.test("pr_feedback prompt fixes a refusal finding at the rule it names (Issue #3162)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  assert(
    text.includes("A refusal finding is fixed at the rule it names"),
    `Making Changes section is missing the refusal-finding rule: ${text}`,
  );
  assert(
    text.includes("repeats the finding one level down"),
    `Making Changes section is missing the repeats-one-level-down phrase: ${text}`,
  );
  assert(
    text.includes("confirm each still reaches it"),
    `Making Changes section is missing the confirm-still-reaches phrase: ${text}`,
  );
  assert(
    text.includes("A refusal test must be refused by the rule it names"),
    `Making Changes section is missing the back-reference to the refusal-test rule: ${text}`,
  );
});
