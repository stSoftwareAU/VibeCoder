/**
 * Setup-phase regression tests for a milestone ruleset that refuses its own
 * branch creation (Issue #2079).
 *
 * `stSoftwareAU/GRQ-FX-validation` recorded three fast failures in a day and
 * was backed off: every claim reached `setup`, tried to open the milestone
 * branch, and was refused by the repository's own ruleset inside a minute.
 * Issue #2067 put the remedy in the operator-run `setup` command, which
 * nobody re-ran against that repository — so the worker now clears the block
 * in the run that meets it and creates the branch, instead of dying.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type IssueContext,
  type PhaseState,
  workOnIssueSetupBranch,
} from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { GitHubClient } from "../types.ts";
import { resetMilestoneCreateBlockRepairsForTest } from "../lib/milestone_create_block_repair.ts";
import { resetRepoLevelRejectionsForTest } from "../lib/milestone_branch_rejection.ts";

const MILESTONE = "Scan 20260910";
const BRANCH = "milestone/scan-20260910";

/** The refusal GRQ-FX-validation produced, verbatim. */
const REFUSAL = `Failed to push milestone branch ${BRANCH}: ` +
  `git push origin Develop:refs/heads/${BRANCH} failed (exit code 1): ` +
  `remote: error: GH013: Repository rule violations found for ` +
  `refs/heads/${BRANCH}.\n! [remote rejected] Develop -> ${BRANCH} ` +
  `(push declined due to repository rule violations)`;

interface Escalations {
  comments: string[];
  labels: string[];
}

function stubClient(calls: Escalations): GitHubClient {
  return {
    getIssue: () => Promise.reject(new Error("stub: getIssue")),
    getIssueComments: () =>
      Promise.resolve(
        calls.comments.map((body, i) => ({
          id: i + 1,
          body,
          author: "testbot",
          createdAt: new Date().toISOString(),
          reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
        })),
      ),
    addLabel: (_repo: string, _n: number, label: string) => {
      calls.labels.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, _n: number, body: string) => {
      calls.comments.push(body);
      return Promise.resolve(undefined);
    },
    updateComment: () => Promise.resolve(),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as GitHubClient;
}

function makeContext(): IssueContext {
  return {
    repo: "stSoftwareAU/GRQ-FX-validation",
    issueNumber: 151,
    issueTitle: "Milestone child",
    issueBody: "body",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    milestoneTitle: MILESTONE,
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-151-milestone-child",
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

async function stopHeartbeatFor(state: PhaseState): Promise<void> {
  if (!state.heartbeatHandle) return;
  const { stopHeartbeat } = await import("../lib/heartbeat.ts");
  await stopHeartbeat(state.heartbeatHandle);
}

/**
 * A ruleset that refuses branch creation until it is repaired — the live
 * shape of the failure, driven through the phase's own seams.
 */
function blockedRepo() {
  const state = { blocked: true, repairs: 0, pushes: 0 };
  return {
    state,
    ensure: () => {
      state.pushes++;
      return Promise.resolve(
        state.blocked
          ? { ok: false as const, error: new Error(REFUSAL) }
          : { ok: true as const, value: `Milestone branch ${BRANCH} created` },
      );
    },
    repair: () => {
      state.repairs++;
      state.blocked = false;
      return Promise.resolve({
        ok: true as const,
        repaired: true as const,
        ruleset: "Vibe Coder milestone branches",
      });
    },
  };
}

Deno.test("setupBranch - repairs the create-blocking ruleset and opens the milestone branch (Issue #2079)", async () => {
  resetMilestoneCreateBlockRepairsForTest();
  resetRepoLevelRejectionsForTest();
  const ctx = makeContext();
  const state = makeState();
  const calls: Escalations = { comments: [], labels: [] };
  const repo = blockedRepo();
  const deps = createMockDeps({
    git: {
      ensureMilestoneBranchExists: repo
        .ensure as unknown as ReturnType<
          typeof createMockDeps
        >["git"]["ensureMilestoneBranchExists"],
    },
    github: {
      createClient: () => stubClient(calls),
      repairMilestoneCreateBlock: repo.repair,
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(state.baseBranch, BRANCH);
  // One repair, and the branch creation retried exactly once after it.
  assertEquals(repo.state.repairs, 1);
  assertEquals(repo.state.pushes, 2);
  // Nothing was handed to a human: the worker fixed it.
  assertEquals(calls.comments.length, 0);
  assertEquals(calls.labels.length, 0);

  await stopHeartbeatFor(state);
});

Deno.test("setupBranch - a refused repair still fails loud and names what the worker tried (Issue #2079)", async () => {
  resetMilestoneCreateBlockRepairsForTest();
  resetRepoLevelRejectionsForTest();
  const ctx = makeContext();
  const state = makeState();
  const calls: Escalations = { comments: [], labels: [] };
  const deps = createMockDeps({
    git: {
      ensureMilestoneBranchExists: (() =>
        Promise.resolve({
          ok: false,
          error: new Error(REFUSAL),
        })) as unknown as ReturnType<
          typeof createMockDeps
        >["git"]["ensureMilestoneBranchExists"],
    },
    github: {
      createClient: () => stubClient(calls),
      repairMilestoneCreateBlock: () =>
        Promise.resolve({
          ok: false as const,
          error: new Error(
            "Not Found — writing a ruleset needs ADMIN on " + ctx.repo,
          ),
        }),
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertStringIncludes((result as { reason: string }).reason, BRANCH);
  // The handoff says the worker tried and why it could not finish.
  assertEquals(calls.comments.length, 1);
  const comment = calls.comments[0] ?? "";
  assertStringIncludes(comment, "needs ADMIN");
  assert(
    calls.labels.includes(ctx.config.needsHumanLabel),
    "a refused repair must still escalate to a human",
  );

  await stopHeartbeatFor(state);
});
