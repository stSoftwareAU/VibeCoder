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
import { loadResumeState } from "../lib/resume_state_store.ts";

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
