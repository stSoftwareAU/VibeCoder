/**
 * Graft, CodeGraph, and RTK context wiring into grill-me degradation comments
 * (Issue #2561, part of #2159/#2102).
 *
 * Every grill-me run-stats comment — the healthy round's cost/model comment and
 * the degraded round's report alike — carries three lines (Graft, CodeGraph,
 * RTK) in that order, reporting each collection's status and findings. Disabled
 * contexts report "off"; failed contexts report "failed"; enabled contexts
 * report their findings.
 *
 * The rendering logic (three status lines in order) is shared with planning and
 * tested in phase_run_stats_test.ts. The first half of this file verifies that
 * reportGrillMeDegradation threads Graft/CodeGraph/RTK results through to that
 * shared renderer; the second half drives the processor itself, so the figures
 * those lines report come from tools the round's spawn actually had.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { reportGrillMeDegradation } from "../lib/grill_me_run_stats.ts";
import { processGrillMe } from "../lib/grill_me_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import type { GitHubClient, GitHubIssue, Logger } from "../types.ts";
import type { GrillMeClaudeResult } from "../lib/grill_me_run_stats.ts";
import {
  type CollectGraftContextOptions,
  GRAFT_PROMPT_LINE,
  type GraftContextResult,
} from "../lib/graft_context.ts";
import {
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
} from "../lib/codegraph_context.ts";
import { RTK_PROMPT_LINE, type RtkOutputResult } from "../lib/rtk_output.ts";
import {
  rtkGain,
  rtkMissing,
  type RtkSeam,
  rtkSeam,
  rtkVersion,
} from "./support/rtk_seam.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** An `ok` Graft collection. */
function okGraftOutcome(): GraftContextResult {
  return {
    status: "ok",
    enabled: true,
    buildSeconds: 12.5,
    bundleChars: 1024,
    nodeCount: 820,
    callEdgeCount: 1204,
    bundle: "export function parseDate() {}",
  };
}

/** A Graft collection that failed. */
function failedGraftOutcome(): GraftContextResult {
  return {
    status: "failed",
    enabled: true,
    buildSeconds: 300,
    nodeCount: 0,
    callEdgeCount: 0,
  };
}

/** A switched-off Graft context. */
function offGraftOutcome(): GraftContextResult {
  return {
    status: "off",
    enabled: false,
  };
}

/** An `ok` CodeGraph collection. */
function okCodegraphOutcome(): CodegraphContextResult {
  return {
    status: "ok",
    enabled: true,
    nodeCount: 500,
  };
}

/** A switched-off CodeGraph context. */
function offCodegraphOutcome(): CodegraphContextResult {
  return {
    status: "off",
    enabled: false,
  };
}

/** A mock logger for test assertions. */
function stubLogger(): Logger {
  return {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
}

/** A mock GitHub client that records posted comments. */
function stubGhClient(posted: string[] = []): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 100,
        title: "Clarify requirements",
        body: "Can you clarify the scope?",
        labels: [],
        author: "user",
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_r: string, _i: number, body: string) => {
      posted.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as unknown as GitHubClient;
}

/**
 * Report degradation with context results and return observed comments.
 * Tests pass Graft/CodeGraph/RTK results directly to reportGrillMeDegradation.
 */
async function reportGrillMeDegradationWithResults(
  claudeResult: GrillMeClaudeResult,
  graftResult: GraftContextResult,
  codegraphResult: CodegraphContextResult,
  rtkResult: RtkOutputResult | undefined,
): Promise<string[]> {
  const posted: string[] = [];
  const ghClient = stubGhClient(posted);
  const logger = stubLogger();

  await reportGrillMeDegradation({
    repo: "org/repo",
    issueNumber: 100,
    claudeResult,
    ghClient,
    runGhCommand: async () => "{}",
    logger,
    graftContextResult: graftResult,
    codegraphContextResult: codegraphResult,
    rtkOutputResult: rtkResult,
  });

  return posted;
}

/**
 * Create a GrillMeClaudeResult representing a degraded model
 * (servedModels != requestedModel).
 */
function degradedGrillMeResult(): GrillMeClaudeResult {
  return {
    runStats: {
      servedModels: ["opus"], // degraded: served opus
      requestedModel: "fable", // expected: fable
      wallClockMs: 100,
      toolCallCounts: {},
    },
  };
}

/**
 * Create a GrillMeClaudeResult representing a healthy model
 * (servedModels === requestedModel).
 */
function healthyGrillMeResult(): GrillMeClaudeResult {
  return {
    runStats: {
      servedModels: ["fable"], // healthy: served fable
      requestedModel: "fable", // expected: fable
      wallClockMs: 100,
      toolCallCounts: {},
    },
  };
}

