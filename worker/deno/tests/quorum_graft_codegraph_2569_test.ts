/**
 * Graft, CodeGraph and RTK wiring for the quorum phase (Issue #2569).
 *
 * A plan-off collects one Graft bundle, prepares CodeGraph and RTK once, hands
 * all three to every Claude invocation (both drafts and the judge), and
 * reports them on its run-stats comment — which a plan-off posts only when the
 * run degraded (Issue #4434), so the fixtures here degrade the model.
 *
 * Australian English spelling throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { processQuorum } from "../lib/quorum_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import { FABLE_PREFLIGHT_DEGRADED_REASON } from "../lib/fable_routing.ts";
import type { CodegraphContextResult } from "../lib/codegraph_context.ts";
import type { GraftContextResult } from "../lib/graft_context.ts";
import type { SpawnOptions } from "./support/rtk_wiring_asserts.ts";
import { rtkGain, rtkSeam, rtkVersion } from "./support/rtk_seam.ts";
import {
  assertAcceleratedSpawn,
  assertUnacceleratedSpawn,
  graftQueryingRunStats,
  offCodegraphOutcome,
  offGraftOutcome,
  okCodegraphOutcome,
  okGraftOutcome,
  recordingCollector,
} from "./support/phase_accelerator_asserts.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const WORK_DIR = "/tmp/quorum-2569-work";
const STATS_HEADING = "## Quorum run model stats";

/** Drive one degraded plan-off; returns its spawns, posts and collections. */
async function runPlanOff(
  graft: GraftContextResult,
  codegraph: CodegraphContextResult,
  enabled: boolean,
) {
  const config = buildDefaultWorkerConfig({ workDir: WORK_DIR });
  config.rtkOutput = { enabled };
  config.codegraphContext = { enabled };

  const spawns: SpawnOptions[] = [];
  const seam = rtkSeam([rtkVersion(), rtkGain(100), rtkGain(150)]);
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (options) => {
        spawns.push(options as unknown as SpawnOptions);
        const judge = options.phase === "quorum_judge";
        return Promise.resolve({
          ok: true,
          value: {
            output: judge
              ? `<quorum_verdict>\n${
                JSON.stringify({ winner: "A", reasoning: "Plan A is safer." })
              }\n</quorum_verdict>`
              : "A drafted plan.",
            exitCode: 0,
            timedOut: false,
            // Fable was unavailable, so the run degrades and posts its stats.
            runStats: {
              ...graftQueryingRunStats(),
              servedModels: ["claude-opus-4-8"],
            },
            preflightDegraded: true,
            preflightDegradedReason: FABLE_PREFLIGHT_DEGRADED_REASON,
          },
        });
      },
      prepareRtkRun: seam.prepare,
      rtkProviderId: () => CLAUDE_PROVIDER_ID,
      prepareCodegraphContext: () => Promise.resolve(codegraph),
    },
  });
  deps.github.runGhCommand = () => Promise.resolve("");

  const posted: string[] = [];
  const ghClient = {
    getIssue: () =>
      Promise.resolve({
        number: 4112,
        title: "Fix the date parser",
        body: "",
        labels: ["quorum"],
        author: "human",
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_r: string, _n: number, body: string) => {
      posted.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
  const { collect, collected } = recordingCollector(graft);

  const result = await processQuorum({
    repo: "org/repo",
    issueNumber: 4112,
    issueTitle: "Fix the date parser",
    issueBody: "parseDate drops the timezone.",
    issueLabels: ["quorum"],
    issueComments: "",
    githubUser: "testbot",
    config,
  }, {
    promptsDir: PROMPTS_DIR,
    ghClient,
    logger: deps.logger,
    deps,
    collectGraftContext: collect,
  });
  assertEquals(result.ok, true, `run failed: ${!result.ok && result.error}`);
  return {
    spawns,
    stats: posted.find((b) => b.includes(STATS_HEADING)),
    collected,
    seam,
  };
}

Deno.test("quorum - wires Graft, CodeGraph and RTK into every Claude invocation and the stats comment (Issue #2569)", async () => {
  const { spawns, stats, collected, seam } = await runPlanOff(
    okGraftOutcome(),
    okCodegraphOutcome(),
    true,
  );

  assertEquals(collected.length, 1, "one Graft collection per plan-off");
  assertEquals(collected[0]?.repoDir, `${WORK_DIR}/repo`);
  assertEquals(seam.prepared.length, 1, "RTK is prepared once per plan-off");
  assertEquals(spawns.length, 3, "two drafts and the judge");
  for (const spawn of spawns) assertAcceleratedSpawn(spawn, WORK_DIR);

  assert(stats, "a degraded plan-off posts its stats comment");
  const graftAt = stats.indexOf("- **Graft:**");
  const codegraphAt = stats.indexOf("- **CodeGraph:**");
  const rtkAt = stats.indexOf("- **RTK:**");
  assert(graftAt >= 0, "the comment carries the Graft line");
  assert(codegraphAt > graftAt, "CodeGraph follows Graft");
  assert(rtkAt > codegraphAt, "RTK follows CodeGraph");
  // Three invocations at three Graft queries each.
  assertStringIncludes(stats.slice(graftAt, codegraphAt), "9 queries");
});

Deno.test("quorum - all three off leaves every invocation unaccelerated (Issue #2569)", async () => {
  const { spawns, stats } = await runPlanOff(
    offGraftOutcome(),
    offCodegraphOutcome(),
    false,
  );

  assertEquals(spawns.length, 3);
  for (const spawn of spawns) assertUnacceleratedSpawn(spawn);
  assertStringIncludes(stats ?? "", "- **Graft:** off");
});
