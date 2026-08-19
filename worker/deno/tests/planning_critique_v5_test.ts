/**
 * Tests for planning_critique v5 (Issue #3796).
 *
 * v5 closes the eight Claude best-practice gaps the #3772 audit recorded
 * against v4 — the publish half of the draft → critique → publish chain: a
 * milestone-carrying example, worked examples for the two hardest judgements,
 * an XML tag vocabulary, a role sentence, output skeletons, a do-not-stop-early
 * clause with a re-run guard, a duplicate listing of its own, and a no-files
 * bound.
 *
 * v4 stays immutable (Issue #235) and is used here as the negative control:
 * each gap test asserts the defect is present in v4 and absent in v5, so the
 * test fails against the unfixed template.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { buildPlanningCritiquePrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadCritique(version: string): Promise<string> {
  const result = await loadPrompt("planning_critique", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `planning_critique ${version} failed to load`);
  if (!result.ok) throw new Error(`planning_critique ${version} failed`);
  return result.value;
}

const loadV5 = () => loadCritique("v5");

/** Text between two markers, exclusive of the markers. */
function between(body: string, start: string, end: string): string {
  const from = body.indexOf(start);
  const to = body.indexOf(end, from + start.length);
  assertEquals(from >= 0 && to > from, true, `missing ${start} … ${end}`);
  return body.slice(from + start.length, to);
}

// --- Loading contract ---

Deno.test("planning_critique v5 - loads via loadPrompt", async () => {
  assertEquals((await loadV5()).length > 0, true);
});

Deno.test("planning_critique v5 - is the latest version", async () => {
  const result = await getLatestVersion("planning_critique", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 5,
    true,
    `Expected planning_critique >= v5, got ${result.value}`,
  );
});

Deno.test("planning_critique v5 - satisfies the placeholder contract", async () => {
  const v = validatePromptTemplate("planning_critique", await loadV5());
  assertEquals(v.ok, true);
});

// --- Gap 1: be clear and direct (example contradicted the milestone mandate) ---

Deno.test("planning_critique v5 - Gap 1: the canonical example carries the milestone flag", async () => {
  const v4 = await loadCritique("v4");
  const v5 = await loadV5();
  const v4Example = between(v4, "gh issue create --repo", "```\n");
  assertEquals(
    v4Example.includes("--milestone"),
    false,
    "v4's example omitted the flag its own milestone block mandates",
  );
  const v5Example = between(v5, "gh issue create --repo", "```\n");
  assertStringIncludes(v5Example, '--milestone "<milestone>"');
  assertStringIncludes(
    v5,
    "Omit `--milestone` only when no milestone instructions appear above.",
  );
});

Deno.test("planning_critique v5 - Gap 1: the built prompt agrees with itself on the flag", async () => {
  const built = await buildPlanningCritiquePrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Big feature",
    issueBody: "Body",
    issueLabels: "enhancement",
    milestoneTitle: "v2.0",
    draftPlan: "draft",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  const prompt = built.value.prompt;
  // The mandate renders …
  assertStringIncludes(
    prompt,
    'Every sub-issue you create MUST include the `--milestone "<milestone>"` flag',
  );
  // … and the template's own example now obeys it.
  assertStringIncludes(
    prompt,
    '--label "enhancement" --milestone "<milestone>"',
  );
});

// --- Gap 2: use examples effectively ---

Deno.test("planning_critique v5 - Gap 2: Failure Detection verdicts are shown, not just described", async () => {
  const v4 = await loadCritique("v4");
  const v5 = await loadV5();
  assertEquals(v4.includes("<example>"), false, "v4 had no examples");

  const publish = between(v5, '<step name="publish">', "</step>");
  const block = between(publish, "<examples>", "</examples>");
  const count = block.split("<candidate>").length - 1;
  assertEquals(count >= 5, true, `expected >= 5 candidates, got ${count}`);
  assertEquals(
    block.split("<verdict>").length - 1,
    count,
    "every candidate needs one verdict",
  );
  // The three failing shapes the gate would otherwise catch after the fact.
  assertStringIncludes(block, "bare bracketed placeholder");
  assertStringIncludes(block, "no automated surface");
  assertStringIncludes(block, "a console log alone never qualifies");
  // And the two passing shapes.
  assertStringIncludes(block, "N/A — prompt-only change, no runtime surface.");
});

