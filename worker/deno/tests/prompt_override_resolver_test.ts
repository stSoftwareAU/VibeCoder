/**
 * Tests for resolving a phase's prompt template at build time (Issue #849,
 * part of #843) — the runtime half of the override.
 *
 * What matters here is *which file a phase ran with*:
 *
 *   1. a configured override replaces the built-in template for that phase,
 *      and only that phase;
 *   2. a phase with no override loads `prompts/<phase>/prompt.md` exactly as
 *      before;
 *   3. an override file that has gone missing since config load fails the
 *      build loudly — it never falls back to the repository's template; and
 *   4. the resolution is recorded, naming the file, so a run is traceable back
 *      to the operator file behind it.
 *
 * The builder tests assert on rendered output rather than on call
 * bookkeeping, so they keep working if the loading is refactored.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { CustomLabelPromptMapping, Logger } from "../types.ts";
import {
  PromptOverrideBuildError,
  refuseFallbackPastOverride,
  resolvePromptTemplate,
} from "../lib/prompt_override_resolver.ts";
import {
  buildIssuePrompt,
  buildPlanningCritiquePrompt,
  buildPlanningPrompt,
  buildQuestionPrompt,
} from "../lib/prompt_builder.ts";
import { buildGrillMePrompt } from "../lib/grill_me_processor.ts";

/** A logger that keeps every info line for assertion. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const noop = () => {};
  const logger = {
    info: (message: string) => lines.push(message),
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  } as unknown as Logger;
  return { logger, lines };
}

/** Run `fn` with a scratch directory, cleaning up afterwards. */
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "prompt-override-resolver-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Write an operator template and return the mapping that points at it. */
async function override(
  dir: string,
  name: string,
  label: string,
  phase: string,
  body: string,
): Promise<CustomLabelPromptMapping> {
  const promptPath = `${dir}/${name}`;
  await Deno.writeTextFile(promptPath, body);
  return { label, promptPath, targetPhase: "issue", overridesPhase: phase };
}

const OPERATOR_MARKER = "OPERATOR TEMPLATE — not the repository's";

// ---------------------------------------------------------------------------
// resolvePromptTemplate
// ---------------------------------------------------------------------------

Deno.test("resolvePromptTemplate - no override loads the built-in template", async () => {
  const { logger, lines } = recordingLogger();
  const result = await resolvePromptTemplate("planning", { logger });
  assert(result.ok, result.ok ? "" : result.error.message);
  assertStringIncludes(result.value.source, "prompts/planning/prompt.md");
  assertEquals(result.value.overrideLabel, undefined);
  assertStringIncludes(result.value.content, "{{PLANNING_LABEL}}");
  assertEquals(
    lines.some((line) => line.includes(result.value.source)),
    true,
    `expected the traceability record to name the template: ${lines.join("|")}`,
  );
});

Deno.test("resolvePromptTemplate - an override replaces only its own phase", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "plan.md",
      "planning",
      "planning",
      `${OPERATOR_MARKER}\n{{REPO}} {{ISSUE_NUMBER}} {{PLANNING_LABEL}}\n`,
    );
    const { logger, lines } = recordingLogger();

    const planning = await resolvePromptTemplate("planning", {
      overrides: [mapping],
      logger,
    });
    assert(planning.ok, planning.ok ? "" : planning.error.message);
    assertStringIncludes(planning.value.content, OPERATOR_MARKER);
    assertEquals(planning.value.source, mapping.promptPath);
    assertEquals(planning.value.overrideLabel, "planning");
    assertEquals(
      lines.some((line) => line.includes(mapping.promptPath)),
      true,
      "the run record must name the operator file",
    );

    // The critique turn is a different template and is untouched.
    const critique = await resolvePromptTemplate("planning_critique", {
      overrides: [mapping],
      logger,
    });
    assert(critique.ok, critique.ok ? "" : critique.error.message);
    assertEquals(critique.value.content.includes(OPERATOR_MARKER), false);
    assertStringIncludes(
      critique.value.source,
      "prompts/planning_critique/prompt.md",
    );
  });
});

Deno.test("resolvePromptTemplate - a deleted override fails loud, with no fallback", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "gone.md",
      "question",
      "question",
      `${OPERATOR_MARKER}\n{{REPO}} {{ISSUE_NUMBER}} {{QUESTION_LABEL}}\n`,
    );
    await Deno.remove(mapping.promptPath);

    const result = await resolvePromptTemplate("question", {
      overrides: [mapping],
    });
    assertEquals(result.ok, false);
    const message = result.ok ? "" : result.error.message;
    assertStringIncludes(message, mapping.promptPath);
    assertStringIncludes(message, "question");
  });
});

Deno.test("resolvePromptTemplate - an override edited below its contract fails loud", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "plan.md",
      "planning",
      "planning",
      "Someone deleted the placeholders.\n",
    );
    const result = await resolvePromptTemplate("planning", {
      overrides: [mapping],
    });
    assertEquals(result.ok, false);
    assertStringIncludes(
      result.ok ? "" : result.error.message,
      "PLANNING_LABEL",
    );
  });
});

