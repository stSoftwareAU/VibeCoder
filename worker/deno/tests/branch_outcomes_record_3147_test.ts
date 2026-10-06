/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3147 — the branch-outcome rule (Issue #3069) stayed prose: fleet PRs
 * kept shipping a new branch no test reached, and review-fix runs closed out
 * an untested-branch finding by adding only the test it named while their
 * own rework opened new untested branches of its own (GRQ-AutoTrader#2368),
 * or named a test that did not exist (VibeCoder#3132). CODING-STANDARDS.md
 * and the coding_guidelines prompt must both now require the enumeration to
 * be recorded as a `Branch outcomes:` list in the PR summary's Test Plan (or
 * `Branch outcomes: none added`); the issue prompt's Test Plan step must name
 * that list and say the worker blocks PR creation without it; the issue
 * prompt's skeleton summary must carry a `Branch outcomes:` example; and the
 * pr_feedback prompt must require a fix to re-enumerate every branch its own
 * commits add and refresh the list.
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

function branchOutcomeParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the branch-outcome rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const RECORD_KEY_PHRASES = [
  "writes or refreshes a PR summary",
  "Branch outcomes:",
  "Branch outcomes: none added",
  "re-enumerates every branch its own commits add",
];

Deno.test("both surfaces record the branch-outcome enumeration as a Branch outcomes: list (Issue #3147)", async () => {
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
    const paragraph = branchOutcomeParagraph(text, surface);
    for (const phrase of RECORD_KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the branch-outcome rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    branchOutcomeParagraph(standards, "CODING-STANDARDS.md"),
    branchOutcomeParagraph(guidelines, "coding_guidelines"),
    "the branch-outcome rule must still be identical on both surfaces",
  );
});

Deno.test("issue prompt Test Plan step names the Branch outcomes: list and its gate (Issue #3147)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  for (
    const phrase of [
      "Branch outcomes:",
      "Branch outcomes: none added",
      "the worker blocks PR creation without that line",
    ]
  ) {
    assert(
      text.includes(phrase),
      `PR Summary File section is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("issue prompt skeleton summary carries a Branch outcomes: example (Issue #3147)", async () => {
  const flattened = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    flattened.includes("**Branch outcomes:**"),
    "issue prompt skeleton is missing a Branch outcomes: example",
  );
});

Deno.test("pr_feedback prompt requires re-enumerating every branch a fix commit adds (Issue #3147)", async () => {
  const flattened = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  for (
    const phrase of [
      "A fix re-enumerates the branches it adds",
      "re-running the branch-outcome enumeration",
      "every branch the fix commit itself adds",
      "Refresh the summary's",
      "Branch outcomes:",
      "every test it names must exist at the head",
    ]
  ) {
    assert(
      flattened.includes(phrase),
      `pr_feedback prompt is missing "${phrase}": ${flattened}`,
    );
  }
});
