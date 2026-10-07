/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3149 — fleet PRs have shipped text gates whose matchers miss a
 * realistic variant of the thing they exist to catch, or fire on a
 * look-alike they should ignore, while input they cannot handle is skipped
 * and the gate still reports a clean pass. VibeCoder#3148 counted a
 * commented-out assertion as "moved" because its text was a substring of an
 * added block; VibeCoder#3132 recognised only column-0 fences; VibeCoder#3134
 * skipped every non-matching closure entry with `continue`, including the
 * `partial`/`missing` entries that were the run's own evidence of a gap; and
 * VibeCoder#3157 counted `Deno.test(` inside string literals and
 * `Deno.test.ignore` declarations, flagging correct Test Plan counts as
 * stale. CODING-STANDARDS.md and the issue prompt's Instructions must both
 * carry the four-point checklist: an evasion table run both ways, a corpus
 * run reporting false-positive and false-negative counts, no silent pass on
 * unread input, and comparing like with like. Issue #3313 adds the pointer
 * to the shared Markdown code-span helper so a gate over Markdown never
 * pairs backticks with a per-line regex.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const STANDARDS_KEY_PHRASES = [
  "Evasion table",
  "Run the table both ways",
  "Corpus run",
  "false-positive and false-negative counts",
  "No silent pass on unread input",
  "never a clean",
  "Compare like with like",
  "Normalise both sides of a comparison",
];

Deno.test("CODING-STANDARDS.md carries the Writing a gate over text checklist (Issue #3149)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Writing a gate over text",
    ),
  );

  for (const phrase of STANDARDS_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Writing a gate over text is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("CODING-STANDARDS.md Writing a gate over text points at the shared Markdown code-span helper (Issue #3313)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Writing a gate over text",
    ),
  );

  for (
    const phrase of [
      "markdown_code_spans.ts",
      "never pairs backticks with a per-line regex",
    ]
  ) {
    assert(
      text.includes(phrase),
      `Writing a gate over text is missing "${phrase}": ${text}`,
    );
  }
});

const ISSUE_PROMPT_KEY_PHRASES = [
  "A gate over text catches the variants and never passes what it skipped",
  "Writing a gate over text",
  "evasion test per realistic variant",
  "false-positive and false-negative counts",
  "never a clean pass",
  "normalised the same way",
];

Deno.test("issue prompt testing step points at Writing a gate over text (Issue #3149)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );

  for (const phrase of ISSUE_PROMPT_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Instructions is missing "${phrase}": ${text}`,
    );
  }
});
