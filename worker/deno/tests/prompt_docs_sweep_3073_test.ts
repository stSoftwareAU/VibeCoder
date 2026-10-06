/**
 * Tests for the manual-section docs sweep (Issue #3073).
 *
 * Fleet PRs still left the manual for the changed surface stale: the grep
 * terms were internal identifiers that missed prose, hits were dismissed by
 * the file's topic without reading the sentence, and a behaviour change that
 * kept every name had nothing to grep, so the manual still described the old
 * behaviour. The `issue` and `pr_feedback` templates now also require
 * finding the manual section that documents the changed surface by its own
 * name, reading it through, and naming that section in the **Docs sweep**
 * line. The `issue` template additionally gates PR creation on that line
 * being present.
 *
 * The assertions run against the current template, so a later edit that
 * drops the rule fails in CI.
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

async function scoped(doc: string, title: string): Promise<string> {
  return flat(section(await readRepoDoc(doc), title)).toLowerCase();
}

Deno.test("issue - docs sweep also finds the manual section by the surface's own name", async () => {
  const body = await scoped("prompts/issue/prompt.md", "Instructions");

  for (
    const required of [
      "manual section",
      "surface's own name",
      "read that section through",
      "never by the file's topic",
      "section:",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("issue - worker gates PR creation on the Docs sweep line", async () => {
  const body = await scoped("prompts/issue/prompt.md", "Instructions");

  assertStringIncludes(body, "worker will not raise the pr without that line");
  assertStringIncludes(body, "a second miss fails the run");
});

Deno.test("pr_feedback - docs sweep also finds the manual section by the surface's own name", async () => {
  const body = await scoped("prompts/pr_feedback/prompt.md", "Making Changes");

  for (
    const required of [
      "manual section",
      "surface's own name",
      "read that section through",
      "never by the file's topic",
      "section:",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});
