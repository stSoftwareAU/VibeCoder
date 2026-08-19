/**
 * The completion phase reconciles HEAD to the worker branch before pushing
 * (Issue #4286): the agent had committed on a branch of its own, so the
 * worker branch was pushed empty and `gh pr create` failed with "No commits
 * between …" (private-repo-22#565, three attempts).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { HeadReconciliation } from "../lib/git_branch.ts";

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

async function runCompletion(
  reconcile: Result<HeadReconciliation>,
  gitStdoutFor: (args: string[]) => string = () => "",
): Promise<{
  status: string;
  reason?: string;
  order: string[];
  gitCalls: string[][];
  warnings: string[];
}> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-565.md`,
    "## Summary\n\nBanner. Closes #565.\n",
  );
  const config = buildDefaultWorkerConfig();
  const ctx: IssueContext = {
    repo: "stSoftwareAU/private-repo-22",
    issueNumber: 565,
    issueTitle: "Branding: hot-link the banner",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-565-branding-hot-link",
    baseBranch: "Develop",
    defaultBranch: "Develop",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const order: string[] = [];
  const gitCalls: string[][] = [];
  const warnings: string[] = [];
  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(),
      runGhCommand: () =>
        Promise.resolve(
          "https://github.com/stSoftwareAU/private-repo-22/pull/9",
        ),
    },
    git: {
      reconcileHeadToBranch: () => {
        order.push("reconcile");
        return Promise.resolve(reconcile);
      },
      pushUnpushedCommits: () => {
        order.push("push");
        return Promise.resolve({ ok: true as const, value: 2 });
      },
      runGitCommand: (args: string[]) => {
        gitCalls.push(args);
        return Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: gitStdoutFor(args), stderr: "" },
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
  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });
  return {
    status: result.status,
    ...(result.status === "failure" ? { reason: result.reason } : {}),
    order,
    gitCalls,
    warnings,
  };
}

Deno.test("completion - reconciles HEAD to the worker branch BEFORE pushing, and warns when it had to fast-forward (Issue #4286)", async () => {
  const run = await runCompletion(
    {
      ok: true,
      value: { action: "fast-forwarded", fromRef: "issue-565-readme-banner" },
    },
    (args) => args[0] === "rev-list" ? "2\n" : "",
  );
  assertEquals(run.status, "continue");
  assertEquals(run.order.slice(0, 2), ["reconcile", "push"]);
  assert(
    run.warnings.some((w) => w.includes("issue-565-readme-banner")),
    `expected a fast-forward warning naming the agent's branch: ${run.warnings}`,
  );
});

Deno.test("completion - the ahead-of-base guard counts the WORKER branch, not HEAD (Issue #4286)", async () => {
  const run = await runCompletion(
    {
      ok: true,
      value: {
        action: "already-on-branch",
        fromRef: "issue-565-branding-hot-link",
      },
    },
    (args) => args[0] === "rev-list" ? "1\n" : "",
  );
  assertEquals(run.status, "continue");
  const revList = run.gitCalls.find((a) => a[0] === "rev-list");
  assert(revList, "expected the ahead guard to run");
  assertEquals(revList[2], "Develop..issue-565-branding-hot-link");
});

Deno.test("completion - diverged agent/worker branches fail with the explicit reason, never reaching gh pr create (Issue #4286)", async () => {
  const run = await runCompletion({
    ok: false,
    error: new Error(
      "HEAD is on 'agent-branch' and the worker branch 'issue-565-branding-hot-link' has diverged from it",
    ),
  });
  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "diverged");
  assertStringIncludes(run.reason ?? "", "issue-565-branding-hot-link");
  assertEquals(
    run.order,
    ["reconcile"],
    "nothing pushed after a refused reconcile",
  );
});

Deno.test("completion - a failing ahead-of-base guard warns instead of silently proceeding (Issue #4286)", async () => {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  const config = buildDefaultWorkerConfig();
  const ctx: IssueContext = {
    repo: "o/r",
    issueNumber: 1,
    issueTitle: "t",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "u",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-1-x",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const warnings: string[] = [];
  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(),
      runGhCommand: () => Promise.resolve("https://github.com/o/r/pull/1"),
    },
    git: {
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true as const,
          value: args[0] === "rev-list"
            ? { code: 128, stdout: "", stderr: "fatal: bad revision" }
            : { code: 0, stdout: "", stderr: "" },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
  });
  try {
    await workOnIssueCompletion(ctx, state, deps);
    assert(
      warnings.some((w) => w.includes("Ahead-of-base guard could not run")),
      `expected a guard warning: ${warnings}`,
    );
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});
