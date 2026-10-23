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
 * carry the checklist: an evasion table run both ways, a corpus
 * run reporting false-positive and false-negative counts, no silent pass on
 * unread input, and comparing like with like. Issue #3313 adds the pointer
 * to the shared Markdown code-span helper so a gate over Markdown never
 * pairs backticks with a per-line regex. Issue #3696 adds a fifth point:
 * reading the worker's own marker out of a body that also holds agent text
 * is a gate over text, read only at the anchored position or after
 * neutralisation. Issue #3929 widens the trigger to any text a matcher reads,
 * including config and CI workflow files (YAML, JSON, TOML), where the matcher
 * must read the structure rather than one physical line or only the line
 * above; the corpus run names the policed files at base and head first; and
 * the issue prompt's gate-over-text bullet is self-contained for repos other
 * than VibeCoder.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import {
  assertPins,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

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

Deno.test("CODING-STANDARDS.md Writing a gate over text matches Markdown prose per logical unit (Issue #3356)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Writing a gate over text",
    ),
  );

  for (
    const phrase of [
      "markdownLogicalUnits",
      "never per physical line",
      "splits the matched phrase or claim itself across a line break",
      "a real wrapped shape from the corpus",
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

Deno.test("CODING-STANDARDS.md Writing a gate over text treats reading the worker's own marker as a gate (Issue #3696)", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Writing a gate over text",
    ),
    [
      "Reading the worker's own marker is a gate over text",
      "extractLeadingSection",
      "neutraliseAgentMarkers",
      "Never use `includes()` or a first-occurrence match over such a mixed body",
      "quoting the marker in a code span and in plain prose after the summary heading",
      "re-wrapping the worker does",
    ],
  );
});

Deno.test("issue prompt gate-over-text bullet covers reading the worker's own marker (Issue #3696)", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
    [
      "Reading the worker's own marker out of a body that also holds agent, issue or comment text is such a gate",
      "only at the anchored position where the worker writes it",
      "never with `includes()` or a first-occurrence match over the whole body",
      "after the worker re-wraps the body",
    ],
  );
});

Deno.test("CODING-STANDARDS.md Writing a gate over text covers config and CI workflow files and the policed-files corpus (Issue #3929)", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Writing a gate over text",
    ),
    [
      "any text a matcher reads",
      "config or CI workflow file (YAML, JSON, TOML)",
      "reads the structure, not one physical line or only the line above",
      "Run the matcher over every file it polices, as it stands on the base branch and at head",
      "report each line the fix changes on the base copy, for every reason the PR's docs say it checks",
      "Then add the other corpora where they apply",
    ],
  );
});

Deno.test("issue prompt gate-over-text bullet is self-contained for repos other than VibeCoder (Issue #3929)", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
    [
      "any text a matcher reads",
      "config or CI workflow files (YAML, JSON, TOML)",
      "https://github.com/stSoftwareAU/VibeCoder/blob/main/CODING-STANDARDS.md#writing-a-gate-over-text",
      "re-wrapped across lines",
      "every file the matcher polices, as it stands on the base branch and at head",
      "report each line the fix changes on the base copy",
    ],
  );
});
