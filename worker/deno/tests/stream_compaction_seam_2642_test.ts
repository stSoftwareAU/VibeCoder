/**
 * Stream compaction goes through `deps.claude` (Issue #2642).
 *
 * `primeStreamCompaction` spawns the real agent CLI for a `/compact` turn
 * whenever a run resumes its stream's conversation. The planning and setup
 * phases called it directly, so a mocked test whose round resumed a stream —
 * any round after the first on a shared `workDir` — ran `claude` for real and
 * took one to three seconds a round. These tests pin that both phases reach
 * compaction only through the seam, and that the seam's answer is what the
 * run carries.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { type ClaudeDeps, createMockDeps } from "../lib/issue_worker_wiring.ts";
import { processIssuePlanning } from "../lib/planning_processor.ts";
import { workOnIssueSetupBranch } from "../lib/phases/setup_branch_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient } from "../types.ts";
import { saveStreamSession } from "../lib/resume_state_store.ts";
import { resolveStreamId } from "../lib/stream_identity.ts";
import { anticipatedProviderId } from "../lib/stream_session.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
/** An RFC 4122 v4 id — the CLI rejects anything else (Issue #204). */
const STREAM_SESSION_ID = "0199fd1e-2a4b-4c3d-8e5f-000000002642";
/** A window no default produces, so seeing it proves the seam's answer won. */
const SEAM_WINDOW = 26_420;

type PrimeOptions = Parameters<ClaudeDeps["primeStreamCompaction"]>[0];

/** A compaction seam that records its calls and answers {@link SEAM_WINDOW}. */
function recordingCompaction(calls: PrimeOptions[]) {
  return ((options: PrimeOptions) => {
    calls.push(options);
    return Promise.resolve(SEAM_WINDOW);
  }) as ClaudeDeps["primeStreamCompaction"];
}

/** Seed the stream record a sibling issue left behind. */
async function seedStream(
  workDir: string,
  repo: string,
  milestoneTitle?: string,
): Promise<string> {
  const providerId = anticipatedProviderId();
  const saved = await saveStreamSession(
    workDir,
    resolveStreamId(repo, milestoneTitle),
    { providerId, sessionId: STREAM_SESSION_ID, holderHost: "test-host" },
  );
  assert(saved, "the fixture must seed the stream record");
  return providerId;
}

function stubGhClient(): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 100,
        title: "Break down auth refactor",
        body: "",
        labels: [],
        author: "user",
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as unknown as GitHubClient;
}

Deno.test("#2642 - planning compacts a resumed stream through deps.claude, and every turn carries its window", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue2642-planning-" });
  try {
    const repo = "org/repo";
    const providerId = await seedStream(workDir, repo);
    const config = buildDefaultWorkerConfig();
    config.workDir = workDir;
    config.enableSessionResume = true;
    const ctx: IssueContext = {
      repo,
      issueNumber: 100,
      issueTitle: "Break down auth refactor",
      issueBody: "This issue needs to be broken into sub-issues.",
      issueLabels: ["planning"],
      issueComments: "",
      githubUser: "testbot",
      config,
    };
    const calls: PrimeOptions[] = [];
    const runs: Record<string, unknown>[] = [];
    const deps = createMockDeps({
      claude: {
        primeStreamCompaction: recordingCompaction(calls),
        runClaudeWithRetry: ((options: Record<string, unknown>) => {
          runs.push(options);
          return Promise.resolve({
            ok: true,
            value: {
              output: runs.length === 1
                ? "Draft plan: this needs two sub-issues."
                : "Created https://github.com/org/repo/issues/131",
              exitCode: 0,
              timedOut: false,
            },
          });
        }) as never,
      },
    });

    await processIssuePlanning(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient: stubGhClient(),
      logger: deps.logger,
      deps,
    });

    assertEquals(calls.length, 1, "compacted once, before the first turn");
    assertEquals(calls[0]?.outcome, "resumed");
    assertEquals(calls[0]?.sessionId, STREAM_SESSION_ID);
    assertEquals(calls[0]?.providerId, providerId);
    assert(runs.length >= 1, "the round must make at least one turn");
    for (const run of runs) assertEquals(run.autocompactTokens, SEAM_WINDOW);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("#2642 - the setup phase compacts a resumed stream through deps.claude", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue2642-setup-" });
  try {
    const repo = "stSoftwareAU/VibeCoder";
    const milestoneTitle = "#2642 fast unit tests";
    const providerId = await seedStream(workDir, repo, milestoneTitle);
    const ctx: IssueContext = {
      repo,
      issueNumber: 2642,
      issueTitle: "Unit tests should be fast",
      issueBody: "",
      issueLabels: ["work-on"],
      issueComments: "",
      githubUser: "vibe-worker",
      milestoneTitle,
      config: {
        ...buildDefaultWorkerConfig(),
        workDir,
        enableSessionResume: true,
      },
    };
    const state: PhaseState = {
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
    const calls: PrimeOptions[] = [];
    const deps = createMockDeps({
      claude: { primeStreamCompaction: recordingCompaction(calls) },
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);
    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);

    assertEquals(result.status, "continue");
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.outcome, "resumed");
    assertEquals(calls[0]?.sessionId, STREAM_SESSION_ID);
    assertEquals(calls[0]?.providerId, providerId);
    assertEquals(state.autocompactTokens, SEAM_WINDOW);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("#2642 - the mock deps' compaction answers no window and runs nothing", async () => {
  const deps = createMockDeps();
  const window = await deps.claude.primeStreamCompaction({
    outcome: "resumed",
    providerId: "claude",
    sessionId: STREAM_SESSION_ID,
    logger: deps.logger,
  });
  assertEquals(window, undefined);
});
