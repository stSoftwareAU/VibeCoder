/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3223 — a doc, prompt or code comment could name behaviour that
 * another issue owns (a sibling sub-issue, a milestone's planned issue, a
 * follow-up) as if it were already present, when the deliverable was not at
 * the head. CODING-STANDARDS.md's "PR Summary and Evidence" section and the
 * issue prompt's Instructions section must both state the new rule: name
 * such behaviour only as planned, only while the issue is open, grep the
 * head for the deliverable before writing the sentence, and grep the docs
 * for a sibling's issue number when the plan says that sibling will deliver
 * it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("CODING-STANDARDS.md states the forward-reference rule in PR Summary and Evidence (Issue #3223)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "PR Summary and Evidence",
    ),
  );

  for (
    const phrase of [
      "Behaviour another issue delivers is not described as present",
      "only while #N is open",
      "grep the head for its deliverable",
      "that sibling's `#N`",
      "closed as not planned",
    ]
  ) {
    assert(
      text.includes(phrase),
      `CODING-STANDARDS.md § PR Summary and Evidence is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("issue prompt Instructions section states the forward-reference rule (Issue #3223)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );

  for (
    const phrase of [
      "Behaviour another issue delivers",
      "only while #N is open",
      "grep the head for its deliverable",
      "that sibling's `#N`",
    ]
  ) {
    assert(
      text.includes(phrase),
      `issue prompt § Instructions is missing "${phrase}": ${text}`,
    );
  }
});
