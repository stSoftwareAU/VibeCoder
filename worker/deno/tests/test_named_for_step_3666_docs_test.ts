/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertPins,
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const STEP_START = "**A test named for one step must reach that step.**";

/** The paragraph opening at `opening`, up to the next blank line, flattened. */
function paragraphAt(
  sectionText: DocSection,
  opening: string,
  what: string,
): string {
  const start = sectionText.indexOf(opening);
  assert(start >= 0, `could not locate "${opening}" in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  return flat(excerpt(sectionText, start, end >= 0 ? end : undefined)).trim();
}

const KEY_PHRASES = [
  "fixture that reaches the named step",
  "past earlier steps",
  "positive control showing earlier steps completed",
  "do not require breaking each step in turn",
  "stops at an earlier step is a blocking self-review finding",
];

Deno.test("both surfaces carry the per-step rule (Issue #3666)", async () => {
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
    const paragraph = paragraphAt(text, STEP_START, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the per-step rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    paragraphAt(standards, STEP_START, "CODING-STANDARDS.md"),
    paragraphAt(guidelines, STEP_START, "coding_guidelines"),
    "the per-step rule must be identical on both surfaces",
  );
});

Deno.test("per-step rule uses reachable fixtures and positive controls", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Test coverage expectations",
    ),
    [
      "A test named for one step must reach that step",
      "positive control showing earlier steps completed",
    ],
  );
});

Deno.test("issue prompt requires reaching the named step", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "earlier steps",
      "assert that step's outcome",
    ],
  );
});

Deno.test("feedback scopes red evidence to diagnosed bugs", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    [
      "For a diagnosed bug",
      "do not expand a finding into per-line, per-step or per-operand mutation exercises",
    ],
  );
});

Deno.test("review brief checks a later-step test gets past earlier steps (Issue #3666)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_review_brief/prompt.md"),
      "Review Mode — one change against its linked issue",
    ),
  );
  const phrase = "gets past every earlier step giving the same outcome";
  assert(
    text.includes(phrase),
    `Review Mode section is missing "${phrase}": ${text}`,
  );
});

Deno.test("manual keeps per-step reachability without breaking steps", async () => {
  assertPins(
    section(
      await readRepoDoc("docs/workflows/issue-processing.md"),
      "Reproduction status on a bug fix",
    ),
    [
      "fixture gets past earlier steps",
      "a positive control",
      "An earlier refusal cannot stand in for testing the later step",
    ],
  );
});
