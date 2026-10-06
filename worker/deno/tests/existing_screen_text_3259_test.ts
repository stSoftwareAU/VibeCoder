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
 * CODING-STANDARDS.md and the issue prompt must both carry the "a new state
 * on an existing screen re-reads that screen's existing text" rule, and the
 * issue prompt's Test Plan step must require listing the messages checked.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import {
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**A new state on an existing screen re-reads that screen's existing text.**";

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
    "list every message the screen already renders",
    "say whether it is still true in the new state",
    "reword it, hide it or mark it",
    "Add a test that renders the new state",
    "is a blocking self-review finding",
    "List the messages checked in the PR summary's Test Plan",
  ];
  for (const phrase of keyPhrases) {
    assert(
      paragraph.includes(phrase),
      `CODING-STANDARDS.md is missing "${phrase}" from the existing-screen-text rule: ${paragraph}`,
    );
  }
});

Deno.test("issue prompt Instructions carry the existing-screen-text rule (Issue #3259)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );

  const keyPhrases = [
    "A new state on an existing screen re-reads that screen's existing text.",
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
    text.includes("re-reads that screen's existing text"),
    `PR Summary File section is missing the existing-screen-text requirement: ${text}`,
  );
  assert(
    text.includes("each marked still true or changed for the new state"),
    `PR Summary File section is missing the per-message marking requirement: ${text}`,
  );
});
