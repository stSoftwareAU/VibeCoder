/**
 * The completion phase refuses a PR built from nothing but preserved WIP
 * (Issue #148, follow-up to #47).
 *
 * A timed-out execute parks its work as a `wip:` commit on the issue branch.
 * That commit makes the branch "ahead of base", so the pre-existing
 * ahead-of-base guard waves through a later claim that added nothing — and
 * `gh pr create` presents parked, half-done work as a finished change. The
 * refusal here needs the run to have resumed a checkpoint AND to have added
 * no commit of its own AND the branch to hold only WIP markers, so a run
 * whose own work landed in checkpoint commits still raises its PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { WIP_CHECKPOINT_COMMIT_MESSAGE } from "../lib/wip_checkpoint.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";

const BRANCH = "issue-148-preserve-wip";
const RESUMED_HEAD = "a1b2c3d4e5f6";
const WIP_SUBJECT =
  "wip: execute timed out after 1780s at the cycle deadline — preserving " +
  "6 uncommitted file(s) (Issue #47)";

function stubClient(): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

/**
 * Run the completion phase over a branch that is two commits ahead of base.
 *
 * @param opts.resumedCheckpointHead - `state.resumedCheckpointHead`.
 * @param opts.commitsAddedByThisRun - `rev-list <resumed>..<branch>` count.
 * @param opts.subjects - commit subjects ahead of base.
 */
async function runCompletion(opts: {
  resumedCheckpointHead?: string;
  commitsAddedByThisRun: number;
  subjects: string[];
}): Promise<{
  status: string;
  reason?: string;
  ghCalls: string[][];
  gitCalls: string[][];
}> {
  const repoPath = await Deno.makeTempDir({ prefix: "issue148-wip-gate-" });
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-148.md`,
    "## Summary\n\nPreserve WIP. Closes #148.\n",
  );
  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 148,
    issueTitle: "Preserve a timed-out run's WIP",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...(opts.resumedCheckpointHead
      ? {
        resumedFromCheckpoint: true,
        resumedCheckpointHead: opts.resumedCheckpointHead,
      }
      : {}),
  };
  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];
  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(),
      runGhCommand: (args: string[]) => {
        ghCalls.push(args);
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/900",
        );
      },
    },
    git: {
      reconcileHeadToBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: { action: "already-on-branch" as const, fromRef: BRANCH },
        }),
      pushUnpushedCommits: () =>
        Promise.resolve({ ok: true as const, value: 1 }),
      runGitCommand: (args: string[]) => {
        gitCalls.push(args);
        let stdout = "";
        if (args[0] === "rev-list" && args[2]?.startsWith("main..")) {
          stdout = `${opts.subjects.length}\n`;
        } else if (
          args[0] === "rev-list" && args[2]?.startsWith(`${RESUMED_HEAD}..`)
        ) {
          stdout = `${opts.commitsAddedByThisRun}\n`;
        } else if (args[0] === "log" && args[1] === "--format=%s") {
          stdout = opts.subjects.join("\n");
        }
        return Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout, stderr: "" },
        });
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
  });

  try {
    const result = await workOnIssueCompletion(ctx, state, deps);
    return {
      status: result.status,
      ...(result.status === "failure" ? { reason: result.reason } : {}),
      ghCalls,
      gitCalls,
    };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

Deno.test("completion #148 - a resumed run that added nothing to a WIP-only branch raises no PR", async () => {
  const run = await runCompletion({
    resumedCheckpointHead: RESUMED_HEAD,
    commitsAddedByThisRun: 0,
    subjects: [WIP_SUBJECT, WIP_CHECKPOINT_COMMIT_MESSAGE],
  });

  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "only preserved WIP");
  assertStringIncludes(run.reason ?? "", BRANCH);
  assertStringIncludes(run.reason ?? "", "Issue #148");
  assert(
    !run.ghCalls.some((a) => a[0] === "pr" && a[1] === "create"),
    `no PR may be created from parked work: ${JSON.stringify(run.ghCalls)}`,
  );
});

Deno.test("completion #148 - the refusal is diagnosed as no_changes, not a worker fault", async () => {
  const run = await runCompletion({
    resumedCheckpointHead: RESUMED_HEAD,
    commitsAddedByThisRun: 0,
    subjects: [WIP_SUBJECT],
  });
  assertEquals(detectFailureCategory(run.reason ?? ""), "no_changes");
});

Deno.test("completion #148 - a resumed run that advanced the branch still raises its PR", async () => {
  const run = await runCompletion({
    resumedCheckpointHead: RESUMED_HEAD,
    commitsAddedByThisRun: 2,
    // Even when the advancing commits were themselves checkpoints, the run
    // produced work — this is the false positive the guard must not hit.
    subjects: [WIP_CHECKPOINT_COMMIT_MESSAGE, WIP_SUBJECT],
  });
  assertEquals(run.status, "continue");
  assert(
    run.ghCalls.some((a) => a[0] === "pr" && a[1] === "create"),
    "an advanced branch must still reach gh pr create",
  );
});

Deno.test("completion #148 - a real commit on the branch is never refused", async () => {
  const run = await runCompletion({
    resumedCheckpointHead: RESUMED_HEAD,
    commitsAddedByThisRun: 0,
    subjects: [WIP_SUBJECT, "Add the claim-runway floor (Issue #47)"],
  });
  assertEquals(run.status, "continue");
});

Deno.test("completion #148 - a run that never resumed a checkpoint skips the guard entirely", async () => {
  const run = await runCompletion({
    commitsAddedByThisRun: 0,
    subjects: [WIP_CHECKPOINT_COMMIT_MESSAGE],
  });
  assertEquals(run.status, "continue");
  assert(
    !run.gitCalls.some((a) => a[0] === "log" && a[1] === "--format=%s"),
    "the subject read only runs for a resumed claim",
  );
});
