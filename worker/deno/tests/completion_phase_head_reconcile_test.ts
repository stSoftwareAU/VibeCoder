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
  opts: {
    /** Per-command exit code; default 0 (command succeeded). */
    gitCodeFor?: (args: string[]) => number;
    /** Set `state.milestoneBranch` to exercise the milestone base (Issue #68). */
    milestoneBranch?: string;
  } = {},
): Promise<{
  status: string;
  reason?: string;
  order: string[];
  gitCalls: string[][];
  warnings: string[];
  errors: string[];
}> {
  const gitCodeFor = opts.gitCodeFor ?? (() => 0);
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
    ...(opts.milestoneBranch ? { milestoneBranch: opts.milestoneBranch } : {}),
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
  const errors: string[] = [];
  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: (m: string) => errors.push(m),
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
          value: {
            code: gitCodeFor(args),
            stdout: gitStdoutFor(args),
            stderr: "",
          },
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
    errors,
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
  // NOT simply the first rev-list: the branch-currency check runs one of its
  // own (`--left-right --count`) before the push. The ahead guard is the
  // plain `--count`.
  const revList = run.gitCalls.find(
    (a) => a[0] === "rev-list" && !a.includes("--left-right"),
  );
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

// ---------------------------------------------------------------------------
// Issue #68 — the ahead-of-base guard resolves an origin-only milestone base.
// The clone was set up on the issue branch, so a milestone base exists only as
// `origin/<base>`; the bare name is an unknown revision and the guard used to
// take its "could not run" path on every milestone PR.
// ---------------------------------------------------------------------------

const MILESTONE = "milestone/54-planning-the-failure-detection-self-repair";
const RECONCILE_ON_BRANCH = {
  ok: true as const,
  value: {
    action: "already-on-branch" as const,
    fromRef: "issue-565-branding-hot-link",
  },
};

Deno.test("completion #68 - counts against origin/<base> when the milestone base is not local", async () => {
  const run = await runCompletion(
    RECONCILE_ON_BRANCH,
    (args) => args[0] === "rev-list" ? "1\n" : "",
    {
      milestoneBranch: MILESTONE,
      // Local milestone ref absent (exit 1); origin/<base> resolves (exit 0).
      gitCodeFor: (args) =>
        args[0] === "rev-parse" && args.includes(`${MILESTONE}^{commit}`)
          ? 1
          : 0,
    },
  );
  assertEquals(run.status, "continue");
  // NOT simply the first rev-list: the branch-currency check runs one of its
  // own (`--left-right --count`) before the push. The ahead guard is the
  // plain `--count`.
  const revList = run.gitCalls.find(
    (a) => a[0] === "rev-list" && !a.includes("--left-right"),
  );
  assert(revList, "the ahead guard must run for a milestone PR");
  assertEquals(
    revList[2],
    `origin/${MILESTONE}..issue-565-branding-hot-link`,
    "guard counts against the remote-tracking milestone ref",
  );
  assertEquals(run.errors, [], "no louder error when the base resolves");
});

Deno.test("completion #68 - a milestone base with zero ahead commits still fails with the bare name", async () => {
  const run = await runCompletion(
    RECONCILE_ON_BRANCH,
    (args) => args[0] === "rev-list" ? "0\n" : "",
    {
      milestoneBranch: MILESTONE,
      gitCodeFor: (args) =>
        args[0] === "rev-parse" && args.includes(`${MILESTONE}^{commit}`)
          ? 1
          : 0,
    },
  );
  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "no commits ahead");
  // The user-facing message names the base by its bare (server-side) name.
  assertStringIncludes(run.reason ?? "", MILESTONE);
});

Deno.test("completion #68 - an unresolvable base logs a louder error and skips the guard, not a routine warning", async () => {
  const run = await runCompletion(
    RECONCILE_ON_BRANCH,
    () => "",
    {
      milestoneBranch: MILESTONE,
      // Neither local nor origin resolves, and the fetch fails too.
      gitCodeFor: (args) =>
        args[0] === "rev-parse" || args[0] === "fetch" ? 1 : 0,
    },
  );
  assertEquals(run.status, "continue"); // proceeds without the guard
  assert(
    run.errors.some((e) => e.includes("base ref unresolvable")),
    `expected a louder error for an unresolvable base: ${run.errors}`,
  );
  assert(
    !run.warnings.some((w) => w.includes("Ahead-of-base guard could not run")),
    "an unresolvable base is the louder error, not the per-PR warning",
  );
  // The guard never ran a rev-list against a milestone range.
  assert(
    !run.gitCalls.some((a) =>
      a[0] === "rev-list" && !a.includes("--left-right") &&
      a[2]?.includes(MILESTONE)
    ),
    "no ahead-count attempted once the base could not be resolved",
  );
});
