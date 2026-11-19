/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3253 — fleet PRs wired a new argument into some callers and missed
 * one hidden by a do-nothing default or a hard-coded old value:
 * VibeCoder#3251 gave `recoverAndFinaliseExistingPr` a
 * `docsSweepHitsComment = ""` parameter that `reportSummaryRuleBlock` never
 * passed; GRQ-AutoTrader#2282 added `RunOrigin` but every production caller
 * hard-coded `RunOrigin::Scheduled`; and VibeCoder#3095 fixed two of three
 * declared hand-off outcomes and left `handOffToPlanning` unchanged.
 * Issue #5205 replaced the long caller-inventory and PR-summary caller-list
 * obligations with a shorter rule: behaviour the issue requires is carried
 * through affected production callers, constructors and recovery paths;
 * required behaviour inputs are explicit in the type; and the entry points are
 * judged by their observable behaviour. CODING-STANDARDS.md and the
 * coding_guidelines prompt must both carry that rule, inside the test-coverage
 * section, word for word once wrapping is ignored; the issue prompt's Test
 * Plan step must carry the same wording. This test pins that wording and the
 * retirement of the caller list on all three surfaces.
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
  "**A new argument or behaviour reaches every caller that needs it.**";

function callerReachParagraph(
  sectionText: DocSection,
  what: string,
): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the caller-reach rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "through affected production callers and constructors, including recovery paths",
  "explicit in the type rather than silently disabled by an omitted parameter or field",
  "Where absence is intentional, preserve that contract",
  "Every changed call site needs a test that goes red without it",
  "direct helper coverage alone does not establish production wiring",
];

const RETIRED_PHRASES = [
  "list every caller and sibling first",
  "state in the PR summary why that caller does not need it",
  "List the callers and siblings checked in the PR summary",
];

Deno.test("both surfaces carry the caller-reach rule (Issues #3253, #5205)", async () => {
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
    const paragraph = callerReachParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the caller-reach rule: ${paragraph}`,
      );
    }
    for (const phrase of RETIRED_PHRASES) {
      assert(
        !paragraph.includes(phrase),
        `${surface} still carries the retired "${phrase}": ${paragraph}`,
      );
    }
  }

  assertEquals(
    callerReachParagraph(standards, "CODING-STANDARDS.md"),
    callerReachParagraph(guidelines, "coding_guidelines"),
    "the caller-reach rule must be identical on both surfaces",
  );
});

Deno.test("issue prompt Test Plan step carries the short caller-reach rule and retires the caller list (Issue #5205)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  for (
    const phrase of [
      "reaches the affected production callers and constructors, including recovery paths",
      "not by direct helper coverage alone",
    ]
  ) {
    assert(
      text.includes(phrase),
      `PR Summary File section is missing "${phrase}": ${text}`,
    );
  }
  for (
    const phrase of [
      "list the callers and siblings checked",
      "reaches every caller and sibling route that needs it",
    ]
  ) {
    assert(
      !text.includes(phrase),
      `PR Summary File section still carries the retired "${phrase}": ${text}`,
    );
  }
});
