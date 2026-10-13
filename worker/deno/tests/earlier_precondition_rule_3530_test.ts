/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3530 — fleet PRs (VibeCoder#3388, #3522) added an earlier
 * precondition (a git repository, a verified commit identity) and existing
 * negative tests silently stopped reaching the guard they pin.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same "a new precondition must not stop existing tests short" rule, inside
 * the test-coverage section, word for word once wrapping is ignored.
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
  "**A new precondition must not stop existing tests short.**";
const REFUSAL_PARAGRAPH_START =
  "**A refusal test must be refused by the rule it names.**";

function preconditionParagraph(
  sectionText: DocSection,
  what: string,
): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the earlier-precondition rule in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "a git repository, a git identity, a config value, the network or the clock",
  "confirm each one still reaches the logic it asserts on",
  "they stay green when the path is skipped",
  "A test that now stops at the new precondition is a blocking self-review finding",
  "add a positive control: an assertion that the precondition holds",
  "the same fixture with only the probed value changed reaching the other outcome",
  "names the existing tests that needed fixture changes, or says that none did",
];

Deno.test("both surfaces carry the earlier-precondition rule (Issue #3530)", async () => {
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
    const paragraph = preconditionParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the earlier-precondition rule: ${paragraph}`,
      );
    }

    const refusal = text.indexOf(REFUSAL_PARAGRAPH_START);
    assert(
      refusal >= 0,
      `could not locate the refusal-test rule in ${surface}`,
    );
    assert(
      text.indexOf(PARAGRAPH_START) > refusal,
      `${surface} must place the earlier-precondition rule after the refusal-test rule`,
    );
  }

  assertEquals(
    preconditionParagraph(standards, "CODING-STANDARDS.md"),
    preconditionParagraph(guidelines, "coding_guidelines"),
    "the earlier-precondition rule must be identical on both surfaces",
  );
});
