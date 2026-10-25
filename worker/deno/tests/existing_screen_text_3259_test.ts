/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3259 — fleet UI PRs added a state to an existing screen and left its
 * existing notes/empty state/badges stating the old state:
 * GRQ-AutoTrader#2560 added "Load older decisions" paging to Activity, and
 * its empty state still read "Nothing happened in this period." above the
 * load-older control; GRQ-AutoTrader#2615 added an earlier-date mode to
 * Scores, and every row still drew today's live `CurrentStars` badge beside
 * that date's stars, while the unreadable-decisions note still said rows
 * "may read as not evaluated" where every row read "Not considered".
 * CODING-STANDARDS.md and the issue prompt must both carry the "a new case
 * re-reads the text it now reaches" rule: a change sends a new case to text
 * that already exists. The issue prompt's Test Plan step must require
 * listing the messages checked.
 *
 * The old heading must not sit beside the new one. These four live copies
 * are checked for its absence; the historical PR summary
 * `docs/archive/pr-summaries/pr-summary-3259.md` is not one of them.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertFalse } from "@std/assert";
import {
  type DocSection,
  excerpt,
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

/** Heading retired by Issue #4198. Absence is over the whole live copy. */
const OLD_HEADING =
  "A new state on an existing screen re-reads that screen's existing text";

/**
 * Live copies of the rule. The archived PR summary is omitted on purpose:
 * it records the wording the original change shipped with.
 */
const LIVE_COPIES = [
  "CODING-STANDARDS.md",
  "prompts/coding_guidelines/prompt.md",
  "prompts/issue/prompt.md",
  "docs/workflows/issue-processing.md",
] as const;

const PARAGRAPH_START = "**A new case re-reads the text it now reaches.**";

const TRIGGER = "a change sends a new case to text that already exists";

const TRIGGER_EXAMPLES = [
  "a widened condition",
  "a new arm or allowed value",
  "a newly called function or component",
];

function existingScreenTextParagraph(
  sectionText: DocSection,
  what: string,
): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the existing-screen-text rule in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

Deno.test("CODING-STANDARDS carries the existing-screen-text rule (Issue #3259)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );

  const paragraph = existingScreenTextParagraph(
    standards,
    "CODING-STANDARDS.md",
  );

  const keyPhrases = [
    TRIGGER,
    ...TRIGGER_EXAMPLES,
    "list every message the screen already renders",
    "say whether it is still true in the new state",
    "reword it, hide it or mark it",
    "Add a test that renders the new state",
    "A pre-existing message left unchanged that is false or misleading in the new state is a blocking self-review finding",
    "List the messages checked in the PR summary's Test Plan",
  ];
  for (const phrase of keyPhrases) {
    assert(
      paragraph.includes(phrase),
      `CODING-STANDARDS.md is missing "${phrase}" from the existing-screen-text rule: ${paragraph}`,
    );
  }
});

// The injected twin is the only surface pr_feedback, ci_fix, merge_conflict
// and custom_pr runs in a fleet repo ever see (review of PR #3283).
Deno.test("the injected coding_guidelines twin carries the existing-screen-text rule (Issue #3259)", async () => {
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );
  const paragraph = existingScreenTextParagraph(
    guidelines,
    "coding_guidelines",
  );
  for (
    const phrase of [
      TRIGGER,
      ...TRIGGER_EXAMPLES,
      "list every message the screen already renders",
      "say whether it is still true in the new state",
      "reword it, hide it or mark it",
      "Add a test that renders the new state",
      "A pre-existing message left unchanged that is false or misleading in the new state is a blocking self-review finding",
      "List the messages checked in the PR summary's Test Plan",
    ]
  ) {
    assert(
      paragraph.includes(phrase),
      `coding_guidelines is missing "${phrase}" from the existing-screen-text rule: ${paragraph}`,
    );
  }
});

Deno.test("issue prompt Instructions carry the existing-screen-text rule (Issue #3259)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );

  const keyPhrases = [
    "A new case re-reads the text it now reaches.",
    TRIGGER,
    ...TRIGGER_EXAMPLES,
    "list every message the screen already renders",
    "add a test that renders the new state",
    "A pre-existing message left unchanged that is false or misleading in the new state is a blocking self-review finding",
  ];
  for (const phrase of keyPhrases) {
    assert(
      text.includes(phrase),
      `Instructions section is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("issue prompt Test Plan step lists the messages checked (Issue #3259)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes("re-reads the text it now reaches"),
    `PR Summary File section is missing the reached-text requirement: ${text}`,
  );
  assert(
    text.includes(TRIGGER),
    `PR Summary File section is missing the new-case trigger: ${text}`,
  );
  assert(
    text.includes("each marked still true or changed for the new state"),
    `PR Summary File section is missing the per-message marking requirement: ${text}`,
  );
  assertFalse(
    text.includes("re-reads that screen's existing text"),
    `PR Summary File section still carries the old heading phrase: ${text}`,
  );
});

Deno.test("the old existing-screen heading is absent from the live copies (Issue #4198)", async () => {
  for (const path of LIVE_COPIES) {
    const text = flatWholeFile(await readRepoDoc(path));
    assertFalse(
      text.includes(OLD_HEADING),
      `${path} still carries the old heading "${OLD_HEADING}"`,
    );
  }
});