Deno.test("planning_critique v5 - Gap 2: the revision step carries a worked criticism → revision pair", async () => {
  const v5 = await loadV5();
  const step = between(v5, '<step name="revise">', "</step>");
  const block = between(step, "<examples>", "</examples>");
  const count = block.split("<criticism>").length - 1;
  assertEquals(
    count >= 2,
    true,
    `expected >= 2 revision examples, got ${count}`,
  );
  assertEquals(
    block.split("<revision>").length - 1,
    count,
    "every criticism needs one revision",
  );
});

// --- Gap 3: structure prompts with XML tags ---

Deno.test("planning_critique v5 - Gap 3: the three steps and the injected value are tagged", async () => {
  const v4 = await loadCritique("v4");
  const v5 = await loadV5();
  assertEquals(
    v4.includes("<step name="),
    false,
    "v4 was pure Markdown",
  );
  for (const name of ["attack", "revise", "publish"]) {
    assertStringIncludes(v5, `<step name="${name}">`);
  }
  assertEquals(
    v5.split("</step>").length - 1,
    3,
    "every <step> must be closed",
  );
  assertStringIncludes(
    between(v5, "<milestone_instructions>", "</milestone_instructions>"),
    "{{MILESTONE_INSTRUCTIONS}}",
  );
});

Deno.test("planning_critique v5 - Gap 3: the built prompt renders the milestone text inside its tags", async () => {
  const built = await buildPlanningCritiquePrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Big feature",
    issueBody: "Body",
    issueLabels: "enhancement",
    milestoneTitle: "v2.0",
    draftPlan: "draft",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  assertStringIncludes(
    between(
      built.value.prompt,
      "<milestone_instructions>",
      "</milestone_instructions>",
    ),
    "v2.0",
  );
});

// --- Gap 4: give Claude a role ---

Deno.test("planning_critique v5 - Gap 4: opens with an adversarial persona", async () => {
  const v4 = await loadCritique("v4");
  const v5 = await loadV5();
  assertEquals(
    v4.includes("You are an adversarial plan reviewer"),
    false,
    "v4 stated a task, not a role",
  );
  assertStringIncludes(v5, "You are an adversarial plan reviewer.");
  // The persona must precede the draft framing it supports.
  assertEquals(
    v5.indexOf("You are an adversarial plan reviewer") <
      v5.indexOf("do not assume it is correct just because it is yours"),
    true,
    "the role sentence must come first",
  );
});

// --- Gap 5: control the format of responses ---

Deno.test("planning_critique v5 - Gap 5: carries the sub-issue body skeleton with a filled Failure Detection", async () => {
  const v4 = await loadCritique("v4");
  const v5 = await loadV5();
  assertEquals(
    v4.includes("<sub_issue_body_template>"),
    false,
    "v4 described the body in prose only",
  );
  const skeleton = between(
    v5,
    "<sub_issue_body_template>",
    "</sub_issue_body_template>",
  );
  for (
    const heading of [
      "## Summary",
      "## What Needs to Be Done",
      "## Acceptance Criteria",
      "## Failure Detection",
      "## Dependencies",
      "## Context",
    ]
  ) {
    assertStringIncludes(skeleton, heading);
  }
  assertStringIncludes(skeleton, "Part of #{{ISSUE_NUMBER}}");
  // The carried skeleton must model a filled section, not a placeholder the
  // deterministic gate would reject (Issue #3246).
  const failureDetection = between(
    skeleton,
    "## Failure Detection\n",
    "\n\n## Dependencies",
  );
  assertEquals(
    failureDetection.trim().startsWith("["),
    false,
    "the skeleton must show a filled criterion, not a bracketed placeholder",
  );
  assertStringIncludes(failureDetection, "fails in CI");
});

Deno.test("planning_critique v5 - Gap 5: carries a summary-comment skeleton", async () => {
  const v5 = await loadV5();
  assertStringIncludes(v5, "## Plan published");
  assertStringIncludes(v5, "Sub-issues created, in implementation order:");
  assertStringIncludes(v5, "```mermaid");
  assertStringIncludes(v5, "Assumptions:");
});

