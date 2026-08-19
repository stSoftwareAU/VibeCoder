/**
 * Tests for the security-fix gate verdict reaching the retry prompt
 * (Issue #4057).
 *
 * A blocked attempt records its missing evidence in worker run state. The next
 * attempt on the same issue must read it from there — not from the gate's own
 * issue comment, which the service account authors and the comment trust
 * filter therefore discards — and hand it to the prompt builder.
 *
 * Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import type { CachedIssuePromptOptions } from "../lib/prompt_builder_cache.ts";
import {
  recordSecurityFixGateBlock,
  resolveSecurityGateStateDir,
} from "../lib/security_fix_gate_feedback.ts";

const REPO = "owner/repo";
const ISSUE = 4030;

function createMockDeps(
  capture: (opts: CachedIssuePromptOptions) => void,
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
    buildCachedIssuePrompt: (opts) => {
      capture(opts);
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
    getLatestVersion: () => Promise.resolve({ ok: true, value: "v31" }),
    log: () => {},
  };
}

function createTestOptions(workDir: string): ExecuteClaudePhaseOptions {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Fix the injection flaw",
    issueBody: "The parser concatenates user input into a query.",
    issueLabels: "security,work-on",
    githubUser: "bot-user",
    branchName: "issue-4030-injection",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir,
    includeRecentActivity: false,
  };
}

/** Run a body against a temporary workDir, cleaning up afterwards. */
async function withWorkDir(
  body: (workDir: string, stateDir: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  const workDir = `${root}/work`;
  try {
    await body(workDir, resolveSecurityGateStateDir(workDir));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("execute phase - a recorded gate verdict reaches the prompt builder", async () => {
  await withWorkDir(async (workDir, stateDir) => {
    await recordSecurityFixGateBlock(stateDir, REPO, ISSUE, [
      "test-identifier-in-diff",
      "trigger-closed",
    ]);

    let promptOptions: CachedIssuePromptOptions | undefined;
    const result = await runExecuteClaudePhase(
      createTestOptions(workDir),
      createMockDeps((opts) => {
        promptOptions = opts;
      }),
    );

    assertEquals(result.action, "success");
    assert(promptOptions, "prompt builder was not called");
    assertEquals(promptOptions.securityGateBlock?.missing, [
      "test-identifier-in-diff",
      "trigger-closed",
    ]);
    assertEquals(promptOptions.securityGateBlock?.blockCount, 1);
  });
});

Deno.test("execute phase - no recorded verdict means no retry context", async () => {
  await withWorkDir(async (workDir) => {
    let promptOptions: CachedIssuePromptOptions | undefined;
    await runExecuteClaudePhase(
      createTestOptions(workDir),
      createMockDeps((opts) => {
        promptOptions = opts;
      }),
    );

    assertEquals(promptOptions?.securityGateBlock, undefined);
  });
});

Deno.test("execute phase - another issue's verdict is not replayed", async () => {
  await withWorkDir(async (workDir, stateDir) => {
    await recordSecurityFixGateBlock(stateDir, REPO, ISSUE + 1, [
      "trigger-closed",
    ]);

    let promptOptions: CachedIssuePromptOptions | undefined;
    await runExecuteClaudePhase(
      createTestOptions(workDir),
      createMockDeps((opts) => {
        promptOptions = opts;
      }),
    );

    assertEquals(promptOptions?.securityGateBlock, undefined);
  });
});
