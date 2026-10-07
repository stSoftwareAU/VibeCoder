/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3338 — fleet PRs cited a wrong or never-filed issue number as a
 * change's provenance. CODING-STANDARDS.md, the issue prompt and the
 * pr_feedback prompt must state that every issue number cited as provenance
 * was looked up with `gh issue view` in the run, that a follow-up is cited
 * only after it is filed, and that each cited number is listed as
 * `#N: <title>` in the PR summary.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("CODING-STANDARDS.md states the provenance-citation rule in PR Summary and Evidence (Issue #3338)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "PR Summary and Evidence",
    ),
  );

  for (
    const phrase of [
      "An issue number cited as provenance is one you looked up",
      "`_<N>_test.ts` in a test file name",
      "Never cite a follow-up by number before it is filed",
      "file the follow-up with `gh issue create` and cite the number it returns",
      "(`PR #N review`)",
      "as `#N: <title>` in the PR summary's Evidence",
    ]
  ) {
    assert(
      text.includes(phrase),
      `CODING-STANDARDS.md § PR Summary and Evidence is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("issue prompt Instructions section states the provenance-citation rule (Issue #3338)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );

  for (
    const phrase of [
      "An issue number the diff adds as provenance",
      "Never cite a follow-up by number before it is filed",
      "file it with `gh issue create` and cite the number it returns",
      "as `#N: <title>` in the PR summary's Evidence",
    ]
  ) {
    assert(
      text.includes(phrase),
      `issue prompt § Instructions is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("pr_feedback prompt Making Changes section states the provenance-citation rule (Issue #3338)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  for (
    const phrase of [
      "An issue number you cite as provenance is one you looked up",
      "Never cite a follow-up by number before it is filed",
      "(`PR #{{PR_NUMBER}} review`)",
      "as `#N: <title>` in the PR summary's Evidence",
    ]
  ) {
    assert(
      text.includes(phrase),
      `pr_feedback prompt § Making Changes is missing "${phrase}": ${text}`,
    );
  }
});
