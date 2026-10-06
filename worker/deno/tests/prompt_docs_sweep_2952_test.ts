/**
 * Tests for the removal-aware docs sweep (Issue #2952).
 *
 * Fleet PRs that removed or changed behaviour left docs/ manuals stale
 * because the docs step only covered additions — "update README.md or other
 * documentation if your changes ... add new features" never told agents to
 * check for stale wording describing behaviour that no longer exists. The
 * `issue` (and `pr_feedback`) templates now require a removal-aware docs
 * sweep before committing, and a one-line **Docs sweep** entry in the PR
 * summary recording the grep terms and the doc files updated (or `no hits`).
 *
 * The assertions run against the current template, so a later edit that
 * drops the rule fails in CI.
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

/** The flattened, lowercased text of one heading's section of a doc. */
async function scoped(doc: string, title: string): Promise<string> {
  return flat(section(await readRepoDoc(doc), title)).toLowerCase();
}

Deno.test("issue - step 3 owes a docs change for additions, changes and removals", async () => {
  const body = await scoped("prompts/issue/prompt.md", "Instructions");

  for (
    const required of [
      "adds, changes or removes",
      "a code change owes a docs change",
      "excluding `docs/archive/`",
      "`*/readme.md`",
      "user-visible wording",
      "fix every hit",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("issue - PR summary requires a Docs sweep line", async () => {
  const body = await scoped("prompts/issue/prompt.md", "PR Summary File");

  assertStringIncludes(body, "**docs sweep**");
  assertStringIncludes(body, "`no hits`");
});

Deno.test("pr_feedback - a fix runs the same docs sweep", async () => {
  const body = await scoped("prompts/pr_feedback/prompt.md", "Making Changes");

  for (
    const required of [
      "adds, changes or removes",
      "a code change owes a docs change",
      "excluding `docs/archive/`",
      "user-visible wording",
      "**docs sweep**",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});