// ---------------------------------------------------------------------------
// Never fall back past an override
// ---------------------------------------------------------------------------

Deno.test("refuseFallbackPastOverride - throws for an overridden phase", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "q.md",
      "question",
      "question",
      "{{REPO}} {{ISSUE_NUMBER}} {{QUESTION_LABEL}}\n",
    );
    const thrown = assertThrows(
      () =>
        refuseFallbackPastOverride(
          [mapping],
          "question",
          new Error("the file went missing"),
        ),
      PromptOverrideBuildError,
      "question",
    );
    assertStringIncludes(thrown.message, mapping.promptPath);
    assertStringIncludes(thrown.message, "the file went missing");
  });
});

Deno.test("refuseFallbackPastOverride - leaves an unoverridden phase alone", () => {
  // A broken *repository* template still gets its basic-prompt rescue.
  refuseFallbackPastOverride([], "question", new Error("boom"));
  refuseFallbackPastOverride(undefined, "planning", new Error("boom"));
  refuseFallbackPastOverride(
    [{
      label: "planning",
      promptPath: "/opt/a.md",
      targetPhase: "issue",
      overridesPhase: "planning",
    }],
    "question",
    new Error("boom"),
  );
});

// ---------------------------------------------------------------------------
// The builders each phase uses
// ---------------------------------------------------------------------------

Deno.test("buildIssuePrompt - a work-on override replaces the issue template", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "issue.md",
      "work-on",
      "issue",
      `${OPERATOR_MARKER}\nIssue {{ISSUE_NUMBER}}\n{{QUALITY_INSTRUCTIONS}}\n`,
    );
    const result = await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "42",
      issueTitle: "A title",
      issueBody: "A body",
      issueLabels: "work-on",
      qualityInstructions: "run the gate",
      promptOverrides: [mapping],
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertStringIncludes(result.value.prompt, OPERATOR_MARKER);
    assertStringIncludes(result.value.prompt, "Issue 42");
    // The untrusted issue text is still fenced exactly as the built-in
    // template's build fences it.
    assertStringIncludes(result.value.prompt, "BOUNDARY_");
  });
});

Deno.test("buildIssuePrompt - a dispatched custom prompt wins over a work-on override", async () => {
  await withDir(async (dir) => {
    const overrideMapping = await override(
      dir,
      "work-on.md",
      "work-on",
      "issue",
      `${OPERATOR_MARKER}\nIssue {{ISSUE_NUMBER}}\n{{QUALITY_INSTRUCTIONS}}\n`,
    );
    const dispatched = `${dir}/dispatched.md`;
    await Deno.writeTextFile(
      dispatched,
      `DISPATCHED TEMPLATE\nIssue {{ISSUE_NUMBER}}\n{{QUALITY_INSTRUCTIONS}}\n`,
    );

    const result = await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "42",
      issueTitle: "A title",
      issueBody: "A body",
      issueLabels: "my-custom-label",
      qualityInstructions: "run the gate",
      customPromptPath: dispatched,
      customPromptLabel: "my-custom-label",
      promptOverrides: [overrideMapping],
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertStringIncludes(result.value.prompt, "DISPATCHED TEMPLATE");
    assertEquals(result.value.prompt.includes(OPERATOR_MARKER), false);
  });
});

Deno.test("buildIssuePrompt - no override renders the built-in template", async () => {
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "A title",
    issueBody: "A body",
    issueLabels: "work-on",
    qualityInstructions: "run the gate",
  });
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value.prompt.includes(OPERATOR_MARKER), false);
});

Deno.test("buildPlanningPrompt - a planning override replaces the template, the critique keeps its own", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "plan.md",
      "planning",
      "planning",
      `${OPERATOR_MARKER}\n{{REPO}} #{{ISSUE_NUMBER}} {{PLANNING_LABEL}}\n`,
    );
    const planning = await buildPlanningPrompt({
      repo: "owner/repo",
      issueNumber: "7",
      issueTitle: "A title",
      issueBody: "A body",
      issueLabels: "planning",
      promptOverrides: [mapping],
    });
    assert(planning.ok, planning.ok ? "" : planning.error.message);
    assertStringIncludes(planning.value.prompt, OPERATOR_MARKER);
    assertStringIncludes(planning.value.prompt, "owner/repo #7 planning");

    const critique = await buildPlanningCritiquePrompt({
      repo: "owner/repo",
      issueNumber: "7",
      issueTitle: "A title",
      issueBody: "A body",
      issueLabels: "planning",
      draftPlan: "A draft",
      promptOverrides: [mapping],
    });
    assert(critique.ok, critique.ok ? "" : critique.error.message);
    assertEquals(
      critique.value.prompt.includes(OPERATOR_MARKER),
      false,
      "overriding planning must not override the critique turn",
    );
  });
});

