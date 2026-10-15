/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3666 — fleet PRs added the same handling at more than one step of a
 * path and a new test named for a later step whose fixture stopped at an
 * earlier one; the red check reverted the whole change, which removed the
 * earlier step too, so it could not show which step the test reached
 * (NEAT-AI-Discovery#2400, VibeCoder#3308 and two private fleet PRs).
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same per-step rule word for word once wrapping is ignored, and the new-test
 * rule must point to it; the issue prompt's Test Plan step, the pr_feedback
 * red-run rule, the shared review brief and the issue-processing manual must
 * each carry it too.
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

const STEP_START = "**A test named for one step must reach that step.**";
const NEW_TEST_START = "**A new test must go red without its change.**";

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
  "break only that step and leave the earlier ones in place",
  "does not show which step a test reached",
  "got past the earlier steps",
  "the step-only break",
  "only its own step is broken",
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

Deno.test("the new-test rule points to the per-step rule (Issue #3666)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );
  const phrase =
    "below is this rule for a change that adds the same handling at more than one step";

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = paragraphAt(text, NEW_TEST_START, surface);
    assert(
      paragraph.includes(phrase),
      `${surface} new-test rule is missing "${phrase}": ${paragraph}`,
    );
  }
});

Deno.test("issue prompt Test Plan step breaks only the named step (Issue #3666)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );
  for (
    const phrase of [
      "with only that step broken and the earlier steps left in place",
      "also asserts that the run got past the earlier steps",
    ]
  ) {
    assert(
      text.includes(phrase),
      `PR Summary File section is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("pr_feedback red-run rule reverts only the named step (Issue #3666)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );
  const phrase = "revert only that step and keep the earlier ones";
  assert(
    text.includes(phrase),
    `Making Changes section is missing "${phrase}": ${text}`,
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

Deno.test("issue-processing manual records the per-step rule (Issue #3666)", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/workflows/issue-processing.md"),
      "Reproduction status on a bug fix",
    ),
  );
  const phrase = "break only its own step and leave the earlier ones in place";
  assert(
    text.includes(phrase),
    `issue-processing section is missing "${phrase}": ${text}`,
  );
});
