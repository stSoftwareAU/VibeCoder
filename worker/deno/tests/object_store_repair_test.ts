/**
 * A corrupt shared object store is repaired and retried, never skipped
 * (Issue #1093).
 *
 * Regression cover for VibeCoder#984, which failed at `setup` with
 * `inflate: data stream error (unknown compression method)`. The lane
 * worktrees share one object store per repository, so that one damaged
 * object failed every slot and every milestone branch in the repository, on
 * every run, until a human intervened. The direction that matters is the
 * loud one: repair and retry, and when the repair does not hold, say so with
 * the repository named — never quietly proceed as though nothing was wrong.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  claimObjectStoreRepair,
  hasClaimedObjectStoreRepair,
  isObjectStoreCorruption,
  repairSharedObjectStore,
  resetObjectStoreRepairsForTest,
} from "../lib/object_store_repair.ts";
import {
  OBJECT_STORE_NEXT_STEP,
  workOnIssueSetupBranch,
} from "../lib/phases/setup_branch_phase.ts";
import {
  createMockDeps,
  mockGitHubClient,
} from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";
import type { CommandResult, GitHubClient, Result } from "../types.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";

/** The exact git output the live incident produced. */
const CORRUPT =
  "Failed to create feature branch 'issue-984-document-the-extension' from " +
  "'milestone/933-extension-framework': git checkout -B … exited 128: " +
  "error: inflate: data stream error (unknown compression method)";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

Deno.test(
  "isObjectStoreCorruption - the four corruption wordings are their own class; a bad ref is not (Issue #1093)",
  () => {
    assert(isObjectStoreCorruption(CORRUPT));
    assert(isObjectStoreCorruption(
      "error: loose object 8fa1c2d is corrupt",
    ));
    assert(isObjectStoreCorruption(
      "fatal: unable to read sha1 file of README.md (8fa1c2d)",
    ));
    assert(isObjectStoreCorruption(
      "error: object file .git/objects/8f/a1c2d is empty",
    ));

    // A ref or branch failure must stay an ordinary failure — re-cloning a
    // healthy repository on a guess costs a slot's worth of network.
    assertEquals(
      isObjectStoreCorruption(
        "pathspec 'milestone/933' did not match any file(s) known to git",
      ),
      false,
    );
    assertEquals(
      isObjectStoreCorruption(
        "! [remote rejected] (push declined due to repository rule violations)",
      ),
      false,
    );
    assertEquals(isObjectStoreCorruption(""), false);
  },
);

Deno.test(
  "claimObjectStoreRepair - one repair per repository per run, not one per issue (Issue #1093)",
  () => {
    resetObjectStoreRepairsForTest();
    try {
      assertEquals(hasClaimedObjectStoreRepair("org/repo"), false);
      assertEquals(claimObjectStoreRepair("org/repo"), true);
      // The next issue in the SAME repository must not re-clone again.
      assertEquals(claimObjectStoreRepair("org/repo"), false);
      assertEquals(hasClaimedObjectStoreRepair("org/repo"), true);
      // A different repository is a different fault.
      assertEquals(claimObjectStoreRepair("org/other"), true);
    } finally {
      resetObjectStoreRepairsForTest();
    }
  },
);

// ---------------------------------------------------------------------------
// The repair itself
// ---------------------------------------------------------------------------

function gitFsck(output: string): (
  args: string[],
  options?: { cwd?: string },
) => Promise<Result<GitCommandOutput>> {
  return (_args, _options) =>
    Promise.resolve({
      ok: true as const,
      value: { code: 1, stdout: output, stderr: "", timedOut: false },
    });
}

