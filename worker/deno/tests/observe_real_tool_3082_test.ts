/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3082 — fleet PRs relied on unverified external-tool behaviour, e.g.
 * PR #2939 `git for-each-ref` exiting 0 with a broken-ref warning, PR #2949
 * case-insensitive `gh` labels, PR #3079 `compare` listing base commits a
 * merge brought in while the fake returned only the merge commit.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same "observe the real tool before you rely on it" rule, inside the
 * test-coverage section, word for word once wrapping is ignored, sitting
 * after the stub-contract paragraph and before the workflow-validator
 * paragraph; and the issue prompt's PR Raising Requirements section must
 * require the same observed-fixture discipline for Bugs/Enhancements.
 * Issue #5386 shortened the rule: the test's input is taken from the tool, run
 * in the test where the suite has it, in the production environment; the
 * PR-summary Evidence sentence was retired.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START = "**Observe the real tool before you rely on it.**";

function observeRealToolParagraph(
  sectionText: DocSection,
  what: string,
): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the observe-real-tool rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "prints or returns",
  "take the test's input from the tool, not from what you expect it to be",
  "run the tool in the test where the suite has it",
  "in the environment production gives it",
  "or use output copied from a real run",
  "If the issue names real examples, use them",
  "take it from the tool's documentation or source",
];

const RETIRED_PHRASES = [
  "run the real tool on that case first",
  "in a particular case",
  "give the command you ran and the part of the output the code depends on",
  "Build the fake's fixture from the observed output",
];

Deno.test("both surfaces carry the observe-real-tool rule (Issue #3082)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = observeRealToolParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the observe-real-tool rule: ${paragraph}`,
      );
    }
    for (const phrase of RETIRED_PHRASES) {
      assert(
        !paragraph.includes(phrase),
        `${surface} still carries "${phrase}" in the observe-real-tool rule; Issue #5386 retired it: ${paragraph}`,
      );
    }
  }

  assertEquals(
    observeRealToolParagraph(standards, "CODING-STANDARDS.md"),
    observeRealToolParagraph(guidelines, "coding_guidelines"),
    "the observe-real-tool rule must be identical on both surfaces",
  );
});

Deno.test("the observe-real-tool rule sits between the stub-contract and workflow-validator paragraphs (Issue #3082)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const stubIndex = text.indexOf(
      "**A stub mirrors the real callee's contract.**",
    );
    const observeIndex = text.indexOf(PARAGRAPH_START);
    const workflowIndex = text.indexOf(
      "**A workflow behaviour change extends the workflow validator.**",
    );

    assert(stubIndex >= 0, `${surface} is missing the stub-contract rule`);
    assert(
      observeIndex >= 0,
      `${surface} is missing the observe-real-tool rule`,
    );
    assert(
      workflowIndex >= 0,
      `${surface} is missing the workflow-validator rule`,
    );

    assert(
      stubIndex < observeIndex,
      `${surface}: observe-real-tool rule must come after the stub-contract rule`,
    );
    assert(
      observeIndex < workflowIndex,
      `${surface}: observe-real-tool rule must come before the workflow-validator rule`,
    );
  }
});

Deno.test("issue prompt PR Raising Requirements require observed fixtures for Bugs/Enhancements (Issue #3082)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Raising Requirements",
    ),
  );

  assert(
    text.includes("take the test's input from the tool"),
    `PR Raising Requirements is missing the input-from-the-tool requirement: ${text}`,
  );
  assert(
    text.includes("run the tool in the test where the suite has it"),
    `PR Raising Requirements is missing the run-in-the-test requirement: ${text}`,
  );
  assert(
    text.includes("Observe the real tool before you rely on it"),
    `PR Raising Requirements is missing the back-reference to the guidelines: ${text}`,
  );
  assert(
    text.includes(
      "the behaviour you observed is a blocking self-review finding",
    ),
    `PR Raising Requirements is missing the blocking self-review finding: ${text}`,
  );
  assert(
    !text.includes("The PR summary's Evidence gives the command you ran"),
    `PR Raising Requirements still carries the PR-summary Evidence sentence; Issue #5386 retired it: ${text}`,
  );
});
