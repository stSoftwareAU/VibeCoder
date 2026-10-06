/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3114 — review-fix runs repeatedly fixed only the locations a
 * finding listed and left other instances of the same defect class live in
 * the head — other builders of the same shape, the other order of a race,
 * later iterations of the same loop, and the same claim repeated in test
 * names — so the re-review raised the finding again as only partly fixed
 * (VibeCoder#3066, #3068, #3065, GRQ-AutoTrader#2210, #2220). Issue #3114
 * extends the Issue #3086 rule to require stating the defect as a class and
 * checking every other instance of that class, not only the one the finding
 * named.
 *
 * This pins a prompt rule the code cannot express: the pr_feedback prompt and
 * its operator manual must both keep carrying the sharpened wording, so a
 * later edit that drops or waters it down fails here rather than silently.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import {
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**Fix the defect everywhere it lives, not only where the finding points.**";

function defectClassParagraph(sectionText: DocSection): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, "could not locate the 'fix the defect everywhere' rule");
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim().toLowerCase();
}

Deno.test("pr_feedback Making Changes states the defect as a class (Issue #3114)", async () => {
  const making = section(
    await readRepoDoc("prompts/pr_feedback/prompt.md"),
    "Making Changes",
  );
  const paragraph = defectClassParagraph(making);

  for (
    const phrase of [
      "a finding's locations are examples, not the list",
      "state the defect as a class",
      "every caller or builder of the same shape",
      "test names",
      "walk each order of the parties, not only the one the reviewer described",
      "every window between their steps",
      "every later iteration of the same loop",
      "fix each instance or rebut it with the reason",
      "what you searched and which other instances you fixed",
      "another instance of the class left in the head is a blocking self-review finding",
    ]
  ) {
    assert(
      paragraph.includes(phrase),
      `Making Changes is missing "${phrase}" from the defect-class rule: ${paragraph}`,
    );
  }
});

Deno.test("pr_feedback Change Scope names another caller and another order of the same race (Issue #3114)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Change Scope",
    ),
  ).toLowerCase();

  for (
    const phrase of [
      "another caller of the same shape",
      "another order of the same race",
    ]
  ) {
    assert(
      text.includes(phrase),
      `Change Scope is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("pr_feedback Response Message names which other instances were fixed (Issue #3114)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Response Message",
    ),
  ).toLowerCase();

  assert(
    text.includes(
      "for each finding the other paths and copies you checked and which other instances you fixed",
    ),
    `Response Message is missing the "which other instances you fixed" wording: ${text}`,
  );
});

Deno.test("pr-feedback operator manual pins the Issue #3114 defect-class rule", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/workflows/pr-feedback.md"),
      "Fix the defect everywhere it lives",
    ),
  ).toLowerCase();

  for (
    const phrase of [
      "issue #3114",
      "a finding's locations are examples, not the list",
      "every caller or builder of the same shape",
      "blocking self-review finding",
    ]
  ) {
    assert(
      text.includes(phrase),
      `pr-feedback.md operator manual is missing "${phrase}": ${text}`,
    );
  }
});
