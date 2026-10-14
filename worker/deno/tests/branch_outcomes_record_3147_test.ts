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
 * Issue #3538 re-scoped these pins without deleting them: the agent now
 * records the enumeration as structured facts in
 * `docs/archive/pr-summaries/pr-summary-<N>.facts.json` (or `"noneAdded":
 * true`) and leaves a `<!-- vibe-branch-outcomes -->` marker in the Test Plan
 * for the worker to render, so the `Branch outcomes:` prose list survives only
 * as the fallback when there is no facts file. The schema is documented once,
 * in CODING-STANDARDS.md (`**Branch outcomes facts file.**`); the guidelines
 * surface only points at it; the issue prompt's skeleton carries the marker in
 * place of the old `**Branch outcomes:**` heading; and the pr_feedback prompt
 * keeps the facts file true to the head.
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
  "pr-summary-<N>.facts.json",
  "<!-- vibe-branch-outcomes -->",
  "noneAdded",
  "Branch outcomes facts file",
];

Deno.test("both surfaces record the branch-outcome enumeration as structured facts with a Branch outcomes: fallback (Issues #3147, #3538)", async () => {
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

Deno.test("CODING-STANDARDS.md documents the facts-file schema once; the guidelines only point at it (Issue #3538)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );
  const start = standards.indexOf("**Branch outcomes facts file.**");
  assert(start >= 0, "CODING-STANDARDS.md has no facts-file schema paragraph");
  const end = standards.indexOf("\n\n", start);
  const schema = flat(excerpt(standards, start, end >= 0 ? end : undefined));

  for (
    const phrase of [
      "flipWentRed",
      "testName",
      "exempt",
      "out-of-scope",
      "untestable",
      "at least 3 words",
      "100,000",
      "4,000",
      "blocks",
      "With no facts file",
    ]
  ) {
    assert(
      schema.includes(phrase),
      `facts-file schema paragraph is missing "${phrase}": ${schema}`,
    );
  }

  const pointer = flat(guidelines);
  assert(
    pointer.includes("**Branch outcomes facts file**"),
    "coding_guidelines does not reference the facts-file schema",
  );
  assert(
    !pointer.includes("**Branch outcomes facts file.**"),
    "coding_guidelines must not carry the schema paragraph (documented once)",
  );
});

Deno.test("issue prompt Test Plan step names the Branch outcomes: list, the facts file and the gate (Issues #3147, #3538)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  for (
    const phrase of [
      "Branch outcomes:",
      "Branch outcomes: none added",
      "the worker blocks PR creation without the facts file or that line",
      "pr-summary-{{ISSUE_NUMBER}}.facts.json",
      "<!-- vibe-branch-outcomes -->",
      "noneAdded",
      "flipWentRed",
      "exempt",
    ]
  ) {
    assert(
      text.includes(phrase),
      `PR Summary File section is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("issue prompt skeleton carries the branch-outcomes marker in its Test Plan, not a Branch outcomes: heading (Issue #3538)", async () => {
  const body = section(
    await readRepoDoc("prompts/issue/prompt.md"),
    "PR Summary File",
  );
  const planStart = body.indexOf("## Test Plan");
  assert(planStart >= 0, "issue prompt skeleton has no '## Test Plan' area");
  const marker = body.indexOf("<!-- vibe-branch-outcomes -->", planStart);
  assert(
    marker >= 0,
    "issue prompt skeleton's Test Plan is missing the <!-- vibe-branch-outcomes --> marker",
  );
  assert(
    !flat(body).includes("**Branch outcomes:**"),
    "issue prompt skeleton still carries the old **Branch outcomes:** heading",
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
      "facts file",
      "pr-summary-<N>.facts.json",
      "true to the head",
    ]
  ) {
    assert(
      flattened.includes(phrase),
      `pr_feedback prompt is missing "${phrase}": ${flattened}`,
    );
  }
});
