/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3120 — fleet PRs' docs and prompts misstated the PR's own new
 * behaviour: a doc said an 8.2 GB tarball "only reappears when the remote
 * symlink moves" when the PR's own code downloads it again whenever the
 * extracted tree is wiped (GRQ#5158); a prompt said a `## Blocked:` heading
 * defers, when the code defers only on a `Depends on`/`Blocked by` line
 * naming an issue it reads as open (VibeCoder#3095); a section said a script
 * "runs automatically" after a fetch that never calls it (GRQ#5153).
 * CODING-STANDARDS.md, the issue prompt's docs-change step and the
 * pr_feedback prompt's Making Changes section must all carry the four-step
 * check: name every condition and path the sentence must cover, require a
 * line of head code for any absolute word, say where a moved cost lands,
 * and check history claims against the base-branch code.
 *
 * Issue #3232 — the absolute-word list missed "every"/"all"/"each" and
 * counted or closed lists, and the rule spoke only of when the behaviour
 * happens and what it costs, not which inputs a scan covers
 * (VibeCoder#3231, VibeCoder#3160, GRQ-AutoTrader#2479). The three surfaces
 * must also carry those words and the "open the code that builds the set"
 * check.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import {
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const STANDARDS_KEY_PHRASES = [
  "Prose about the PR's own change",
  "list every condition and every path",
  "a line of head code that guarantees it",
  "where the cost now lands",
  "checked against the base-branch code",
];

Deno.test("CODING-STANDARDS.md PR Summary and Evidence requires checking claims about the PR's own change (Issue #3120)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "PR Summary and Evidence",
    ),
  );

  for (const phrase of STANDARDS_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `PR Summary and Evidence is missing "${phrase}": ${text}`,
    );
  }
});

const ISSUE_PROMPT_KEY_PHRASES = [
  "Hold prose about this PR's own change to the code that decides it",
  "list every condition and every path in the head code",
  "a line of head code that guarantees it",
  "where the cost now lands",
  "checked against the base-branch code",
  "Prose about the PR's own change",
];

Deno.test("issue prompt docs-change step requires checking claims about the PR's own change (Issue #3120)", async () => {
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

const PR_FEEDBACK_PROMPT_KEY_PHRASES = [
  "Hold prose about this PR's own change to the code that decides it",
  "open the branch condition and the callers behind the sentence",
  "a line of head code that guarantees it",
  "where a moved cost",
  "against the base-branch code",
  "Prose about the PR's own change",
];

Deno.test("pr_feedback prompt Making Changes requires checking claims about the PR's own change (Issue #3120)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  for (const phrase of PR_FEEDBACK_PROMPT_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Making Changes is missing "${phrase}": ${text}`,
    );
  }
});

const STANDARDS_SET_CLAIM_PHRASES = [
  '"every", "all"',
  '"all", "each"',
  "no … is missed",
  "a counted or closed list",
  "X, Y and Z are the …",
  "which inputs",
  "the code that builds the set",
  "VibeCoder#3231",
  "VibeCoder#3160",
  "GRQ-AutoTrader#2479",
  "(Issue #3232)",
];

Deno.test("CODING-STANDARDS.md PR Summary and Evidence holds every/all and closed-list claims to the code that builds the set (Issue #3232)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "PR Summary and Evidence",
    ),
  );

  for (const phrase of STANDARDS_SET_CLAIM_PHRASES) {
    assert(
      text.includes(flatWholeFile(phrase)),
      `PR Summary and Evidence is missing "${phrase}": ${text}`,
    );
  }
});

const ISSUE_PROMPT_SET_CLAIM_PHRASES = [
  '"every", "all"',
  '"all", "each"',
  "no … is missed",
  "a counted or closed list",
  "X, Y and Z are the …",
  "which inputs",
  "the code that builds the set",
];

Deno.test("issue prompt docs-change step holds every/all and closed-list claims to the code that builds the set (Issue #3232)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );

  for (const phrase of ISSUE_PROMPT_SET_CLAIM_PHRASES) {
    assert(
      text.includes(flatWholeFile(phrase)),
      `Instructions is missing "${phrase}": ${text}`,
    );
  }
});

const PR_FEEDBACK_PROMPT_SET_CLAIM_PHRASES = [
  '"every", "all"',
  '"all", "each"',
  "no … is missed",
  "a counted or closed list",
  "X, Y and Z are the …",
  "which inputs",
  "the code that builds the set",
];

Deno.test("pr_feedback prompt Making Changes holds every/all and closed-list claims to the code that builds the set (Issue #3232)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  for (const phrase of PR_FEEDBACK_PROMPT_SET_CLAIM_PHRASES) {
    assert(
      text.includes(flatWholeFile(phrase)),
      `Making Changes is missing "${phrase}": ${text}`,
    );
  }
});
