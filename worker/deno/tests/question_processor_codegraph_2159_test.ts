/**
 * CodeGraph wiring in the question run (Issue #2159, part of #2145).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { processIssueQuestion } from "../lib/question_processor.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import type { GitHubClient } from "../types.ts";
import {
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
  type PrepareCodegraphContextOptions,
} from "../lib/codegraph_context.ts";

/** A gh client that answers everything the answer path needs. */
function stubGhClient(): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 2159,
        title: "How does the retry logic work?",
        body: "",
        labels: [],
        author: "user",
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as unknown as GitHubClient;
}

interface Observed {
  runOptions: Record<string, unknown>[];
  prepared: PrepareCodegraphContextOptions[];
  queries?: number;
  status?: string;
}

async function runQuestion(
  enabled: boolean,
  codegraph: CodegraphContextResult,
  toolCallCounts?: Record<string, number>,
): Promise<Observed> {
  const config = buildDefaultWorkerConfig();
  config.workDir = "/tmp/codegraph-2159-work";
  config.codegraphContext = { enabled };
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 2159,
    issueTitle: "How does the retry logic work?",
    issueBody: "Explain it.",
    issueLabels: ["question"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const observed: Observed = { runOptions: [], prepared: [] };
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: Record<string, unknown>) => {
        observed.runOptions.push(options);
        return Promise.resolve({
          ok: true,
          value: {
            output: "The retry logic uses exponential backoff.",
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
  });

  const result = await processIssueQuestion(ctx, {
    ghClient: stubGhClient(),
    logger: deps.logger,
    deps,
  });
  assert(result.ok, "the question run must succeed");
  observed.status = result.value.codegraphContext?.status;
  observed.queries = result.value.codegraphContext?.queries;
  return observed;
}

Deno.test("question_processor - the switch off leaves the invocation untouched", async () => {
  const observed = await runQuestion(false, { status: "off", enabled: false });

  assertEquals(observed.prepared[0]?.enabled, false);
  assertEquals(
    Object.hasOwn(observed.runOptions[0] ?? {}, "mcpConfig"),
    false,
    "an off host must write no MCP configuration at all",
  );
  assertEquals(
    String(observed.runOptions[0]?.prompt).includes("CodeGraph index"),
    false,
  );
  assertEquals(observed.status, "off");
});

Deno.test("question_processor - an indexed run gets the line and the server together", async () => {
  const observed = await runQuestion(
    true,
    { status: "ok", enabled: true, nodeCount: 1, relationshipCount: 2 },
    { mcp__codegraph__codegraph_explore: 4 },
  );

  assertEquals(observed.prepared[0]?.repoDir, "/tmp/codegraph-2159-work/repo");

  const prompt = String(observed.runOptions[0]?.prompt);
  assertStringIncludes(prompt, CODEGRAPH_PROMPT_LINE);
  assertEquals(prompt.split(CODEGRAPH_PROMPT_LINE).length - 1, 1);

  const mcp = observed.runOptions[0]?.mcpConfig as {
    playwright?: boolean;
    servers?: Record<string, { command: string }>;
  };
  assertEquals(mcp.playwright, false);
  assertEquals(mcp.servers?.codegraph?.command, "codegraph");
  assertEquals(observed.status, "ok");
  assertEquals(observed.queries, 4);
});

Deno.test("question_processor - a failed index adds neither half", async () => {
  for (const status of ["failed", "unsupported"] as const) {
    const observed = await runQuestion(true, { status, enabled: true }, {
      Bash: 2,
    });

    assertEquals(
      Object.hasOwn(observed.runOptions[0] ?? {}, "mcpConfig"),
      false,
    );
    assertEquals(
      String(observed.runOptions[0]?.prompt).includes("CodeGraph index"),
      false,
    );
    assertEquals(observed.status, status);
    assertEquals(observed.queries, 0);
  }
});
