/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3061 — a fleet PR editing an existing test for an issue-required
 * change dropped assertions the issue never touched, which were still true;
 * a green gate before and after did not prove nothing was lost. Both the
 * coding standards and the issue prompt must keep the "Change only what the
 * issue changes" rule: edit only the expectation the issue changes, keep
 * every other assertion, and name the issue requirement that makes each
 * removed assertion untrue, or treat its removal as a blocking self-review
 * finding.
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
  assertStringIncludes(text, "an issue requirement that makes it untrue");
  assertStringIncludes(text, "blocking self-review finding");
});

Deno.test("issue prompt - Instructions keep the change-only-what-the-issue-changes rule", async () => {
  const instructions = flat(section(await issuePrompt(), "Instructions"));

  assertStringIncludes(instructions, "Change only what the issue changes");
  assertStringIncludes(
    instructions,
    "the issue requirement that makes it untrue",
  );
});

Deno.test("issue prompt - PR Summary Test Plan requires covering removed assertions", async () => {
  const text = flat(section(await issuePrompt(), "PR Summary File"));

  assertStringIncludes(
    text,
    "the issue requirement that makes it untrue",
  );
  assertStringIncludes(text, "blocking self-review finding");
});
