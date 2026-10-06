/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3067 — fleet PRs threaded a new argument through several production
 * callers and tested only one, so reverting an untested caller's change left
 * the suite green. CODING-STANDARDS.md and the coding_guidelines prompt must
 * both carry the same "every changed call site needs a test that goes red
 * without it" rule, inside the test-coverage section, word for word once
 * wrapping is ignored; the "Choosing assertions" section's Units bullet must
 * point back to it; and the issue prompt's Test Plan step must require
 * reverting each changed call site and seeing a test go red.
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
  "revert only that caller's change",
  "confirm at least one test goes red",
  "does not count for that path",
  "blocking self-review finding",
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

Deno.test("issue prompt Test Plan step requires reverting each changed call site (Issue #3067)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes("goes red when only that caller's change is reverted"),
    `PR Summary File section is missing the red-run requirement: ${text}`,
  );
  assert(
    text.includes(
      "a changed call site whose revert leaves the suite green is a blocking self-review finding",
    ),
    `PR Summary File section is missing the green-without-revert finding: ${text}`,
  );
});
