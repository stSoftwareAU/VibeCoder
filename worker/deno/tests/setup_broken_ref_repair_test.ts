/**
 * Broken refs in a shared clone are swept and retried before failing every
 * issue in the repository identically (Issue #2884).
 *
 * Regression cover for the failure mode where `fatal: bad object
 * refs/heads/…` or `warning: ignoring broken ref refs/remotes/origin/…`
 * made `createFeatureBranchFromBase` fail for every issue in a repository,
 * charged to the issue as an ordinary, uncategorised failure. Repair
 * cheapest first: sweep the broken refs and prune-fetch, and only fall back
 * to the Issue #1093 re-clone when that does not hold.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  claimObjectStoreRepair,
  resetObjectStoreRepairsForTest,
} from "../lib/object_store_repair.ts";
import {
  BROKEN_REFS_NEXT_STEP,
  workOnIssueSetupBranch,
} from "../lib/phases/setup_branch_phase.ts";
import {
  createMockDeps,
  mockGitHubClient,
} from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import type { GitHubClient } from "../types.ts";

/** The exact wording git produces for a broken ref, per the issue. */
const BROKEN_REF =
  "fatal: bad object refs/heads/milestone/933-extension-framework\n" +
  "warning: ignoring broken ref refs/remotes/origin/Develop\n" +
  "fatal: 'origin/Develop' is not a commit and a branch " +
  "'issue-984-document-the-extension' cannot be created from it";

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

function buildContext(workDir: string): IssueContext {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 984,
    issueTitle: "Document the extension framework",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "vibe-worker",
    laneId: "s2",
    config: { ...buildDefaultWorkerConfig(), workDir },
  };
}

