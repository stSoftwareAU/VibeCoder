/**
 * Tests for the execute-claude phase orchestration (Issue #1227).
 *
 * Covers:
 * - Screenshot requirement detection (label and repo config matching)
 * - Failure message formatting (timeout, rate limit, diagnostics)
 * - Diagnostic context building
 * - Self-healing PR recovery
 * - Full phase execution with mocked dependencies
 *
 * Uses Australian English throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  attemptPrSelfHealing,
  buildDiagnosticContext,
  buildFailureMessage,
  buildOutOfMemoryMessage,
  detectScreenshotRequired,
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";

// =============================================================================
// Screenshot requirement detection
// =============================================================================

Deno.test("detectScreenshotRequired - returns true when needs-screenshot label present", () => {
  const result = detectScreenshotRequired(
    "enhancement,needs-screenshot,work-on",
    "needs-screenshot",
    undefined,
    "owner/repo",
  );
  assertEquals(result, true);
});

Deno.test("detectScreenshotRequired - case-insensitive label matching", () => {
  const result = detectScreenshotRequired(
    "enhancement,Needs-Screenshot,work-on",
    "needs-screenshot",
    undefined,
    "owner/repo",
  );
  assertEquals(result, true);
});

Deno.test("detectScreenshotRequired - returns false when label not present", () => {
  const result = detectScreenshotRequired(
    "enhancement,work-on",
    "needs-screenshot",
    undefined,
    "owner/repo",
  );
  assertEquals(result, false);
});

Deno.test("detectScreenshotRequired - returns true when repo requires screenshots", () => {
  const repoConfigs = {
    "owner/ui-repo": { requiresScreenshots: true } as Record<string, unknown>,
  };
  const result = detectScreenshotRequired(
    "enhancement",
    "needs-screenshot",
    repoConfigs as unknown as Record<string, import("../types.ts").RepoConfig>,
    "owner/ui-repo",
  );
  assertEquals(result, true);
});

Deno.test("detectScreenshotRequired - returns true when repo has requiresScreenshots as string", () => {
  const repoConfigs = {
    "owner/ui-repo": { requiresScreenshots: "true" } as Record<string, unknown>,
  };
  const result = detectScreenshotRequired(
    "enhancement",
    "needs-screenshot",
    repoConfigs as unknown as Record<string, import("../types.ts").RepoConfig>,
    "owner/ui-repo",
  );
  assertEquals(result, true);
});

Deno.test("detectScreenshotRequired - returns false for different repo", () => {
  const repoConfigs = {
    "owner/ui-repo": { requiresScreenshots: true } as Record<string, unknown>,
  };
  const result = detectScreenshotRequired(
    "enhancement",
    "needs-screenshot",
    repoConfigs as unknown as Record<string, import("../types.ts").RepoConfig>,
    "owner/other-repo",
  );
  assertEquals(result, false);
});

// =============================================================================
// Failure message formatting
// =============================================================================

Deno.test("buildFailureMessage - timeout with output includes partial output section", () => {
  const message = buildFailureMessage({
    failureType: "timeout",
    failureReason: "timed out after 14400 seconds (240 minutes)",
    failureOutput: "Working on implementation...\nInstalling dependencies...",
    timeoutFailureSummary: "",
    diagnosticContent: "",
  });
  assertStringIncludes(message, "timed out after 14400 seconds");
  assertStringIncludes(message, "actively working but did not finish");
  assertStringIncludes(message, "Working on implementation");
});

Deno.test("buildFailureMessage - timeout with zero output includes zero-output diagnosis", () => {
  const message = buildFailureMessage({
    failureType: "timeout",
    failureReason: "timed out after 14400 seconds (240 minutes)",
    failureOutput: "",
    timeoutFailureSummary: "",
    diagnosticContent: "some diagnostics here",
  });
  assertStringIncludes(message, "zero output");
  assertStringIncludes(message, "No output captured");
  assertStringIncludes(message, "some diagnostics here");
});

Deno.test("buildFailureMessage - includes failure summary when provided", () => {
  const message = buildFailureMessage({
    failureType: "timeout",
    failureReason: "timed out",
    failureOutput: "partial output",
    timeoutFailureSummary: "Claude was running tests when it timed out",
    diagnosticContent: "",
  });
  assertStringIncludes(message, "### Failure Summary");
  assertStringIncludes(message, "Claude was running tests when it timed out");
});

Deno.test("buildFailureMessage - rate limit includes rate limit reason", () => {
  const message = buildFailureMessage({
    failureType: "rate_limit",
    failureReason: "hit rate limit after 2 retries (max wait: 600s)",
    failureOutput: "Rate limit error...",
    timeoutFailureSummary: "",
    diagnosticContent: "",
  });
  assertStringIncludes(message, "hit rate limit after 2 retries");
});

Deno.test("buildOutOfMemoryMessage - names OOM as terminal and includes output tail", () => {
  const message = buildOutOfMemoryMessage({
    failureOutput: "FATAL ERROR: JavaScript heap out of memory",
  });
  assertStringIncludes(message, "ran out of memory (OOM)");
  assertStringIncludes(message, "failing fast");
  assertStringIncludes(message, "waiting cannot recover memory");
  assertStringIncludes(message, "JavaScript heap out of memory");
});

Deno.test("buildOutOfMemoryMessage - handles empty output", () => {
  const message = buildOutOfMemoryMessage({ failureOutput: "" });
  assertStringIncludes(message, "ran out of memory (OOM)");
  assertStringIncludes(message, "No output captured");
});

// =============================================================================
// Diagnostic context
// =============================================================================

Deno.test("buildDiagnosticContext - formats context string correctly", () => {
  const context = buildDiagnosticContext({
    clarityStatus: "clear",
    elapsedSeconds: 3600,
    claudeNoOutputTimeout: 900,
    claudeTimeout: 14400,
  });
  assertStringIncludes(context, "health_check=passed");
  assertStringIncludes(context, "clarity=clear");
  assertStringIncludes(context, "elapsed_seconds=3600");
  assertStringIncludes(context, "no_output_timeout=900");
  assertStringIncludes(context, "claude_timeout=14400");
});

// =============================================================================
// Self-healing PR recovery
// =============================================================================

Deno.test("attemptPrSelfHealing - returns ok with PR URL when PR exists", async () => {
  const result = await attemptPrSelfHealing(
    {
      repo: "owner/repo",
      branchName: "issue-42-fix-bug",
      milestoneBranch: "",
      issueNumber: 42,
      githubUser: "bot-user",
    },
    {
      findExistingPrForBranch: async () => ({
        ok: true,
        value: "https://github.com/owner/repo/pull/99",
      }),
      retargetPrToMilestone: async () => ({ ok: true, value: "retargeted" }),
      finalisePr: async () => ({ ok: true, value: "finalised" }),
      ensureIssueClosedIfPrMerged: async () => ({ ok: true, value: undefined }),
      log: () => {},
    },
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.prUrl, "https://github.com/owner/repo/pull/99");
    assertEquals(result.value.prNumber, 99);
  }
});

Deno.test("attemptPrSelfHealing - returns error when no PR exists", async () => {
  const result = await attemptPrSelfHealing(
    {
      repo: "owner/repo",
      branchName: "issue-42-fix-bug",
      milestoneBranch: "",
      issueNumber: 42,
      githubUser: "bot-user",
    },
    {
      findExistingPrForBranch: async () => ({
        ok: false,
        error: new Error("No PR found"),
      }),
      retargetPrToMilestone: async () => ({ ok: true, value: "retargeted" }),
      finalisePr: async () => ({ ok: true, value: "finalised" }),
      ensureIssueClosedIfPrMerged: async () => ({ ok: true, value: undefined }),
      log: () => {},
    },
  );
  assertEquals(result.ok, false);
});

Deno.test("attemptPrSelfHealing - retargets to milestone when milestone branch set", async () => {
  let retargetCalled = false;
  await attemptPrSelfHealing(
    {
      repo: "owner/repo",
      branchName: "issue-42-fix-bug",
      milestoneBranch: "milestone/v2",
      issueNumber: 42,
      githubUser: "bot-user",
    },
    {
      findExistingPrForBranch: async () => ({
        ok: true,
        value: "https://github.com/owner/repo/pull/99",
      }),
      retargetPrToMilestone: async (_repo, _pr, branch) => {
        retargetCalled = true;
        assertEquals(branch, "milestone/v2");
        return { ok: true, value: "retargeted" };
      },
      finalisePr: async () => ({ ok: true, value: "finalised" }),
      ensureIssueClosedIfPrMerged: async () => ({ ok: true, value: undefined }),
      log: () => {},
    },
  );
  assertEquals(retargetCalled, true);
});

// =============================================================================
// Full phase execution
// =============================================================================

/** Create mock dependencies for testing. */
function createMockDeps(
  overrides: Partial<ExecuteClaudePhaseDeps> = {},
): ExecuteClaudePhaseDeps {
  return {
    runClaudeWithRetry: async () => ({
      ok: true,
      value: {
        exitCode: 0,
        output: "Implementation complete.",
        timedOut: false,
      },
    }),
    buildIssuePrompt: async () => ({
      ok: true,
      value: {
        systemPrompt: "Mock system prompt",
        prompt: "Mock prompt for testing",
      },
    }),
    buildCachedIssuePrompt: async () => ({
      ok: true,
      value: {
        systemPrompt: "Mock system prompt",
        prompt: "Mock prompt for testing",
        promptSha: "a".repeat(64),
        cacheHit: false,
      },
    }),
    validateRepoState: async () => ({
      ok: true,
      value: { valid: true, actions: [], warnings: [] },
    }),
    findExistingPrForBranch: async () => ({
      ok: false,
      error: new Error("No PR found"),
    }),
    retargetPrToMilestone: async () => ({ ok: true, value: "retargeted" }),
    finalisePr: async () => ({ ok: true, value: "finalised" }),
    ensureIssueClosedIfPrMerged: async () => ({ ok: true, value: undefined }),
    runGitCommand: async (args: string[]) => {
      // Default: report changes present
      if (args[0] === "status" && args[1] === "--porcelain") {
        return { ok: true, value: "M src/main.ts" };
      }
      if (args[0] === "log") {
        return { ok: true, value: "abc1234 feat: implement feature" };
      }
      return { ok: true, value: "" };
    },
    recordHeartbeat: async () => ({ ok: true, value: undefined }),
    clearHeartbeat: async () => ({ ok: true, value: undefined }),
    getLatestVersion: async () => ({ ok: true, value: "v3" }),
    log: () => {},
    ...overrides,
  };
}

