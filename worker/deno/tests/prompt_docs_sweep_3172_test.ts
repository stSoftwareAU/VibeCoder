/**
 * Tests for the Docs sweep re-run guidance (Issue #3172).
 *
 * Fleet PRs passed the docs-sweep gate with hits of their own declared grep
 * terms still stating removed behaviour — a missed inflection
 * ("replaced or removed" against a grep for "replaces or removes") or a
 * second passage in a file the sweep listed as updated. The `issue`
 * template now asks for stem greps, a re-run on the final head, and every
 * remaining hit recorded as `file:line — still true because …`, and says the
 * worker re-runs the terms itself. A hit outside the lines the diff changed
 * and not named by the line is advisory only (Issue #3237): the worker posts
 * it once as a PR comment for the reviewer and never blocks the PR on it.
 *
 * The assertions run against the current template, so a later edit that
 * drops the rule fails in CI.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

/** The docs-sweep rule for the `issue` template lives in `## Instructions`. */
async function scoped(doc: string, title: string): Promise<string> {
  return flat(section(await readRepoDoc(doc), title)).toLowerCase();
}

Deno.test("issue - docs sweep greps the stem of a behavioural claim", async () => {
  const body = await scoped("prompts/issue/prompt.md", "Instructions");
  assertStringIncludes(body, "grep for the **stem** of a behavioural claim");
  assertStringIncludes(body, "replac\\w* or remov\\w*");
});

Deno.test("issue - docs sweep is re-run on the final head and each remaining hit is recorded", async () => {
  const body = await scoped("prompts/issue/prompt.md", "Instructions");
  assertStringIncludes(body, "on the final head, after editing");
  assertStringIncludes(body, "file:line — still true because");
});

Deno.test("issue - docs sweep reads every passage in a file it lists as updated", async () => {
  const body = await scoped("prompts/issue/prompt.md", "Instructions");
  assertStringIncludes(
    body,
    "in every file you list as updated, read every passage that mentions the changed surface",
  );
});

Deno.test("issue - the template says the worker re-runs the line's quoted terms", async () => {
  const body = await scoped("prompts/issue/prompt.md", "Instructions");
  assertStringIncludes(body, "the worker re-runs the line's quoted terms");
});

Deno.test("issue - a stale hit is advisory, not a block (Issue #3237)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );
  assertStringIncludes(text, "The worker re-runs the line's quoted terms");
  assertStringIncludes(text, "and over the comment lines of its source files");
  assertStringIncludes(
    text,
    "is posted as an advisory PR comment for the reviewer and does not " +
      "block the PR",
  );
  assertEquals(
    text.includes("blocks the PR the same way a missing line does"),
    false,
  );
});

Deno.test("CODING-STANDARDS.md - a stale hit is advisory, not a block (Issue #3237)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "PR Summary and Evidence",
    ),
  );
  assertStringIncludes(text, "the worker re-runs the line's quoted terms");
  assertStringIncludes(text, "and the comment lines of its source files");
  assertStringIncludes(
    text,
    "posts a hit outside the diff that the line does not name as an " +
      "advisory PR comment for the reviewer",
  );
  assertEquals(text.includes("refuses a hit outside the diff"), false);
});

Deno.test("issue-processing.md - a stale hit is advisory, not a block (Issue #3237)", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/workflows/issue-processing.md"),
      "Docs sweep on a code change",
    ),
  );
  assertStringIncludes(
    text,
    "Any other hit is advisory (Issue #3237",
  );
  assertStringIncludes(
    text,
    "posted once, as a PR comment for the reviewer",
  );
  assertStringIncludes(
    text,
    "It never blocks the summary and triggers no recovery turn",
  );
  assertStringIncludes(
    text,
    "are otherwise advisory too: posted once as a PR comment and logged at " +
      "WARN, never blocking and never triggering a recovery turn",
  );
  assertEquals(
    text.includes("through the same single in-run recovery turn"),
    false,
  );
  assertEquals(text.includes("block through the same recovery turn"), false);
});
