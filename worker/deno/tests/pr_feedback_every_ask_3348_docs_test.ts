/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3348 — review-fix runs did one ask of a multi-part finding and left
 * the rest: a finding with lettered parts, an "also", a second input or path,
 * or a request to record observed output in the PR summary was fixed for its
 * main ask only, so the re-review raised it again as "one part of the earlier
 * review is still not done" (VibeCoder#3312, #3318, GRQ-AutoTrader#2699).
 *
 * This pins the rule in the pr_feedback prompt (break each finding into its
 * asks, list them in the reply, count them against the Fix) and in its
 * operator manual, so a later edit that drops or waters it down fails here
 * rather than silently.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import {
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**Answer every ask in a finding, not only the finding.**";
const TWIN_START = "**Every change-request finding ends fixed or rebutted.**";

Deno.test("pr_feedback Making Changes answers every ask in a finding (Issue #3348)", async () => {
  const making = section(
    await readRepoDoc("prompts/pr_feedback/prompt.md"),
    "Making Changes",
  );
  const start = making.indexOf(PARAGRAPH_START);
  assert(start >= 0, "could not locate the 'answer every ask' rule");
  const end = making.indexOf("\n\n", start);
  const paragraph = flat(excerpt(making, start, end >= 0 ? end : undefined))
    .trim()
    .toLowerCase();

  for (
    const phrase of [
      "break each finding into its asks",
      "every separate change its **fix** requests",
      '"the same way"',
      "list the asks under each finding",
      "the commit, test or line that settles it, or a rebuttal with evidence",
      "count the asks you listed for each finding",
      "leaves the finding partly fixed",
    ]
  ) {
    assert(
      paragraph.includes(phrase),
      `Making Changes is missing "${phrase}" from the every-ask rule: ${paragraph}`,
    );
  }

  const twin = making.indexOf(TWIN_START);
  assert(twin >= 0, "could not locate the 'ends fixed or rebutted' rule");
  assert(
    start > twin,
    "the every-ask rule must sit after the 'ends fixed or rebutted' rule it builds on",
  );
});

Deno.test("pr_feedback Response Message lists the asks under each finding (Issue #3348)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Response Message",
    ),
  ).toLowerCase();

  assert(
    text.includes(
      "the asks under each finding with the commit, test or line that settles each one",
    ),
    `Response Message is missing the "asks under each finding" wording: ${text}`,
  );
});

Deno.test("pr-feedback manual documents answering every ask (Issue #3348)", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/workflows/pr-feedback.md"),
      "Answer every ask in a finding (Issue #3348)",
    ),
  ).toLowerCase();

  for (
    const phrase of [
      "break each finding into its asks",
      "counts the asks it listed",
      "leaves the finding partly fixed",
    ]
  ) {
    assert(
      text.includes(phrase),
      `pr-feedback.md operator manual is missing "${phrase}": ${text}`,
    );
  }
});
