/**
 * Graft, CodeGraph and RTK wiring for the refinement phase (Issue #2569).
 *
 * A refinement run collects one Graft bundle, prepares CodeGraph and RTK once,
 * hands all three to its spawn, and reports them on its run-stats comment.
 *
 * Australian English spelling throughout.
 */

import { assertEquals } from "@std/assert";
import { processIssueRefinement } from "../lib/refinement_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import type { CodegraphContextResult } from "../lib/codegraph_context.ts";
import type { GraftContextResult } from "../lib/graft_context.ts";
import type { GitHubComment } from "../types.ts";
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

const WORK_DIR = "/tmp/refinement-2569-work";

/** Drive one refinement round; returns its spawn, posts and collections. */
async function runRefinement(
  graft: GraftContextResult,
  codegraph: CodegraphContextResult,
  enabled: boolean,
) {
  const config = buildDefaultWorkerConfig();
  config.workDir = WORK_DIR;
  config.rtkOutput = { enabled };
  config.codegraphContext = { enabled };

  const spawns: SpawnOptions[] = [];
  const seam = rtkSeam([rtkVersion(), rtkGain(100), rtkGain(150)]);
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (options) => {
        spawns.push(options as unknown as SpawnOptions);
        return Promise.resolve({
          ok: true,
          value: {
            output: JSON.stringify({
              update_title: false,
              new_title: "",
              update_body: true,
              new_body: "Refined body.",
              summary: "Clarified the scope.",
            }),
            exitCode: 0,
            timedOut: false,
            runStats: graftQueryingRunStats(),
          },
        });
      },
      prepareRtkRun: seam.prepare,
      rtkProviderId: () => CLAUDE_PROVIDER_ID,
      prepareCodegraphContext: () => Promise.resolve(codegraph),
    },
  });
  deps.github.runGhCommand = () => Promise.resolve("");

  const comments: GitHubComment[] = [{
    id: 1,
    author: "reviewer1",
    body: "Please mention the timezone.",
    createdAt: "2026-01-01T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  }];
  const posted: string[] = [];
  const ghClient = {
    getIssue: () =>
      Promise.resolve({
        number: 42,
        title: "Fix the date parser",
        body: "",
        labels: [],
        author: "user",
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve(comments),
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
  };
  const { collect, collected } = recordingCollector(graft);

  const result = await processIssueRefinement({
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Fix the date parser",
    issueBody: "parseDate drops the timezone.",
    issueLabels: ["refine-issue"],
    issueComments: "",
    githubUser: "testbot",
    config,
  }, { ghClient, logger: deps.logger, deps, collectGraftContext: collect });
  assertEquals(result.ok, true, "the refinement round completes");
  return { spawns, posted, collected };
}

Deno.test("refinement - wires Graft, CodeGraph and RTK into its spawn and stats comment (Issue #2569)", async () => {
  const { spawns, posted, collected } = await runRefinement(
    okGraftOutcome(),
    okCodegraphOutcome(),
    true,
  );

  assertEquals(collected.length, 1, "one Graft collection per run");
  assertEquals(collected[0]?.repoDir, `${WORK_DIR}/repo`);
  assertEquals(spawns.length, 1);
  assertAcceleratedSpawn(spawns[0], WORK_DIR);
  assertAcceleratorLines(posted.find((b) => b.includes("- **Graft:**")));
});

Deno.test("refinement - all three off leaves the spawn unaccelerated (Issue #2569)", async () => {
  const { spawns, posted } = await runRefinement(
    offGraftOutcome(),
    offCodegraphOutcome(),
    false,
  );

  assertUnacceleratedSpawn(spawns[0]);
  const stats = posted.find((b) => b.includes("- **Graft:**"));
  assertEquals(stats?.includes("- **Graft:** off"), true);
});
