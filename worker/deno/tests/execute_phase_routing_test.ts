/**
 * The main-loop execute phase must route the coding run through the
 * documented `issue` phase and name the repo — the standalone command path
 * did (Issue #2709), this path never had it, so fleet runs bypassed the
 * per-phase model/effort chain and logged `phase=unknown` /
 * `[agent-progress] agent:`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";
import {
  loadResumeState,
  loadStreamSession,
  saveStreamSession,
} from "../lib/resume_state_store.ts";
import { resolveStreamId } from "../lib/stream_identity.ts";

Deno.test("execute_phase - the runner is called with phase 'issue' and the repo (main-loop routing)", async () => {
  const config: WorkerConfig = buildDefaultWorkerConfig();
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 7,
    issueTitle: "Route me",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-7-route-me",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const seen: Array<Record<string, unknown>> = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: Record<string, unknown>) => {
        seen.push(options);
        return Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(seen.length >= 1, true, "the runner must be invoked");
  assertEquals(seen[0]!.phase, "issue");
  assertEquals(seen[0]!.repo, "org/repo");
});

Deno.test("execute_phase - a Codex thread id is adopted and persisted (Issue #1699)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "execute-codex-session-" });
  try {
    const config: WorkerConfig = {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume: true,
    };
    const ctx: IssueContext = {
      repo: "org/repo",
      issueNumber: 1699,
      issueTitle: "Resume me",
      issueBody: "Do the thing.",
      issueLabels: [],
      issueComments: "",
      githubUser: "testbot",
      config,
    };
    const state: PhaseState = {
      branchName: "issue-1699-resume-me",
      baseBranch: "main",
      defaultBranch: "main",
      repoPath: workDir,
      clarityStatus: "assessed_clear",
      claudeOutput: "",
      executeStartTime: Date.now(),
      baselineQualityPassed: true,
      baselineQualityOutput: "",
    };
    const threadId = "0199a5b2-7f31-7c4a-9e08-2b6a4c1d5e77";
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: ((_options: Record<string, unknown>) => {
          return Promise.resolve({
            ok: true,
            value: {
              output: "done",
              exitCode: 0,
              timedOut: false,
              provider: "codex",
              agentOutput: { sessionId: threadId },
            },
          });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(state.sessionResumeState?.sessionId, threadId);
    assertEquals(state.sessionResumeState?.providerId, "codex");
    assertEquals(state.sessionResumeState?.phaseCount, 1);

    const persisted = await loadResumeState(workDir, "org/repo", 1699);
    assertEquals(persisted?.sessionId, threadId);
    assertEquals(persisted?.providerId, "codex");
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

/** State for the stream write-back cases below. */
function streamState(repoPath: string): PhaseState {
  return {
    branchName: "issue-2333-join-the-stream",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** Deps whose agent run always succeeds under `providerId`. */
function streamDeps(providerId: string, sessionId?: string) {
  return createMockDeps({
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: {
            output: "done",
            exitCode: 0,
            timedOut: false,
            provider: providerId,
            ...(sessionId ? { agentOutput: { sessionId } } : {}),
          },
        })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });
}

Deno.test("#2333 - the execute phase writes its session back to the joined stream", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "execute-stream-" });
  try {
    const config: WorkerConfig = {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume: true,
    };
    const ctx: IssueContext = {
      repo: "org/repo",
      issueNumber: 2333,
      issueTitle: "Join the stream",
      issueBody: "Do the thing.",
      issueLabels: [],
      issueComments: "",
      githubUser: "testbot",
      milestoneTitle: "#2319 session resume",
      config,
    };
    const stream = resolveStreamId("org/repo", ctx.milestoneTitle);
    const state = streamState(workDir);
    state.streamSession = { stream, providerId: "claude" };

    await workOnIssueExecuteClaude(ctx, state, streamDeps("claude"));

    const recorded = await loadStreamSession(workDir, stream, "claude");
    assertEquals(recorded?.sessionId, state.sessionResumeState?.sessionId);
    // The holder host is recorded so a reader on another host knows the
    // transcript is not its own to replay.
    assertEquals(typeof recorded?.holderHost, "string");
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#2333 - a run that joined no stream writes no stream record", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "execute-no-stream-" });
  try {
    const config: WorkerConfig = {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume: true,
    };
    const ctx: IssueContext = {
      repo: "org/repo",
      issueNumber: 2334,
      issueTitle: "Sweep the repo",
      issueBody: "Do the thing.",
      issueLabels: ["idle-task"],
      issueComments: "",
      githubUser: "testbot",
      milestoneTitle: "#2319 session resume",
      config,
    };
    const state = streamState(workDir);

    await workOnIssueExecuteClaude(ctx, state, streamDeps("claude"));

    // A session was still opened — per-issue, as it always was.
    assertEquals(typeof state.sessionResumeState?.sessionId, "string");
    const stream = resolveStreamId("org/repo", ctx.milestoneTitle);
    assertEquals(await loadStreamSession(workDir, stream, "claude"), null);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#2333 - a fallback provider's run writes its own stream slot", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "execute-stream-codex-" });
  try {
    const config: WorkerConfig = {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume: true,
    };
    const ctx: IssueContext = {
      repo: "org/repo",
      issueNumber: 2335,
      issueTitle: "Join the stream under Codex",
      issueBody: "Do the thing.",
      issueLabels: [],
      issueComments: "",
      githubUser: "testbot",
      milestoneTitle: "#2319 session resume",
      config,
    };
    const stream = resolveStreamId("org/repo", ctx.milestoneTitle);
    // The primary's session is already on the stream.
    await saveStreamSession(workDir, stream, {
      providerId: "claude",
      sessionId: "0199fd1e-2a4b-4c3d-8e5f-6a7b8c9d0e1f",
    });

    const state = streamState(workDir);
    // Setup anticipated Codex; the run confirms it and names its own thread.
    state.streamSession = { stream, providerId: "codex" };
    const threadId = "codex-thread-2335";

    await workOnIssueExecuteClaude(ctx, state, streamDeps("codex", threadId));

    assertEquals(
      (await loadStreamSession(workDir, stream, "codex"))?.sessionId,
      threadId,
    );
    // The primary's slot is untouched.
    assertEquals(
      (await loadStreamSession(workDir, stream, "claude"))?.sessionId,
      "0199fd1e-2a4b-4c3d-8e5f-6a7b8c9d0e1f",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
