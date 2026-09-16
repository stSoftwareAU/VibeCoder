/**
 * CodeGraph wiring in the CI-fix run (Issue #2160, part of #2145).
 *
 * Mirrors the issue-path suite, plus the one thing this path has that the
 * others do not: the post-quality retry reuses the index the first attempt
 * prepared rather than building a second one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import type { Logger } from "../types.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";
import {
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
  type PrepareCodegraphContextOptions,
} from "../lib/codegraph_context.ts";

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

const ANNOTATIONS: CheckAnnotation[] = [
  { path: "tests/main_test.ts", start_line: 42, message: "Assertion failed" },
];

interface Observed {
  runOptions: Record<string, unknown>[];
  prepared: PrepareCodegraphContextOptions[];
  workDir: string;
  status?: string;
  queries?: number;
}

interface RunOptions {
  /** The host switch. */
  enabled: boolean;
  /** What the injected preparer answers. */
  codegraph: CodegraphContextResult;
  /** Tool tally each invocation reports. */
  toolCallCounts?: Record<string, number>;
  /** Drive the post-quality retry (Issue #1456) as well. */
  qualityRetry?: boolean;
}

async function runCiFix(options: RunOptions): Promise<Observed> {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-codegraph-2160-" });
  const observed: Observed = { runOptions: [], prepared: [], workDir: tmpDir };
  try {
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: ((runOptions: Record<string, unknown>) => {
        observed.runOptions.push(runOptions);
        return Promise.resolve({
          ok: true,
          value: {
            output: "Fixed CI",
            exitCode: 0,
            timedOut: false,
            ...(options.toolCallCounts
              ? {
                runStats: {
                  servedModels: [],
                  requestedModel: "opus",
                  wallClockMs: 1,
                  toolCallCounts: options.toolCallCounts,
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
        return Promise.resolve(options.codegraph);
      }) as unknown as ClaudeDeps["prepareCodegraphContext"],
    };
    const mockGithub: Partial<GitHubDeps> = { runGhCommand: openPrGh() };
    // Uncommitted changes before and after the gate, so the retry path runs.
    const gitMock = ((args: string[]) =>
      Promise.resolve({
        ok: true,
        value: {
          code: 0,
          stdout: args[0] === "status" && options.qualityRetry
            ? " M src/broken.ts\n"
            : "",
          stderr: "",
        },
      })) as unknown as GitDeps["runGitCommand"];
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand: gitMock,
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

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      codegraphContextEnabled: options.enabled,
      ...(options.qualityRetry
        ? {
          qualityGateFn: () =>
            Promise.resolve({
              action: "failed_fixable" as const,
              qualityOutput: "deno check failed",
              retryPrompt: "./quality.sh failing:\ndeno check failed",
            }),
        }
        : {}),
      verifyPushFn: () =>
        Promise.resolve({
          landed: true,
          localSha: "f".repeat(40),
          remoteSha: "f".repeat(40),
          reason: "verified in test",
        }),
    };

    const result = await processCiFailure({
      repo: "org/repo",
      prNumber: 42,
      branchName: "issue-42-fix-bug",
      checkRunId: "67890",
      checkName: "CI / test",
      encodedAnnotations: btoa(JSON.stringify(ANNOTATIONS)),
    }, processorDeps);
    assert(result.ok, "the CI fix run must succeed");
    observed.status = result.value.codegraphContext?.status;
    observed.queries = result.value.codegraphContext?.queries;
    return observed;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("pr_ci_processor - the switch off leaves the invocation untouched", async () => {
  const observed = await runCiFix({
    enabled: false,
    codegraph: { status: "off", enabled: false },
  });

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

Deno.test("pr_ci_processor - an indexed run gets the line and the server together", async () => {
  const observed = await runCiFix({
    enabled: true,
    codegraph: { status: "ok", enabled: true, nodeCount: 1 },
    toolCallCounts: { mcp__codegraph__codegraph_explore: 6 },
  });

  assertEquals(observed.prepared[0]?.repoDir, observed.workDir);
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
  assertEquals(mcp.playwright, false);
  assertEquals(mcp.servers?.codegraph?.command, "codegraph");
  assertEquals(observed.status, "ok");
  assertEquals(observed.queries, 6);
});

Deno.test("pr_ci_processor - a failed index adds neither half", async () => {
  for (const status of ["failed", "unsupported"] as const) {
    const observed = await runCiFix({
      enabled: true,
      codegraph: { status, enabled: true },
      toolCallCounts: { Bash: 2 },
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

Deno.test("pr_ci_processor - the post-quality retry reuses the index, it does not build a second", async () => {
  const observed = await runCiFix({
    enabled: true,
    codegraph: { status: "ok", enabled: true, nodeCount: 1 },
    toolCallCounts: { mcp__codegraph__codegraph_explore: 2 },
    qualityRetry: true,
  });

  assertEquals(observed.runOptions.length, 2, "the retry must have run");
  assertEquals(
    observed.prepared.length,
    1,
    "the retry reuses the prepared index rather than indexing again",
  );

  const retry = observed.runOptions[1] ?? {};
  assertStringIncludes(String(retry.prompt), CODEGRAPH_PROMPT_LINE);
  assertEquals(retry.cwd, observed.prepared[0]?.repoDir);
  const mcp = retry.mcpConfig as {
    servers?: Record<string, { command: string }>;
  };
  assertEquals(mcp?.servers?.codegraph?.command, "codegraph");
  assertEquals(observed.queries, 4, "both invocations' tallies are summed");
});
