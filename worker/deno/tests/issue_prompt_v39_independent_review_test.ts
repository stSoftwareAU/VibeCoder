/**
 * Tests for issue prompt v39 (Issue #663).
 *
 * v38's `## Acceptance Criteria` closure block asks the right three questions
 * but is answered by the agent that wrote the code, in the context that
 * produced it — which is why v38 had to counter-steer in wording ("do not
 * inflate a status"). v39 solves it structurally, as
 * `skills/engineering/code-review/SKILL.md` in mattpocock/skills does: an
 * independent Spec reviewer sub-agent judges the criteria from the diff and the
 * issue body alone, an independent Standards reviewer judges the diff against
 * `CODING-STANDARDS.md`, and the two are reported under separate headings —
 * never merged, never reranked across axes.
 *
 * v38 stays immutable and is the negative control.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import { validateIndependentReview } from "../lib/independent_review_gate.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadIssue(version: string): Promise<string> {
  const result = await loadPrompt("issue", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `issue ${version} failed to load`);
  if (!result.ok) throw new Error(`issue ${version} failed to load`);
  return result.value;
}

const loadV38 = () => loadIssue("v38");
const loadV39 = () => loadIssue("v39");

function lower(text: string): string {
  return text.toLowerCase();
}

Deno.test("issue v39 - is the version the worker resolves", async () => {
  const latest = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;
  assertEquals(latest.value, "v39");

  const [byName, byVersion] = await Promise.all([
    loadPrompt("issue", undefined, PROMPTS_DIR),
    loadPrompt("issue", "v39", PROMPTS_DIR),
  ]);
  assertEquals(byName.ok, true);
  assertEquals(byVersion.ok, true);
  if (byName.ok && byVersion.ok) {
    assertEquals(byName.value, byVersion.value);
  }
});

Deno.test("issue v39 - keeps the placeholders and the existing gated blocks", async () => {
  const v39 = await loadV39();
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
    assertStringIncludes(v39, required);
  }
});

Deno.test("issue v39 - dispatches an independent reviewer for each axis", async () => {
  const [v38, v39] = await Promise.all([loadV38(), loadV39()]);
  const body = lower(v39);

  // Two reviewers, dispatched in parallel, before the summary is written.
  assertStringIncludes(body, "spec reviewer");
  assertStringIncludes(body, "standards reviewer");
  assertStringIncludes(body, "in parallel");
  assertStringIncludes(v39, "git diff <base>...HEAD");
  assertStringIncludes(v39, "CODING-STANDARDS.md");
  // Independence is the point: the reviewer never sees the author's context.
  assertStringIncludes(body, "implementation transcript");

  assertEquals(lower(v38).includes("spec reviewer"), false);
});

Deno.test("issue v39 - asks the Spec reviewer all three questions", async () => {
  const body = lower(await loadV39());

  assertStringIncludes(body, "missing or partial");
  assertStringIncludes(body, "was not asked");
  assertStringIncludes(body, "implemented wrongly");
});

Deno.test("issue v39 - keeps the two axes on separate headings", async () => {
  const [v38, v39] = await Promise.all([loadV38(), loadV39()]);
  const body = lower(v39);

  assertStringIncludes(v39, "## Standards Review");
  assert(
    body.includes("never merge or rerank") || body.includes("never merged"),
    "v39 must forbid merging or reranking the two axes",
  );
  // The worst issue is named within each axis, not one winner across both.
  assertStringIncludes(body, "within each axis");

  assertEquals(lower(v38).includes("## standards review"), false);
});

Deno.test("issue v39 - records who judged the criteria, and any departure", async () => {
  const v39 = await loadV39();
  const body = lower(v39);

  assertStringIncludes(v39, "vibe-spec-review");
  assertStringIncludes(v39, "vibe-standards-review");
  assertStringIncludes(v39, "reviewer: met");
  // Departing from the reviewer is allowed, but only out loud.
  assertStringIncludes(body, "only out loud");
  assertStringIncludes(body, "never fabricate a verdict");
});

Deno.test("issue v39 - carves the two reviewers out of the delegation cap", async () => {
  const body = lower(await loadV39());

  assertStringIncludes(body, "delegate sparingly");
  assertStringIncludes(body, "two agents, not a");
});

Deno.test("issue v39 - the shape it prescribes passes the live gate", async () => {
  const v39 = await loadV39();

  // The worked example the prompt tells the run to copy must satisfy the gate
  // that blocks PR creation — the prompt and the gate cannot drift apart.
  const start = v39.indexOf("## Acceptance Criteria\n\n<!-- vibe-spec-review");
  assert(start > -1, "v39 must carry a worked Acceptance Criteria block");
  const example = v39.slice(start);

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
