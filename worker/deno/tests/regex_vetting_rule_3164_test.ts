/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3164 — PRs #3085 and #3160 each added a hostile test for the one
 * regex the author had in mind while a sibling regex in the same module,
 * reading the same untrusted text, shipped with the same quadratic-backtrack
 * shape (two quantifiers that can match the same characters with only
 * optional tokens between them). The fix is a prompt rule, not code: vet
 * every regex that reads untrusted or agent-written text, one hostile case
 * per pattern, not one per module.
 *
 * This pins that rule in the four surfaces that carry it — the coding
 * standard, the shared coding-guidelines prompt, the pr_feedback prompt's
 * "fix the defect everywhere it lives" rule, and the pr-feedback operator
 * manual — so a later edit that drops or waters down the wording fails here
 * rather than silently.
 *
 * Uses Australian English spelling (behaviour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("CODING-STANDARDS Unit tests pins the regex-vetting rule before the super-linearity bullet (Issue #3164)", async () => {
  const unitTests = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Unit tests",
  );
  const text = flat(unitTests).toLowerCase();

  for (
    const phrase of [
      "vet every regex that reads untrusted text",
      "one hostile case per pattern",
      "only optional tokens between them",
      "a parser with several patterns needs a case for each",
      "a lone `\\r`",
    ]
  ) {
    assert(
      text.includes(phrase),
      `CODING-STANDARDS.md Unit tests is missing "${phrase}": ${text}`,
    );
  }

  const vetIndex = text.indexOf("vet every regex that reads untrusted text");
  const guardIndex = text.indexOf("guard super-linearity by behaviour first");
  assert(vetIndex >= 0, "could not locate the regex-vetting bullet");
  assert(guardIndex >= 0, "could not locate the super-linearity bullet");
  assert(
    vetIndex < guardIndex,
    "the regex-vetting bullet must come before 'guard super-linearity by behaviour first'",
  );
});

Deno.test("coding_guidelines prompt Unit Tests vs Benchmarks pins the regex-vetting rule (Issue #3164)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Unit Tests vs Benchmarks",
    ),
  ).toLowerCase();

  for (
    const phrase of [
      "vet every regex that reads untrusted text",
      "one hostile case per pattern",
      "only optional tokens between them",
      "a parser with several patterns needs a case for each",
    ]
  ) {
    assert(
      text.includes(phrase),
      `coding_guidelines prompt is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("pr_feedback prompt Making Changes checks every other regex in the module (Issue #3164)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  ).toLowerCase();

  assert(
    text.includes(
      "for a backtracking or quadratic regex finding, check every other regex in the same module for the same shape",
    ),
    `pr_feedback prompt Making Changes is missing the regex-vetting sentence: ${text}`,
  );
});

Deno.test("pr-feedback operator manual pins the Issue #3164 regex-vetting rule", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/workflows/pr-feedback.md"),
      "Fix the defect everywhere it lives",
    ),
  ).toLowerCase();

  for (
    const phrase of [
      "issue #3164",
      "checks every other regex in the same module",
    ]
  ) {
    assert(
      text.includes(phrase),
      `pr-feedback.md operator manual is missing "${phrase}": ${text}`,
    );
  }
});
