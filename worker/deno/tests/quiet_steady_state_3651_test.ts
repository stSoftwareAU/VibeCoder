/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3651 — VibeCoder#3065 and VibeCoder#3640 added per-cycle scan steps
 * that re-ran, re-posted or rewrote on every cycle when nothing had changed.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same "quiet at steady state" rule, the standards must name both past
 * regressions, and the guidelines copy must sit in the core layer after the
 * re-fire rule.
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

const RULE_START = "**A per-cycle step is quiet at steady state.**";
const REFIRE_RULE_START =
  "**Automation that creates fleet work must not re-fire on its own output.**";
const SECOND_PASS = "**Test the second pass**";
const GUIDELINES_LAYER_MARKER = "<!-- guidelines-layer: code -->";
const STANDARDS_TITLE = "Automation and Shared GitHub State";
const GUIDELINES_TITLE = "Human Escalation";

const KEY_PHRASES = [
  "must do nothing observable on a pass where nothing it depends on has changed",
  "no GitHub write (an edit, comment, marker or label)",
  "no repeated WARNING",
  "no uncached per-item read whose count grows with the open items",
  "Quiet is not silent about a fault",
  "**Compare before writing**",
  "the PR is no longer OPEN",
  "**Record that an action ran**",
  "a failure that records nothing re-runs on the next cycle",
  "**Gate expensive reads on a change signal**",
  "`updatedAt` or a head SHA",
  "run the step twice over unchanged mocked GitHub state",
  "the second pass issues no write and no repeat of the action",
];

/**
 * The quiet-at-steady-state rule: from its bold opening up to the end of the
 * "Test the second pass" bullet, which is the next blank line after that
 * bullet.
 */
function quietRule(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(RULE_START);
  assert(
    start >= 0,
    `could not locate the quiet-at-steady-state rule in ${what}`,
  );
  const bullet = sectionText.indexOf(SECOND_PASS, start);
  assert(
    bullet >= 0,
    `could not locate the "Test the second pass" bullet in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", bullet);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

Deno.test("both surfaces carry the quiet-at-steady-state rule (Issue #3651)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    STANDARDS_TITLE,
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    GUIDELINES_TITLE,
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const rule = quietRule(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        rule.includes(phrase),
        `${surface} is missing "${phrase}" from the quiet-at-steady-state rule: ${rule}`,
      );
    }
  }
});

Deno.test("the standards name both past regressions (Issue #3651)", async () => {
  const standards = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), STANDARDS_TITLE),
  );

  assert(
    standards.includes("VibeCoder#3065, at the head reviewed (`6e564bd8`)"),
    `the standards do not name VibeCoder#3065 at the head reviewed (\`6e564bd8\`): ${standards}`,
  );
  assert(
    standards.includes("VibeCoder#3640, at the head reviewed (`459e991e`)"),
    `the standards do not name VibeCoder#3640 at the head reviewed (\`459e991e\`): ${standards}`,
  );
  assert(
    standards.includes("`isConflictAttemptDue`"),
    `the standards do not name the \`isConflictAttemptDue\` regression: ${standards}`,
  );
  assert(
    standards.includes("`gh pr edit --body`"),
    `the standards do not name the \`gh pr edit --body\` regression: ${standards}`,
  );
});

Deno.test("the guidelines copy sits in the core layer after the re-fire rule (Issue #3651)", async () => {
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    GUIDELINES_TITLE,
  );

  const refire = guidelines.indexOf(REFIRE_RULE_START);
  const quiet = guidelines.indexOf(RULE_START);
  const marker = guidelines.indexOf(GUIDELINES_LAYER_MARKER);

  assert(
    refire >= 0,
    `Human Escalation is missing the re-fire rule "${REFIRE_RULE_START}"`,
  );
  assert(
    quiet >= 0,
    `Human Escalation is missing the quiet-at-steady-state rule "${RULE_START}"`,
  );
  assert(
    marker >= 0,
    `Human Escalation is missing the "${GUIDELINES_LAYER_MARKER}" marker`,
  );
  assert(
    refire < quiet,
    "the quiet-at-steady-state rule must follow the re-fire rule in Human Escalation",
  );
  assert(
    quiet < marker,
    "the quiet-at-steady-state rule must sit before the guidelines-layer code marker",
  );
});
