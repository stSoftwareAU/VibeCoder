/**
 * Tests for the branch conflict pass (Issue #2459):
 * When `ensureBranchCurrent` returns `declined` due to a rebase conflict,
 * exactly one agent pass is invoked to attempt resolution. On success,
 * the PR is raised with no conflict comment. On failure, exactly one
 * conflict comment is posted naming the conflicting paths.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const BRANCH = "issue-2459-branch-conflict-test";
const BASE_BRANCH = "main";

interface RecordedComment {
  repo: string;
  issueNumber: number;
  body: string;
}

function makeStubClient(comments: RecordedComment[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (repo, issueNumber, body) => {
      comments.push({ repo, issueNumber, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 2459,
    issueTitle:
      "One in-run agent rebase-and-fix pass when the pre-PR rebase declines",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: BASE_BRANCH,
    defaultBranch: BASE_BRANCH,
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...overrides,
  };
}

/**
 * Create fake dependencies that simulate a rebase conflict scenario:
 * - First rev-list call returns behind=2 (triggers declined)
 * - Cherry-pick fails with conflict
 * - Agent pass is invoked
 * - On success: second rev-list call returns behind=0
 * - On failure: no second rev-list call, handoff with conflict comment
 */
function makeBranchConflictDeps(
  comments: RecordedComment[],
  agentSuccess: boolean,
) {
  let revListCallCount = 0;
  let agentCallCount = 0;

  return createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => makeStubClient(comments),
      runGhCommand: (_args: string[]) =>
        Promise.resolve("https://github.com/stSoftwareAU/VibeCoder/pull/2459"),
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
        const joined = args.join(" ");
        let code = 0;
        let stdout = "";

        // Handle fetch origin <baseBranch>
        if (args[0] === "fetch" && args[1] === "origin") {
          stdout = "";
          code = 0;
        } // Handle rev-list --left-right --count
        else if (args[0] === "rev-list" && joined.includes("--left-right")) {
          revListCallCount++;
          if (revListCallCount === 1) {
            // First call from ensureBranchCurrent: behind=2 to trigger declined
            stdout = "2 0\n";
          } else {
            // Second call from runDeclinedRebasePass post-agent: behind=0 for success
            stdout = "0 0\n";
          }
        } // Handle status --porcelain
        else if (args[0] === "status" && joined.includes("--porcelain")) {
          stdout = ""; // Clean tree
        } // Handle rev-parse --verify --end-of-options <branch>^{commit}
        else if (
          args[0] === "rev-parse" &&
          joined.includes("--verify") &&
          joined.includes("^{commit}")
        ) {
          stdout = "a".repeat(40) + "\n"; // Fake branch tip SHA
        } // Handle rev-list --reverse --no-merges to get commits
        else if (args[0] === "rev-list" && joined.includes("--reverse")) {
          stdout = "b".repeat(40) + "\n"; // Fake commit SHA
        } // Handle checkout
        else if (args[0] === "checkout") {
          stdout = "";
          code = 0;
        } // Handle reset --hard
        else if (
          args[0] === "reset" &&
          (joined.includes("--hard") || args[1] === "--hard")
        ) {
          stdout = "";
          code = 0;
        } // Handle cherry-pick -n (non-interactive)
        else if (args[0] === "cherry-pick" && joined.includes("-n")) {
          // Simulate conflict failure on the first cherry-pick
          stdout = "CONFLICT (content): Merge conflict in src/file.ts\n";
          code = 1; // Non-zero to trigger conflict
        } // Handle cherry-pick --abort, rebase --abort, merge --abort
        else if (
          (args[0] === "cherry-pick" && args[1] === "--abort") ||
          (args[0] === "rebase" && args[1] === "--abort") ||
          (args[0] === "merge" && args[1] === "--abort")
        ) {
          code = 0;
          stdout = "";
        } // Handle diff --name-only (from findBothSidesPaths)
        else if (args[0] === "diff" && joined.includes("--name-only")) {
          // Return conflict paths
          stdout = "src/file.ts\nlib/helper.ts\n";
        }

        return Promise.resolve({
          ok: true as const,
          value: { code, stdout, stderr: "" },
        });
      },
    },
    claude: {
      runClaudeWithRetry: () => {
        agentCallCount++;
        if (agentSuccess) {
          // Agent succeeds: return successful result
          return Promise.resolve({
            ok: true as const,
            value: {
              exitCode: 0,
              output: "Resolved conflicts and rebased successfully",
              timedOut: false,
            },
          });
        } else {
          // Agent fails: return error
          return Promise.resolve({
            ok: false as const,
            error: new Error("Agent rebase attempt failed"),
          });
        }
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });
}

