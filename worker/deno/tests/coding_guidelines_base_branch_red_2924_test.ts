/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #2924 — fleet runs claimed bug fixes whose regression test went red
 * only against the PR's own modified fake/fixture and passed on the base
 * branch, while others changed durable formats or production behaviour on an
 * unverified diagnosis. CODING-STANDARDS.md and the coding_guidelines prompt
 * must both carry the same base-branch-red rule, inside the test-coverage
 * section, word for word once wrapping is ignored.
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

const PARAGRAPH_START = "**A red run counts only against the base branch.**";

function redRunParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the base-branch-red rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "base-branch production code",
  "test doubles",
  "proves nothing",
  "durable format",
  "undiagnosed or already fixed",
  "logged error line",
  "quote the line",
];

Deno.test("both surfaces carry the base-branch-red rule (Issue #2924)", async () => {
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
    const paragraph = redRunParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the base-branch-red rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    redRunParagraph(standards, "CODING-STANDARDS.md"),
    redRunParagraph(guidelines, "coding_guidelines"),
    "the base-branch-red rule must be identical on both surfaces",
  );
});
