/**
 * The setup phase resumes an issue's pushed work after a retitle (Issue #220).
 *
 * Regression cover for VibeCoder#211: the resume file named the branch created
 * under the OLD title, the issue was retitled, and the next claim derived a
 * different slug — so a pushed 20-file WIP commit was never looked at. The
 * phase must now key on the issue number, adopt the branch it finds, and do so
 * whether or not `enable_session_resume` is on.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { workOnIssueSetupBranch } from "../lib/phases/setup_branch_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { saveResumeState } from "../lib/resume_state_store.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";

/** The branch the previous claim pushed WIP to, under the previous title. */
const WIP_BRANCH = "issue-211-two-hosts-maintaining-the-same-pr-after-a-sibling";

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
  enableSessionResume: boolean,
): IssueContext {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 211,
    // The CURRENT title — retitled after the WIP branch was pushed.
    issueTitle: "False 'push failed' on single-branch clones",
    issueBody: "",
    issueLabels: ["top-priority"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume,
    },
  };
}

/** Mock deps whose remote carries {@link WIP_BRANCH} and nothing else. */
function depsWithPushedWip(freshBranches: string[]) {
  return createMockDeps({
    git: {
      listRemoteIssueBranches: () =>
        Promise.resolve({
          ok: true as const,
          value: [{ branch: WIP_BRANCH, sha: "7bc5ea8" }],
        }),
      countCommitsAhead: () => Promise.resolve({ ok: true as const, value: 1 }),
      resumeFeatureBranchFromRemote: () =>
        Promise.resolve({ ok: true as const, value: true }),
      createFeatureBranchFromBase: (branch: string) => {
        freshBranches.push(branch);
        return Promise.resolve({ ok: true as const, value: branch });
      },
    },
  });
}

Deno.test("#220 - a retitled issue resumes its pushed branch instead of starting from scratch", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue220-setup-" });
  try {
    const ctx = buildContext(workDir, true);
    const state = buildState();
    const freshBranches: string[] = [];
    const deps = depsWithPushedWip(freshBranches);

    // The resume file still names the pre-retitle branch.
    await saveResumeState(workDir, ctx.repo, 211, {
      sessionId: "0199fd1e-2a4b-7c3d-8e5f-6a7b8c9d0e1f",
      phaseCount: 2,
      branch: WIP_BRANCH,
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    // The run continues on the pushed branch, not the title-derived one.
    assertEquals(state.branchName, WIP_BRANCH);
    assertNotEquals(state.branchName, deps.git.createBranchName(211, ctx.issueTitle));
    assertEquals(state.resumedFromCheckpoint, true);
    // No fresh branch was cut from base.
    assertEquals(
      (deps.git.createFeatureBranchFromBase as { calls: unknown[] }).calls
        .length,
      0,
    );
    // Session resume is on, so the CLI conversation is primed too.
    assertEquals(state.sessionResumeState?.sessionId, "0199fd1e-2a4b-7c3d-8e5f-6a7b8c9d0e1f");

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#220 - pushed WIP is resumed with enable_session_resume off", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue220-setup-" });
  try {
    const ctx = buildContext(workDir, false);
    const state = buildState();
    const deps = depsWithPushedWip();
    // No resume file at all — the branch on the remote is the only evidence,
    // as on a sibling host that never held the earlier claim.

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.branchName, WIP_BRANCH);
    assertEquals(state.resumedFromCheckpoint, true);
    // The CLI conversation replay stays gated on the flag.
    assertEquals(state.sessionResumeState, undefined);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#220 - a branch level with base is left alone and a fresh branch is cut", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue220-setup-" });
  try {
    const ctx = buildContext(workDir, false);
    const state = buildState();
    const deps = createMockDeps({
      git: {
        listRemoteIssueBranches: () =>
          Promise.resolve({
            ok: true as const,
            value: [{ branch: "issue-211-stale", sha: "deadbee" }],
          }),
        // Nothing beyond base — there is no prior work to continue.
        countCommitsAhead: () =>
          Promise.resolve({ ok: true as const, value: 0 }),
        resumeFeatureBranchFromRemote: () =>
          Promise.resolve({ ok: true as const, value: true }),
      },
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.branchName, deps.git.createBranchName(211, ctx.issueTitle));
    assertEquals(state.resumedFromCheckpoint, false);
    assertEquals(
      (deps.git.createFeatureBranchFromBase as { calls: unknown[] }).calls
        .length,
      1,
    );

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#220 - a failed remote lookup starts clean rather than reporting no work", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue220-setup-" });
  try {
    const ctx = buildContext(workDir, false);
    const state = buildState();
    const warnings: string[] = [];
    const deps = createMockDeps({
      git: {
        listRemoteIssueBranches: () =>
          Promise.resolve({
            ok: false as const,
            error: new Error("ls-remote exited 128"),
          }),
      },
    });
    const baseWarn = deps.logger.warn.bind(deps.logger);
    deps.logger.warn = (message: string, fields?: Record<string, unknown>) => {
      warnings.push(message);
      baseWarn(message, fields);
    };

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, false);
    // The failure is surfaced, not swallowed into "no prior work".
    assertEquals(
      warnings.some((line) =>
        line.includes("Could not look up prior branches") &&
        line.includes("ls-remote exited 128")
      ),
      true,
    );

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
