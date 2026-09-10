/**
 * The setup phase syncs the milestone branch before it cuts a child branch
 * (Issue #1780).
 *
 * A milestone child run used to cut its issue branch off whatever the milestone
 * branch happened to be, however far behind the default branch that was. The
 * phase now merges the default branch down first — one ladder attempt, charged
 * to the branch's conflict ledger — and defers the whole run when it cannot.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueSetupBranch } from "../lib/phases/setup_branch_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";
import { MILESTONE_BEHIND_DEFER_REASON } from "../lib/milestone_presync.ts";
import {
  loadSyncStreaks,
  milestoneSyncStreakPath,
  saveSyncStreaks,
} from "../lib/milestone_sync_streak.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";

const REPO = "stSoftwareAU/VibeCoder";
const MILESTONE_TITLE = "#1730 Resolve merge conflicts";
const MILESTONE_BRANCH = "milestone/1730-resolve-merge-conflicts";
const LEDGER_KEY = `${REPO}|${MILESTONE_BRANCH}`;

function buildState(): PhaseState {
  return {
    branchName: "",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

function buildContext(
  workDir: string,
  milestoneTitle?: string,
): IssueContext {
  return {
    repo: REPO,
    issueNumber: 1780,
    issueTitle: "Child issue run syncs the milestone branch inline",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    ...(milestoneTitle ? { milestoneTitle } : {}),
    config: { ...buildDefaultWorkerConfig(), workDir },
  };
}

/** One recorded pre-cut sync call. */
interface SyncCall {
  milestoneBranch: string;
  defaultBranch: string;
  cwd: string | undefined;
  agentGranted: boolean;
}

function depsFor(options: {
  behindBy: number;
  syncFails?: Error;
  syncCalls: SyncCall[];
  freshBranches: string[];
  /** Every `gh` argv the phase issued, so a deferral can be shown silent. */
  ghCalls?: string[][];
}) {
  return createMockDeps({
    github: {
      runGhCommand: (args: string[]) => {
        options.ghCalls?.push(args);
        return Promise.resolve("");
      },
    },
    git: {
      countCommitsAhead: () =>
        Promise.resolve({ ok: true as const, value: options.behindBy }),
      syncMilestoneBranchWithDefault: (
        milestoneBranch: string,
        defaultBranch: string,
        gitOptions?: { cwd?: string },
        _repo?: string,
        _mergeGate?: unknown,
        _resolutionGate?: unknown,
        agentFn?: unknown,
      ) => {
        options.syncCalls.push({
          milestoneBranch,
          defaultBranch,
          cwd: gitOptions?.cwd,
          agentGranted: agentFn !== undefined,
        });
        return Promise.resolve(
          options.syncFails
            ? { ok: false as const, error: options.syncFails }
            : { ok: true as const, value: { message: "merged main down" } },
        );
      },
      createFeatureBranchFromBase: (branch: string, base: string) => {
        options.freshBranches.push(`${branch}<-${base}`);
        return Promise.resolve({ ok: true as const, value: branch });
      },
    },
  });
}

/** A conflict every rung left undecided — the branch's own failure. */
function unresolvedConflict(): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "lib/foo.ts could not be settled",
    [{
      path: "lib/foo.ts",
      reason: "agent: could not settle the collision",
      oursExports: [],
      theirsExports: [],
      oursTests: [],
      theirsTests: [],
      onlyOursTests: [],
      onlyTheirsTests: [],
    }],
    [],
    "d".repeat(40),
  );
}

