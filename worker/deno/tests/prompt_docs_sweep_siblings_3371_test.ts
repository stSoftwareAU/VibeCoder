/**
 * Tests for the sibling-member docs sweep (Issue #3371).
 *
 * The #3137 rule that adding a member owes a docs change was prose only: the
 * Docs sweep lines of GRQ-AutoTrader#2460, #2481, #2682 and #2792 grepped only
 * the new member's name, which is in no doc yet, so the doc listing the set
 * stayed one short. The Docs sweep line now carries a `siblings:` part naming
 * the existing sibling members grepped for each set the change adds a member
 * to, or `siblings: none — <why>`. The `issue`, `pr_feedback` and
 * `coding_guidelines` templates and CODING-STANDARDS.md say so, and the gate
 * refuses a line without that part. The assertions run against the current
 * documents, so a later edit that drops the rule fails in CI.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { validateDocsSweep } from "../lib/docs_sweep_gate.ts";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const ISSUE_PROMPT = "prompts/issue/prompt.md";

/** The flattened text of one heading's section of a doc. */
async function scoped(doc: string, title: string): Promise<string> {
  return flat(section(await readRepoDoc(doc), title));
}

Deno.test("issue - Instructions names the siblings part of the Docs sweep line (Issue #3371)", async () => {
  const body = await scoped(ISSUE_PROMPT, "Instructions");

  assertStringIncludes(body, "siblings:");
  assertStringIncludes(body, "siblings: none —");
});

Deno.test("issue - PR Summary File names the siblings part of the Docs sweep line (Issue #3371)", async () => {
  const body = await scoped(
    ISSUE_PROMPT,
    "PR Summary File — docs/archive/pr-summaries/pr-summary-ISSUE.md",
  );

  assertStringIncludes(body, "siblings:");
  assertStringIncludes(body, "siblings: none —");
});

Deno.test("CODING-STANDARDS.md - the docs-change rule names the siblings part (Issue #3371)", async () => {
  const body = await scoped(
    "CODING-STANDARDS.md",
    "A Code Change Owes a Docs Change",
  );

  assertStringIncludes(body, "siblings:");
});

Deno.test("coding_guidelines - the docs-change rule names the siblings part (Issue #3371)", async () => {
  const body = await scoped(
    "prompts/coding_guidelines/prompt.md",
    "A Code Change Owes a Docs Change",
  );

  assertStringIncludes(body, "siblings:");
});

Deno.test("pr_feedback - Making Changes names the siblings part (Issue #3371)", async () => {
  const body = await scoped("prompts/pr_feedback/prompt.md", "Making Changes");

  assertStringIncludes(body, "siblings:");
});

Deno.test("issue - every Docs sweep example in PR Summary File passes the gate (Issue #3371)", async () => {
  const body = section(
    await readRepoDoc(ISSUE_PROMPT),
    "PR Summary File — docs/archive/pr-summaries/pr-summary-ISSUE.md",
  );

  const lineExamples = body.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("**Docs sweep**"));
  const inlineExample = body.match(
    /e\.g\. (\*\*Docs sweep\*\* — grep:[^\n]*)/,
  )?.[1];

  assert(
    lineExamples.length > 0,
    "no line starting with **Docs sweep** in PR Summary File",
  );
  assert(
    inlineExample !== undefined,
    "no inline e.g. **Docs sweep** — grep: example in PR Summary File",
  );

  for (const prSummaryContent of [...lineExamples, inlineExample]) {
    const result = validateDocsSweep({
      changedFiles: ["worker/deno/lib/x.ts"],
      prSummaryContent,
    });
    assertEquals(
      result.valid,
      true,
      `the gate refuses the documented example: ${prSummaryContent}`,
    );
  }
});