/** Create default test options. */
function createTestOptions(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Fix the bug",
    issueBody: "There is a bug that needs fixing.",
    issueLabels: "enhancement,work-on",
    githubUser: "bot-user",
    branchName: "issue-42-fix-the-bug",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/test-work",
    claudeTimeout: 14400,
    claudeKillAfter: 30,
    maxRateLimitRetries: 2,
    maxRateLimitWait: 600,
    ...overrides,
  };
}

Deno.test("runExecuteClaudePhase - success when Claude makes changes", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps(),
  );
  assertEquals(result.action, "success");
  assertEquals(result.hasUncommittedChanges, true);
  assertEquals(result.hasNewCommits, true);
  assertEquals(result.promptVersions?.issue, "v3");
});

Deno.test("runExecuteClaudePhase - failure when repo validation fails", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      validateRepoState: async () => ({
        ok: true,
        value: { valid: false, actions: [], warnings: [] },
      }),
    }),
  );
  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "validation");
  assertStringIncludes(result.failureMessage!, "validation failed");
});

Deno.test("runExecuteClaudePhase - failure when prompt building fails", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      buildCachedIssuePrompt: async () => ({
        ok: false,
        error: new Error("Template not found"),
      }),
    }),
  );
  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "execution_error");
  assertStringIncludes(result.failureMessage!, "Failed to build prompt");
});

