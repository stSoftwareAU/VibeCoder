/**
 * Issue #886: `reviewer:` is a verdict, not a quotation.
 *
 * `issue/v43` gave two rules for the same field that could not both be
 * satisfied:
 *
 * - "Every criterion entry names the reviewer's verdict — `reviewer: met`,
 *   `reviewer: partial`, `reviewer: missing` or `reviewer: unrequested`."
 * - "keep the `reviewer:` field **as the reviewer wrote it** and add a
 *   one-line `reason:` saying why you departed."
 *
 * A reviewer writing anything outside the four literals put them in direct
 * conflict, and `independent_review_gate.ts` enforces the first — so an agent
 * obeying the second failed the run.
 *
 * That is what happened to #834 on 2026-09-03, after a 36-minute run:
 *
 * ```text
 * problems=`met` entry names no `reviewer:` verdict (met / partial / missing /
 *   unrequested): "... — reviewer: not assessed (run separately) — reason: the
 *   reviewer saw only the diff; the gate was run here and passed"
 * ERROR: failed at phase 'completion': Independent Spec/Standards review not
 *   reported
 * ```
 *
 * Both offending entries carried a `reason:` — the agent was following the
 * second rule exactly, recording its departure out loud rather than silently
 * overwriting the reviewer. The prompt rewarded discarding the reviewer's
 * words and punished preserving them, the opposite of its stated intent.
 *
 * v44 separates the two concerns: the verdict is the closed vocabulary the
 * gate parses, and the reviewer's own words go in `reason:`, which is what a
 * human reads anyway.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertStringIncludes } from "@std/assert";
import {
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const SECTION_TITLE = "Independent Review Before the PR";

/** The `reviewer:`/`reason:` rule's own section, whitespace flattened so a
 * line wrap cannot break a match. */
async function reviewerVerdictSection(): Promise<string> {
  const doc = await readRepoDoc("prompts/issue/prompt.md");
  return flat(section(doc, SECTION_TITLE));
}

Deno.test("reviewer verdict - the field is declared a closed vocabulary (Issue #886)", async () => {
  const text = await reviewerVerdictSection();
  assertStringIncludes(text, "`reviewer:` is a verdict, not a quotation");
  for (const verdict of ["met", "partial", "missing", "unrequested"]) {
    assertStringIncludes(text, `\`${verdict}\``);
  }
});

Deno.test("reviewer verdict - the prompt no longer demands verbatim reviewer text (Issue #886)", async () => {
  const doc = await readRepoDoc("prompts/issue/prompt.md");
  const whole = flatWholeFile(doc);
  assert(
    !whole.includes("keep the `reviewer:` field as the reviewer wrote it"),
    "this instruction conflicts with the closed vocabulary the gate parses, " +
      "and cost #834 a completed run",
  );
});

Deno.test("reviewer verdict - non-conforming reviewer wording is directed to reason: (Issue #886)", async () => {
  const text = await reviewerVerdictSection();
  assertStringIncludes(text, "put the **nearest** of the four in `reviewer:`");
  assertStringIncludes(text, "quote what it actually said in `reason:`");
});

Deno.test("reviewer verdict - the observed wording is named as an example (Issue #886)", async () => {
  // #834 wrote exactly these. Naming them means the next agent recognises the
  // case rather than inventing a fifth verdict.
  const text = await reviewerVerdictSection();
  assertStringIncludes(text, "not assessed");
  assertStringIncludes(text, "traceable, not creep");
});

Deno.test("reviewer verdict - departing out loud is still required (Issue #886)", async () => {
  // The fix must not weaken the rule it clarifies: a departure still has to be
  // recorded, which is the whole purpose of the section.
  const text = await reviewerVerdictSection();
  assertStringIncludes(
    text,
    "add a one-line `reason:` saying why you departed",
  );
  assertStringIncludes(
    text,
    "An unrecorded departure is the self-assessment this whole section exists to remove",
  );
});
