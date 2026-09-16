/**
 * CodeGraph wiring in the planning run (Issue #2159, part of #2145).
 *
 * Planning makes several invocations in one round, so the index is prepared
 * once, every invocation is handed the same MCP entry and prompt line, and
 * the `codegraph_explore` calls are summed into one figure for the run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { processIssuePlanning } from "../lib/planning_processor.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import type { GitHubClient } from "../types.ts";
import {
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
  type PrepareCodegraphContextOptions,
} from "../lib/codegraph_context.ts";
import { assertCodegraphRootedAt } from "./support/codegraph_mcp_root.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const FLEET_LOGIN = "testbot";

/** The published plan the coverage gate reads back off the parent. */
function coverageReadResponse(): string {
  return JSON.stringify({
    body: "Parent",
    comments: [{
      author: { login: FLEET_LOGIN },
      body: [
        "## Plan published",
        "",
        "1. #131 — Break the issue down (`enhancement`)",
        "2. #132 — Carry it into the gate (`enhancement`, depends on #131)",
        "",
        "## Plan Coverage",
        "",
        "| Ask | Covered by | Notes |",
        "| --- | --- | --- |",
        "| Break the issue down | #131, #132 | Both published |",
      ].join("\n"),
    }],
  });
}

function isCoverageRead(args: string[]): boolean {
  const jsonIdx = args.indexOf("--json");
  return args[0] === "issue" && args[1] === "view" && jsonIdx >= 0 &&
    (args[jsonIdx + 1] ?? "").includes("comments");
}

function stubGhClient(): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 100,
        title: "Break down auth refactor",
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
  status?: string;
  queries?: number;
  subIssueCount?: number;
}

/**
 * Drive one planning round: turn 1 drafts prose, turn 2 publishes the URLs,
 * so the round genuinely makes two invocations.
 */
async function runPlanning(
  enabled: boolean,
  codegraph: CodegraphContextResult,
  tallies: (Record<string, number> | undefined)[] = [],
): Promise<Observed> {
  const config = buildDefaultWorkerConfig();
  config.workDir = "/tmp/codegraph-2159-work";
  config.codegraphContext = { enabled };
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 100,
    issueTitle: "Break down auth refactor",
    issueBody: "This issue needs to be broken into sub-issues.",
    issueLabels: ["planning"],
    issueComments: "",
    githubUser: FLEET_LOGIN,
    config,
  };
  const observed: Observed = { runOptions: [], prepared: [] };

  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: Record<string, unknown>) => {
        const turn = observed.runOptions.length;
        observed.runOptions.push(options);
        const tally = tallies[turn];
        return Promise.resolve({
          ok: true,
          value: {
            output: turn === 0
              ? "Draft plan: this needs two sub-issues."
              : "Created https://github.com/org/repo/issues/131 and " +
                "https://github.com/org/repo/issues/132",
            exitCode: 0,
            timedOut: false,
            ...(tally
              ? {
                runStats: {
                  servedModels: [],
                  requestedModel: "opus",
                  wallClockMs: 1,
                  toolCallCounts: tally,
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
    github: {
      runGhCommand: ((args: string[]) => {
        if (isCoverageRead(args)) {
          return Promise.resolve(coverageReadResponse());
        }
        return Promise.resolve("");
      }) as never,
    },
  });

  const result = await processIssuePlanning(ctx, {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(),
    logger: deps.logger,
    deps,
  });
  assert(result.ok, "the planning round must succeed");
  observed.status = result.value.codegraphContext?.status;
  observed.queries = result.value.codegraphContext?.queries;
  observed.subIssueCount = result.value.subIssueCount;
  return observed;
}

Deno.test("planning_processor - the switch off leaves every invocation untouched", async () => {
  const observed = await runPlanning(false, { status: "off", enabled: false });

  assertEquals(observed.prepared.length, 1, "prepared once, even when off");
  assertEquals(observed.prepared[0]?.enabled, false);
  assert(observed.runOptions.length >= 2, "the round must make its two turns");
  for (const options of observed.runOptions) {
    assertEquals(Object.hasOwn(options, "mcpConfig"), false);
    assertEquals(String(options.prompt).includes("CodeGraph index"), false);
  }
  assertEquals(observed.status, "off");
});

Deno.test("planning_processor - one index serves every invocation of the round", async () => {
  const observed = await runPlanning(
    true,
    { status: "ok", enabled: true, nodeCount: 8, relationshipCount: 9 },
    [{ codegraph_explore: 2 }, { codegraph_explore: 3, Bash: 1 }],
  );

  // Prepared once for the round, against the repository checkout.
  assertEquals(observed.prepared.length, 1);
  assertEquals(observed.prepared[0]?.repoDir, "/tmp/codegraph-2159-work/repo");

  assert(observed.runOptions.length >= 2);
  for (const options of observed.runOptions) {
    const prompt = String(options.prompt);
    assertStringIncludes(prompt, CODEGRAPH_PROMPT_LINE);
    assertEquals(prompt.split(CODEGRAPH_PROMPT_LINE).length - 1, 1);
    const mcp = options.mcpConfig as {
      playwright?: boolean;
      servers?: Record<string, { command: string }>;
    };
    assertEquals(mcp.playwright, false);
    assertEquals(mcp.servers?.codegraph?.command, "codegraph");
    // The agent's `cwd` here is the work volume — the parent of every clone —
    // so the server has to name the indexed checkout itself (Issue #2200).
    assertEquals(options.cwd, "/tmp/codegraph-2159-work");
    assertCodegraphRootedAt(
      mcp,
      observed.prepared[0]?.repoDir,
      "planning_processor",
    );
  }

  assertEquals(observed.status, "ok");
  assertEquals(observed.queries, 5, "queries are summed across invocations");
  assertEquals(observed.subIssueCount, 2);
});

Deno.test("planning_processor - a failed index adds neither half and the round proceeds", async () => {
  for (const status of ["failed", "unsupported"] as const) {
    const observed = await runPlanning(true, { status, enabled: true }, [
      { Bash: 1 },
      { Bash: 2 },
    ]);

    for (const options of observed.runOptions) {
      assertEquals(Object.hasOwn(options, "mcpConfig"), false);
      assertEquals(String(options.prompt).includes("CodeGraph index"), false);
    }
    assertEquals(observed.status, status);
    assertEquals(observed.queries, 0);
    assertEquals(observed.subIssueCount, 2);
  }
});
