/**
 * Graft, CodeGraph and RTK wiring for the clarity phase (Issue #2569).
 *
 * A clarity assessment collects one Graft bundle, prepares CodeGraph and RTK
 * once, hands all three to its spawn, and reports them on its run-stats
 * comment — which clarity posts only when the run degraded (Issue #3232), so
 * the fixtures here degrade the model.
 *
 * Australian English spelling throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runClarityPhase } from "../lib/clarity_phase.ts";
import {
  buildDefaultWorkerConfig,
  LABEL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import { FABLE_PREFLIGHT_DEGRADED_REASON } from "../lib/fable_routing.ts";
import type { ClaudeExecutionResult } from "../lib/claude_executor.ts";
import type { CodegraphContextResult } from "../lib/codegraph_context.ts";
import type { GraftContextResult } from "../lib/graft_context.ts";
import type { SpawnOptions } from "./support/rtk_wiring_asserts.ts";
import { rtkGain, rtkSeam, rtkVersion } from "./support/rtk_seam.ts";
import {
  assertAcceleratedSpawn,
  assertAcceleratorLines,
  assertUnacceleratedSpawn,
  graftQueryingRunStats,
  offCodegraphOutcome,
  offGraftOutcome,
  okCodegraphOutcome,
  okGraftOutcome,
  recordingCollector,
} from "./support/phase_accelerator_asserts.ts";

const WORK_DIR = "/tmp/clarity-2569-work";

/** Drive one degraded clarity assessment; returns its spawn, posts and collections. */
async function runClarity(
  graft: GraftContextResult,
  codegraph: CodegraphContextResult,
  enabled: boolean,
) {
  const config = buildDefaultWorkerConfig({ workDir: WORK_DIR });
  config.rtkOutput = { enabled };
  config.codegraphContext = { enabled };

  const spawns: SpawnOptions[] = [];
  const posted: string[] = [];
  const gh = (args: string[]) => {
    if (args[0] === "issue" && args[1] === "comment") {
      posted.push(args[args.indexOf("--body") + 1] ?? "");
    }
    return Promise.resolve("");
  };
  const seam = rtkSeam([rtkVersion(), rtkGain(100), rtkGain(150)]);
  const { collect, collected } = recordingCollector(graft);

  const result = await runClarityPhase(
    {
      repo: "org/repo",
      issueNumber: 42,
      issueTitle: "Fix the date parser",
      issueBody: "parseDate drops the timezone.",
      issueLabels: "bug,work-on",
      issueComments: "",
      issueCommentRows: [],
      githubUser: "testbot",
    },
    {
      refineIssueLabel: LABEL_DEFAULTS.refineIssueLabel,
      planningLabel: LABEL_DEFAULTS.planningLabel,
      questionLabel: LABEL_DEFAULTS.questionLabel,
      documentationLabel: LABEL_DEFAULTS.documentationLabel,
      needsHumanLabel: LABEL_DEFAULTS.needsHumanLabel,
    },
    {
      ghCommandFn: gh,
      labelManagerDeps: { ghCommandFn: gh },
      assessmentDeps: {
        runClaude: (prompt, opts) => {
          spawns.push({ prompt, ...opts } as unknown as SpawnOptions);
          return Promise.resolve({
            ok: true as const,
            value: {
              exitCode: 0,
              output: "CLEAR",
              timedOut: false,
              // Fable was unavailable, so the run degrades and posts its stats.
              runStats: {
                ...graftQueryingRunStats(),
                servedModels: ["claude-opus-4-8"],
              },
              preflightDegraded: true,
              preflightDegradedReason: FABLE_PREFLIGHT_DEGRADED_REASON,
            } as ClaudeExecutionResult,
          });
        },
      },
      accelerators: {
        config,
        claude: {
          prepareRtkRun: seam.prepare,
          rtkProviderId: () => CLAUDE_PROVIDER_ID,
          prepareCodegraphContext: () => Promise.resolve(codegraph),
        },
        collectGraftContext: collect,
      },
    },
  );
  assertEquals(result.action, "proceed", `clarity failed: ${result.reason}`);
  return {
    spawns,
    stats: posted.find((b) => b.includes("- **Graft:**")),
    collected,
    seam,
  };
}

Deno.test("clarity - wires Graft, CodeGraph and RTK into its spawn and stats comment (Issue #2569)", async () => {
  const { spawns, stats, collected, seam } = await runClarity(
    okGraftOutcome(),
    okCodegraphOutcome(),
    true,
  );

  assertEquals(collected.length, 1, "one Graft collection per run");
  assertEquals(collected[0]?.repoDir, `${WORK_DIR}/repo`);
  assertEquals(seam.prepared.length, 1, "RTK is prepared once per run");
  assertEquals(spawns.length, 1);
  assertAcceleratedSpawn(spawns[0], WORK_DIR);
  assertAcceleratorLines(stats);
});

Deno.test("clarity - all three off leaves the spawn unaccelerated (Issue #2569)", async () => {
  const { spawns, stats } = await runClarity(
    offGraftOutcome(),
    offCodegraphOutcome(),
    false,
  );

  assertEquals(spawns.length, 1);
  assertUnacceleratedSpawn(spawns[0]);
  assertStringIncludes(stats ?? "", "- **Graft:** off");
});
