/**
 * Tests for placeholder substitution in prompt_builder.ts (Issue #3813).
 *
 * Covers three of the six audited gaps:
 *
 *   Gap 1 — `{{REPO}}` was absent from the issue builder's replacement map, so
 *           every issue prompt shipped three literal `{{REPO}}` tokens and the
 *           escape-hatch `gh` commands were unfollowable.
 *   Gap 2 — `substitute()` shipped an unmatched placeholder silently, which is
 *           how Gap 1 survived. It now fails loud.
 *   Gap 6 — a classification with no matched signals is rendered as weak
 *           evidence the run may reasonably deviate from.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCiFixPrompt,
  buildIssuePrompt,
  buildPlanningCritiquePrompt,
  buildPlanningPrompt,
  buildPrFeedbackPrompt,
  buildQuestionPrompt,
  buildSpellingFixPrompt,
  buildWorkflowSetupPrompt,
  formatCiFailureClassification,
} from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Any `{{PLACEHOLDER}}` token left unrendered in an assembled prompt. */
const LEFTOVER_PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]*\}\}/g;

function assertNoLeftoverPlaceholders(prompt: string, label: string): void {
  const leftovers = prompt.match(LEFTOVER_PLACEHOLDER) ?? [];
  assertEquals(
    leftovers,
    [],
    `${label} rendered unfilled placeholder(s): ${leftovers.join(", ")}`,
  );
}

// =============================================================================
// Gap 1 + Gap 2: every builder renders with no placeholder left behind
// =============================================================================

Deno.test("every builder renders with no unfilled placeholder", async () => {
  const built: Array<[string, string]> = [];

  const issue = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Title",
    issueBody: "Body",
    issueLabels: "enhancement",
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(issue.ok, true);
  if (issue.ok) built.push(["issue", issue.value.prompt]);

  const planning = await buildPlanningPrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Title",
    issueBody: "Body",
    issueLabels: "planning",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(planning.ok, true);
  if (planning.ok) built.push(["planning", planning.value.prompt]);

  const critique = await buildPlanningCritiquePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Title",
    issueBody: "Body",
    issueLabels: "planning",
    draftPlan: "Draft plan text",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(critique.ok, true);
  if (critique.ok) built.push(["planning_critique", critique.value.prompt]);

  const question = await buildQuestionPrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "How does X work?",
    issueBody: "Explain X.",
    issueLabels: "question",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(question.ok, true);
  if (question.ok) built.push(["question", question.value.prompt]);

  const feedback = await buildPrFeedbackPrompt({
    repo: "owner/repo",
    prNumber: "7",
    commentBody: "Please fix this.",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(feedback.ok, true);
  if (feedback.ok) built.push(["pr_feedback", feedback.value.prompt]);

  const spelling = await buildSpellingFixPrompt({
    repo: "owner/repo",
    prNumber: "7",
    checkName: "cspell",
    annotationDetails: "Misspelled: behaviur",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(spelling.ok, true);
  if (spelling.ok) built.push(["spelling_fix", spelling.value.prompt]);

  const ciFix = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "7",
    checkName: "ci/test",
    annotationDetails: "Test failed",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(ciFix.ok, true);
  if (ciFix.ok) built.push(["ci_fix", ciFix.value.prompt]);

  const workflow = await buildWorkflowSetupPrompt({
    repo: "owner/repo",
    languages: "TypeScript",
    missingWorkflows: "codeql.yml",
    defaultBranch: "main",
    existingWorkflows: "lint.yml",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(workflow.ok, true);
  if (workflow.ok) built.push(["workflow_setup", workflow.value.prompt]);

  assertEquals(built.length, 8, "every builder must have produced a prompt");
  for (const [label, prompt] of built) {
    assertNoLeftoverPlaceholders(prompt, label);
  }
});

Deno.test("issue prompt - REPO is substituted into the escape-hatch commands", async () => {
  const result = await buildIssuePrompt({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: "42",
    issueTitle: "Title",
    issueBody: "Body",
    issueLabels: "enhancement",
    qualityInstructions: "",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertStringIncludes(
    result.value.prompt,
    "gh issue create --repo stSoftwareAU/VibeCoder",
  );
  assertEquals(
    result.value.prompt.includes("{{REPO}}"),
    false,
    "the issue prompt must not ship a literal {{REPO}} token",
  );
});

// =============================================================================
// Gap 2: substitute() fails loud on an unmatched placeholder
// =============================================================================

Deno.test("builder fails loud when a template placeholder has no value", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/issue`, { recursive: true });
    await Deno.mkdir(`${tempDir}/coding_guidelines`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/issue/v1.md`,
      "Work on #{{ISSUE_NUMBER}}.\n{{QUALITY_INSTRUCTIONS}}\n" +
        "Report to {{UNKNOWN_PLACEHOLDER}} and {{ANOTHER_MISSING}}.\n",
    );
    await Deno.writeTextFile(
      `${tempDir}/coding_guidelines/v1.md`,
      "Use Australian English.\n",
    );

    const result = await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "42",
      issueTitle: "Title",
      issueBody: "Body",
      issueLabels: "enhancement",
      qualityInstructions: "",
      promptsDir: tempDir,
    });

    assertEquals(
      result.ok,
      false,
      "an unmatched placeholder must not be shipped to the model",
    );
    if (result.ok) return;
    assertStringIncludes(result.error.message, "{{ANOTHER_MISSING}}");
    assertStringIncludes(result.error.message, "{{UNKNOWN_PLACEHOLDER}}");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("substituted untrusted content carrying placeholder syntax does not fail the build", async () => {
  // The fail-loud check reads the template, not the rendered output, so a CI
  // log excerpt containing `{{FOO}}` must not be mistaken for a build fault.
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "7",
    checkName: "ci/test",
    annotationDetails: "Test failed",
    prFailureActions: "Template render failed: {{MISSING_VALUE}}",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  // The excerpt still reaches the model — neutralised to fullwidth braces by
  // the untrusted-content sanitiser, but not treated as a build fault.
  assertStringIncludes(result.value.prompt, "Template render failed:");
});

// =============================================================================
// Gap 6: the no-signals case is rendered as weak evidence
// =============================================================================

Deno.test("classification block - no matched signals is flagged as weak evidence", () => {
  const block = formatCiFailureClassification({
    category: "infrastructure",
    reason: "Check name suggests an integration run",
    signals: [],
  });
  assertStringIncludes(block, "no signals matched");
  assertStringIncludes(block, "weak evidence");
  assertStringIncludes(block, "deviate");
});

Deno.test("classification block - matched signals are listed without the weak-evidence note", () => {
  const block = formatCiFailureClassification({
    category: "code-fix-required",
    reason: "Compiler error in the diff",
    signals: ["error TS2345", "Argument of type 'string'"],
  });
  assertStringIncludes(block, "- error TS2345");
  assertStringIncludes(block, "- Argument of type 'string'");
  assertEquals(
    block.includes("weak evidence"),
    false,
    "a signal-backed classification must not carry the weak-evidence note",
  );
});