// -----------------------------------------------------------------------
// Context budget hard ceiling (Issue #3713)
// -----------------------------------------------------------------------

Deno.test("runExecuteClaudePhase - context budget ceiling blocks the phase and escalates (Issue #3713)", async () => {
  const escalations: Array<{ issueNumber: number; reason: string }> = [];
  let claudeCalls = 0;

  const result = await runExecuteClaudePhase(
    // A 0.001% ceiling on a 1M window blocks any realistic prompt.
    createTestOptions({ contextBudgetBlockPercent: 0.001 }),
    createMockDeps({
      escalateContextBudget: async (opts) => {
        escalations.push({
          issueNumber: opts.issueNumber,
          reason: opts.reason,
        });
      },
      runClaudeWithRetry: async () => {
        claudeCalls++;
        return {
          ok: true,
          value: { exitCode: 0, output: "", timedOut: false },
        };
      },
    }),
  );

  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "context_budget");
  assertStringIncludes(result.failureMessage!, "hard ceiling");
  assertEquals(claudeCalls, 0, "no billed invocation past the ceiling");
  assertEquals(escalations.length, 1, "issue handed to a human");
  assertEquals(escalations[0]!.issueNumber, 42);
});

Deno.test("runExecuteClaudePhase - a zero ceiling keeps the budget check observational (Issue #3713)", async () => {
  const escalations: string[] = [];

  const result = await runExecuteClaudePhase(
    createTestOptions({ contextBudgetBlockPercent: 0 }),
    createMockDeps({
      escalateContextBudget: async (opts) => {
        escalations.push(opts.reason);
      },
    }),
  );

  assertEquals(result.action, "success");
  assertEquals(escalations.length, 0);
});

