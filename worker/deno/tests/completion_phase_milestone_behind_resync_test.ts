/**
 * A child PR whose milestone branch fell behind mid-run is armed in the same
 * cycle (Issue #2005).
 *
 * The default branch moves while a child issue run works, so by the time the
 * run raises its PR the milestone branch it targets is behind. The Issue
 * #1779 gate defers the arming, and before this change the PR waited for the
 * next cycle's periodic sync — observed once as a child PR raised at 22:11Z
 * that a human merged by hand at 23:26Z.
 *
 * The completion phase now runs the Issue #1780 inline pre-sync at that
 * point and arms again. These tests drive `workOnIssueCompletion` — the path
 * `issue_worker.ts` runs — and assert on what it did: the sync attempt, the
 * second arming, and the PR comment a branch that could not be brought level
 * gets.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { GitHubClient } from "../types.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";

const REPO = "org/repo";
const MILESTONE_TITLE = "#1730 Resolve merge conflicts";
const MILESTONE_BRANCH = "milestone/1730-resolve-merge-conflicts";
const PR_URL = "https://github.com/org/repo/pull/5";

/** One recorded inline sync attempt. */
interface SyncCall {
  milestoneBranch: string;
  defaultBranch: string;
  cwd: string | undefined;
}

/** What one drive of the completion phase did. */
interface Observed {
  status: string;
  /** One entry per `finalisePr` call — the arming attempts. */
  armAttempts: number;
  syncCalls: SyncCall[];
  /** Comments posted on any thread, in order. */
  comments: Array<{ number: number; body: string }>;
}

function buildContext(workDir: string): IssueContext {
  return {
    repo: REPO,
    issueNumber: 2005,
    issueTitle: "Arm a child PR whose milestone fell behind",
    issueBody: "The child PR waits a whole cycle.",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    milestoneTitle: MILESTONE_TITLE,
    config: { ...buildDefaultWorkerConfig(), workDir },
  };
}

function buildState(): PhaseState {
  return {
    branchName: "issue-2005-arm-child-pr",
    baseBranch: MILESTONE_BRANCH,
    defaultBranch: "main",
    milestoneBranch: MILESTONE_BRANCH,
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** A conflict every rung the attempt was granted left undecided. */
function unresolvedConflict(): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "lib/foo.ts could not be settled",
    [{
      path: "lib/foo.ts",
      reason: "agent: could not settle the collision",
      oursExports: [],
      theirsExports: [],
      oursTests: [],
      theirsTests: [],
      onlyOursTests: [],
      onlyTheirsTests: [],
    }],
    [],
    "d".repeat(40),
  );
}

/**
 * Drive the live completion phase against a milestone-behind deferral.
 *
 * `finalisePr` answers `milestone-behind` until the branch is reported
 * level, which is exactly what the real gate does — so a second arming only
 * succeeds when the sync actually landed.
 */
async function runCompletion(options: {
  behindBy: number;
  syncFails?: Error;
  /** Omit the milestone branch, as a non-milestone run does. */
  withoutMilestoneBranch?: boolean;
}): Promise<Observed> {
  const workDir = await Deno.makeTempDir({ prefix: "issue-2005-" });
  await Deno.mkdir(`${workDir}/repo`, { recursive: true });
  const syncCalls: SyncCall[] = [];
  const comments: Array<{ number: number; body: string }> = [];
  let armAttempts = 0;
  let branchLevel = options.behindBy === 0;

  const client: GitHubClient = {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, number: number, body: string) => {
      comments.push({ number, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };

  const deps = createMockDeps({
    github: {
      createClient: () => client,
      runGhCommand: () => Promise.resolve(PR_URL),
    },
    git: {
      countCommitsAhead: () =>
        Promise.resolve({
          ok: true as const,
          value: branchLevel ? 0 : options.behindBy,
        }),
      syncMilestoneBranchWithDefault: (
        milestoneBranch: string,
        defaultBranch: string,
        gitOptions?: { cwd?: string },
      ) => {
        syncCalls.push({
          milestoneBranch,
          defaultBranch,
          cwd: gitOptions?.cwd,
        });
        if (options.syncFails) {
          return Promise.resolve({
            ok: false as const,
            error: options.syncFails,
          });
        }
        branchLevel = true;
        return Promise.resolve({
          ok: true as const,
          value: { message: "merged main down" },
        });
      },
      runGitCommand: () =>
        Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: "a".repeat(40), stderr: "" },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
      finalisePr: (() => {
        armAttempts++;
        return Promise.resolve(
          branchLevel
            ? { ok: true as const, value: { message: "auto-merge armed" } }
            : {
              ok: true as const,
              value: {
                message: "milestone behind default branch (1 commit)",
                deferral: "milestone-behind" as const,
                milestoneBranch: MILESTONE_BRANCH,
              },
            },
        );
      }) as unknown as ReturnType<typeof createMockDeps>["pr"]["finalisePr"],
    },
  });

  const state = buildState();
  if (options.withoutMilestoneBranch) delete state.milestoneBranch;

  try {
    const result = await workOnIssueCompletion(
      buildContext(workDir),
      state,
      deps,
    );
    return { status: result.status, armAttempts, syncCalls, comments };
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("#2005 - a clean inline sync arms the child PR in the same run", async () => {
  const observed = await runCompletion({ behindBy: 1 });

  assertEquals(observed.status, "continue");
  assertEquals(observed.syncCalls.length, 1, "one inline sync attempt");
  assertEquals(observed.syncCalls[0]?.milestoneBranch, MILESTONE_BRANCH);
  assertEquals(observed.syncCalls[0]?.defaultBranch, "main");
  // The shared clone the periodic sweep uses — never this lane's worktree.
  assertStringIncludes(observed.syncCalls[0]?.cwd ?? "", "/repo");
  assertEquals(
    observed.armAttempts,
    2,
    "arming is retried once the milestone branch is level",
  );
  assertEquals(
    observed.comments.filter((c) => c.body.includes("Auto-merge not armed")),
    [],
    "a cleared deferral says nothing on the PR",
  );
});

Deno.test("#2005 - a conflicting sync leaves the deferral and says so on the PR", async () => {
  const observed = await runCompletion({
    behindBy: 2,
    syncFails: unresolvedConflict(),
  });

  assertEquals(observed.status, "continue");
  assertEquals(observed.syncCalls.length, 1, "one inline sync attempt");
  assertEquals(
    observed.armAttempts,
    1,
    "arming is not retried against a branch still behind",
  );
  const deferralComment = observed.comments.find((c) =>
    c.body.includes("Auto-merge not armed")
  );
  assert(deferralComment, "the deferral reason is posted on the PR");
  assertEquals(deferralComment.number, 5, "posted on the PR, not the issue");
  assertStringIncludes(deferralComment.body, MILESTONE_BRANCH);
  assertStringIncludes(deferralComment.body, "main");
  assertStringIncludes(deferralComment.body, "conflict attempt 1 of");
});

Deno.test("#2005 - a milestone branch already level is armed without a merge", async () => {
  const observed = await runCompletion({ behindBy: 0 });

  assertEquals(observed.status, "continue");
  assertEquals(observed.syncCalls, [], "a level branch is not merged into");
  assertEquals(observed.armAttempts, 1, "the first arming already succeeded");
});

Deno.test("#2005 - a deferral naming no branch this run knows attempts no sync", async () => {
  const observed = await runCompletion({
    behindBy: 1,
    withoutMilestoneBranch: true,
  });

  assertEquals(observed.status, "continue");
  assertEquals(observed.syncCalls, [], "no branch is guessed at");
  assertEquals(observed.armAttempts, 1);
});
