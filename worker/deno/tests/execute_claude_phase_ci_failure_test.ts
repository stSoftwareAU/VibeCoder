/**
 * Tests for CI-failure log auto-fetch wiring in the issue phase (Issue #3581).
 *
 * A CI-failure issue must trigger the log fetch **before** the prompt is
 * built, and the fetched context must reach the prompt builder. An issue
 * without a configured failure label must not trigger any fetch.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import type { CachedIssuePromptOptions } from "../lib/prompt_builder_cache.ts";

function createMockDeps(
  overrides: Partial<ExecuteClaudePhaseDeps> = {},
): ExecuteClaudePhaseDeps {
  return {
    runClaudeWithRetry: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 0, output: "done", timedOut: false },
      }),
    buildIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "sys", prompt: "user" },
      }),
    buildCachedIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: {
          systemPrompt: "sys",
          prompt: "user",
          promptSha: "a".repeat(64),
          cacheHit: false,
        },
      }),
    validateRepoState: () =>
      Promise.resolve({
        ok: true,
        value: { valid: true, actions: [], warnings: [] },
      }),
    findExistingPrForBranch: () =>
      Promise.resolve({ ok: false, error: new Error("No PR found") }),
    retargetPrToMilestone: () => Promise.resolve({ ok: true, value: "ok" }),
    finalisePr: () => Promise.resolve({ ok: true, value: "ok" }),
    ensureIssueClosedIfPrMerged: () =>
      Promise.resolve({ ok: true, value: undefined }),
    runGitCommand: (args: string[]) =>
      Promise.resolve({
        ok: true,
        value: args[0] === "status" ? "M src/main.ts" : "",
      }),
    recordHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    clearHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    getPromptsCommit: () => Promise.resolve({ ok: true, value: "abc1234" }),
    log: () => {},
    ...overrides,
  };
}

function createTestOptions(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Develop pipeline build failed",
    issueBody: "- **Build number:** `4347`",
    issueLabels: "develop-build-failure",
    githubUser: "bot-user",
    branchName: "issue-42-build-failure",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/test-work-3581",
    includeRecentActivity: false,
    ...overrides,
  };
}

Deno.test("runExecuteClaudePhase - CI-failure label triggers the log fetch", async () => {
  const seen: { issueBody?: string; jobPath?: string } = {};
  let promptOptions: CachedIssuePromptOptions | undefined;

  const result = await runExecuteClaudePhase(
    createTestOptions({
      repoConfigs: {
        "owner/repo": {
          ciFailureLabels: ["develop-build-failure"],
          ciFailureJobPath: "Migration/job/Develop",
        },
      },
    }),
    createMockDeps({
      buildCiFailureContext: (opts) => {
        seen.issueBody = opts.issueBody;
        seen.jobPath = opts.jobPath;
        return Promise.resolve("## CI Failure Diagnosis\nfetched build #4347");
      },
      buildCachedIssuePrompt: (opts) => {
        promptOptions = opts;
        return Promise.resolve({
          ok: true,
          value: {
            systemPrompt: "sys",
            prompt: "user",
            promptSha: "a".repeat(64),
            cacheHit: false,
          },
        });
      },
    }),
  );

  assertEquals(result.action, "success");
  assertEquals(seen.issueBody, "- **Build number:** `4347`");
  assertEquals(seen.jobPath, "Migration/job/Develop");
  assert(promptOptions, "prompt builder was not called");
  assertStringIncludes(
    promptOptions.ciFailureContext ?? "",
    "fetched build #4347",
  );
});

Deno.test("runExecuteClaudePhase - no configured label means no fetch", async () => {
  let called = false;
  let promptOptions: CachedIssuePromptOptions | undefined;

  await runExecuteClaudePhase(
    createTestOptions({ issueLabels: "bug,work-on" }),
    createMockDeps({
      buildCiFailureContext: () => {
        called = true;
        return Promise.resolve("should not happen");
      },
      buildCachedIssuePrompt: (opts) => {
        promptOptions = opts;
        return Promise.resolve({
          ok: true,
          value: {
            systemPrompt: "sys",
            prompt: "user",
            promptSha: "a".repeat(64),
            cacheHit: false,
          },
        });
      },
    }),
  );

  assertEquals(called, false);
  assertEquals(promptOptions?.ciFailureContext, undefined);
});

Deno.test("runExecuteClaudePhase - label configured but issue lacks it means no fetch", async () => {
  let called = false;

  await runExecuteClaudePhase(
    createTestOptions({
      issueLabels: "enhancement",
      repoConfigs: {
        "owner/repo": { ciFailureLabels: ["develop-build-failure"] },
      },
    }),
    createMockDeps({
      buildCiFailureContext: () => {
        called = true;
        return Promise.resolve("should not happen");
      },
    }),
  );

  assertEquals(called, false);
});

Deno.test("runExecuteClaudePhase - log fence and prompt share one boundary id (Issue #3639)", async () => {
  let fetchBoundaryId: string | undefined;
  let promptOptions: CachedIssuePromptOptions | undefined;

  await runExecuteClaudePhase(
    createTestOptions({
      repoConfigs: {
        "owner/repo": {
          ciFailureLabels: ["develop-build-failure"],
          ciFailureJobPath: "Migration/job/Develop",
        },
      },
    }),
    createMockDeps({
      buildCiFailureContext: (opts) => {
        fetchBoundaryId = opts.boundaryId;
        return Promise.resolve("## CI Failure Diagnosis");
      },
      buildCachedIssuePrompt: (opts) => {
        promptOptions = opts;
        return Promise.resolve({
          ok: true,
          value: {
            systemPrompt: "sys",
            prompt: "user",
            promptSha: "a".repeat(64),
            cacheHit: false,
          },
        });
      },
    }),
  );

  assert(fetchBoundaryId, "no boundary id was handed to the log fetcher");
  // A CSPRNG nonce the attacker cannot guess, shared with the prompt builder
  // so the integrity instruction covers the fenced console log.
  assertMatch(fetchBoundaryId, /^[0-9a-f]{12}$/);
  assertEquals(promptOptions?.ciFailureBoundaryId, fetchBoundaryId);
});