Deno.test("buildGrillMePrompt - a grill-me override replaces the template", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "grill.md",
      "grill-me",
      "grill-me",
      `${OPERATOR_MARKER}\nRound {{ROUND_NUMBER}}/{{MAX_ROUNDS}} on ` +
        `{{REPO}}#{{ISSUE_NUMBER}}\n{{ISSUE_TITLE}}\n{{ISSUE_BODY}}\n` +
        `{{COMMENT_HISTORY}}\n{{BOUNDARY_INTEGRITY_INSTRUCTION}}\n`,
    );
    const result = await buildGrillMePrompt({
      roundNumber: 2,
      maxRounds: 5,
      issueBody: "A body",
      commentHistory: "None.",
      repo: "owner/repo",
      issueNumber: 9,
      issueTitle: "A title",
      codingGuidelines: "",
      verbosityInstructions: "",
      promptOverrides: [mapping],
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertStringIncludes(result.value, OPERATOR_MARKER);
    assertStringIncludes(result.value, "Round 2/5 on owner/repo#9");
    // The untrusted body is still fenced and the integrity instruction is
    // still rendered — the security machinery is not an opt-in of the
    // built-in template.
    assertStringIncludes(result.value, "BOUNDARY_");
  });
});

Deno.test("buildGrillMePrompt - no override renders the built-in template", async () => {
  const result = await buildGrillMePrompt({
    roundNumber: 1,
    maxRounds: 5,
    issueBody: "A body",
    commentHistory: "None.",
    repo: "owner/repo",
    issueNumber: 9,
    issueTitle: "A title",
    codingGuidelines: "",
    verbosityInstructions: "",
  });
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value.includes(OPERATOR_MARKER), false);
});

Deno.test("buildQuestionPrompt - a question override replaces the template", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "question.md",
      "question",
      "question",
      `${OPERATOR_MARKER}\n{{REPO}} #{{ISSUE_NUMBER}} {{QUESTION_LABEL}}\n`,
    );
    const result = await buildQuestionPrompt({
      repo: "owner/repo",
      issueNumber: "12",
      issueTitle: "A title",
      issueBody: "A body",
      issueLabels: "question",
      promptOverrides: [mapping],
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertStringIncludes(result.value.prompt, OPERATOR_MARKER);
    assertStringIncludes(result.value.prompt, "owner/repo #12 question");
    // The untrusted issue text is still fenced by this run's nonce.
    assertStringIncludes(result.value.prompt, "BOUNDARY_");
  });
});

Deno.test("buildQuestionPrompt - no override renders the built-in template", async () => {
  const result = await buildQuestionPrompt({
    repo: "owner/repo",
    issueNumber: "12",
    issueTitle: "A title",
    issueBody: "A body",
    issueLabels: "question",
  });
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value.prompt.includes(OPERATOR_MARKER), false);
});

// ---------------------------------------------------------------------------
// The run's traceability record (Issue #849)
// ---------------------------------------------------------------------------

Deno.test("buildIssuePrompt - the result names the template file the build read", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "work-on.md",
      "work-on",
      "issue",
      `${OPERATOR_MARKER}\nIssue {{ISSUE_NUMBER}}\n{{QUALITY_INSTRUCTIONS}}\n`,
    );
    const overridden = await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "42",
      issueTitle: "A title",
      issueBody: "A body",
      issueLabels: "work-on",
      qualityInstructions: "run the gate",
      promptOverrides: [mapping],
    });
    assert(overridden.ok, overridden.ok ? "" : overridden.error.message);
    assertEquals(overridden.value.templateSource, mapping.promptPath);

    // With no override the record names the repository's own template, so a
    // run is traceable either way.
    const builtIn = await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "42",
      issueTitle: "A title",
      issueBody: "A body",
      issueLabels: "work-on",
      qualityInstructions: "run the gate",
    });
    assert(builtIn.ok, builtIn.ok ? "" : builtIn.error.message);
    assertStringIncludes(
      builtIn.value.templateSource ?? "",
      "prompts/issue/prompt.md",
    );
  });
});

Deno.test("buildPlanningPrompt - the record names each turn's own template", async () => {
  await withDir(async (dir) => {
    const mapping = await override(
      dir,
      "plan.md",
      "planning",
      "planning",
      `${OPERATOR_MARKER}\n{{REPO}} #{{ISSUE_NUMBER}} {{PLANNING_LABEL}}\n`,
    );
    const planning = await buildPlanningPrompt({
      repo: "owner/repo",
      issueNumber: "7",
      issueTitle: "A title",
      issueBody: "A body",
      issueLabels: "planning",
      promptOverrides: [mapping],
    });
    assert(planning.ok, planning.ok ? "" : planning.error.message);
    assertEquals(planning.value.templateSource, mapping.promptPath);

    const critique = await buildPlanningCritiquePrompt({
      repo: "owner/repo",
      issueNumber: "7",
      issueTitle: "A title",
      issueBody: "A body",
      issueLabels: "planning",
      draftPlan: "A draft",
      promptOverrides: [mapping],
    });
    assert(critique.ok, critique.ok ? "" : critique.error.message);
    assertStringIncludes(
      critique.value.templateSource ?? "",
      "prompts/planning_critique/prompt.md",
    );
  });
});
