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

const LEAD =
  "**State recorded on a failure path is cleared on the path that recovers.**";
const DESTRUCTIVE_LEAD =
  "**Code that deletes or replaces state proves everything it destroys is safe";

function recordParagraph(sectionText: DocSection): DocSection {
  const start = sectionText.indexOf(LEAD);
  assert(start >= 0, "could not locate the failure-record-clear paragraph");
  const end = sectionText.indexOf("\n\n", start);
  return excerpt(sectionText, start, end >= 0 ? end : undefined);
}

Deno.test("both surfaces carry the failure-record-clear rule, identical, right after the destructive-state rule (Issue #3430)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [text, next] of [
      [standards, "**A named test must exist.**"],
      [
        guidelines,
        "**Every changed call site needs a test that goes red without it.**",
      ],
    ] as const
  ) {
    assertPins(text, [LEAD]);
    assertPins(recordParagraph(text), [
      "list every path on which a later run finds the condition gone",
      "finds nothing wrong, is below a threshold, or is switched off",
      "why the record should outlive a healthy run",
      "existing set/clear pair on a sibling path",
      "real record helper against a temporary store, not a stub",
      "drive the failure, then a healthy run, and assert the record is gone",
      "List the set/clear pairs checked in the PR summary",
      "A record with no clear on a healthy path is a blocking self-review finding",
    ]);

    const destructive = text.indexOf(DESTRUCTIVE_LEAD);
    const here = text.indexOf(LEAD);
    const following = text.indexOf(next);
    assert(
      destructive >= 0 && destructive < here,
      "must follow destructive-state rule",
    );
    assert(following >= 0 && here < following, `must precede ${next}`);
  }

  assertEquals(
    flat(recordParagraph(standards)).trim(),
    flat(recordParagraph(guidelines)).trim(),
    "the failure-record-clear rule must be identical on both surfaces",
  );
});

Deno.test("issue prompt PR Summary File step restates the failure-record-clear rule (Issue #3430)", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "**State recorded on a failure path is cleared on the path that recovers**",
      "list the set/clear pairs checked",
      "a record with no clear on a healthy path is a blocking self-review finding",
    ],
  );
});