Deno.test("#1780 - a behind milestone branch is synced before the child branch is cut", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue1780-setup-" });
  try {
    const syncCalls: SyncCall[] = [];
    const freshBranches: string[] = [];
    const ctx = buildContext(workDir, MILESTONE_TITLE);
    const state = buildState();
    const deps = depsFor({ behindBy: 2, syncCalls, freshBranches });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(syncCalls.length, 1, "one pre-cut sync attempt");
    assertEquals(syncCalls[0]?.milestoneBranch, MILESTONE_BRANCH);
    assertEquals(syncCalls[0]?.defaultBranch, "main");
    // The shared clone the periodic sweep uses — never the lane worktree.
    assertEquals(syncCalls[0]?.cwd, `${workDir}/VibeCoder`);
    // The whole ladder is offered, which is what lets a failure be charged.
    assertEquals(syncCalls[0]?.agentGranted, true);
    // The child branch is cut from the milestone branch, after the sync.
    assertEquals(state.baseBranch, MILESTONE_BRANCH);
    assertEquals(freshBranches, [`${state.branchName}<-${MILESTONE_BRANCH}`]);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#1780 - a level milestone branch is not merged into", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue1780-setup-" });
  try {
    const syncCalls: SyncCall[] = [];
    const freshBranches: string[] = [];
    const ctx = buildContext(workDir, MILESTONE_TITLE);
    const state = buildState();

    const result = await workOnIssueSetupBranch(
      ctx,
      state,
      depsFor({ behindBy: 0, syncCalls, freshBranches }),
    );

    assertEquals(result.status, "continue");
    assertEquals(syncCalls, []);
    assertEquals(freshBranches.length, 1);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#1780 - a failed sync defers the run, charges the ledger once and cuts no branch", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue1780-setup-" });
  try {
    const syncCalls: SyncCall[] = [];
    const freshBranches: string[] = [];
    const ghCalls: string[][] = [];
    const ctx = buildContext(workDir, MILESTONE_TITLE);
    const state = buildState();

    const result = await workOnIssueSetupBranch(
      ctx,
      state,
      depsFor({
        behindBy: 5,
        syncFails: unresolvedConflict(),
        syncCalls,
        freshBranches,
        ghCalls,
      }),
    );

    assertEquals(result.status, "early_exit");
    assert(result.status === "early_exit");
    assertEquals(result.reason, MILESTONE_BEHIND_DEFER_REASON);
    // A bounce, not a failure: the issue keeps its pickup label and nothing is
    // tracked against it.
    assertEquals(result.expectedSkip, true);
    assertEquals(result.outcome?.kind, "no_pr_expected");
    assertStringIncludes(
      result.outcome?.kind === "no_pr_expected" ? result.outcome.summary : "",
      MILESTONE_BEHIND_DEFER_REASON,
    );
    // No branch was cut from the behind base.
    assertEquals(freshBranches, []);
    assertEquals(syncCalls.length, 1);
    // Nothing is posted, labelled or escalated: the release comment the worker
    // writes afterwards is the whole record.
    assertEquals(
      ghCalls.filter((args) =>
        args.includes("comment") || args.includes("--add-label")
      ),
      [],
    );

    // The branch's ledger carries exactly one charged attempt, and a deferral.
    const entry = (await loadSyncStreaks(milestoneSyncStreakPath(workDir)))[
      LEDGER_KEY
    ];
    assert(entry, "the failure is recorded against the branch");
    assertEquals(entry.conflictAttempts, 1);
    assert(entry.deferUntil, "a charged failure paces the branch");

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#1780 - a paced milestone branch defers without attempting a merge", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue1780-setup-" });
  try {
    const deferUntil = new Date(Date.now() + 3600_000).toISOString();
    await saveSyncStreaks(milestoneSyncStreakPath(workDir), {
      [LEDGER_KEY]: {
        count: 1,
        escalated: false,
        conflictAttempts: 1,
        deferUntil,
        lastAttempt: {
          at: new Date(Date.now() - 60_000).toISOString(),
          outcome: "failed",
          reason: "conflict unresolved at rung agent",
          defaultSha: "d".repeat(40),
        },
      },
    });
    const syncCalls: SyncCall[] = [];
    const freshBranches: string[] = [];
    const ctx = buildContext(workDir, MILESTONE_TITLE);
    const state = buildState();

    const result = await workOnIssueSetupBranch(
      ctx,
      state,
      depsFor({ behindBy: 3, syncCalls, freshBranches }),
    );

    assert(result.status === "early_exit");
    assertEquals(result.reason, MILESTONE_BEHIND_DEFER_REASON);
    assertEquals(syncCalls, [], "a paced branch is not merged into again");
    assertEquals(freshBranches, []);
    // The deferral is untouched — no second charge for waiting.
    const entry = (await loadSyncStreaks(milestoneSyncStreakPath(workDir)))[
      LEDGER_KEY
    ];
    assertEquals(entry?.conflictAttempts, 1);
    assertEquals(entry?.deferUntil, deferUntil);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#1780 - an issue with no milestone never reaches the pre-cut sync", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue1780-setup-" });
  try {
    const syncCalls: SyncCall[] = [];
    const freshBranches: string[] = [];
    const ctx = buildContext(workDir);
    const state = buildState();

    const result = await workOnIssueSetupBranch(
      ctx,
      state,
      depsFor({ behindBy: 7, syncCalls, freshBranches }),
    );

    assertEquals(result.status, "continue");
    assertEquals(syncCalls, []);
    assertEquals(state.baseBranch, "main");
    assertEquals(freshBranches, [`${state.branchName}<-main`]);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
