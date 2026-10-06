/**
 * Issue #3196: a Standards `violation` in the PR's own lines may not "stand".
 *
 * The gate half lives in `independent_review_gate_test.ts` and
 * `closure_verdict_test.ts`. These tests pin the instructions a run writes its
 * summary from — the issue prompt, the template both gates print, and the
 * closure-verdict recovery brief — so none of them invites the run to leave a
 * self-flagged breach standing again.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertStringIncludes } from "@std/assert";
import { REVIEW_BLOCK_TEMPLATE } from "../lib/review_block_template.ts";
import { buildClosureVerdictPrompt } from "../lib/closure_verdict_recovery.ts";
import {
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

Deno.test("Issue #3196 - the issue prompt offers only fixed or filed as a violation's reason", async () => {
  const doc = await readRepoDoc("prompts/issue/prompt.md");

  assert(
    !/why it stands/i.test(flatWholeFile(doc)),
    "the prompt still offers 'why it stands' as a violation's reason",
  );
  const reviewSection = flat(
    section(doc, "Independent Review Before the PR"),
  );
  assertStringIncludes(reviewSection, "reason: fixed in this diff");
  assertStringIncludes(reviewSection, "reason: pre-existing, filed #<n>");
  assertStringIncludes(
    reviewSection,
    "A breach in a line this diff adds or changes may not be deferred",
  );
});

Deno.test("Issue #3196 - the template both gates print records a fix, not a standing breach", () => {
  assert(!/why it stands/i.test(REVIEW_BLOCK_TEMPLATE));
  assertStringIncludes(REVIEW_BLOCK_TEMPLATE, "reason: fixed in this diff");
});

Deno.test("Issue #3196 - the closure-verdict brief asks for fixed or filed", () => {
  const brief = flatWholeFile(
    buildClosureVerdictPrompt({
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 3196,
      criteria: ["one"],
      problems: [],
    }),
  );

  assertStringIncludes(brief, "fixed in this diff");
  assertStringIncludes(brief, "pre-existing, filed #<n>");
});
