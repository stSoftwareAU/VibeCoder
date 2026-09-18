/**
 * The standalone issue phase hands the agent Graft's tools beside the bundle
 * (Issue #2314, part of #2060).
 *
 * Mirrors `execute_claude_phase_codegraph_2159_test.ts`: on an `ok`
 * collection the `graft` MCP server and the prompt line arrive together, the
 * tally lands on the phase result, and a collection short of `ok` changes
 * nothing about the prompt or the MCP request.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import {
  type CollectGraftContextOptions,
  GRAFT_PROMPT_LINE,
  type GraftContextResult,
} from "../lib/graft_context.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";

interface Observed {
  runOptions?: RunClaudeOptions;
  collected: CollectGraftContextOptions[];
  logs: string[];
}

function okCollection(): GraftContextResult {
  return {
    status: "ok",
    enabled: true,
    buildSeconds: 2.2,
    bundleChars: 52,
    nodeCount: 820,
    callEdgeCount: 1204,
    bundle: "export function parseIsoDate(raw: string): number {}",
  };
}

function createDeps(
  observed: Observed,
  graft: GraftContextResult,
  toolCallCounts?: Record<string, number>,
): ExecuteClaudePhaseDeps {
  return {
    runClaudeWithRetry: (options: RunClaudeOptions) => {
      observed.runOptions = options;
      return Promise.resolve({
        ok: true as const,
        value: {
          exitCode: 0,
          output: "done",
          timedOut: false,
          ...(toolCallCounts
            ? {
              runStats: {
                servedModels: [],
                requestedModel: "opus",
                wallClockMs: 1,
                toolCallCounts,
              },
            }
            : {}),
        },
      });
    },
    collectGraftContext: (options: CollectGraftContextOptions) => {
      observed.collected.push(options);
      return Promise.resolve(graft);
    },
    buildIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "sys", prompt: "user" },
      }),
    buildCachedIssuePrompt: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          systemPrompt: "sys",
          prompt: "---BEGIN UNTRUSTED---\nissue body\n---END UNTRUSTED---",
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
    runGitCommand: () => Promise.resolve({ ok: true, value: "" }),
    recordHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    clearHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    getPromptsCommit: () => Promise.resolve({ ok: true, value: "abc1234" }),
    log: (message: string) => observed.logs.push(message),
  };
}

function options(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 2314,
    issueTitle: "Hand the agent Graft's tools",
    issueBody: "Do the thing.",
    issueLabels: "enhancement",
    githubUser: "bot-user",
    branchName: "issue-2314-graft-tools",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/graft-2314-work",
    includeRecentActivity: false,
    includeCodebaseMap: false,
    ...overrides,
  };
}

Deno.test("execute_claude_phase - the switch off leaves the prompt and MCP config untouched (Issue #2314)", async () => {
  const observed: Observed = { collected: [], logs: [] };
  const result = await runExecuteClaudePhase(
    options(),
    createDeps(observed, { status: "off", enabled: false }),
  );
  assertEquals(observed.collected[0]?.enabled, false);
  assertEquals(observed.runOptions?.mcpConfig, false);
  assertEquals(
    observed.runOptions?.prompt?.includes(GRAFT_PROMPT_LINE),
    false,
    "an off host must not mention the Graft tools",
  );
  assertEquals(result.graftContext?.status, "off");
  assertEquals(result.graftContext?.queries, undefined);
});

Deno.test("execute_claude_phase - an ok collection gets the line and the server together (Issue #2314)", async () => {
  const observed: Observed = { collected: [], logs: [] };
  const result = await runExecuteClaudePhase(
    options({ graftContextEnabled: true }),
    createDeps(observed, okCollection(), {
      mcp__graft__graft_find_code: 4,
      mcp__graft__graft_file_api: 2,
      Bash: 3,
    }),
  );

  // Built against the repository checkout, not the work volume.
  assertEquals(observed.collected[0]?.enabled, true);
  assertEquals(observed.collected[0]?.repoDir, "/tmp/graft-2314-work/repo");

  const prompt = observed.runOptions?.prompt ?? "";
  assertStringIncludes(prompt, GRAFT_PROMPT_LINE);
  assertEquals(
    prompt.split(GRAFT_PROMPT_LINE).length - 1,
    1,
    "the line must appear exactly once",
  );
  assert(
    prompt.indexOf(GRAFT_PROMPT_LINE) > prompt.indexOf("---END UNTRUSTED---"),
    "the line must sit outside the untrusted fence",
  );

  const mcp = observed.runOptions?.mcpConfig;
  assert(typeof mcp === "object", "the graft server must be requested");
  assertEquals(mcp.playwright, false, "no screenshot, no browser grant");
  assertEquals(mcp.servers?.graft?.command, "graft");
  assertEquals(mcp.servers?.graft?.args, ["mcp", "/tmp/graft-2314-work/repo"]);

  assertEquals(result.graftContext?.status, "ok");
  assertEquals(result.graftContext?.queries, 6);
  assertEquals(result.graftContext?.bundle, undefined, "never serialised");
  assert(
    observed.logs.some((line) => line.includes("Graft tools: handed to")),
    `the hand-over is logged, got: ${observed.logs.join(" | ")}`,
  );
});

Deno.test("execute_claude_phase - a failed collection adds neither half and never fails the run (Issue #2314)", async () => {
  const observed: Observed = { collected: [], logs: [] };
  const result = await runExecuteClaudePhase(
    options({ graftContextEnabled: true }),
    createDeps(
      observed,
      { status: "failed", enabled: true, buildSeconds: 300 },
      { Bash: 3 },
    ),
  );
  assertEquals(observed.runOptions?.mcpConfig, false);
  assertEquals(
    (observed.runOptions?.prompt ?? "").includes(GRAFT_PROMPT_LINE),
    false,
  );
  assertEquals(result.graftContext?.status, "failed");
  assertEquals(result.graftContext?.queries, undefined);
});

Deno.test("execute_claude_phase - a screenshot run keeps its browser grant beside the graft server (Issue #2314)", async () => {
  const observed: Observed = { collected: [], logs: [] };
  await runExecuteClaudePhase(
    options({ graftContextEnabled: true, issueLabels: "needs-screenshot" }),
    createDeps(observed, okCollection()),
  );
  const mcp = observed.runOptions?.mcpConfig;
  assert(typeof mcp === "object");
  assertEquals(mcp.playwright, true);
  assertEquals(mcp.servers?.graft?.command, "graft");
});

Deno.test("execute_claude_phase - the summary pass is threaded to the collector when configured (Issue #2315)", async () => {
  const observed: Observed = { collected: [], logs: [] };
  const deep = {
    provider: "anthropic" as const,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    timeoutSeconds: 900,
  };
  await runExecuteClaudePhase(
    options({ graftContextEnabled: true, graftContextDeep: deep }),
    createDeps(observed, okCollection()),
  );
  assertEquals(observed.collected[0]?.deep, deep);

  const plain: Observed = { collected: [], logs: [] };
  await runExecuteClaudePhase(
    options({ graftContextEnabled: true }),
    createDeps(plain, okCollection()),
  );
  assertEquals(plain.collected[0]?.deep, undefined);
});