Deno.test(
  "#2884 - broken refs are swept and the issue proceeds, without re-cloning",
  async () => {
    resetObjectStoreRepairsForTest();
    const workDir = await Deno.makeTempDir({ prefix: "issue2884-sweep-" });
    try {
      const ctx = buildContext(workDir);
      const state = buildState();
      let branchAttempts = 0;
      let sweeps = 0;
      let repairs = 0;
      const deps = createMockDeps({
        git: {
          createFeatureBranchFromBase: (branch: string) => {
            branchAttempts += 1;
            return branchAttempts === 1
              ? Promise.resolve({
                ok: false as const,
                error: new Error(BROKEN_REF),
              })
              : Promise.resolve({ ok: true as const, value: branch });
          },
          sweepBrokenRefs: () => {
            sweeps += 1;
            return Promise.resolve({
              ok: true as const,
              value: {
                removed: ["refs/heads/milestone/933-extension-framework"],
              },
            });
          },
          repairObjectStore: () => {
            repairs += 1;
            return Promise.resolve({
              ok: true as const,
              value: { fsck: "", removed: [], repoPath: "/tmp/test-repo" },
            });
          },
        },
      });

      const result = await workOnIssueSetupBranch(ctx, state, deps);

      assertEquals(result.status, "continue", JSON.stringify(result));
      assertEquals(sweeps, 1, "the sweep must run exactly once");
      assertEquals(
        repairs,
        0,
        "a re-clone must not be tried when the sweep held",
      );
      assertEquals(
        branchAttempts,
        2,
        "the branch must be retried after the sweep",
      );

      if (state.heartbeatHandle) stopHeartbeat(state.heartbeatHandle);
    } finally {
      resetObjectStoreRepairsForTest();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "#2884 - a sweep that does not hold falls back to a re-clone, and the issue proceeds",
  async () => {
    resetObjectStoreRepairsForTest();
    const workDir = await Deno.makeTempDir({ prefix: "issue2884-fallback-" });
    try {
      const ctx = buildContext(workDir);
      const state = buildState();
      let branchAttempts = 0;
      let sweeps = 0;
      let repairs = 0;
      let reSetups = 0;
      const deps = createMockDeps({
        git: {
          createFeatureBranchFromBase: (branch: string) => {
            branchAttempts += 1;
            // Fails first attempt (broken ref) AND after the sweep; only
            // the re-clone retry succeeds.
            return branchAttempts <= 2
              ? Promise.resolve({
                ok: false as const,
                error: new Error(BROKEN_REF),
              })
              : Promise.resolve({ ok: true as const, value: branch });
          },
          sweepBrokenRefs: () => {
            sweeps += 1;
            return Promise.resolve({
              ok: true as const,
              value: { removed: [] },
            });
          },
          repairObjectStore: (request) => {
            repairs += 1;
            return Promise.resolve({
              ok: true as const,
              value: {
                fsck: "",
                removed: [`${request.workDir}/VibeCoder`],
                repoPath: `${request.workDir}/VibeCoder`,
              },
            });
          },
          setupRepo: (_repo: string, workDirArg: string) => {
            reSetups += 1;
            return Promise.resolve({
              ok: true as const,
              value: `${workDirArg}/VibeCoder`,
            });
          },
        },
      });

      const result = await workOnIssueSetupBranch(ctx, state, deps);

      assertEquals(result.status, "continue", JSON.stringify(result));
      assertEquals(sweeps, 1);
      assertEquals(repairs, 1, "the re-clone fallback must run once");
      // One at the ordinary start of setup, plus one taking a fresh
      // worktree off the re-cloned store.
      assertEquals(reSetups, 2);
      assertEquals(branchAttempts, 3);

      if (state.heartbeatHandle) stopHeartbeat(state.heartbeatHandle);
    } finally {
      resetObjectStoreRepairsForTest();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "#2884 - broken refs that survive sweep AND re-clone escalate with the repository named, marked clone_corrupt",
  async () => {
    resetObjectStoreRepairsForTest();
    const workDir = await Deno.makeTempDir({ prefix: "issue2884-escalate-" });
    try {
      const ctx = buildContext(workDir);
      const state = buildState();
      const comments: string[] = [];
      const labels: string[] = [];
      const deps = createMockDeps({
        git: {
          createFeatureBranchFromBase: () =>
            Promise.resolve({
              ok: false as const,
              error: new Error(BROKEN_REF),
            }),
          sweepBrokenRefs: () =>
            Promise.resolve({ ok: true as const, value: { removed: [] } }),
          repairObjectStore: (request) =>
            Promise.resolve({
              ok: true as const,
              value: {
                fsck: "",
                removed: [],
                repoPath: `${request.workDir}/VibeCoder`,
              },
            }),
        },
      });
      const client: GitHubClient = {
        ...mockGitHubClient(),
        postComment: (_repo, _number, body) => {
          comments.push(body);
          return Promise.resolve(undefined);
        },
        addLabel: (_repo, _number, label) => {
          labels.push(label);
          return Promise.resolve();
        },
      };
      deps.github.createClient = () => client;

      const result = await workOnIssueSetupBranch(ctx, state, deps);

      assertEquals(result.status, "failure");
      assert(
        result.status === "failure" &&
          result.reason.includes(
            "the host's shared clone of this repository is damaged",
          ),
        JSON.stringify(result),
      );
      assert(
        result.status === "failure" &&
          detectFailureCategory(result.reason) === "clone_corrupt",
        JSON.stringify(result),
      );
      assertEquals(comments.length, 1, JSON.stringify(comments));
      const comment = comments[0]!;
      assertStringIncludes(comment, "Broken refs in shared clone");
      assertStringIncludes(comment, "stSoftwareAU/VibeCoder");
      assertStringIncludes(comment, BROKEN_REFS_NEXT_STEP);
      assertStringIncludes(comment, "broken-refs-stSoftwareAU/VibeCoder");
      assertEquals(labels, [ctx.config.needsHumanLabel]);

      if (state.heartbeatHandle) stopHeartbeat(state.heartbeatHandle);
    } finally {
      resetObjectStoreRepairsForTest();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "#2884 - the second issue in a repository already repaired this run does not sweep again",
  async () => {
    resetObjectStoreRepairsForTest();
    const workDir = await Deno.makeTempDir({ prefix: "issue2884-once-" });
    try {
      // The first issue of the run already took the one repair (shared with
      // the #1093 claim).
      assertEquals(claimObjectStoreRepair("stSoftwareAU/VibeCoder"), true);

      const ctx = buildContext(workDir);
      const state = buildState();
      let sweeps = 0;
      const deps = createMockDeps({
        git: {
          createFeatureBranchFromBase: () =>
            Promise.resolve({
              ok: false as const,
              error: new Error(BROKEN_REF),
            }),
          sweepBrokenRefs: () => {
            sweeps += 1;
            return Promise.resolve({
              ok: true as const,
              value: { removed: [] },
            });
          },
        },
      });
      deps.github.createClient = () => mockGitHubClient();

      const result = await workOnIssueSetupBranch(ctx, state, deps);

      assertEquals(result.status, "failure");
      assertEquals(sweeps, 0, "the sweep is once per repository per run");
      assert(
        result.status === "failure" &&
          result.reason.includes(
            "the host's shared clone of this repository is damaged",
          ),
        JSON.stringify(result),
      );

      if (state.heartbeatHandle) stopHeartbeat(state.heartbeatHandle);
    } finally {
      resetObjectStoreRepairsForTest();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "#2884 - an ordinary branch failure is NOT swept; it fails as it always did",
  async () => {
    resetObjectStoreRepairsForTest();
    const workDir = await Deno.makeTempDir({ prefix: "issue2884-ordinary-" });
    try {
      const ctx = buildContext(workDir);
      const state = buildState();
      let sweeps = 0;
      const deps = createMockDeps({
        git: {
          createFeatureBranchFromBase: () =>
            Promise.resolve({
              ok: false as const,
              error: new Error(
                "fatal: invalid reference: nosuch",
              ),
            }),
          sweepBrokenRefs: () => {
            sweeps += 1;
            return Promise.resolve({
              ok: true as const,
              value: { removed: [] },
            });
          },
        },
      });

      const result = await workOnIssueSetupBranch(ctx, state, deps);

      assertEquals(result.status, "failure");
      assertEquals(sweeps, 0);
      assertEquals(
        result.status === "failure" ? result.reason : "",
        "Failed to create feature branch: fatal: invalid reference: nosuch",
      );

      if (state.heartbeatHandle) stopHeartbeat(state.heartbeatHandle);
    } finally {
      resetObjectStoreRepairsForTest();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