Deno.test("runExecuteClaudePhase - timeout failure with no self-healing", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runClaudeWithRetry: async () => ({
        ok: true,
        value: {
          exitCode: 124,
          output: "Partial work output...",
          timedOut: true,
        },
      }),
    }),
  );
  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "timeout");
  assertStringIncludes(result.failureMessage!, "timed out");
});

Deno.test("runExecuteClaudePhase - timeout with self-healing PR found", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runClaudeWithRetry: async () => ({
        ok: true,
        value: {
          exitCode: 124,
          output: "",
          timedOut: true,
        },
      }),
      findExistingPrForBranch: async () => ({
        ok: true,
        value: "https://github.com/owner/repo/pull/55",
      }),
    }),
  );
  assertEquals(result.action, "self_healed");
  assertEquals(result.prUrl, "https://github.com/owner/repo/pull/55");
  assertEquals(result.prNumber, 55);
});

Deno.test("runExecuteClaudePhase - rate limit exhaustion failure", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runClaudeWithRetry: async () => ({
        ok: true,
        value: {
          exitCode: 2,
          output: "Rate limit exceeded",
          timedOut: false,
        },
      }),
    }),
  );
  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "rate_limit");
  assertStringIncludes(result.failureMessage!, "rate limit");
});

Deno.test("runExecuteClaudePhase - out of memory maps to out_of_memory failure", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runClaudeWithRetry: async () => ({
        ok: true,
        value: {
          exitCode: 137,
          output: "FATAL ERROR: JavaScript heap out of memory",
          timedOut: false,
          outOfMemory: true,
        },
      }),
    }),
  );
  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "out_of_memory");
  // OOM must never be mislabelled as a timeout or rate limit.
  assertEquals(result.failureType === "timeout", false);
  assertEquals(result.failureType === "rate_limit", false);
  assertStringIncludes(result.failureMessage!, "ran out of memory (OOM)");
});

Deno.test("runExecuteClaudePhase - out of memory still self-heals a pushed PR", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runClaudeWithRetry: async () => ({
        ok: true,
        value: {
          exitCode: 137,
          output: "Reached heap limit Allocation failed",
          timedOut: false,
          outOfMemory: true,
        },
      }),
      findExistingPrForBranch: async () => ({
        ok: true,
        value: "https://github.com/owner/repo/pull/77",
      }),
    }),
  );
  assertEquals(result.action, "self_healed");
  assertEquals(result.prUrl, "https://github.com/owner/repo/pull/77");
  assertEquals(result.prNumber, 77);
});

