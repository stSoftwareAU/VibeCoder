/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3455 — three private fleet PRs added a production prop or field that
 * only tests read or set, so the tests checked the member instead of what a
 * user or caller sees. The "nothing exists only for a test to read" paragraph
 * must be on both CODING-STANDARDS.md and the coding_guidelines prompt, in
 * their testing sections, word for word once wrapping is ignored. Issue #4992
 * rewrote the check so the code that declares or fills a member is not a use,
 * and members whose last production caller the diff removes are checked too.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
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

const LEAD = "**Nothing exists only for a test to read.**";

function ruleParagraph(sectionText: DocSection): DocSection {
  const start = sectionText.indexOf(LEAD);
  assert(start >= 0, "could not locate the production-reader paragraph");
  const end = sectionText.indexOf("\n\n", start);
  return excerpt(sectionText, start, end >= 0 ? end : undefined);
}

Deno.test("both surfaces carry the production-reader rule, identical, in their testing sections (Issue #3455)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test-Driven Development (TDD)",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Testing Best Practices",
  );

  for (const text of [standards, guidelines]) {
    assertPins(text, [LEAD]);
    assertPins(ruleParagraph(text), [
      "only a test uses does not belong in production code",
      "the returned value, the error message, the rendered text",
      "inject through a seam the code already has",
      "The code that declares, fills or defaults the member is not a use",
      "`git grep -n -w <name>`",
      "whose production caller the diff removes or replaces",
      "counts as a production caller",
      "Do not filter with `':!*test*'`",
      "Remove a test-only member and move the assertion onto what production does with it",
      "explicitly asks for as public API",
    ]);
  }

  const here = standards.indexOf(LEAD);
  const item5 = standards.indexOf(
    "5. Do NOT write tests that grep source files",
  );
  const examples = standards.indexOf("### Examples");
  assert(item5 >= 0 && item5 < here, "must follow numbered item 5");
  assert(examples >= 0 && here < examples, "must precede ### Examples");

  const guidelinesHere = guidelines.indexOf(LEAD);
  const grepRule = guidelines.indexOf("rather than faking a test with grep.");
  assert(
    grepRule >= 0 && grepRule < guidelinesHere,
    "must follow the grep rule in Testing Best Practices",
  );

  assertEquals(
    flat(ruleParagraph(standards)).trim(),
    flat(ruleParagraph(guidelines)).trim(),
    "the production-reader rule must be identical on both surfaces",
  );
});