Deno.test(
  "repairSharedObjectStore - drops the clone AND every lane worktree, then re-clones (Issue #1093)",
  async () => {
    const removed: string[] = [];
    const cloned: string[] = [];
    const result = await repairSharedObjectStore(
      { repo: "stSoftwareAU/VibeCoder", workDir: "/work" },
      {
        runGit: gitFsck("error: inflate: data stream error"),
        removeTree: (path) => {
          removed.push(path);
          return Promise.resolve();
        },
        listLaneIds: () => Promise.resolve(["s1", "s2", "m1"]),
        recloneFn: (repo, workDir) => {
          cloned.push(`${repo} -> ${workDir}`);
          return Promise.resolve(
            {
              success: true,
              message: `${workDir}/VibeCoder`,
            } satisfies CommandResult,
          );
        },
      },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    // The shared store, and the three lane worktrees hanging off it. A
    // surviving worktree directory would make `git worktree add` refuse the
    // path, so every lane would inherit the fault it was meant to escape.
    assertEquals(removed, [
      "/work/VibeCoder",
      "/work/worktrees/s1/VibeCoder",
      "/work/worktrees/s2/VibeCoder",
      "/work/worktrees/m1/VibeCoder",
    ]);
    assertEquals(cloned, ["stSoftwareAU/VibeCoder -> /work"]);
    // fsck is carried out as evidence for the log and any escalation.
    assertStringIncludes(result.value.fsck, "inflate: data stream error");
  },
);

Deno.test(
  "repairSharedObjectStore - a failed re-clone is a loud failure naming the repository (Issue #1093)",
  async () => {
    const result = await repairSharedObjectStore(
      { repo: "org/widget", workDir: "/work" },
      {
        runGit: gitFsck(""),
        removeTree: () => Promise.resolve(),
        listLaneIds: () => Promise.resolve([]),
        recloneFn: () =>
          Promise.resolve(
            {
              success: false,
              message: "gh repo clone failed: network unreachable",
            } satisfies CommandResult,
          ),
      },
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "org/widget");
      assertStringIncludes(result.error.message, "network unreachable");
    }
  },
);

Deno.test(
  "repairSharedObjectStore - a removal that fails stops before the re-clone and says which path (Issue #1093)",
  async () => {
    let recloned = false;
    const result = await repairSharedObjectStore(
      { repo: "org/widget", workDir: "/work" },
      {
        runGit: gitFsck(""),
        removeTree: (path) =>
          Promise.reject(new Error(`permission denied: ${path}`)),
        listLaneIds: () => Promise.resolve([]),
        recloneFn: () => {
          recloned = true;
          return Promise.resolve({ success: true, message: "/work/widget" });
        },
      },
    );

    assertEquals(result.ok, false);
    assertEquals(
      recloned,
      false,
      "must not clone over a store it could not clear",
    );
    if (!result.ok) {
      assertStringIncludes(result.error.message, "/work/widget");
      assertStringIncludes(result.error.message, "permission denied");
    }
  },
);

