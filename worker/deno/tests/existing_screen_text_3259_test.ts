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
 * that already exists. Issue #5411 retired the screen inventory ("list every
 * message the screen already renders") and the Test Plan list of messages
 * checked: the rule now follows the new case to each place that shows, posts
 * or prints something for it.
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

/** Phrases every live copy of the rule must carry. */
const RULE_PHRASES = [
  TRIGGER,
  ...TRIGGER_EXAMPLES,
  "a new state on a screen that already exists",
  "follow the new case to each place that shows, posts or prints something for it",
  "hide or mark any text that is false or misleading for the new case",
  "a test that puts the new case through and asserts each text that differs for it",
  "Pre-existing text left unchanged that is false or misleading for the new case is a blocking self-review finding",
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

  const keyPhrases = RULE_PHRASES;
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
  for (const phrase of RULE_PHRASES) {
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
    ...RULE_PHRASES,
  ];
  for (const phrase of keyPhrases) {
    assert(
      text.includes(phrase),
      `Instructions section is missing "${phrase}": ${text}`,
    );
  }
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

/** Phrases of the screen inventory and Test Plan list retired by Issue #5411. */
const RETIRED_PHRASES = [
  "the screen already renders",
  "messages checked in the PR summary's Test Plan",
  "rendered-screen counterpart",
  "each marked still true or changed for the new state",
];

Deno.test("the retired screen inventory and Test Plan list are absent from the live copies (Issue #5411)", async () => {
  for (const path of LIVE_COPIES) {
    const text = flatWholeFile(await readRepoDoc(path));
    for (const phrase of RETIRED_PHRASES) {
      assertFalse(
        text.includes(phrase),
        `${path} still carries the retired phrase "${phrase}"`,
      );
    }
  }
});
