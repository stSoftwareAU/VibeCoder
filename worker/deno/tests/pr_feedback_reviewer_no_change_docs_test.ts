/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift
 * tests), scoped to the `## Making Changes` section of the `pr_feedback`
 * prompt: Issue #3246.
 *
 * A PR-feedback run on a reviewer's `CHANGES_REQUESTED` review used to be
 * able to end with no commit and no `.pr_response_message`, and the worker
 * then posted the neutral "could not identify a code change" reply — so the
 * finding came back on the next review even though the review that raised
 * it had already been dismissed and could not be rediscovered. The
 * `pr_feedback` prompt now tells the agent explicitly, in `## Making
 * Changes`, that a finding naming a file, a line and a fix is never left
 * unanswered: fix and push it, or rebut it by name in `.pr_response_message`
 * with evidence, because a run that does neither gets no reply of its own —
 * the worker re-runs the agent once on the same review, and escalates to
 * `needs-human` if that also produces nothing.
 *
 * Each pinned phrase was absent from the base branch's `## Making Changes`
 * section (checked with `deno task drift-pins-on-base`), so deleting the
 * new rule turns this suite red.
 *
 * Uses Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

/** The `## Making Changes` section of the `pr_feedback` prompt. */
async function makingChangesSection(): Promise<string> {
  return section(
    await readRepoDoc("prompts/pr_feedback/prompt.md"),
    "Making Changes",
  );
}

Deno.test("pr_feedback - a change request is never answered with no change (Issue #3246)", async () => {
  const body = flat(await makingChangesSection()).toLowerCase();

  for (
    const required of [
      '"no change" is not an answer to a change request',
      "rebut that finding by name",
      "re-runs you once",
      "it labels the pr `needs-human` instead of replying",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});
