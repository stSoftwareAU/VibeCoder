/**
 * Graft and CodeGraph context wiring into planning run-stats comments
 * (Issue #2561, part of #2159/#2102).
 *
 * Planning builds its own stats section with Graft, CodeGraph, and RTK lines,
 * rendered in order. Both success and failure paths post the three-line section.
 * Disabled contexts report "off"; missing contexts report "failed"; enabled
 * contexts report their findings.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { processIssuePlanning } from "../lib/planning_processor.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import type { GitHubClient } from "../types.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import type {
  CollectGraftContextOptions,
  GraftContextResult,
} from "../lib/graft_context.ts";
import type { CodegraphContextResult } from "../lib/codegraph_context.ts";
import type { RtkOutputResult } from "../lib/rtk_output.ts";
import {
  rtkGain,
  type RtkSeam,
  rtkSeam,
  rtkVersion,
} from "./support/rtk_seam.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const FLEET_LOGIN = "testbot";

interface Observed {
  runOptions: { prompt: string }[];
  rtkOutput?: RtkOutputResult;
  graftResult?: GraftContextResult;
  codegraphResult?: CodegraphContextResult;
  /** Comment bodies the round posted on the parent. */
  posted: string[];
}

/** A collector that records its calls and answers with a fixed outcome. */
function fakeCollector(outcome: GraftContextResult): {
  collect: (options: CollectGraftContextOptions) => Promise<GraftContextResult>;
  calls: CollectGraftContextOptions[];
} {
  const calls: CollectGraftContextOptions[] = [];
  return {
    calls,
    collect: (options: CollectGraftContextOptions) => {
      calls.push(options);
      return Promise.resolve(outcome);
    },
  };
}

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

function stubGhClient(posted: string[] = []): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 100,
        title: "Parse date correctly",
        body: "Fix ISO-8601 parsing.",
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

/** A healthy RTK seam whose gain store grows by ten tokens per re-read. */
function growingRtkSeam(): RtkSeam {
  return rtkSeam([
    rtkVersion(),
    rtkGain(100),
    ...Array.from({ length: 5 }, (_, read) => rtkGain(110 + read * 10)),
  ]);
}

/**
 * Drive one planning round with Graft, CodeGraph, and RTK all configured.
 * Returns the observed state for assertions.
 */
async function runPlanningWithAllAccelerators(
  graftOutcome: GraftContextResult,
  codegraphOutcome: CodegraphContextResult,
  rtkSeamObj: RtkSeam,
  /** Time the publish turn out, so the round ends on its failure path. */
  publishTimesOut = false,
): Promise<Observed> {
  const config = buildDefaultWorkerConfig();
  config.workDir = "/tmp/planning-2561-work";
  config.rtkOutput = { enabled: true };
  config.codegraphContext = { enabled: true };
  const graftCollector = fakeCollector(graftOutcome);

  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 100,
    issueTitle: "Parse date correctly",
    issueBody: "Fix ISO-8601 parsing.",
    issueLabels: ["planning"],
    issueComments: "",
    githubUser: FLEET_LOGIN,
    config,
  };
  const observed: Observed = { runOptions: [], posted: [] };

  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: { prompt: string }) => {
        observed.runOptions.push(options);
        const kind = observed.runOptions.length === 1 ? "draft" : "publish";
        const output = kind === "draft"
          ? "Draft plan: create two sub-issues."
          : "I have thought about it and created nothing yet.";
        return Promise.resolve({
          ok: true,
          value: {
            output,
            exitCode: 0,
            timedOut: publishTimesOut && kind === "publish",
            runStats: {
              servedModels: [],
              requestedModel: "fable",
              wallClockMs: 1,
              toolCallCounts: { Bash: 2 },
            },
          },
        });
      }) as never,
      prepareRtkRun: rtkSeamObj.prepare,
      rtkProviderId: () => CLAUDE_PROVIDER_ID,
      prepareCodegraphContext: () => Promise.resolve(codegraphOutcome),
    },
    github: {
      runGhCommand: ((args: string[]) => {
        if (args[0] === "issue" && args[1] === "view") {
          const jsonArg = args[args.indexOf("--json") + 1] ?? "";
          if (jsonArg.includes("comments")) {
            return Promise.resolve(
              JSON.stringify({ body: "Parent", comments: [] }),
            );
          }
          if (jsonArg.includes("body")) {
            return Promise.resolve(JSON.stringify({
              number: Number(args[2]),
              title: "Sub-issue",
              body: "## Summary\nDo a thing.\n",
            }));
          }
          return Promise.resolve(JSON.stringify({ state: "OPEN" }));
        }
        if (args.includes("search")) return Promise.resolve("[]");
        return Promise.resolve("");
      }) as never,
    },
  });

  const result = await processIssuePlanning(ctx, {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(observed.posted),
    logger: deps.logger,
    deps,
    collectGraftContext: graftCollector.collect,
  });

  if (publishTimesOut) {
    assert(!result.ok, "a timed-out publish turn fails the round");
    observed.graftResult = graftOutcome;
    observed.codegraphResult = codegraphOutcome;
    return observed;
  }

  assert(result.ok, "the round should succeed");
  if (result.ok) {
    observed.rtkOutput = result.value.rtkOutput;
  }
  observed.graftResult = graftOutcome;
  observed.codegraphResult = codegraphOutcome;
  return observed;
}