Deno.test("runExecuteClaudePhase - no changes triggers self-healing for existing PR", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runGitCommand: async (args: string[]) => {
        // No local changes
        if (args[0] === "status") return { ok: true, value: "" };
        if (args[0] === "log" && args[1]?.startsWith("main..issue")) {
          return { ok: true, value: "" };
        }
        return { ok: true, value: "" };
      },
      findExistingPrForBranch: async () => ({
        ok: true,
        value: "https://github.com/owner/repo/pull/77",
      }),
    }),
  );
  assertEquals(result.action, "self_healed");
  assertEquals(result.prUrl, "https://github.com/owner/repo/pull/77");
});

Deno.test("runExecuteClaudePhase - no changes with remote commits triggers remote self-healing", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runGitCommand: async (args: string[]) => {
        if (args[0] === "status") return { ok: true, value: "" };
        if (args[0] === "log" && args[1] === "main..issue-42-fix-the-bug") {
          return { ok: true, value: "" }; // No local commits
        }
        if (args[0] === "fetch") return { ok: true, value: "" };
        if (args[0] === "log" && args[1]?.includes("origin/")) {
          return { ok: true, value: "def5678 feat: prior work" }; // Remote commits exist
        }
        if (args[0] === "reset") return { ok: true, value: "" };
        return { ok: true, value: "" };
      },
    }),
  );
  assertEquals(result.action, "remote_self_healed");
  assertEquals(result.hasNewCommits, true);
});

Deno.test("runExecuteClaudePhase - no changes and no remote commits returns no_changes", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runGitCommand: async (args: string[]) => {
        if (args[0] === "status") return { ok: true, value: "" };
        if (args[0] === "fetch") return { ok: true, value: "" };
        // All log commands return empty
        if (args[0] === "log") return { ok: true, value: "" };
        return { ok: true, value: "" };
      },
    }),
  );
  assertEquals(result.action, "no_changes");
  assertEquals(result.hasUncommittedChanges, false);
  assertEquals(result.hasNewCommits, false);
});

Deno.test("runExecuteClaudePhase - screenshot label triggers screenshot instructions", async () => {
  let promptOptions: Record<string, unknown> | undefined;
  const result = await runExecuteClaudePhase(
    createTestOptions({ issueLabels: "enhancement,needs-screenshot" }),
    createMockDeps({
      buildCachedIssuePrompt: async (opts) => {
        promptOptions = opts as unknown as Record<string, unknown>;
        return {
          ok: true,
          value: {
            systemPrompt: "Mock system",
            prompt: "Mock prompt",
            promptSha: "a".repeat(64),
            cacheHit: false,
          },
        };
      },
    }),
  );
  assertEquals(result.action, "success");
  assertEquals(promptOptions?.screenshotRequired, true);
});

Deno.test("runExecuteClaudePhase - heartbeat started and stopped", async () => {
  let heartbeatRecorded = false;
  let heartbeatCleared = false;
  await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      recordHeartbeat: async () => {
        heartbeatRecorded = true;
        return { ok: true, value: undefined };
      },
      clearHeartbeat: async () => {
        heartbeatCleared = true;
        return { ok: true, value: undefined };
      },
    }),
  );
  // Heartbeat recording is async/fire-and-forget via setInterval,
  // so we just verify the deps were provided (heartbeat module tests
  // cover the actual lifecycle). The clear should be called on stop.
  assertEquals(heartbeatRecorded || heartbeatCleared, true);
});

Deno.test("runExecuteClaudePhase - milestone branch passed to prompt", async () => {
  let promptOptions: Record<string, unknown> | undefined;
  await runExecuteClaudePhase(
    createTestOptions({ milestoneBranch: "milestone/v2" }),
    createMockDeps({
      buildCachedIssuePrompt: async (opts) => {
        promptOptions = opts as unknown as Record<string, unknown>;
        return {
          ok: true,
          value: {
            systemPrompt: "Mock system",
            prompt: "Mock prompt",
            promptSha: "a".repeat(64),
            cacheHit: false,
          },
        };
      },
    }),
  );
  assertEquals(promptOptions?.milestoneBranch, "milestone/v2");
});

