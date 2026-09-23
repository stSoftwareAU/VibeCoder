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
import {
  saveResumeState,
  saveStreamSession,
} from "../lib/resume_state_store.ts";
import { resolveStreamId } from "../lib/stream_identity.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";

/**
 * A session id the CLI would accept — RFC 4122 v4. A v7 id is rejected by
 * `isValidSessionId` (Issue #204), so the fixture must not use one.
 */
const SESSION_ID = "0199fd1e-2a4b-4c3d-8e5f-6a7b8c9d0e1f";

/** The session the stream's earlier issues have been conversing on (#2333). */
const STREAM_SESSION_ID = "0199fd1e-2a4b-4c3d-8e5f-000000002333";

/** The branch the previous claim pushed WIP to, under the previous title. */
const WIP_BRANCH =
  "issue-211-two-hosts-maintaining-the-same-pr-after-a-sibling";

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
  overrides: Partial<IssueContext> = {},
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
    ...overrides,
  };
}

/**
 * Mock deps whose remote carries {@link WIP_BRANCH} and nothing else.
 *
 * `freshBranches` records every branch cut from base, so a test can assert
 * that no fresh branch was created; tests that do not care omit it.
 */
function depsWithPushedWip(freshBranches: string[] = []) {
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
      sessionId: SESSION_ID,
      phaseCount: 2,
      branch: WIP_BRANCH,
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    // The run continues on the pushed branch, not the title-derived one.
    assertEquals(state.branchName, WIP_BRANCH);
    assertNotEquals(
      state.branchName,
      deps.git.createBranchName(211, ctx.issueTitle),
    );
    assertEquals(state.resumedFromCheckpoint, true);
    // No fresh branch was cut from base.
    assertEquals(freshBranches, []);
    // Session resume is on, so the CLI conversation is primed too.
    assertEquals(state.sessionResumeState?.sessionId, SESSION_ID);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#1699 - a Codex resume record restores providerId onto session state", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue1699-setup-" });
  try {
    const ctx = buildContext(workDir, true);
    const state = buildState();
    const deps = depsWithPushedWip();
    const threadId = "0199a5b2-7f31-7c4a-9e08-2b6a4c1d5e77";

    await saveResumeState(workDir, ctx.repo, 211, {
      sessionId: threadId,
      phaseCount: 2,
      branch: WIP_BRANCH,
      providerId: "codex",
      credentialScope: "chatgpt-plus",
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.sessionResumeState?.sessionId, threadId);
    assertEquals(state.sessionResumeState?.providerId, "codex");
    assertEquals(state.sessionResumeState?.credentialScope, "chatgpt-plus");
    assertEquals(
      (state.sessionResumeState?.phaseCount ?? 0) >= 1,
      true,
    );

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
    const freshBranches: string[] = [];
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
        createFeatureBranchFromBase: (branch: string) => {
          freshBranches.push(branch);
          return Promise.resolve({ ok: true as const, value: branch });
        },
      },
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(
      state.branchName,
      deps.git.createBranchName(211, ctx.issueTitle),
    );
    assertEquals(state.resumedFromCheckpoint, false);
    assertEquals(freshBranches, [
      deps.git.createBranchName(211, ctx.issueTitle),
    ]);

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

Deno.test("#2333 - the setup phase joins the issue's stream conversation", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue2333-setup-" });
  try {
    const milestoneTitle = "#2319 session resume on by default";
    const ctx = buildContext(workDir, true, { milestoneTitle });
    const stream = resolveStreamId(ctx.repo, milestoneTitle);
    // A sibling issue of the same milestone already opened the conversation.
    await saveStreamSession(workDir, stream, {
      providerId: "claude",
      sessionId: STREAM_SESSION_ID,
      holderHost: "test-host",
    });
    const state = buildState();
    const lines: string[] = [];
    const deps = depsWithPushedWip();
    const baseInfo = deps.logger.info.bind(deps.logger);
    deps.logger.info = (message: string, fields?: Record<string, unknown>) => {
      lines.push(message);
      baseInfo(message, fields);
    };

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    // This issue continues the stream's conversation...
    assertEquals(state.sessionResumeState?.sessionId, STREAM_SESSION_ID);
    assertEquals(state.streamSession?.providerId, "claude");
    assertEquals(state.streamSession?.stream.milestoneTitle, milestoneTitle);
    // ...and says so, once, in the documented shape.
    assertEquals(
      lines.filter((line) =>
        line === `stream ${ctx.repo}${milestoneTitle} session ` +
            `${STREAM_SESSION_ID} (resumed)`
      ).length,
      1,
    );

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#2333 - an idle-task run keeps its per-issue session and reads no stream", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue2333-idle-" });
  try {
    const milestoneTitle = "#2319 session resume on by default";
    const ctx = buildContext(workDir, true, {
      milestoneTitle,
      issueLabels: ["idle-task"],
    });
    const stream = resolveStreamId(ctx.repo, milestoneTitle);
    await saveStreamSession(workDir, stream, {
      providerId: "claude",
      sessionId: STREAM_SESSION_ID,
    });
    const state = buildState();

    const result = await workOnIssueSetupBranch(
      ctx,
      state,
      depsWithPushedWip(),
    );

    assertEquals(result.status, "continue");
    // No stream was joined, so the execute phase opens a per-issue session.
    assertEquals(state.streamSession, undefined);
    assertNotEquals(state.sessionResumeState?.sessionId, STREAM_SESSION_ID);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#2333 - the issue's own checkpoint wins over the stream's session", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue2333-checkpoint-" });
  try {
    const milestoneTitle = "#2319 session resume on by default";
    const ctx = buildContext(workDir, true, { milestoneTitle });
    await saveStreamSession(
      workDir,
      resolveStreamId(ctx.repo, milestoneTitle),
      {
        providerId: "claude",
        sessionId: STREAM_SESSION_ID,
      },
    );
    // The interrupted run on this very branch is closer to the work.
    await saveResumeState(workDir, ctx.repo, 211, {
      sessionId: SESSION_ID,
      phaseCount: 2,
      branch: WIP_BRANCH,
    });
    const state = buildState();

    const result = await workOnIssueSetupBranch(
      ctx,
      state,
      depsWithPushedWip(),
    );

    assertEquals(result.status, "continue");
    assertEquals(state.sessionResumeState?.sessionId, SESSION_ID);
    assertEquals(state.streamSession, undefined);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#2333 - the stream is not joined with enable_session_resume off", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue2333-off-" });
  try {
    const milestoneTitle = "#2319 session resume on by default";
    const ctx = buildContext(workDir, false, { milestoneTitle });
    await saveStreamSession(
      workDir,
      resolveStreamId(ctx.repo, milestoneTitle),
      {
        providerId: "claude",
        sessionId: STREAM_SESSION_ID,
      },
    );
    const state = buildState();

    const result = await workOnIssueSetupBranch(
      ctx,
      state,
      depsWithPushedWip(),
    );

    assertEquals(result.status, "continue");
    assertEquals(state.sessionResumeState, undefined);
    assertEquals(state.streamSession, undefined);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#2530 - a shared stream keeps this run on a per-issue session", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue2530-shared-" });
  try {
    const milestoneTitle = "#2319 session resume on by default";
    const ctx = buildContext(workDir, true, { milestoneTitle });
    // Another host is inside this stream's conversation right now.
    await saveStreamSession(
      workDir,
      resolveStreamId(ctx.repo, milestoneTitle),
      {
        providerId: "claude",
        sessionId: STREAM_SESSION_ID,
        holderHost: "other-host",
      },
    );
    const state = buildState();
    const lines: string[] = [];
    const deps = createMockDeps({
      git: depsWithPushedWip().git,
      issues: {
        claimIssue: () =>
          Promise.resolve({
            ok: true as const,
            value: {
              claimed: true,
              winnerId: "my-worker",
              streamShared: {
                holderIssue: 2529,
                holderHost: "other-host",
                streamLabel: `${"stSoftwareAU/VibeCoder"}${milestoneTitle}`,
              },
            },
          }),
      },
    });
    const baseInfo = deps.logger.info.bind(deps.logger);
    deps.logger.info = (message: string, fields?: Record<string, unknown>) => {
      lines.push(message);
      baseInfo(message, fields);
    };

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    // The stream's conversation belongs to the holder — this run starts its
    // own, so nothing is written back as the stream's session or holder.
    assertEquals(state.streamSession, undefined);
    assertEquals(state.sessionResumeState, undefined);
    assertEquals(
      lines.filter((line) =>
        line.startsWith("Stream shared — keeping a per-issue session")
      ).length,
      1,
    );

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#2530 - the claim is told the tier may share a busy stream", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue2530-tier-" });
  try {
    const ctx = buildContext(workDir, true, {
      milestoneTitle: "#2319 session resume on by default",
    });
    const shareable: unknown[] = [];
    const deps = createMockDeps({
      git: depsWithPushedWip().git,
      issues: {
        claimIssue: (options: { streamShareable?: boolean }) => {
          shareable.push(options.streamShareable);
          return Promise.resolve({
            ok: true as const,
            value: { claimed: true, winnerId: "my-worker" },
          });
        },
      },
    });

    // `top-priority` (the default configured tier) shares...
    const topState = buildState();
    await workOnIssueSetupBranch(ctx, topState, deps);
    // ...and `low-priority` does not.
    const lowState = buildState();
    await workOnIssueSetupBranch(
      { ...ctx, issueLabels: ["low-priority"] },
      lowState,
      deps,
    );

    assertEquals(shareable, [true, false]);

    if (topState.heartbeatHandle) await stopHeartbeat(topState.heartbeatHandle);
    if (lowState.heartbeatHandle) await stopHeartbeat(lowState.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
