/**
 * Graft, CodeGraph, and RTK context wiring into grill-me degradation comments
 * (Issue #2561, part of #2159/#2102).
 *
 * Grill-me posts degradation stats only when a round was served by a degraded
 * model. The stats comment carries three lines (Graft, CodeGraph, RTK) in order,
 * reporting their respective collection status and findings. Disabled contexts
 * report "off"; failed contexts report "failed"; enabled contexts report their
 * findings.
 *
 * The rendering logic (three status lines in order) is shared with planning and
 * tested in phase_run_stats_test.ts. This test verifies that reportGrillMeDegradation
 * correctly threads Graft/CodeGraph/RTK results through to the shared renderer.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { reportGrillMeDegradation } from "../lib/grill_me_run_stats.ts";
import type { GitHubClient, Logger } from "../types.ts";
import type { GrillMeClaudeResult } from "../lib/grill_me_run_stats.ts";
import type { GraftContextResult } from "../lib/graft_context.ts";
import type { CodegraphContextResult } from "../lib/codegraph_context.ts";
import type { RtkOutputResult } from "../lib/rtk_output.ts";

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
  "grill_me_processor - healthy model serves no comment (Issue #2561)",
  async () => {
    const posted = await reportGrillMeDegradationWithResults(
      healthyGrillMeResult(),
      okGraftOutcome(),
      okCodegraphOutcome(),
      okRtkResult(),
    );

    // Healthy rounds post nothing — the degradation label is the visible signal.
    assertEquals(
      posted.length,
      0,
      "healthy grill-me round must not post degradation comment",
    );
  },
);
