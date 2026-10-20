/**
 * Tests that the live completion phase unassigns the worker from the source
 * issue once the PR exists (Issue #1453, re-wired by Issue #3939).
 *
 * `unassign_on_pr_created` was honoured only by the `pr_completion_phase.ts`
 * module the bash→Deno migration orphaned, so in production the worker stayed
 * assigned and the heartbeat sweep later "recovered" it as a crash. These tests
 * drive `workOnIssueCompletion` and assert on the `gh issue edit
 * --remove-assignee` call it makes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

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

/** Run the completion phase and report whether the worker was unassigned. */
async function runCompletion(unassignOnPrCreated: boolean): Promise<{
  status: string;
  unassignCalls: string[][];
}> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-1453.md`,
    "## Summary\n\nDid the work. Closes #1453.\n",
  );

  const config = buildDefaultWorkerConfig();
  config.unassignOnPrCreated = unassignOnPrCreated;

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 1453,
    issueTitle: "Unassign after PR creation",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-1453-unassign",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const unassignCalls: string[][] = [];
  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(),
      runGhCommand: (args: string[]) => {
        if (args.includes("--remove-assignee")) unassignCalls.push(args);
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/42",
        );
      },
    },
    git: {
      runGitCommand: () =>
        Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: "", stderr: "" },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });
  return { status: result.status, unassignCalls };
}

Deno.test("completion - unassigns the worker after the PR is created", async () => {
  const { status, unassignCalls } = await runCompletion(true);

  assertEquals(status, "continue");
  assertEquals(unassignCalls.length, 1);
  assertEquals(unassignCalls[0], [
    "issue",
    "edit",
    "1453",
    "--repo",
    "stSoftwareAU/VibeCoder",
    "--remove-assignee",
    "vibe-worker",
  ]);
});

Deno.test("completion - unassign_on_pr_created=false leaves the assignee", async () => {
  const { status, unassignCalls } = await runCompletion(false);

  assertEquals(status, "continue");
  assertEquals(unassignCalls.length, 0);
});

Deno.test("completion - Issue #3804: adopts the agent-raised PR body on the run's own branch", async () => {
  const sha = "abc1234def5678abc1234def5678abc1234def56";
  const branch = "issue-1453-unassign";
  const prUrl = "https://github.com/stSoftwareAU/VibeCoder/pull/42";
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-1453.md`,
    "## Summary\n\nDid the work. Closes #1453.\n",
  );

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 1453,
    issueTitle: "Unassign after PR creation",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: branch,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  // The agent raised this PR itself: a marker-less body on the run's branch.
  const editCalls: string[][] = [];
  const editBodies: string[] = [];
  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(),
      runGhCommand: async (args: string[]) => {
        if (
          args[0] === "pr" && args[1] === "view" &&
          args.some((a) => a.includes("headRefName"))
        ) {
          return JSON.stringify({
            body: "## Summary\n\nAgent draft. Closes #1453.\n",
            files: [],
            headRefOid: sha,
            headRefName: branch,
          });
        }
        if (args[0] === "pr" && args[1] === "edit") {
          editCalls.push(args);
          const idx = args.indexOf("--body-file");
          editBodies.push(await Deno.readTextFile(args[idx + 1] ?? ""));
          return "";
        }
        return prUrl;
      },
    },
    git: {
      runGitCommand: (args: string[]) => {
        let stdout = "";
        if (args[0] === "rev-parse") stdout = `${sha}\n`;
        if (args[0] === "ls-remote") stdout = `${sha}\trefs/heads/${branch}\n`;
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
        Promise.resolve({ ok: true, value: prUrl }),
    },
  });

  await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });

  assertEquals(
    editCalls.length,
    1,
    "expected the adopted body to be edited once",
  );
  assertEquals(editCalls[0]?.[2], "42");
  assertStringIncludes(editBodies[0] ?? "", "<!-- vibe-worker-issue-1453 -->");
  assertStringIncludes(editBodies[0] ?? "", "vibe-pr-summary sha256=");
});
