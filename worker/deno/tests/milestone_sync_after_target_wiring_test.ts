/**
 * The production Auto-Merge sweep passes `deferSyncPastRunTarget` (Issue #4243).
 *
 * The sweep's unit tests inject `attemptMerge`, so they cannot show that
 * `run_core_production_deps.ts` gives the sweep's in-cycle milestone sync the
 * start gate. This drives the real `ensureAutoMerge` over one unarmed PR whose
 * base is a milestone branch that is behind its default branch, with the run
 * target already past.
 *
 * The sweep's `attemptMerge` does not receive a `ghCommandFn`, so its merge
 * gate reaches `gh` through the low-level spawn chokepoint (`lib/gh_spawn.ts`).
 * The test replaces that runner with `_setGhSpawnRunner` for its duration: it
 * records every argv and answers the milestone lookups. The deferral comment is
 * posted only by the start gate, so its text proves the flag reached the gate.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { resetAnnouncedDraftsForTest } from "../lib/auto_merge_sweep.ts";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnResult,
} from "../lib/gh_spawn.ts";
import {
  MILESTONE_BEHIND_SYNC_MARKER,
  resetBehindSyncComments,
} from "../lib/pr_auto_merge.ts";
import {
  resetRunTimelineForTests,
  resolveRunTimeline,
  setRunTimeline,
} from "../lib/run_timeline.ts";

const REPO = "org/repo-4243-sweep";
const WORKER_USER = "worker-bot";
const PR_NUMBER = 77;
const MILESTONE_BASE = "milestone/1730-sync";
const HEAD = "issue-77-child";

/**
 * The answer to one `gh` argv on the milestone path: the milestone lookups,
 * a level-or-behind compare, and the default branch. Anything else is empty.
 */
function answerMilestoneLookup(args: readonly string[]): string {
  if (args.includes("--head")) return "[]";
  if (args.some((a) => a.includes("/milestones"))) {
    return JSON.stringify([{ number: 1, title: "1730-sync", state: "open" }]);
  }
  if (args.some((a) => a.includes("default_branch"))) return "main";
  if (args.some((a) => a.includes("/compare/"))) return "1";
  return "";
}

/**
 * Run the production sweep over one unarmed milestone-child PR with the run
 * target already two hours past. Returns every gh argv issued, from both the
 * sweep's injected runner and the spawn runner the merge gate uses.
 */
async function sweepBehindMilestonePastTarget(): Promise<string[]> {
  resetAnnouncedDraftsForTest();
  resetBehindSyncComments();
  const sweepCalls: string[] = [];
  const sweepGh = (args: string[]): Promise<string> => {
    sweepCalls.push(args.join(" "));
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(JSON.stringify([{
        number: PR_NUMBER,
        title: "A milestone child",
        baseRefName: MILESTONE_BASE,
        headRefName: HEAD,
        isDraft: false,
      }]));
    }
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        state: "OPEN",
        mergeable: "MERGEABLE",
        autoMergeRequest: null,
        mergeStateStatus: "BEHIND",
        reviewDecision: "",
        labels: [],
      }));
    }
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequest: {
              headRefName: HEAD,
              baseRefName: MILESTONE_BASE,
              autoMergeRequest: null,
              timelineItems: { nodes: [] },
            },
          },
        },
      }));
    }
    return Promise.resolve("");
  };

  const spawnCalls: string[] = [];
  _setGhSpawnRunner((args) => {
    spawnCalls.push(args.join(" "));
    const result: GhSpawnResult = {
      code: 0,
      success: true,
      stdout: answerMilestoneLookup(args),
      stderr: "",
    };
    return Promise.resolve(result);
  });

  const workDir = await Deno.makeTempDir({ prefix: "milestone-sync-wiring-" });
  // The run started two hours ago, so its one-hour target has passed.
  setRunTimeline(resolveRunTimeline({
    startedMs: Date.now() - 2 * 3600 * 1000,
    runDurationSeconds: 3600,
    runFinishSeconds: 7200,
    env: () => undefined,
    killAfterSeconds: 30,
    warn: () => {},
  }));
  try {
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: () => {} }),
      config: {
        ...buildDefaultWorkerConfig(),
        workDir,
        repos: [REPO],
        allowedAuthors: [WORKER_USER],
        fleetPrAuthors: [],
      },
      autoMergeGhCommandFn: sweepGh,
    });
    const result = await deps.ensureAutoMerge!();
    assert(result.ok, "the sweep itself must succeed");
    return [...sweepCalls, ...spawnCalls];
  } finally {
    _resetGhSpawnRunner();
    resetRunTimelineForTests();
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("Issue #4243: production sweep defers its in-cycle milestone sync past the run target", async () => {
  const calls = await sweepBehindMilestonePastTarget();
  const text = calls.join("\n");
  assert(
    text.includes(MILESTONE_BEHIND_SYNC_MARKER),
    `the behind PR must reach the in-cycle sync path:\n${text}`,
  );
  // Only the start gate writes this text, so it proves the sweep passed
  // deferSyncPastRunTarget and the sync hook was not called.
  assert(
    text.includes("the run target has passed; deferred to the next cycle"),
    `the sweep must pass deferSyncPastRunTarget (no sync past the target):\n${text}`,
  );
});
