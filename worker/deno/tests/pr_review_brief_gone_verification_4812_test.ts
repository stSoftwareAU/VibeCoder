/**
 * Doc-drift test for Issue #4812: the review brief's `verification` bullet
 * must say that a note whose every `coverage` entry is `gone` owes a
 * verification too, and what that verification is (the search or build that
 * showed the removed code and its callers are gone). The fleet's
 * `checkNote` in `.claude/skills/review-fleet-prs/scripts/test_change_policy.ts`
 * refuses an all-gone note without verification, so the brief must tell the
 * reviewer to supply one.
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("Issue #4812 - review brief verification bullet requires verification for an all-gone note", async () => {
  const doc = await readRepoDoc("prompts/pr_review_brief/prompt.md");
  const text = flat(section(doc, "Review Mode"));
  assertStringIncludes(
    text,
    "and also when every `coverage` entry is `gone`: there it is the search or build that showed the removed code and its callers are gone.",
  );
});
