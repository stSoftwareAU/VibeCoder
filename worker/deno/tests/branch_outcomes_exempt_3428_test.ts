/**
 * Documentation-drift test for Issue #3428 — fleet PRs used `exempt
 * (untestable)` for dead code (VibeCoder#3312) and for an outcome existing
 * tests could reach, behind an unverified "no existing harness" claim. The
 * branch-outcome rule now says an unreachable outcome is dead code to remove,
 * `exempt (untestable)` covers only an outcome production can reach but a test
 * cannot stage, its reason names what blocks staging and the harness search,
 * and an outcome the linked issue asks a test for cannot be `exempt
 * (untestable)`. This test pins the shared wording on all four surfaces:
 * CODING-STANDARDS.md, the coding_guidelines prompt, the issue prompt's PR
 * Summary File step, and the pr_feedback prompt's Making Changes section.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

const PINS = [
  "An outcome no input can reach is dead code: remove it, never exempt it.",
  "`exempt (untestable)` is for an outcome production can reach but a test cannot stage",
  "the test files that already call the enclosing function or script (a grep of the test tree for its name), each with why it cannot reach the outcome",
  '"No existing harness" with no search named is not a reason.',
  "An outcome the linked issue asks a test for, in its acceptance criteria or Definition of done, cannot be `exempt (untestable)`.",
] as const;

Deno.test("CODING-STANDARDS.md pins the tightened exempt (untestable) rule (Issue #3428)", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Test coverage expectations",
    ),
    PINS,
  );
});

Deno.test("coding_guidelines pins the tightened exempt (untestable) rule (Issue #3428)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Test Coverage Expectations",
    ),
    PINS,
  );
});

Deno.test("issue prompt PR Summary File pins the tightened exempt (untestable) rule (Issue #3428)", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    PINS,
  );
});

Deno.test("pr_feedback prompt Making Changes pins the tightened exempt (untestable) rule (Issue #3428)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    PINS,
  );
});
