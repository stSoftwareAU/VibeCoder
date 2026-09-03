/**
 * Tests for the issue prompt's independent review (Issue #663).
 *
 * The `## Acceptance Criteria` closure block asks the right three questions,
 * but it used to be answered by the agent that wrote the code, in the context
 * that produced it — which is why the template had to counter-steer in wording
 * ("do not inflate a status"). Issue #663 solved it structurally, as
 * `skills/engineering/code-review/SKILL.md` in mattpocock/skills does: an
 * independent Spec reviewer sub-agent judges the criteria from the diff and the
 * issue body alone, an independent Standards reviewer judges the diff against
 * `CODING-STANDARDS.md`, and the two are reported under separate headings —
 * never merged, never reranked across axes.
 *
 * The assertions run against the current `issue` template, so a later edit
 * that drops the two reviewers fails in CI.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { validateIndependentReview } from "../lib/independent_review_gate.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadIssue(): Promise<string> {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(result.ok, true, "issue failed to load");
  if (!result.ok) throw new Error("issue failed to load");
  return result.value;
}

function lower(text: string): string {
  return text.toLowerCase();
}

Deno.test("issue - keeps the placeholders and the existing gated blocks", async () => {
  const text = await loadIssue();
  for (
    const required of [
      "{{VERBOSITY_INSTRUCTIONS}}",
      "{{QUALITY_INSTRUCTIONS}}",
      "{{ISSUE_NUMBER}}",
      "{{REPO}}",
      "## Reproduction",
      "## Acceptance Criteria",
      "`verified`",
      "`not-run`",
      "red-capable",
      "vibe-already-resolved",
      "docs/archive/pr-summaries/pr-summary-{{ISSUE_NUMBER}}.md",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

Deno.test("issue - dispatches an independent reviewer for each axis", async () => {
  const text = await loadIssue();
  const body = lower(text);

  // Two reviewers, dispatched in parallel, before the summary is written.
  assertStringIncludes(body, "spec reviewer");
  assertStringIncludes(body, "standards reviewer");
  assertStringIncludes(body, "in parallel");
  assertStringIncludes(text, "git diff <base>...HEAD");
  assertStringIncludes(text, "CODING-STANDARDS.md");
  // Independence is the point: the reviewer never sees the author's context.
  assertStringIncludes(body, "implementation transcript");
});

Deno.test("issue - asks the Spec reviewer all three questions", async () => {
  const body = lower(await loadIssue());

  assertStringIncludes(body, "missing or partial");
  assertStringIncludes(body, "was not asked");
  assertStringIncludes(body, "implemented wrongly");
});

Deno.test("issue - keeps the two axes on separate headings", async () => {
  const text = await loadIssue();
  const body = lower(text);

  assertStringIncludes(text, "## Standards Review");
  assert(
    body.includes("never merge or rerank") || body.includes("never merged"),
    "the template must forbid merging or reranking the two axes",
  );
  // The worst issue is named within each axis, not one winner across both.
  assertStringIncludes(body, "within each axis");
});

Deno.test("issue - records who judged the criteria, and any departure", async () => {
  const text = await loadIssue();
  const body = lower(text);

  assertStringIncludes(text, "vibe-spec-review");
  assertStringIncludes(text, "vibe-standards-review");
  assertStringIncludes(text, "reviewer: met");
  // Departing from the reviewer is allowed, but only out loud.
  assertStringIncludes(body, "only out loud");
  assertStringIncludes(body, "never fabricate a verdict");
});

Deno.test("issue - carves the two reviewers out of the delegation cap", async () => {
  const body = lower(await loadIssue());

  assertStringIncludes(body, "delegate sparingly");
  assertStringIncludes(body, "two agents, not a");
});

Deno.test("issue - the shape it prescribes passes the live gate", async () => {
  const text = await loadIssue();

  // The worked example the prompt tells the run to copy must satisfy the gate
  // that blocks PR creation — the prompt and the gate cannot drift apart.
  const start = text.indexOf("## Acceptance Criteria\n\n<!-- vibe-spec-review");
  assert(
    start > -1,
    "the template must carry a worked Acceptance Criteria block",
  );
  const example = text.slice(start);

  const result = validateIndependentReview({
    issueBody: [
      "## Acceptance Criteria",
      "",
      "- [ ] buttons align on mobile",
      "- [ ] the tablet breakpoint is covered",
    ].join("\n"),
    prSummaryContent: example,
  });
  assertEquals(result.problems, []);
  assertEquals(result.valid, true);
});
