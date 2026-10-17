/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3562 — fleet PRs wrote multi-step operations for the happy path.
 * VibeCoder#2909's `recordCiCheckRetry` charged a retry before a checkout that
 * could be refused, and two private fleet PRs let a failed record write skip a
 * cancel pass, or left an audit record no retry could reach because a conflict
 * guard refused the retry first. The "every step of a multi-write operation has
 * a named finisher when it fails" paragraph must be on CODING-STANDARDS.md and
 * the coding_guidelines prompt, inside the test-coverage section right after the
 * failure-record-clear rule, identical once wrapping is ignored; the "Prefer
 * loud, early failure" bullet on both must point at it; and the issue prompt's
 * PR Summary File step must restate it.
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

const LEAD =
  "**Every step of a multi-write operation has a named finisher when it fails.**";
const FAILURE_RECORD_LEAD =
  "**State recorded on a failure path is cleared on the path that recovers.**";
const NEXT_STANDARDS = "**A named test must exist.**";
const NEXT_GUIDELINES =
  "**Every changed call site needs a test that goes red without it.**";
const BULLET_START = "- **Prefer loud, early failure";

/** The rule block from its lead up to the next rule's lead (exclusive). */
function ruleBlock(sectionText: DocSection, next: string): DocSection {
  const start = sectionText.indexOf(LEAD);
  assert(start >= 0, "could not locate the multi-write finisher rule");
  const end = sectionText.indexOf(next, start);
  assert(
    end > start,
    `could not locate the next rule ${next} after the finisher rule`,
  );
  return excerpt(sectionText, start, end);
}

/** The "Prefer loud, early failure" bullet, up to the next bullet. */
function preferLoudBullet(sectionText: DocSection): DocSection {
  const start = sectionText.indexOf(BULLET_START);
  assert(start >= 0, "could not locate the Prefer loud, early failure bullet");
  const next = sectionText.indexOf("\n- ", start + 1);
  return excerpt(sectionText, start, next >= 0 ? next : undefined);
}

Deno.test("both surfaces carry the multi-write finisher rule, identical, right after the failure-record-clear rule (Issue #3562)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  const surfaces: [DocSection, string][] = [
    [standards, NEXT_STANDARDS],
    [guidelines, NEXT_GUIDELINES],
  ];
  for (const [text, next] of surfaces) {
    assertPins(text, [LEAD]);
    assertPins(ruleBlock(text, next), [
      "list the steps in order",
      "What is left behind:",
      "Who finishes the rest:",
      "A retry counts only if it reaches the missing step",
      "must first complete or verify every step the earlier attempt may have missed",
      "A failure that is only logged has no finisher",
      "never stops a safety step (cancel, stop, revoke) from running",
      "Run the safety step, then report the bookkeeping error",
      "Never spend a counted retry or attempt before the step it pays for has passed the point where it can be refused",
      "make it fail, run the named finisher",
      "exactly one copy of each record",
      "remove the finisher and confirm the test goes red",
      "A doc sentence or test message that claims a recovery must name the code that does it",
      "List the steps and their finishers in the PR summary",
      "A step whose failure leaves work that no path ever completes is a blocking self-review finding",
    ]);

    const failureRecord = text.indexOf(FAILURE_RECORD_LEAD);
    const here = text.indexOf(LEAD);
    const following = text.indexOf(next);
    assert(
      failureRecord >= 0 && failureRecord < here,
      "must follow the failure-record-clear rule",
    );
    assert(following >= 0 && here < following, `must precede ${next}`);
  }

  assertEquals(
    flat(ruleBlock(standards, NEXT_STANDARDS)).trim(),
    flat(ruleBlock(guidelines, NEXT_GUIDELINES)).trim(),
    "the multi-write finisher rule must be identical on both surfaces",
  );
});

Deno.test("the fail-fast bullet points at the multi-write finisher rule on both surfaces (Issue #3562)", async () => {
  for (
    const doc of [
      "CODING-STANDARDS.md",
      "prompts/coding_guidelines/prompt.md",
    ]
  ) {
    const text = section(
      await readRepoDoc(doc),
      "Never Fail Silently — Fail Loud",
    );
    assertPins(preferLoudBullet(text), [
      "reported after the safety step it would otherwise block",
      "Every step of a multi-write operation has a named finisher when it fails",
    ]);
  }
});

Deno.test("issue prompt PR Summary File step restates the multi-write finisher rule (Issue #3562)", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "**Every step of a multi-write operation has a named finisher when it fails**",
      "list the steps and their finishers",
      "a step whose failure leaves work that no path ever completes is a blocking self-review finding",
    ],
  );
});
