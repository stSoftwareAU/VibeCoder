/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3615 — fleet guards (VibeCoder#3065, #3514) skipped themselves when a
 * helper turned a failed read into a falsy value, so the merge or push went
 * ahead. The "guard decides the unreadable case itself" bullet must be in
 * Never Fail Silently on both CODING-STANDARDS.md and the coding_guidelines
 * prompt, word for word once wrapping is ignored; the branch-outcome rule must
 * point at it; and the issue prompt's Test Plan step must require the
 * unreadable outcome.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
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

const BULLET_LEAD = "A guard decides the unreadable case itself";
const ABSENCE_BULLET = "- **Absence of a success marker is not success";
const GUARD_BULLET = `- **${BULLET_LEAD}`;
const PARAGRAPH_START =
  "**Every outcome of a branch you add needs a test that reaches it.**";
const POINTER =
  "fail-closed default and, for a guard whose input read can fail, `unreadable`: see **A guard decides the unreadable case itself** under **Never Fail Silently — Fail Loud**";

/** The bullet body after its lead and separator, first letter lower-cased. */
function bulletBody(sectionText: DocSection, separator: string): string {
  const start = sectionText.indexOf(`- **${BULLET_LEAD}${separator}`);
  assert(start >= 0, `could not locate the bullet with separator ${separator}`);
  const ends = ["\n- ", "\n\n"]
    .map((marker) => sectionText.indexOf(marker, start + 1))
    .filter((index) => index >= 0);
  const bullet = flat(excerpt(sectionText, start, Math.min(...ends)));
  const body = bullet.slice(
    bullet.indexOf(separator) + separator.length,
  ).trim();
  return body.charAt(0).toLowerCase() + body.slice(1);
}

function branchOutcomeParagraph(sectionText: DocSection): DocSection {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, "could not locate the branch-outcome rule");
  const end = sectionText.indexOf("\n\n", start);
  return excerpt(sectionText, start, end >= 0 ? end : undefined);
}

Deno.test("both surfaces carry the guard-unreadable rule in Never Fail Silently (Issue #3615)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Never Fail Silently",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Never Fail Silently",
  );

  for (const text of [standards, guidelines]) {
    assertPins(text, [
      BULLET_LEAD,
      "arming auto-merge, merging, pushing, claiming, closing",
      "returns an empty or falsy value on a failed read",
      "that failed read is one of the guard's outcomes",
      "It does not mean the guard does not apply",
      "Make it fail closed: defer, hold or refuse, and never go ahead with the action",
      "Do not let a truthiness check such as `value && …` skip the guard",
      "its own `unreadable` line in `Branch outcomes:`",
      "asserts the action did not happen",
      "never `exempt (untestable)`",
      'When the helper cannot tell "absent" from "failed", fix the helper first',
      "report unread input as not checked",
    ]);

    const absence = text.indexOf(ABSENCE_BULLET);
    const guard = text.indexOf(GUARD_BULLET);
    assert(
      absence >= 0,
      "could not locate the Absence of a success marker bullet",
    );
    assert(
      guard > absence,
      "the guard-unreadable bullet must follow the Absence of a success marker bullet",
    );
    assert(
      !text.slice(absence + 1, guard).includes("\n- **"),
      "no other bullet may sit between the Absence bullet and the guard-unreadable bullet",
    );
  }

  assertEquals(
    bulletBody(standards, "** —"),
    bulletBody(guidelines, ".**"),
    "the guard-unreadable bullet must be identical on both surfaces",
  );
});

Deno.test("the branch-outcome rule points at the guard-unreadable rule on both surfaces (Issue #3615)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (const text of [standards, guidelines]) {
    assertPins(branchOutcomeParagraph(text), [POINTER]);
  }
});

Deno.test("issue prompt Test Plan step requires the unreadable outcome (Issue #3615)", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "has its own `unreadable` outcome when its input read can fail",
      "a truthiness check such as `value && …` must not skip the guard",
      "names a test whose stub makes the read fail and asserts the action did not happen",
      "**A guard decides the unreadable case itself**",
      "A guard that goes ahead when its input cannot be read is a blocking self-review finding",
    ],
  );
});