// ---------------------------------------------------------------------------
// The setup phase repairs and retries instead of failing the issue
// ---------------------------------------------------------------------------

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
  "#1093 - a corrupt object store is re-cloned and the issue proceeds, rather than failing at setup",
  async () => {
    resetObjectStoreRepairsForTest();
    const workDir = await Deno.makeTempDir({ prefix: "issue1093-repair-" });
    try {
      const ctx = buildContext(workDir);
      const state = buildState();
      const repairs: string[] = [];
      let branchAttempts = 0;
      const deps = createMockDeps({
        git: {
          createFeatureBranchFromBase: (branch: string) => {
            branchAttempts += 1;
            // The first attempt hits the damaged object; the retry runs
            // against the freshly cloned store.
            return branchAttempts === 1
              ? Promise.resolve({
                ok: false as const,
                error: new Error(CORRUPT),
              })
              : Promise.resolve({ ok: true as const, value: branch });
          },
          repairObjectStore: (request) => {
            repairs.push(request.repo);
            return Promise.resolve({
              ok: true as const,
              value: {
                fsck: "error: inflate: data stream error",
                removed: [`${request.workDir}/VibeCoder`],
                repoPath: `${request.workDir}/VibeCoder`,
              },
            });
          },
        },
      });

      const result = await workOnIssueSetupBranch(ctx, state, deps);

      assertEquals(result.status, "continue");
      assertEquals(repairs, ["stSoftwareAU/VibeCoder"]);
      assertEquals(
        branchAttempts,
        2,
        "the branch must be retried after repair",
      );
      assertEquals(hasClaimedObjectStoreRepair("stSoftwareAU/VibeCoder"), true);

      if (state.heartbeatHandle) stopHeartbeat(state.heartbeatHandle);
    } finally {
      resetObjectStoreRepairsForTest();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "#1093 - a repair that does not resolve the corruption escalates with the repository named",
  async () => {
    resetObjectStoreRepairsForTest();
    const workDir = await Deno.makeTempDir({ prefix: "issue1093-escalate-" });
    try {
      const ctx = buildContext(workDir);
      const state = buildState();
      const comments: string[] = [];
      const labels: string[] = [];
      const deps = createMockDeps({
        git: {
          // Corrupt before AND after the re-clone: the volume is the fault.
          createFeatureBranchFromBase: () =>
            Promise.resolve({ ok: false as const, error: new Error(CORRUPT) }),
          repairObjectStore: (request) =>
            Promise.resolve({
              ok: true as const,
              value: {
                fsck: "error: inflate: data stream error",
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
          result.reason.includes("inflate: data stream error"),
        JSON.stringify(result),
      );
      assertEquals(comments.length, 1, JSON.stringify(comments));
      const comment = comments[0]!;
      assertStringIncludes(comment, "Corrupt git object store");
      assertStringIncludes(comment, "stSoftwareAU/VibeCoder");
      assertStringIncludes(comment, OBJECT_STORE_NEXT_STEP);
      // Deduplicated per repository, so the marker names the repo.
      assertStringIncludes(
        comment,
        "object-store-corrupt-stSoftwareAU/VibeCoder",
      );
      assertEquals(labels, [ctx.config.needsHumanLabel]);

      if (state.heartbeatHandle) stopHeartbeat(state.heartbeatHandle);
    } finally {
      resetObjectStoreRepairsForTest();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "#1093 - the second issue in a repository already repaired this run does not re-clone again",
  async () => {
    resetObjectStoreRepairsForTest();
    const workDir = await Deno.makeTempDir({ prefix: "issue1093-once-" });
    try {
      // The first issue of the run already took the one repair.
      assertEquals(claimObjectStoreRepair("stSoftwareAU/VibeCoder"), true);

      const ctx = buildContext(workDir);
      const state = buildState();
      let repairs = 0;
      const deps = createMockDeps({
        git: {
          createFeatureBranchFromBase: () =>
            Promise.resolve({ ok: false as const, error: new Error(CORRUPT) }),
          repairObjectStore: () => {
            repairs += 1;
            return Promise.resolve({
              ok: true as const,
              value: { fsck: "", removed: [], repoPath: "/tmp/test-repo" },
            });
          },
        },
      });
      deps.github.createClient = () => mockGitHubClient();

      const result = await workOnIssueSetupBranch(ctx, state, deps);

      assertEquals(result.status, "failure");
      assertEquals(repairs, 0, "the repair is once per repository per run");

      if (state.heartbeatHandle) stopHeartbeat(state.heartbeatHandle);
    } finally {
      resetObjectStoreRepairsForTest();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "#1093 - an ordinary branch failure is NOT re-cloned; it fails as it always did",
  async () => {
    resetObjectStoreRepairsForTest();
    const workDir = await Deno.makeTempDir({ prefix: "issue1093-ordinary-" });
    try {
      const ctx = buildContext(workDir);
      const state = buildState();
      let repairs = 0;
      const deps = createMockDeps({
        git: {
          createFeatureBranchFromBase: () =>
            Promise.resolve({
              ok: false as const,
              error: new Error(
                "pathspec 'milestone/933' did not match any file(s) known to git",
              ),
            }),
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

      assertEquals(result.status, "failure");
      assertEquals(repairs, 0);
      assertEquals(
        hasClaimedObjectStoreRepair("stSoftwareAU/VibeCoder"),
        false,
      );

      if (state.heartbeatHandle) stopHeartbeat(state.heartbeatHandle);
    } finally {
      resetObjectStoreRepairsForTest();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
