/**
 * CodeGraph wiring in the main-loop execute phase (Issue #2159, part of #2145).
 *
 * The fleet path indexes the lane's own checkout, hands the agent the
 * `codegraph` MCP entry and the one prompt line together or not at all, and
 * records the outcome on the phase state beside `claudeRunStats`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import {
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
  type PrepareCodegraphContextOptions,
} from "../lib/codegraph_context.ts";

/** What one execute-phase run handed the agent, plus the resulting state. */
interface Observed {
  runOptions: Record<string, unknown>[];
  prepared: PrepareCodegraphContextOptions[];
  state: PhaseState;
}

async function runPhase(
  enabled: boolean,
  codegraph: CodegraphContextResult,
  toolCallCounts?: Record<string, number>,
): Promise<Observed> {
  const config = buildDefaultWorkerConfig();
  config.codegraphContext = { enabled };
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 2159,
    issueTitle: "Wire CodeGraph in",
    issueBody: "Do the thing.",
    issueLabels: ["enhancement"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-2159-wire-codegraph-in",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/codegraph-2159-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const observed: Observed = { runOptions: [], prepared: [], state };

  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: Record<string, unknown>) => {
        observed.runOptions.push(options);
        return Promise.resolve({
          ok: true,
          value: {
            output: "done",
            exitCode: 0,
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
      }) as never,
      prepareCodegraphContext: ((
        prepareOptions: PrepareCodegraphContextOptions,
      ) => {
        observed.prepared.push(prepareOptions);
        return Promise.resolve(codegraph);
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);
  return observed;
}

Deno.test("execute_phase - the switch off leaves the prompt and MCP config untouched", async () => {
  const observed = await runPhase(false, { status: "off", enabled: false });

  assertEquals(observed.prepared[0]?.enabled, false);
  assertEquals(observed.runOptions[0]?.mcpConfig, false);
  assertEquals(
    String(observed.runOptions[0]?.prompt).includes("CodeGraph index"),
    false,
  );
  assertEquals(observed.state.codegraphContext?.status, "off");
});

Deno.test("execute_phase - an indexed run gets the line and the server together", async () => {
  const observed = await runPhase(
    true,
    {
      status: "ok",
      enabled: true,
      indexSeconds: 9,
      nodeCount: 3,
      relationshipCount: 4,
    },
    { codegraph_explore: 5 },
  );

  // Indexed against the lane's own checkout — the same path handed as `cwd`.
  assertEquals(observed.prepared[0]?.repoDir, "/tmp/codegraph-2159-repo");
  assertEquals(observed.runOptions[0]?.cwd, "/tmp/codegraph-2159-repo");

  const prompt = String(observed.runOptions[0]?.prompt);
  assertStringIncludes(prompt, CODEGRAPH_PROMPT_LINE);
  assertEquals(prompt.split(CODEGRAPH_PROMPT_LINE).length - 1, 1);

  const mcp = observed.runOptions[0]?.mcpConfig as {
    playwright?: boolean;
    servers?: Record<string, { command: string }>;
  };
  assertEquals(mcp.playwright, false);
  assertEquals(mcp.servers?.codegraph?.command, "codegraph");

  assertEquals(observed.state.codegraphContext?.status, "ok");
  assertEquals(observed.state.codegraphContext?.queries, 5);
});

Deno.test("execute_phase - a failed index adds neither half and the run proceeds", async () => {
  for (const status of ["failed", "unsupported"] as const) {
    const observed = await runPhase(true, { status, enabled: true }, {
      Bash: 3,
    });

    assertEquals(observed.runOptions[0]?.mcpConfig, false);
    assertEquals(
      String(observed.runOptions[0]?.prompt).includes("CodeGraph index"),
      false,
    );
    assertEquals(observed.state.codegraphContext?.status, status);
    assertEquals(observed.state.codegraphContext?.queries, 0);
    assert(
      observed.runOptions.length >= 1,
      "the agent must still have been invoked",
    );
  }
});
