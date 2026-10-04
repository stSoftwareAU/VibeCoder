/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3224 — fleet PRs relied on a property only their in-repo fake had,
 * not the production implementation they stood in for, e.g.
 * GRQ-AutoTrader#2546, #2460 and #2407.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same "a fake mirrors the production implementation it stands in for" rule,
 * inside the test-coverage section, word for word once wrapping is ignored,
 * sitting after the stub-contract paragraph and before the
 * observe-real-tool paragraph; and the issue prompt's PR Raising
 * Requirements section must require the same in-repo-port discipline for
 * Bugs/Enhancements.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**A fake mirrors the production implementation it stands in for.**";

function fakeMirrorsParagraph(sectionText: string, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the fake-mirrors rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = end >= 0
    ? sectionText.slice(start, end)
    : sectionText.slice(start);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "read the production implementation first and confirm it has that property",
  "which rows a read returns",
  "whether a conditional write can lose",
  "fix whichever side is wrong",
  "one contract test that runs against both",
  "name the production implementation each load-bearing fake stands in for",
  "a fake more permissive than its production implementation is a blocking self-review finding",
];

Deno.test("both surfaces carry the fake-mirrors-production rule (Issue #3224)", async () => {
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
    const paragraph = fakeMirrorsParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the fake-mirrors rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    fakeMirrorsParagraph(standards, "CODING-STANDARDS.md"),
    fakeMirrorsParagraph(guidelines, "coding_guidelines"),
    "the fake-mirrors-production rule must be identical on both surfaces",
  );
});

Deno.test("the fake-mirrors-production rule sits between the stub-contract and observe-real-tool paragraphs (Issue #3224)", async () => {
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
    const fakeIndex = text.indexOf(PARAGRAPH_START);
    const observeIndex = text.indexOf(
      "**Observe the real tool before you rely on it.**",
    );

    assert(stubIndex >= 0, `${surface} is missing the stub-contract rule`);
    assert(
      fakeIndex >= 0,
      `${surface} is missing the fake-mirrors-production rule`,
    );
    assert(
      observeIndex >= 0,
      `${surface} is missing the observe-real-tool rule`,
    );

    assert(
      stubIndex < fakeIndex,
      `${surface}: fake-mirrors-production rule must come after the stub-contract rule`,
    );
    assert(
      fakeIndex < observeIndex,
      `${surface}: fake-mirrors-production rule must come before the observe-real-tool rule`,
    );
  }
});

Deno.test("issue prompt PR Raising Requirements require production-mirroring fakes for Bugs/Enhancements (Issue #3224)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Raising Requirements",
    ),
  );

  assert(
    text.includes(
      "read the production implementation first and confirm it has that property",
    ),
    `PR Raising Requirements is missing the read-production-first requirement: ${text}`,
  );
  assert(
    text.includes(
      "A fake mirrors the production implementation it stands in for",
    ),
    `PR Raising Requirements is missing the back-reference to the guidelines: ${text}`,
  );
  assert(
    text.includes(
      "names the production implementation each load-bearing fake stands in for",
    ),
    `PR Raising Requirements is missing the Evidence naming requirement: ${text}`,
  );
  assert(
    text.includes(
      "a fake more permissive than its production implementation is a blocking self-review finding",
    ),
    `PR Raising Requirements is missing the blocking self-review finding: ${text}`,
  );
});
