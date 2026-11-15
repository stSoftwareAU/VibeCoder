/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertPins,
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START = "**A new test must go red without its change.**";

function newTestParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the new-test-must-go-red rule in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "Write and run it before implementing the change",
  "retain that observed TDD result",
  "Do not manufacture a separate code mutation for every test",
  "only pins current behaviour",
  "expected green on base",
];

Deno.test("both surfaces carry the new-test-must-go-red rule (Issue #3093)", async () => {
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
    const paragraph = newTestParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the new-test-must-go-red rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    newTestParagraph(standards, "CODING-STANDARDS.md"),
    newTestParagraph(guidelines, "coding_guidelines"),
    "the new-test-must-go-red rule must be identical on both surfaces",
  );
});

Deno.test("documentation assertions identify the intended rule", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Documentation-drift tests",
    ),
    [
      "Every pinned phrase identifies the intended rule",
      "one new pin can hide a vacuous pin",
      "do not require a baseline run or proof log for every phrase",
    ],
  );
});

Deno.test("super-linearity guard is built from the slow input (Issue #3093)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Unit tests"),
  );

  assert(
    text.includes("build the test from the input shape that was slow"),
    `Unit tests is missing the slow-input-shape requirement: ${text}`,
  );
  assert(
    text.includes("run it against the unfixed pattern"),
    `Unit tests is missing the unfixed-pattern requirement: ${text}`,
  );
});

Deno.test("Choosing assertions points back at the new-test rule (Issue #3093)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
  );

  assert(
    text.includes("would it fail if only that change were removed"),
    `Choosing assertions is missing the back-reference to the new-test rule: ${text}`,
  );
});

Deno.test("feedback requires observed bug regression evidence", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    [
      "For a diagnosed bug",
      "before implementing the fix",
      "Do not claim failure from a changed fake",
      "do not expand a finding into per-line, per-step or per-operand mutation exercises",
    ],
  );
});

Deno.test("issue prompt records TDD for diagnosed bugs without per-test mutations", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "For a bug fix",
      "against unfixed code",
      "Do not require deliberate code breaks",
    ],
  );
});
