/**
 * Doc-drift test for Issue #4304: a merged PR that marks acceptance criteria
 * `missing` leaves its issue open and queued for the worker to finish
 * (`missing_criterion_close_guard.ts`, `closeIssuesForMergedPrs`). Two
 * documents said the worker labels it `needs-human` — a hand-back the code
 * never makes, and one the owner rule forbids.
 *
 * Uses Australian English throughout.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { flatWholeFile, readRepoDoc } from "./support/markdown_docs.ts";

const DOCS = ["prompts/pr_feedback/prompt.md", "CODING-STANDARDS.md"] as const;

for (const relative of DOCS) {
  Deno.test(`${relative} - a merged PR with missing criteria re-queues its issue, never needs-human (Issue #4304)`, async () => {
    const text = flatWholeFile(await readRepoDoc(relative));
    assert(
      !/names the missing criteria[^.]*needs-human|needs-human`? and names the missing criteria/
        .test(text),
      `${relative} still hands a missing-criteria merge to a human`,
    );
    assertStringIncludes(text, "leaves the issue open and queued");
  });
}
