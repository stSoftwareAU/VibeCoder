/**
 * Resume-on-reclaim keys on the issue number, not the title (Issue #220).
 *
 * VibeCoder#211 was retitled between two claims; the second claim derived a
 * different branch slug, the exact-name match failed, and a 20-file WIP
 * branch was orphaned. These tests drive the setup phase and pin the two
 * halves of the fix: the persisted branch is resumed whatever the current
 * title derives, and the lookup no longer waits on `enable_session_resume`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueSetupBranch } from "../lib/phases/setup_branch_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { WorkerDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { saveResumeState } from "../lib/resume_state_store.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";

const ORPHANED_BRANCH =
  "issue-211-two-hosts-maintaining-the-same-pr-after-a-sibling";
const RETITLED = "False 'push failed' on single-branch clones";

function makeState(): PhaseState {
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

function makeContext(
  workDir: string,
  overrides: Partial<IssueContext> = {},
): IssueContext {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 211,
    issueTitle: RETITLED,
    issueBody: "",
    issueLabels: ["top-priority"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: { ...buildDefaultWorkerConfig(), workDir },
    ...overrides,
  };
}

/**
 * Mock deps whose remote carries `remoteBranches` (branch → tip SHA) and
 * whose checkout of an existing remote branch succeeds.
 */
function makeDeps(remoteBranches: Record<string, string>): WorkerDeps {
  const resumed: string[] = [];
  const deps = createMockDeps({
    git: {
      runGitCommand: (args: string[]) => {
        let stdout = "";
        let code = 0;
        if (args[0] === "ls-remote") {
          stdout = Object.entries(remoteBranches)
            .map(([branch, sha]) => `${sha}\trefs/heads/${branch}`)
            .join("\n");
        } else if (args[0] === "merge-base") {
          // Not contained in base — every fixture branch carries work.
          code = 1;
        } else if (args[0] === "log") {
          stdout = "1700000000\n";
        }
        return Promise.resolve({
          ok: true as const,
          value: { code, stdout, stderr: "" },
        });
      },
      resumeFeatureBranchFromRemote: (branchName: string) => {
        const exists = branchName in remoteBranches;
        if (exists) resumed.push(branchName);
        return Promise.resolve({ ok: true as const, value: exists });
      },
    },
  });
  return deps;
}

Deno.test("setup #220 - a retitled issue resumes the persisted branch, not the new slug", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue220-setup-" });
  try {
    const ctx = makeContext(workDir);
    const state = makeState();
    const deps = makeDeps({ [ORPHANED_BRANCH]: "7bc5ea8".padEnd(40, "0") });

    // The pointer the dying attempt left behind names the OLD slug.
    await saveResumeState(workDir, ctx.repo, 211, {
      phaseCount: 2,
      branch: ORPHANED_BRANCH,
    });
    // Sanity: the current title derives a different name.
    assert(
      deps.git.createBranchName(211, RETITLED) !== ORPHANED_BRANCH,
      "fixture no longer exercises a retitle",
    );
    // Session resume stays off — pushed WIP must not depend on it.
    assertEquals(ctx.config.enableSessionResume, false);

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, true);
    assertEquals(state.branchName, ORPHANED_BRANCH);
    // No CLI conversation replay was primed — that half is still gated.
    assertEquals(state.sessionResumeState, undefined);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("setup #220 - with no pointer the issue-numbered remote branch is found", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue220-setup-" });
  try {
    const ctx = makeContext(workDir);
    const state = makeState();
    // No resume file at all — only the pushed branch survives.
    const deps = makeDeps({ [ORPHANED_BRANCH]: "a".repeat(40) });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, true);
    assertEquals(state.branchName, ORPHANED_BRANCH);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("setup #220 - another issue's branch is never resumed", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue220-setup-" });
  try {
    const ctx = makeContext(workDir);
    const state = makeState();
    const deps = makeDeps({ "issue-2110-different-issue": "b".repeat(40) });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, false);
    assertEquals(state.branchName, deps.git.createBranchName(211, RETITLED));

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("setup #220 - session resume still primes the CLI replay when enabled", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue220-setup-" });
  try {
    const ctx = makeContext(workDir, {
      config: {
        ...buildDefaultWorkerConfig(),
        workDir,
        enableSessionResume: true,
      },
    });
    const state = makeState();
    const deps = makeDeps({ [ORPHANED_BRANCH]: "c".repeat(40) });
    await saveResumeState(workDir, ctx.repo, 211, {
      sessionId: "6f1b8a2c-3d4e-4f50-9a61-72b8c9d0e1f2",
      phaseCount: 3,
      branch: ORPHANED_BRANCH,
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.branchName, ORPHANED_BRANCH);
    assertEquals(
      state.sessionResumeState?.sessionId,
      "6f1b8a2c-3d4e-4f50-9a61-72b8c9d0e1f2",
    );
    assertEquals(state.sessionResumeState?.phaseCount, 3);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
