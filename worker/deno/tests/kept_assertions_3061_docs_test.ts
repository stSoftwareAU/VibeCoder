/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3061 — a fleet PR editing an existing test for an issue-required
 * change dropped assertions the issue never touched, which were still true;
 * a green gate before and after did not prove nothing was lost. Both the
 * coding standards and the issue prompt must keep every other behaviour
 * assertion when editing a test. A broken "how" assertion is deleted rather
 * than re-counted or restored, while the outcome assertions that still prove
 * the behaviour are named. The Test Plan records why each other removed
 * assertion is justified, or treats it as a blocking self-review finding.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const codingStandards = () => readRepoDoc("CODING-STANDARDS.md");
const issuePrompt = () => readRepoDoc("prompts/issue/prompt.md");

Deno.test("coding standards - TDD rule keeps still-true assertions when editing a test", async () => {
  const text = flat(
    section(await codingStandards(), "Test-Driven Development (TDD)"),
  );

  assertStringIncludes(text, "Change only what the issue changes");
  assertStringIncludes(text, "every other behaviour assertion");
  assertStringIncludes(
    text,
    'A "how" assertion (rule 2 of **Dummy tests and "how" tests are refused**) that the change breaks is deleted, not re-counted or restored',
  );
  assertStringIncludes(
    text,
    "name the outcome assertions that still prove the behaviour",
  );
  assertStringIncludes(
    text,
    "Each removed behaviour assertion needs an issue requirement that makes it untrue, or the replacement or existing coverage that still proves the behaviour",
  );
  assertStringIncludes(text, "A behaviour assertion removed without one is a");
  assertStringIncludes(text, "blocking self-review finding");
});

Deno.test("issue prompt - Instructions keep the change-only-what-the-issue-changes rule", async () => {
  const instructions = flat(section(await issuePrompt(), "Instructions"));

  assertStringIncludes(instructions, "Change only what the issue changes");
  assertStringIncludes(
    instructions,
    "every other behaviour assertion the test made",
  );
  assertStringIncludes(
    instructions,
    "for each removed behaviour assertion, the issue requirement that makes it untrue or the coverage that still proves the behaviour",
  );
  assertStringIncludes(
    instructions,
    'A "how" assertion (rule 2 of **Dummy tests and "how" tests are refused**) that the change breaks is deleted, not re-counted or restored',
  );
  assertStringIncludes(
    instructions,
    "A behaviour assertion removed without one is a blocking self-review finding",
  );
  assertStringIncludes(
    instructions,
    "name the outcome assertions that still prove the behaviour",
  );
});

Deno.test("issue prompt - PR Summary Test Plan requires covering removed assertions", async () => {
  const text = flat(section(await issuePrompt(), "PR Summary File"));

  assertStringIncludes(text, "blocking self-review finding");
  assertStringIncludes(text, "the issue requirement that makes it untrue");
  assertStringIncludes(
    text,
    "this existing entry also covers obsolete call-count and call-order assertions",
  );
});
