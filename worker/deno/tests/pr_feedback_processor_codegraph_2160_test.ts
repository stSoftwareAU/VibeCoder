/**
 * CodeGraph wiring in the PR-feedback run (Issue #2160, part of #2145).
 *
 * Mirrors the issue-path suite: off changes nothing, an indexed run gets the
 * MCP entry and the prompt line together, and any other status gets neither
 * while the run itself carries on. The Playwright browser rides beside it on
 * every run unless the repo sets `skip_screenshot_check` (Issue #2925).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger, RepoConfig } from "../types.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";
import {
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
  type PrepareCodegraphContextOptions,
} from "../lib/codegraph_context.ts";
import { assertCodegraphRootedAt } from "./support/codegraph_mcp_root.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

interface Observed {
  runOptions: Record<string, unknown>[];
  prepared: PrepareCodegraphContextOptions[];
  status?: string;
  queries?: number;
}

async function runFeedback(
  enabled: boolean,
  codegraph: CodegraphContextResult,
  toolCallCounts?: Record<string, number>,
  repoConfigs?: Record<string, RepoConfig>,
): Promise<Observed> {
  const observed: Observed = { runOptions: [], prepared: [] };
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: ((options: Record<string, unknown>) => {
      observed.runOptions.push(options);
      return Promise.resolve({
        ok: true,
        value: {
          output: "Fixed the typo",
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
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    prepareCodegraphContext: ((
      prepareOptions: PrepareCodegraphContextOptions,
    ) => {
      observed.prepared.push(prepareOptions);
      return Promise.resolve(codegraph);
    }) as unknown as ClaudeDeps["prepareCodegraphContext"],
  };
  const mockGithub: Partial<GitHubDeps> = { runGhCommand: openPrGh() };
  const deps = createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
    },
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/codegraph-2160-clone",
    workRoot: "/tmp/codegraph-2160-work",
    codegraphContextEnabled: enabled,
    ...(repoConfigs ? { repoConfigs } : {}),
    verifyPushFn: () =>
      Promise.resolve({
        landed: true,
        localSha: "f".repeat(40),
        remoteSha: "f".repeat(40),
        reason: "verified in test",
      }),
  };

  const result = await processPrFeedback({
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    commentType: "review",
    commentId: "123",
    commentBody: "Please fix the typo on line 10",
  }, processorDeps);
  assert(result.ok, "the feedback run must succeed");
  observed.status = result.value.codegraphContext?.status;
  observed.queries = result.value.codegraphContext?.queries;
  return observed;
}

Deno.test("pr_feedback_processor - the switch off leaves the invocation untouched", async () => {
  const observed = await runFeedback(false, { status: "off", enabled: false });

  assertEquals(observed.prepared[0]?.enabled, false);
  assertEquals(
    observed.runOptions[0]?.mcpConfig,
    true,
    "an off host adds no CodeGraph server — the browser alone is requested",
  );
  assertEquals(
    String(observed.runOptions[0]?.prompt).includes("CodeGraph index"),
    false,
  );
  assertEquals(observed.status, "off");
});

Deno.test("pr_feedback_processor - an indexed run gets the line and the server together", async () => {
  const observed = await runFeedback(
    true,
    { status: "ok", enabled: true, nodeCount: 1, relationshipCount: 2 },
    { mcp__codegraph__codegraph_explore: 3 },
  );

  assertEquals(observed.prepared[0]?.repoDir, "/tmp/codegraph-2160-clone");
  // The half of the pair invariant that lives outside `codegraph_run.ts`:
  // the runner writes no MCP configuration for a request without a `cwd`, so
  // the checkout indexed must be the checkout the agent is run in.
  assertEquals(observed.runOptions[0]?.cwd, observed.prepared[0]?.repoDir);

  const prompt = String(observed.runOptions[0]?.prompt);
  assertStringIncludes(prompt, CODEGRAPH_PROMPT_LINE);
  assertEquals(prompt.split(CODEGRAPH_PROMPT_LINE).length - 1, 1);

  const mcp = observed.runOptions[0]?.mcpConfig as {
    playwright?: boolean;
    servers?: Record<string, { command: string }>;
  };
  assertEquals(mcp.playwright, true);
  assertEquals(mcp.servers?.codegraph?.command, "codegraph");
  assertCodegraphRootedAt(
    mcp,
    observed.prepared[0]?.repoDir,
    "pr_feedback_processor",
  );
  assertEquals(observed.status, "ok");
  assertEquals(observed.queries, 3);
});

Deno.test("pr_feedback_processor - a failed index adds neither half", async () => {
  for (const status of ["failed", "unsupported"] as const) {
    const observed = await runFeedback(true, { status, enabled: true }, {
      Bash: 2,
    });

    assertEquals(observed.runOptions[0]?.mcpConfig, true);
    assertEquals(
      String(observed.runOptions[0]?.prompt).includes("CodeGraph index"),
      false,
    );
    assertEquals(observed.status, status);
    assertEquals(observed.queries, 0);
  }
});

Deno.test("pr_feedback_processor - the browser is granted unless skip_screenshot_check (Issue #2925)", async () => {
  // A reviewer asking for screenshots is where the missing browser bites.
  const granted = await runFeedback(false, { status: "off", enabled: false });
  assertEquals(granted.runOptions[0]?.mcpConfig, true);

  const withheld = await runFeedback(
    false,
    { status: "off", enabled: false },
    undefined,
    { "org/repo": { skipScreenshotCheck: true } as RepoConfig },
  );
  // `false` and absent both write no MCP configuration at all.
  assertEquals(
    Boolean(withheld.runOptions[0]?.mcpConfig),
    false,
    "a skip_screenshot_check repo with CodeGraph off writes no MCP config",
  );
});

// Issue #3402
Deno.test("pr_feedback_processor - a haiku sub-agent tier never puts an explorer (or any --agents) on a non-issue run (Issue #3402)", async () => {
  // `buildIssueRunAgents` — the sole source of the read-only `explorer` and
  // of `--agents` under the haiku tier — is wired only into the `issue`
  // phase's executors; a `pr_feedback` run must stay byte-identical to the
  // tier-unaware invocation regardless of `issue_sub_agent_tier`.
  const observed = await runFeedback(
    false,
    { status: "off", enabled: false },
    undefined,
    {
      "org/repo": { issueSubAgentTier: "haiku" } as RepoConfig,
    },
  );
  assertEquals(observed.runOptions[0]?.agents, undefined);
});