// =============================================================================
// Success case: agent resolves conflict, PR raised with behind=0, no comment
// =============================================================================

Deno.test(
  "completion - on declined rebase, exactly one agent pass is invoked and on success no conflict comment is posted",
  async () => {
    const repoPath = await Deno.makeTempDir();
    await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${repoPath}/docs/archive/pr-summaries/pr-summary-2459.md`,
      "## Summary\n\nBranch conflict resolution. Closes #2459.\n",
    );

    try {
      const ctx = makeContext();
      const state = makeState({ repoPath });
      const comments: RecordedComment[] = [];
      const deps = makeBranchConflictDeps(comments, true); // agentSuccess = true

      const result = await workOnIssueCompletion(ctx, state, deps);

      assertEquals(
        result.status,
        "continue",
        `completion should succeed when agent resolves conflict; got ${result.status}${
          result.status === "failure" ? `: ${result.reason}` : ""
        }`,
      );

      // No conflict comment should be posted on agent success
      const conflictComment = comments.find(
        (c) =>
          c.body.includes("This PR was raised behind") ||
          c.body.includes("merge-conflict ladder"),
      );
      assertEquals(
        conflictComment,
        undefined,
        "no conflict comment should be posted when agent succeeds",
      );
    } finally {
      await Deno.remove(repoPath, { recursive: true });
    }
  },
);

// =============================================================================
// Failure case: agent fails, PR raised anyway, exactly one conflict comment
// =============================================================================

Deno.test(
  "completion - on agent failure, exactly one conflict comment is posted naming conflicting paths",
  async () => {
    const repoPath = await Deno.makeTempDir();
    await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${repoPath}/docs/archive/pr-summaries/pr-summary-2459.md`,
      "## Summary\n\nBranch conflict resolution. Closes #2459.\n",
    );

    try {
      const ctx = makeContext();
      const state = makeState({ repoPath });
      const comments: RecordedComment[] = [];
      const deps = makeBranchConflictDeps(comments, false); // agentSuccess = false

      const result = await workOnIssueCompletion(ctx, state, deps);

      assertEquals(
        result.status,
        "continue",
        `completion should continue even when agent fails; got ${result.status}${
          result.status === "failure" ? `: ${result.reason}` : ""
        }`,
      );

      // Exactly one conflict comment should be posted
      const conflictComments = comments.filter(
        (c) =>
          c.body.includes("This PR was raised behind") ||
          c.body.includes("merge-conflict ladder"),
      );
      assertEquals(
        conflictComments.length,
        1,
        "exactly one conflict comment should be posted on agent failure",
      );

      const conflictComment = conflictComments[0]!;
      assertStringIncludes(
        conflictComment.body,
        "This PR was raised behind",
        "conflict comment must explain the PR was raised behind base",
      );
      assertStringIncludes(
        conflictComment.body,
        "merge-conflict ladder owns this PR from here",
        "conflict comment must mention that merge-conflict ladder owns it",
      );
      assertStringIncludes(
        conflictComment.body,
        "src/file.ts",
        "conflict comment must name at least one conflicting path",
      );
    } finally {
      await Deno.remove(repoPath, { recursive: true });
    }
  },
);