Deno.test("runExecuteClaudePhase - Claude execution error returns failure", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runClaudeWithRetry: async () => ({
        ok: false,
        error: new Error("Claude CLI not found"),
      }),
    }),
  );
  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "execution_error");
  assertStringIncludes(result.failureMessage!, "Claude CLI not found");
});

Deno.test("runExecuteClaudePhase - timeout with zero output includes diagnostic context", async () => {
  const result = await runExecuteClaudePhase(
    createTestOptions({ claudeTimeout: 14400, claudeNoOutputTimeout: 900 }),
    createMockDeps({
      runClaudeWithRetry: async () => ({
        ok: true,
        value: {
          exitCode: 124,
          output: "",
          timedOut: true,
        },
      }),
    }),
  );
  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "timeout");
  assertStringIncludes(result.diagnosticContext!, "health_check=passed");
  assertStringIncludes(result.diagnosticContext!, "clarity=clear");
});

// --- Prompt caching tests (Issue #1262) ---

Deno.test("runExecuteClaudePhase - passes system prompt to Claude runner for caching", async () => {
  let capturedSystemPrompt: string | undefined;
  let capturedPromptSha: string | undefined;
  let capturedCacheHit: boolean | undefined;
  await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      buildCachedIssuePrompt: async () => ({
        ok: true,
        value: {
          systemPrompt: "Cached guidelines content",
          prompt: "Dynamic issue content",
          promptSha: "c".repeat(64),
          cacheHit: true,
        },
      }),
      runClaudeWithRetry: async (options) => {
        capturedSystemPrompt = options.systemPrompt;
        capturedPromptSha = options.promptSha;
        capturedCacheHit = options.promptCacheHit;
        return {
          ok: true,
          value: { exitCode: 0, output: "Done.", timedOut: false },
        };
      },
    }),
  );
  assertEquals(capturedSystemPrompt, "Cached guidelines content");
  assertEquals(capturedPromptSha, "c".repeat(64));
  assertEquals(capturedCacheHit, true);
});

// --- Session resume tests (Issue #1324) ---

Deno.test("runExecuteClaudePhase - passes sessionResumeState to Claude runner", async () => {
  let capturedSessionState:
    | import("../lib/session_resume.ts").SessionResumeState
    | undefined;
  await runExecuteClaudePhase(
    createTestOptions({
      sessionResumeState: {
        sessionId: "owner-repo-42-1700000000000",
        phaseCount: 1,
      },
    }),
    createMockDeps({
      runClaudeWithRetry: async (options) => {
        capturedSessionState = options.sessionResumeState;
        return {
          ok: true,
          value: { exitCode: 0, output: "Done.", timedOut: false },
        };
      },
    }),
  );
  assertEquals(capturedSessionState?.sessionId, "owner-repo-42-1700000000000");
  assertEquals(capturedSessionState?.phaseCount, 1);
});

Deno.test("runExecuteClaudePhase - sessionResumeState is undefined when not provided", async () => {
  let capturedSessionState:
    | import("../lib/session_resume.ts").SessionResumeState
    | undefined = {
      sessionId: "sentinel",
      phaseCount: -1,
    };
  await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runClaudeWithRetry: async (options) => {
        capturedSessionState = options.sessionResumeState;
        return {
          ok: true,
          value: { exitCode: 0, output: "Done.", timedOut: false },
        };
      },
    }),
  );
  assertEquals(capturedSessionState, undefined);
});

// --- Phase routing test (Issue #2709) ---

Deno.test("runExecuteClaudePhase - routes the coding run through phase 'issue'", async () => {
  let capturedPhase: string | undefined = "sentinel";
  await runExecuteClaudePhase(
    createTestOptions(),
    createMockDeps({
      runClaudeWithRetry: async (options) => {
        capturedPhase = options.phase;
        return {
          ok: true,
          value: { exitCode: 0, output: "Done.", timedOut: false },
        };
      },
    }),
  );
  // The coding phase must pass an explicit `phase: "issue"` so model/effort
  // resolve through the documented phase precedence chain rather than the CLI
  // default (Issue #2709).
  assertEquals(capturedPhase, "issue");
});