Deno.test(
  "planning_processor - stats comment carries all three lines: Graft, CodeGraph, RTK (Issue #2561)",
  async () => {
    const observed = await runPlanningWithAllAccelerators(
      okGraftOutcome(),
      okCodegraphOutcome(),
      growingRtkSeam(),
    );

    // Find the stats comment — it should carry all three lines in order.
    const statsComments = observed.posted.filter((b) =>
      b.includes("- **Graft:**")
    );
    assertEquals(
      statsComments.length,
      1,
      `exactly one stats comment carries Graft line: ${observed.posted.length} posted`,
    );

    const statsBody = statsComments[0]!;
    const hasGraft = statsBody.includes("- **Graft:**");
    const hasCodegraph = statsBody.includes("- **CodeGraph:**");
    const hasRtk = statsBody.includes("- **RTK:**");

    assert(hasGraft, "stats comment must include Graft line");
    assert(hasCodegraph, "stats comment must include CodeGraph line");
    assert(hasRtk, "stats comment must include RTK line");

    // Verify order: Graft comes before CodeGraph, CodeGraph before RTK.
    const graftIndex = statsBody.indexOf("- **Graft:**");
    const codegraphIndex = statsBody.indexOf("- **CodeGraph:**");
    const rtkIndex = statsBody.indexOf("- **RTK:**");

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
  "planning_processor - switched-off Graft renders 'off' in stats (Issue #2561)",
  async () => {
    const observed = await runPlanningWithAllAccelerators(
      offGraftOutcome(),
      okCodegraphOutcome(),
      growingRtkSeam(),
    );

    const statsComments = observed.posted.filter((b) =>
      b.includes("- **Graft:**")
    );
    assertEquals(statsComments.length, 1);
    assertStringIncludes(statsComments[0]!, "- **Graft:** off");
  },
);

Deno.test(
  "planning_processor - failed Graft renders 'failed' in stats (Issue #2561)",
  async () => {
    const observed = await runPlanningWithAllAccelerators(
      failedGraftOutcome(),
      okCodegraphOutcome(),
      growingRtkSeam(),
    );

    const statsComments = observed.posted.filter((b) =>
      b.includes("- **Graft:**")
    );
    assertEquals(statsComments.length, 1);
    assertStringIncludes(statsComments[0]!, "- **Graft:** failed");
  },
);

Deno.test(
  "planning_processor - switched-off CodeGraph renders 'off' in stats (Issue #2561)",
  async () => {
    const observed = await runPlanningWithAllAccelerators(
      okGraftOutcome(),
      offCodegraphOutcome(),
      growingRtkSeam(),
    );

    const statsComments = observed.posted.filter((b) =>
      b.includes("- **CodeGraph:**")
    );
    assertEquals(statsComments.length, 1);
    assertStringIncludes(statsComments[0]!, "- **CodeGraph:** off");
  },
);

Deno.test(
  "planning_processor - failure path posts stats with all three lines (Issue #2561)",
  async () => {
    const observed = await runPlanningWithAllAccelerators(
      okGraftOutcome(),
      okCodegraphOutcome(),
      growingRtkSeam(),
      true, // publishTimesOut
    );

    const statsComments = observed.posted.filter((b) =>
      b.includes("- **Graft:**")
    );
    assertEquals(
      statsComments.length,
      1,
      `failure path must post stats: ${observed.posted.length} posted`,
    );

    const statsBody = statsComments[0]!;
    assert(statsBody.includes("- **Graft:**"), "failure stats must have Graft");
    assert(
      statsBody.includes("- **CodeGraph:**"),
      "failure stats must have CodeGraph",
    );
    assert(statsBody.includes("- **RTK:**"), "failure stats must have RTK");
  },
);
