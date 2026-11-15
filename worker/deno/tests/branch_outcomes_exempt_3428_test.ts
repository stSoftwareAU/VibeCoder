/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

const PINS = [
  "An outcome no input can reach is dead code: remove it, never exempt it.",
  "`exempt (untestable)` is for an outcome production can reach but a test cannot stage",
  "the test files that already call the enclosing function or script (a grep of the test tree for its name), each with why it cannot reach the outcome",
  '"No existing harness" with no search named is not a reason.',
  "An outcome the linked issue asks a test for, in its acceptance criteria or Definition of done, cannot be `exempt (untestable)`.",
] as const;

Deno.test("CODING-STANDARDS.md preserves honest staging limitations", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Test coverage expectations",
    ),
    [
      "Remove unreachable dead code",
      "state the limitation and the existing harnesses considered",
      "do not claim it was tested",
      "An explicit acceptance test remains required",
    ],
  );
});

Deno.test("coding_guidelines preserves honest staging limitations", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Test Coverage Expectations",
    ),
    [
      "Remove unreachable dead code",
      "state the limitation and the existing harnesses considered",
      "do not claim it was tested",
      "An explicit acceptance test remains required",
    ],
  );
});

Deno.test("issue prompt requires genuine staging limits and acceptance tests", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "genuine staging limitation and the harnesses considered",
      "satisfy explicit acceptance tests",
    ],
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
