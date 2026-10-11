/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3376 — fleet PRs flipped a compound condition (`a || b`, `a && b`, a
 * chained `?:`) as one outcome, by reverting the whole change or deleting the
 * whole condition, so one operand went untested or was cited with a test that
 * reached only the other (VibeCoder#3079, VibeCoder#3372). CODING-STANDARDS.md
 * and the coding_guidelines prompt must both carry the same per-operand rule
 * word for word once wrapping is ignored; the issue prompt's Test Plan step,
 * the pr_feedback re-enumeration rule and the issue-processing manual must
 * each carry it too.
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
  "**Every outcome of a branch you add needs a test that reaches it.**";

function branchParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the branch-outcome rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  return flat(excerpt(sectionText, start, end >= 0 ? end : undefined)).trim();
}

const KEY_PHRASES = [
  "one outcome per operand",
  "flip each operand on its own",
  "does not show which operand a test reaches",
  "names the operand it covers",
];

Deno.test("both surfaces carry the compound-condition rule (Issue #3376)", async () => {
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
    const paragraph = branchParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the branch-outcome rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    branchParagraph(standards, "CODING-STANDARDS.md"),
    branchParagraph(guidelines, "coding_guidelines"),
    "the branch-outcome rule must be identical on both surfaces",
  );
});

Deno.test("issue prompt Test Plan step flips each operand on its own (Issue #3376)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );
  for (
    const phrase of [
      "Each operand of a compound condition",
      "its flip deletes that operand alone",
    ]
  ) {
    assert(
      text.includes(phrase),
      `PR Summary File section is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("pr_feedback re-enumeration names each operand (Issue #3376)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );
  const phrase = "with that operand alone deleted";
  assert(
    text.includes(phrase),
    `Making Changes section is missing "${phrase}": ${text}`,
  );
});

Deno.test("issue-processing manual records the compound-condition rule (Issue #3376)", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/workflows/issue-processing.md"),
      "Reproduction status on a bug fix",
    ),
  );
  const phrase = "Each operand of a compound condition is its own outcome";
  assert(
    text.includes(phrase),
    `issue-processing section is missing "${phrase}": ${text}`,
  );
});
