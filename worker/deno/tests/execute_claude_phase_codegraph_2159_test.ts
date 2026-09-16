/**
 * CodeGraph wiring in the standalone issue phase (Issue #2159, part of #2145).
 *
 * The phase must index the checkout only when the host switch is on, hand the
 * agent the `codegraph` MCP entry and the single prompt line together or not
 * at all, and carry the outcome — including the run's query tally — on its
 * return value.
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
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
  type PrepareCodegraphContextOptions,
} from "../lib/codegraph_context.ts";
import { assertCodegraphRootedAt } from "./support/codegraph_mcp_root.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";

/** What one phase run handed the agent. */
interface Observed {
  runOptions?: RunClaudeOptions;
  prepared: PrepareCodegraphContextOptions[];
}

function createDeps(
  observed: Observed,
  codegraph: CodegraphContextResult,
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
    prepareCodegraphContext: (options: PrepareCodegraphContextOptions) => {
      observed.prepared.push(options);
      return Promise.resolve(codegraph);
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
    log: () => {},
  };
}

function options(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 2159,
    issueTitle: "Wire CodeGraph in",
    issueBody: "Do the thing.",
    issueLabels: "enhancement",
    githubUser: "bot-user",
    branchName: "issue-2159-wire-codegraph-in",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/codegraph-2159-work",
    includeRecentActivity: false,
    includeCodebaseMap: false,
    ...overrides,
  };
}

Deno.test("execute_claude_phase - the switch off leaves the prompt and MCP config untouched", async () => {
  const observed: Observed = { prepared: [] };
  const result = await runExecuteClaudePhase(
    options(),
    createDeps(observed, { status: "off", enabled: false }),
  );

  assertEquals(observed.prepared[0]?.enabled, false);
  assertEquals(observed.runOptions?.mcpConfig, false);
  assertEquals(
    observed.runOptions?.prompt?.includes("CodeGraph index"),
    false,
    "an off host must not mention CodeGraph in the prompt",
  );
  assertEquals(result.codegraphContext?.status, "off");
});

Deno.test("execute_claude_phase - an indexed run gets the line and the server together", async () => {
  const observed: Observed = { prepared: [] };
  const result = await runExecuteClaudePhase(
    options({ codegraphContextEnabled: true }),
    createDeps(
      observed,
      {
        status: "ok",
        enabled: true,
        indexSeconds: 4,
        nodeCount: 10,
        relationshipCount: 20,
      },
      { mcp__codegraph__codegraph_explore: 7, Bash: 2 },
    ),
  );

  // The index was built against the repository checkout, not the work volume.
  assertEquals(observed.prepared[0]?.enabled, true);
  assertEquals(observed.prepared[0]?.repoDir, "/tmp/codegraph-2159-work/repo");

  const prompt = observed.runOptions?.prompt ?? "";
  assertStringIncludes(prompt, CODEGRAPH_PROMPT_LINE);
  assertEquals(
    prompt.split(CODEGRAPH_PROMPT_LINE).length - 1,
    1,
    "the line must appear exactly once",
  );
  assert(
    prompt.indexOf(CODEGRAPH_PROMPT_LINE) >
      prompt.indexOf("---END UNTRUSTED---"),
    "the line must sit outside the untrusted fence",
  );

  const mcp = observed.runOptions?.mcpConfig;
  assert(typeof mcp === "object", "the codegraph server must be requested");
  assertEquals(mcp.playwright, false);
  assertEquals(mcp.servers?.codegraph?.command, "codegraph");
  assertCodegraphRootedAt(
    mcp,
    observed.prepared[0]?.repoDir,
    "execute_claude_phase",
  );

  assertEquals(result.codegraphContext?.status, "ok");
  assertEquals(result.codegraphContext?.queries, 7);
});

Deno.test("execute_claude_phase - a failed index adds neither half and never fails the run", async () => {
  for (const status of ["failed", "unsupported"] as const) {
    const observed: Observed = { prepared: [] };
    const result = await runExecuteClaudePhase(
      options({ codegraphContextEnabled: true }),
      createDeps(observed, { status, enabled: true }, { Bash: 1 }),
    );

    assertEquals(observed.runOptions?.mcpConfig, false);
    assertEquals(
      observed.runOptions?.prompt?.includes("CodeGraph index"),
      false,
    );
    assertEquals(result.codegraphContext?.status, status);
    // The tally is still read: zero queries is a real figure.
    assertEquals(result.codegraphContext?.queries, 0);
    assert(result.action !== "failure", "losing the index must not fail a run");
  }
});

Deno.test("execute_claude_phase - the run names the checkout, so the MCP request is honoured", async () => {
  // Without a `cwd` the runner's `mcpRequest && cwd` gate writes no MCP
  // configuration, so the phase would append the prompt line and silently
  // drop the server it names — one half of the pair without the other.
  const observed: Observed = { prepared: [] };
  await runExecuteClaudePhase(
    options({ codegraphContextEnabled: true }),
    createDeps(observed, { status: "ok", enabled: true }),
  );

  assertEquals(observed.runOptions?.cwd, "/tmp/codegraph-2159-work/repo");
  assertEquals(observed.runOptions?.cwd, observed.prepared[0]?.repoDir);
  // The work volume stays the rate-limit signal's home (Issue #4315).
  assertEquals(observed.runOptions?.workDir, "/tmp/codegraph-2159-work");
});

Deno.test("execute_claude_phase - a screenshot run keeps its browser grant beside the index", async () => {
  const observed: Observed = { prepared: [] };
  await runExecuteClaudePhase(
    options({ codegraphContextEnabled: true, issueLabels: "needs-screenshot" }),
    createDeps(observed, { status: "ok", enabled: true }),
  );

  const mcp = observed.runOptions?.mcpConfig;
  assert(typeof mcp === "object");
  assertEquals(mcp.playwright, true);
  assertEquals(mcp.servers?.codegraph?.args, [
    "serve",
    "--mcp",
    "--path",
    "/tmp/codegraph-2159-work/repo",
  ]);
});