Deno.test("planning_critique v5 - Gap 5: states the Step 2 acceptance criterion", async () => {
  const v4 = await loadCritique("v4");
  const v5 = await loadV5();
  assertEquals(
    v4.includes("The revision is finished when"),
    false,
    "v4 gave no completion test for the revision",
  );
  const step = between(v5, '<step name="revise">', "</step>");
  assertStringIncludes(step, "The revision is finished when");
  assertStringIncludes(step, "accepted and not worth fixing");
});

// --- Gap 6: long-horizon reasoning and state tracking ---

Deno.test("planning_critique v5 - Gap 6: forbids stopping early and guards a re-run", async () => {
  const v4 = await loadCritique("v4");
  const v5 = await loadV5();
  assertEquals(
    v4.includes("do not stop early"),
    false,
    "v4 said nothing about an unbounded publish sequence",
  );
  assertStringIncludes(v5, "do not stop early");
  assertStringIncludes(v5, "your context is compacted, not exhausted");
  assertStringIncludes(
    v5,
    'gh issue list --repo {{REPO}} --state open --search "Part of #{{ISSUE_NUMBER}}"',
  );
  assertStringIncludes(v5, "skip it rather than creating a duplicate");
});

// --- Gap 7: research and information gathering ---

Deno.test("planning_critique v5 - Gap 7: lists open issues before publishing", async () => {
  const v4 = await loadCritique("v4");
  const v5 = await loadV5();
  assertEquals(
    v4.includes("gh issue list"),
    false,
    "v4 ran no listing of its own",
  );
  const step = between(v5, '<step name="publish">', "</step>");
  assertStringIncludes(
    step,
    "gh issue list --repo {{REPO}} --state open --limit 50",
  );
  assertStringIncludes(step, "added or re-scoped during the revision");
  assertStringIncludes(
    step,
    "reference an existing issue rather than recreating it",
  );
  // The listing must precede the creation it protects.
  assertEquals(
    step.indexOf("gh issue list") < step.indexOf("gh issue create --repo"),
    true,
    "the listing must come before the first gh issue create",
  );
});

// --- Gap 8: reduce file creation in agentic coding ---

Deno.test("planning_critique v5 - Gap 8: bounds the turn's artefacts and forbids stray files", async () => {
  const v4 = await loadCritique("v4");
  const v5 = await loadV5();
  assertEquals(
    v4.includes("Create no files in the working tree"),
    false,
    "v4 never mentioned the working tree",
  );
  assertStringIncludes(
    v5,
    "Your only artefacts are the GitHub issues you create and the summary comment.",
  );
  assertStringIncludes(v5, "Create no files in the working tree");
  assertStringIncludes(v5, "delete it before the turn ends");
});

// --- Behaviour preserved from v4 ---

Deno.test("planning_critique v5 - keeps the bounded single revision pass", async () => {
  const v5 = await loadV5();
  assertStringIncludes(v5, "This is a single revision pass — do not loop.");
  assertStringIncludes(v5, "Do not post the critique anywhere");
});

Deno.test("planning_critique v5 - keeps the zero-sub-issue carrier and inline close", async () => {
  const v5 = await loadV5();
  assertStringIncludes(v5, "Nothing to do — <reason>");
  assertStringIncludes(v5, "one** carrier sub-issue");
  assertStringIncludes(
    v5,
    "gh issue close {{ISSUE_NUMBER}} --repo {{REPO}} --reason completed",
  );
  assertStringIncludes(v5, "{{PLANNING_LABEL}}");
});

Deno.test("planning_critique v5 - keeps the reserved-label constraint", async () => {
  const v5 = await loadV5();
  assertStringIncludes(v5, "`label_security`");
  assertStringIncludes(v5, "`needs-human`");
});

// --- v4 immutability (Issue #235) ---

Deno.test("planning_critique v4 - immutable: still carries none of the v5 fixes", async () => {
  const v4 = await loadCritique("v4");
  for (
    const marker of [
      "<step name=",
      "<examples>",
      "<sub_issue_body_template>",
      "You are an adversarial plan reviewer",
      "gh issue list",
      "Create no files in the working tree",
    ]
  ) {
    assertEquals(
      v4.includes(marker),
      false,
      `v4 must stay immutable — found "${marker}"`,
    );
  }
});