/**
 * Create an RTK output result with a fixed gain.
 */
function okRtkResult(): RtkOutputResult {
  return {
    status: "ok",
    enabled: true,
    savedTokens: 120,
  };
}

Deno.test(
  "grill_me_processor - degraded comment carries all three lines: Graft, CodeGraph, RTK (Issue #2561)",
  async () => {
    const posted = await reportGrillMeDegradationWithResults(
      degradedGrillMeResult(),
      okGraftOutcome(),
      okCodegraphOutcome(),
      okRtkResult(),
    );

    // Only degraded rounds post a comment.
    assertEquals(posted.length, 1, "degraded round must post one comment");

    const body = posted[0]!;
    const hasGraft = body.includes("- **Graft:**");
    const hasCodegraph = body.includes("- **CodeGraph:**");
    const hasRtk = body.includes("- **RTK:**");

    assert(hasGraft, "degradation comment must include Graft line");
    assert(hasCodegraph, "degradation comment must include CodeGraph line");
    assert(hasRtk, "degradation comment must include RTK line");

    // Verify order: Graft comes before CodeGraph, CodeGraph before RTK.
    const graftIndex = body.indexOf("- **Graft:**");
    const codegraphIndex = body.indexOf("- **CodeGraph:**");
    const rtkIndex = body.indexOf("- **RTK:**");

    assert(
      graftIndex < codegraphIndex,
      "Graft line must come before CodeGraph",
    );
    assert(
      codegraphIndex < rtkIndex,
      "CodeGraph line must come before RTK",
    );
  },
);

Deno.test(
  "grill_me_processor - switched-off Graft renders 'off' in degradation comment (Issue #2561)",
  async () => {
    const posted = await reportGrillMeDegradationWithResults(
      degradedGrillMeResult(),
      offGraftOutcome(),
      okCodegraphOutcome(),
      okRtkResult(),
    );

    assertEquals(posted.length, 1);
    assertStringIncludes(posted[0]!, "- **Graft:** off");
  },
);

Deno.test(
  "grill_me_processor - failed Graft renders 'failed' in degradation comment (Issue #2561)",
  async () => {
    const posted = await reportGrillMeDegradationWithResults(
      degradedGrillMeResult(),
      failedGraftOutcome(),
      okCodegraphOutcome(),
      okRtkResult(),
    );

    assertEquals(posted.length, 1);
    assertStringIncludes(posted[0]!, "- **Graft:** failed");
  },
);

Deno.test(
  "grill_me_processor - switched-off CodeGraph renders 'off' in degradation comment (Issue #2561)",
  async () => {
    const posted = await reportGrillMeDegradationWithResults(
      degradedGrillMeResult(),
      okGraftOutcome(),
      offCodegraphOutcome(),
      okRtkResult(),
    );

    assertEquals(posted.length, 1);
    assertStringIncludes(posted[0]!, "- **CodeGraph:** off");
  },
);

Deno.test(
  "grill_me_processor - healthy round's stats comment carries all three lines (Issue #2561)",
  async () => {
    const posted = await reportGrillMeDegradationWithResults(
      healthyGrillMeResult(),
      okGraftOutcome(),
      okCodegraphOutcome(),
      okRtkResult(),
    );

    // A healthy round still posts the run's cost/model stats comment
    // (Issue #3756); it carries the same three lines as the degraded one.
    assertEquals(posted.length, 1, "healthy round must post one stats comment");
    assertStringIncludes(posted[0]!, "- **Graft:**");
    assertStringIncludes(posted[0]!, "- **CodeGraph:**");
    assertStringIncludes(posted[0]!, "- **RTK:**");
  },
);

// ---------------------------------------------------------------------------
// processGrillMe — the round's spawn actually gets the three accelerators
// ---------------------------------------------------------------------------

/** What one driven grill-me round was observed to do. */
interface ObservedRound {
  /** Every Graft collection the round asked for, in call order. */
  collected: CollectGraftContextOptions[];
  /** The options the round's single Claude invocation was given. */
  runOptions?: {
    prompt: string;
    mcpConfig?: unknown;
    settingsJson?: string;
  };
}

/**
 * Drive one grill-me round with the three accelerators wired.
 *
 * @param graftOutcome - What the injected collector answers with
 * @param codegraphOutcome - What the injected index step answers with
 * @param seam - The scripted `rtk` seam the round prepares through
 * @returns What the round asked of each accelerator
 */
