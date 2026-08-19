/**
 * Tests for the clarity phase library and command (Issue #1225).
 *
 * Tests the full clarity phase flow: label routing, complexity detection,
 * clarity assessment, and question posting.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { captureReleaseOutcomes } from "./fixtures/release_outcome_capture.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ClarityPhaseDeps,
  type ClarityPhaseLabels,
  type ClarityPhaseParams,
  runClarityPhase,
} from "../lib/clarity_phase.ts";
import { clarityPhaseCommand } from "../commands/clarity_phase.ts";
import { LABEL_DEFAULTS } from "../lib/config_defaults.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { ClaudeExecutionResult } from "../lib/claude_executor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LABELS: ClarityPhaseLabels = {
  refineIssueLabel: LABEL_DEFAULTS.refineIssueLabel,
  planningLabel: LABEL_DEFAULTS.planningLabel,
  questionLabel: LABEL_DEFAULTS.questionLabel,
  documentationLabel: LABEL_DEFAULTS.documentationLabel,
  needsHumanLabel: LABEL_DEFAULTS.needsHumanLabel,
};

function createParams(
  overrides: Partial<ClarityPhaseParams> = {},
): ClarityPhaseParams {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Fix the login bug",
    issueBody:
      "Users cannot log in after password reset. Update src/auth.ts:123",
    issueLabels: "bug,work-on",
    issueComments: "",
    githubUser: "testworker",
    ...overrides,
  };
}

/** Mock gh command that records calls but does nothing. */
function createMockGh(): {
  fn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    fn: (args: string[]) => {
      calls.push(args);
      return Promise.resolve("");
    },
    calls,
  };
}

/** Mock Claude runner that returns a fixed result. */
function createMockClaude(
  output: string,
  exitCode = 0,
  timedOut = false,
): ClarityPhaseDeps["assessmentDeps"] {
  return {
    runClaude: () =>
      Promise.resolve({
        ok: true as const,
        value: { exitCode, output, timedOut } as ClaudeExecutionResult,
      }),
  };
}

/** Create deps with mocked gh and Claude. */
function createDeps(
  claudeOutput = "CLEAR",
  claudeExitCode = 0,
  claudeTimedOut = false,
): { deps: ClarityPhaseDeps; ghMock: ReturnType<typeof createMockGh> } {
  const ghMock = createMockGh();
  return {
    deps: {
      ghCommandFn: ghMock.fn,
      labelManagerDeps: { ghCommandFn: ghMock.fn },
      assessmentDeps: createMockClaude(
        claudeOutput,
        claudeExitCode,
        claudeTimedOut,
      ),
      maxClarificationRounds: 3,
    },
    ghMock,
  };
}

// ---------------------------------------------------------------------------
// Label Routing Tests
// ---------------------------------------------------------------------------

Deno.test("clarity-phase - refine-issue label routes to refinement", async () => {
  const { deps } = createDeps();
  const params = createParams({ issueLabels: "refine-issue,work-on" });

  const capture = captureReleaseOutcomes();
  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);
  capture.restore();
  // Routing is a deliberate no-PR release, never a ⚠️ failure (Issue #4330).
  assertEquals(capture.hooked.at(-1)?.outcome?.kind, "no_pr_expected");

  assertEquals(result.action, "early_exit");
  assertEquals(result.reason, "refine_label_routing");
  assertEquals(result.shouldCleanupBranch, true);
  assertEquals(result.clarityStatus, "not_assessed");
});

Deno.test("clarity-phase - question label routes to question handler", async () => {
  const { deps } = createDeps();
  const params = createParams({ issueLabels: "question,work-on" });

  const capture = captureReleaseOutcomes();
  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);
  capture.restore();
  assertEquals(capture.hooked.at(-1)?.outcome?.kind, "no_pr_expected");

  assertEquals(result.action, "early_exit");
  assertEquals(result.reason, "question_label_routing");
  assertEquals(result.shouldCleanupBranch, true);
});

Deno.test("clarity-phase - planning label is removed and proceeds", async () => {
  const { deps } = createDeps();
  const params = createParams({ issueLabels: "planning,work-on" });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "proceed");
  assertEquals(result.reason, "clear");
});

// ---------------------------------------------------------------------------
// Documentation Label Bypass Tests
// ---------------------------------------------------------------------------

Deno.test("clarity-phase - documentation label bypasses clarity assessment", async () => {
  const { deps } = createDeps();
  const params = createParams({ issueLabels: "documentation,work-on" });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "proceed");
  assertEquals(result.reason, "clear");
  assertEquals(result.clarityStatus, "skipped");
});

// ---------------------------------------------------------------------------
// Clarification Round Limit Tests
// ---------------------------------------------------------------------------

