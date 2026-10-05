/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3235 — fleet PRs tested config read by an external tool against an
 * in-repo stand-in for that tool's engine, not the tool itself.
 * stSoftwareAU/TagsTS#93's hand-written glob matcher never matched `*`
 * before `/`, so `milestone/foo` failed a star-slash-star branch filter
 * GitHub accepts; TagsTS#98 compiled a Renovate `matchStrings` look-ahead with
 * JavaScript's `RegExp`, which accepts it, while Renovate's RE2 rejects the
 * whole config.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same "a test of a third-party tool's input uses that tool's semantics"
 * rule, inside the test-coverage section, word for word once wrapping is
 * ignored, sitting after the fake-mirrors-production paragraph and before
 * the observe-real-tool paragraph; and the workflow-validator paragraph on
 * both surfaces must link to it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  DocSection,
  excerpt,
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const FAKE_MIRRORS_START =
  "**A fake mirrors the production implementation it stands in for.**";
const PARAGRAPH_START =
  "**A test of a third-party tool's input uses that tool's semantics.**";
const OBSERVE_REAL_TOOL_START =
  "**Observe the real tool before you rely on it.**";
const WORKFLOW_VALIDATOR_START =
  "**A workflow behaviour change extends the workflow validator.**";

function paragraphAt(
  sectionText: DocSection,
  start: string,
  what: string,
): string {
  const index = sectionText.indexOf(start);
  assert(index >= 0, `could not locate "${start}" in ${what}`);
  const end = sectionText.indexOf("\n\n", index);
  const paragraph = end >= 0
    ? excerpt(sectionText, index, end)
    : excerpt(sectionText, index);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "run the test through it",
  "cases taken from the tool's documentation",
  "the exact case the change relies on",
  "at least one input the tool rejects or does not match",
  "Name that documentation in the PR summary",
  "a test passes on input the tool rejects or fails on input it accepts, is a blocking self-review finding",
];

function surfaces(): Promise<
  readonly [
    readonly ["CODING-STANDARDS.md", DocSection],
    readonly ["coding_guidelines", DocSection],
  ]
> {
  return Promise.all([
    readRepoDoc("CODING-STANDARDS.md").then(
      (text) =>
        [
          "CODING-STANDARDS.md",
          section(text, "Test coverage expectations"),
        ] as const,
    ),
    readRepoDoc("prompts/coding_guidelines/prompt.md").then(
      (text) =>
        [
          "coding_guidelines",
          section(text, "Test Coverage Expectations"),
        ] as const,
    ),
  ]);
}

Deno.test("both surfaces carry the third-party-tool-semantics rule (Issue #3235)", async () => {
  const [standards, guidelines] = await surfaces();

  for (const [surface, text] of [standards, guidelines] as const) {
    const paragraph = paragraphAt(text, PARAGRAPH_START, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(flatWholeFile(phrase)),
        `${surface} is missing "${phrase}" from the third-party-tool-semantics rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    paragraphAt(standards[1], PARAGRAPH_START, standards[0]),
    paragraphAt(guidelines[1], PARAGRAPH_START, guidelines[0]),
    "the third-party-tool-semantics rule must be identical on both surfaces",
  );
});

Deno.test("the third-party-tool-semantics rule sits between the fake-mirrors-production and observe-real-tool paragraphs (Issue #3235)", async () => {
  const [standards, guidelines] = await surfaces();

  for (const [surface, text] of [standards, guidelines] as const) {
    const fakeIndex = text.indexOf(FAKE_MIRRORS_START);
    const newIndex = text.indexOf(PARAGRAPH_START);
    const observeIndex = text.indexOf(OBSERVE_REAL_TOOL_START);

    assert(fakeIndex >= 0, `${surface} is missing the fake-mirrors rule`);
    assert(
      newIndex >= 0,
      `${surface} is missing the third-party-tool-semantics rule`,
    );
    assert(
      observeIndex >= 0,
      `${surface} is missing the observe-real-tool rule`,
    );

    assert(
      fakeIndex < newIndex,
      `${surface}: third-party-tool-semantics rule must come after the fake-mirrors rule`,
    );
    assert(
      newIndex < observeIndex,
      `${surface}: third-party-tool-semantics rule must come before the observe-real-tool rule`,
    );
  }
});

Deno.test("the workflow-validator paragraph links to the third-party-tool-semantics rule on both surfaces (Issue #3235)", async () => {
  const [standards, guidelines] = await surfaces();

  for (const [surface, text] of [standards, guidelines] as const) {
    const paragraph = paragraphAt(text, WORKFLOW_VALIDATOR_START, surface);
    assert(
      paragraph.includes(
        flatWholeFile(
          "A validator that emulates GitHub's glob or expression semantics " +
            "is also held to **A test of a third-party tool's input uses " +
            "that tool's semantics**",
        ),
      ),
      `${surface} workflow-validator paragraph is missing the back-reference: ${paragraph}`,
    );
  }
});