async function runGrillMeRound(
  graftOutcome: GraftContextResult,
  codegraphOutcome: CodegraphContextResult,
  seam: RtkSeam,
): Promise<ObservedRound> {
  const config = buildDefaultWorkerConfig();
  config.workDir = "/tmp/grill-me-2561-work";
  config.maxGrillMeRounds = 3;
  config.rtkOutput = { enabled: true };
  config.codegraphContext = { enabled: true };

  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Add reporting dashboard",
    issueBody: "Build a reporting dashboard with charts.",
    issueLabels: ["grill-me"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };

  const observed: ObservedRound = { collected: [] };
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: ObservedRound["runOptions"]) => {
        observed.runOptions = options;
        return Promise.resolve({
          ok: true,
          value: {
            output: "## Grill-Me Round 1\n\nQuestions...",
            exitCode: 0,
            timedOut: false,
            runStats: {
              servedModels: [],
              requestedModel: "opus",
              wallClockMs: 1,
              toolCallCounts: { mcp__graft__graft_find_code: 3, Bash: 2 },
            },
          },
        });
      }) as never,
      prepareRtkRun: seam.prepare,
      rtkProviderId: () => CLAUDE_PROVIDER_ID,
      prepareCodegraphContext: () => Promise.resolve(codegraphOutcome),
    },
  });

  const issue: GitHubIssue = {
    number: 42,
    title: "Add reporting dashboard",
    body: "Build a reporting dashboard with charts.",
    labels: ["grill-me"],
    author: "user1",
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const result = await processGrillMe(ctx, {
    promptsDir: PROMPTS_DIR,
    ghClient: {
      ...stubGhClient(),
      getIssue: () => Promise.resolve(issue),
    } as unknown as GitHubClient,
    logger: deps.logger,
    deps,
    collectGraftContext: (options: CollectGraftContextOptions) => {
      observed.collected.push(options);
      return Promise.resolve(graftOutcome);
    },
  });

  assert(result.ok, "the round should complete");
  return observed;
}

Deno.test(
  "processGrillMe - the round's spawn gets the Graft bundle, both MCP servers, the prompt lines and the RTK hook (Issue #2561)",
  async () => {
    const observed = await runGrillMeRound(
      okGraftOutcome(),
      okCodegraphOutcome(),
      rtkSeam([rtkVersion(), rtkGain(100), rtkGain(160)]),
    );

    // Collected against the repository checkout, not the work volume.
    assertEquals(observed.collected.length, 1);
    assertEquals(
      observed.collected[0]?.repoDir,
      "/tmp/grill-me-2561-work/repo",
    );
    assertStringIncludes(
      observed.collected[0]?.query ?? "",
      "Add reporting dashboard",
    );

    const prompt = observed.runOptions?.prompt ?? "";
    assertStringIncludes(prompt, "export function parseDate() {}");
    assertStringIncludes(prompt, GRAFT_PROMPT_LINE);
    assertStringIncludes(prompt, CODEGRAPH_PROMPT_LINE);
    assertStringIncludes(prompt, RTK_PROMPT_LINE);

    // Both servers ride on the one spawn, and the RTK hook with them.
    const mcp = observed.runOptions?.mcpConfig as {
      servers?: Record<string, { command?: string }>;
    };
    assert(typeof mcp === "object", "the MCP servers must be requested");
    assertEquals(mcp.servers?.graft?.command, "graft");
    assert(
      mcp.servers?.codegraph !== undefined,
      "the codegraph server rides beside graft's",
    );
    assert(
      observed.runOptions?.settingsJson !== undefined,
      "the RTK rewrite hook must be installed on the spawn",
    );
  },
);

Deno.test(
  "processGrillMe - a host with no rtk still completes the round (Issue #2561)",
  async () => {
    // Losing an accelerator never fails a round: the spawn runs unfiltered and
    // the stats line reports the loss instead.
    const observed = await runGrillMeRound(
      okGraftOutcome(),
      okCodegraphOutcome(),
      rtkSeam([rtkMissing()]),
    );

    const prompt = observed.runOptions?.prompt ?? "";
    assertEquals(
      prompt.includes(RTK_PROMPT_LINE),
      false,
      "no hook, no prompt line",
    );
    assertEquals(observed.runOptions?.settingsJson, undefined);
    assertStringIncludes(prompt, GRAFT_PROMPT_LINE);
  },
);

Deno.test(
  "processGrillMe - a switched-off Graft collection leaves the spawn as it was (Issue #2561)",
  async () => {
    const observed = await runGrillMeRound(
      offGraftOutcome(),
      offCodegraphOutcome(),
      rtkSeam([rtkVersion(), rtkGain(100), rtkGain(100)]),
    );

    const prompt = observed.runOptions?.prompt ?? "";
    assertEquals(prompt.includes(GRAFT_PROMPT_LINE), false);
    assertEquals(prompt.includes(CODEGRAPH_PROMPT_LINE), false);
    assertEquals(
      observed.runOptions?.mcpConfig,
      undefined,
      "an off host writes no MCP configuration",
    );
  },
);