Deno.test("clarity-phase - max clarification rounds reached skips assessment", async () => {
  const { deps } = createDeps();
  const comments = [
    "## Clarification Needed\n\nQuestion 1?",
    "## Clarification Needed\n\nQuestion 2?",
    "## Clarification Needed\n\nQuestion 3?",
  ].join("\n\n---\n\n");
  const params = createParams({ issueComments: comments });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "proceed");
  assertEquals(result.clarityStatus, "skipped");
});

// ---------------------------------------------------------------------------
// Complexity Pre-check Tests
// ---------------------------------------------------------------------------

Deno.test("clarity-phase - too complex issue escalates to planning", async () => {
  const { deps } = createDeps();
  // Create an issue body with many directory references to trigger complexity
  const complexBody = [
    "Changes needed in:",
    "- src/auth/login/",
    "- src/auth/register/",
    "- src/api/endpoints/",
    "- src/models/users/",
    "- tests/unit/auth/",
  ].join("\n");
  const params = createParams({ issueBody: complexBody });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "early_exit");
  assertEquals(result.reason, "too_complex");
  assertEquals(result.shouldCleanupBranch, true);
});

// ---------------------------------------------------------------------------
// Clarity Assessment Tests
// ---------------------------------------------------------------------------

Deno.test("clarity-phase - clear assessment proceeds with implementation", async () => {
  const { deps } = createDeps("CLEAR");
  const params = createParams();

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "proceed");
  assertEquals(result.reason, "clear");
  assertEquals(result.clarityStatus, "assessed_clear");
  assertEquals(result.shouldCleanupBranch, false);
});

Deno.test("clarity-phase - unclear assessment waits for clarification", async () => {
  const { deps } = createDeps(
    "1. What colour should the button be?\n2. Where should it go?",
  );
  const params = createParams({
    issueBody: "Add a button",
    issueLabels: "work-on",
  });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "early_exit");
  assertEquals(result.reason, "waiting_for_clarification");
  assertEquals(result.shouldCleanupBranch, true);
});

Deno.test("clarity-phase - assessment failed aborts issue", async () => {
  const { deps } = createDeps("", 124, true);
  const params = createParams({
    issueBody: "Add a button",
    issueLabels: "work-on",
  });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "failure");
  assertStringIncludes(result.reason, "clarity_assessment_failed");
  assertEquals(result.shouldCleanupBranch, true);
});

Deno.test("clarity-phase - invalid questions treated as clear", async () => {
  // Claude returns text without question marks — treated as clear
  const { deps } = createDeps("I will proceed with the implementation now.");
  const params = createParams({
    issueBody: "Add a button",
    issueLabels: "work-on",
  });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "proceed");
  assertEquals(result.clarityStatus, "assessed_clear");
});

Deno.test("clarity-phase - question posting failure proceeds with implementation", async () => {
  const ghMock = createMockGh();
  const failingGh = (args: string[]) => {
    // Fail gh calls that post comments
    if (args.includes("comment")) {
      return Promise.reject(new Error("Network error"));
    }
    return ghMock.fn(args);
  };

  const deps: ClarityPhaseDeps = {
    ghCommandFn: failingGh,
    labelManagerDeps: { ghCommandFn: failingGh },
    assessmentDeps: createMockClaude("1. What colour should this be?"),
    maxClarificationRounds: 3,
  };
  const params = createParams({
    issueBody: "Add a button",
    issueLabels: "work-on",
  });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  // Should proceed since posting failed — graceful degradation
  assertEquals(result.action, "proceed");
  assertEquals(result.clarityStatus, "assessed_clear");
});

// ---------------------------------------------------------------------------
// Label Case Insensitivity Tests
// ---------------------------------------------------------------------------

Deno.test("clarity-phase - label routing is case-insensitive", async () => {
  const { deps } = createDeps();
  const params = createParams({ issueLabels: "Refine-Issue,work-on" });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "early_exit");
  assertEquals(result.reason, "refine_label_routing");
});

Deno.test("clarity-phase - documentation label case-insensitive", async () => {
  const { deps } = createDeps();
  const params = createParams({ issueLabels: "Documentation,work-on" });

  const result = await runClarityPhase(params, DEFAULT_LABELS, deps);

  assertEquals(result.action, "proceed");
  assertEquals(result.clarityStatus, "skipped");
});

// ---------------------------------------------------------------------------
// Command Tests
// ---------------------------------------------------------------------------

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;
}

Deno.test("clarity-phase command - missing repo returns error", async () => {
  const config = createMockConfig();
  const result = await clarityPhaseCommand.execute(
    { "issue-number": 1, "github-user": "worker" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--repo");
});

Deno.test("clarity-phase command - missing issue-number returns error", async () => {
  const config = createMockConfig();
  const result = await clarityPhaseCommand.execute(
    { repo: "org/repo", "github-user": "worker" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--issue-number");
});

Deno.test("clarity-phase command - missing github-user returns error", async () => {
  const config = createMockConfig();
  const result = await clarityPhaseCommand.execute(
    { repo: "org/repo", "issue-number": 1 },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--github-user");
});
