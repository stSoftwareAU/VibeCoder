/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3117 — review-fix runs added a test but left the archived PR
 * summary's Test Plan stale: the list of tests, a per-file test count or a
 * quoted total went uncounted after the push that changed them
 * (VibeCoder#3075, #3105, #3108). The pr_feedback prompt's "keep the PR
 * summary true to the head" rule and the matching workflow doc section must
 * both require recounting the Test Plan from the head on every such push.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("pr_feedback prompt recounts the Test Plan after a review fix (Issue #3117)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  const phrases = [
    "changes the Test Plan, so recount it from the head",
    "every per-file test count",
    "re-run the commands the summary cites on the final head",
    "Never carry a number over from the earlier iteration",
  ];

  for (const phrase of phrases) {
    assert(
      text.includes(phrase),
      `Making Changes is missing "${phrase}" from the Test Plan recount rule: ${text}`,
    );
  }
});

Deno.test("pr-feedback workflow doc mirrors the Test Plan recount rule (Issue #3117)", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/workflows/pr-feedback.md"),
      "Recount the Test Plan after a review fix",
    ),
  );

  const phrases = [
    "every per-file test count",
    "re-running the commands the summary cites on the final head",
    "never carried over from the earlier iteration",
  ];

  for (const phrase of phrases) {
    assert(
      text.includes(phrase),
      `Recount the Test Plan after a review fix is missing "${phrase}": ${text}`,
    );
  }
});
