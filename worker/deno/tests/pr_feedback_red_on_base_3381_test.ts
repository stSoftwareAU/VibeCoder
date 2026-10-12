/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3381 — review-fix pushes that add tests left the PR summary's
 * red-on-base result stale: a first round's "77 passed, 2 failed" from a
 * 79-test file stood after the file grew to 80 tests (VibeCoder#3372), and a
 * "0 passed, 3 failed" after the file grew to five tests (VibeCoder#3066).
 * The pr_feedback prompt, the matching workflow doc sections and the worker's
 * drift check description must all require recounting the red-on-base result
 * from the head and checking a paired result as N + M.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("pr_feedback prompt recounts the red-on-base result after a review fix (Issue #3381)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  const phrases = [
    "re-run the head test file against the base branch's production code",
    "rather than appending a second block beside the stale one",
    'A run against this PR\'s own earlier commit is not "red on base"',
    "is checked as N + M against the head test file's runnable count",
  ];

  for (const phrase of phrases) {
    assert(
      text.includes(phrase),
      `Making Changes is missing "${phrase}" from the red-on-base rule: ${text}`,
    );
  }
});

Deno.test("pr-feedback workflow doc mirrors the red-on-base recount rule (Issue #3381)", async () => {
  const doc = await readRepoDoc("docs/workflows/pr-feedback.md");

  const expectations: Record<string, string[]> = {
    "Recount the Test Plan after a review fix": [
      "the head test file is re-run against the base branch's production code",
      'A run against the PR\'s own earlier commit is not "red on base"',
    ],
    "The worker's drift check": [
      "is compared as N + M with the runnable count",
      "the section's sole changed test file",
    ],
  };

  for (const [title, phrases] of Object.entries(expectations)) {
    const text = flat(section(doc, title));
    for (const phrase of phrases) {
      assert(
        text.includes(phrase),
        `${title} is missing "${phrase}": ${text}`,
      );
    }
  }
});
