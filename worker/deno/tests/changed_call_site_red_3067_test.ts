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

const PARAGRAPH_START =
  "**Every changed call site needs a test that goes red without it.**";

function changedCallSiteParagraph(
  sectionText: DocSection,
  what: string,
): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the changed-call-site rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "real production entry points affected by the change",
  "Existing direct or indirect coverage counts",
  "fake replacing the production default",
  "Do not revert every caller or run automatic mutation checks",
];

Deno.test("both surfaces carry the changed-call-site-must-go-red rule (Issue #3067)", async () => {
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
    const paragraph = changedCallSiteParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the changed-call-site rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    changedCallSiteParagraph(standards, "CODING-STANDARDS.md"),
    changedCallSiteParagraph(guidelines, "coding_guidelines"),
    "the changed-call-site rule must be identical on both surfaces",
  );
});

Deno.test("Choosing assertions' Units bullet points back at the changed-call-site rule (Issue #3067)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
  );

  assert(
    text.includes("does not cover its callers' wiring"),
    `Choosing assertions is missing the back-reference: ${text}`,
  );
});

Deno.test("issue prompt reviews actual affected entry-point coverage", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "actual affected entry points",
      "existing coverage and a visual check may suffice for a presentation change",
      "Do not require deliberate code breaks",
    ],
  );
});
