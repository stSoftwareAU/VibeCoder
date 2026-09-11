/**
 * A `gh pr create` refused by GitHub's *secondary* (content-creation) rate
 * limit defers the PR instead of failing the run (Issue #1951).
 *
 * Observed live: the work was finished, quality-gated and pushed; the create
 * was refused for a self-clearing content-creation throttle, retried for ~30
 * seconds, and the run was recorded as a failure with the branch orphaned and
 * the refusal classified as an account usage limit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { listDeferredPrs } from "../lib/deferred_pr_store.ts";

/** GitHub's wording when the content-creation limit refuses a PR. */
const SECONDARY_ERROR =
  "gh command failed (exit 1): HTTP 403: You have exceeded a secondary rate " +
  "limit and have been temporarily blocked from content creation. Please " +
  "retry your request again later.";

function stubClient(comments: string[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_r: string, _i: number, body: string) => {
      comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as unknown as GitHubClient;
}

interface CompletionRun {
  status: string;
  reason?: string;
  outcomeKind?: string;
  comments: string[];
  ghCalls: string[][];
  warnings: string[];
  workDir: string;
}

/**
 * Run the completion phase with a scripted `gh`.
 *
 * The handler deadline is already past, so no minute-scale wait is
 * affordable — the run must defer rather than burn the remaining budget.
 * The waiting itself is covered by `pr_creation_retry_test.ts`.
 */
async function runCompletion(
  ghHandler: (args: string[]) => string,
  options: { handlerDeadlineEpochMs?: number; workDir?: string } = {},
): Promise<CompletionRun> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-16.md`,
    "## Summary\n\nSecondary-limit deferral. Closes #16.\n",
  );

  const config = buildDefaultWorkerConfig();
  config.infraRetryBackoffMs = 1;
  config.workDir = options.workDir ?? workDir;
  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 16,
    issueTitle: "Secondary limit refuses the PR",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "stservice",
    config,
    handlerDeadlineEpochMs: options.handlerDeadlineEpochMs ?? Date.now(),
  };
  const state: PhaseState = {
    branchName: "issue-16-secondary-limit",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const ghCalls: string[][] = [];
  const warnings: string[] = [];
  const comments: string[] = [];
  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(comments),
      runGhCommand: (args: string[]) => {
        ghCalls.push(args);
        try {
          return Promise.resolve(ghHandler(args));
        } catch (err) {
          return Promise.reject(err);
        }
      },
    },
    git: {
      reconcileHeadToBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            action: "already-on-branch" as const,
            fromRef: "issue-16-secondary-limit",
          },
        }),
      pushUnpushedCommits: () =>
        Promise.resolve({ ok: true as const, value: 2 }),
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: args[0] === "rev-list" ? "2\n" : "",
            stderr: "",
          },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("no PR for issue") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("no PR for branch") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });
  return {
    status: result.status,
    ...(result.status !== "continue" ? { reason: result.reason } : {}),
    ...(result.status === "early_exit" && result.outcome
      ? { outcomeKind: result.outcome.kind }
      : {}),
    comments,
    ghCalls,
    warnings,
    workDir,
  };
}

Deno.test("completion - a secondary-limit refusal defers the PR instead of failing the run", async () => {
  const run = await runCompletion((args) => {
    if (args[0] === "pr" && args[1] === "create") {
      throw new Error(SECONDARY_ERROR);
    }
    return "";
  });

  assertEquals(
    run.status,
    "early_exit",
    `finished work must not be recorded as a failure: ${run.reason}`,
  );
  assertEquals(run.outcomeKind, "pr_deferred");

  const deferred = await listDeferredPrs(run.workDir);
  assertEquals(deferred.length, 1);
  assertEquals(deferred[0]?.branch, "issue-16-secondary-limit");
  assertEquals(deferred[0]?.base, "main");
  assertEquals(deferred[0]?.repo, "stSoftwareAU/VibeCoder");
  assertEquals(deferred[0]?.issueNumber, 16);
  assertStringIncludes(deferred[0]?.body ?? "", "Closes #16");

  assert(
    run.comments.some((c) => c.includes("PR pending")),
    `the issue thread must say the PR is pending: ${run.comments.join(" | ")}`,
  );
  await Deno.remove(run.workDir, { recursive: true });
});

Deno.test("completion - a non-rate-limit create failure still fails the run", async () => {
  const run = await runCompletion((args) => {
    if (args[0] === "pr" && args[1] === "create") {
      throw new Error(
        "gh command failed (exit 1): No commits between main and branch",
      );
    }
    return "";
  });

  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "No commits between");
  const deferred = await listDeferredPrs(run.workDir);
  assertEquals(deferred.length, 0, "an ordinary failure defers nothing");
  await Deno.remove(run.workDir, { recursive: true });
});

Deno.test("completion - with nowhere to park the PR the run fails loudly rather than promising one", async () => {
  // A deferral nothing recorded is a PR no cycle will ever raise: the run must
  // say so rather than report a pending PR that does not exist.
  const run = await runCompletion((args) => {
    if (args[0] === "pr" && args[1] === "create") {
      throw new Error(SECONDARY_ERROR);
    }
    return "";
  }, { workDir: "" });

  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "PR creation failed");
  await Deno.remove(run.workDir, { recursive: true });
});

Deno.test("completion - the latch's cool-down still takes the REST fallback (Issue #42 preserved)", async () => {
  // `primaryQuotaSkipMessage()` names the secondary limit AND the primary
  // quota. REST is exempt from the latch, so that message must still open the
  // PR at once rather than waiting minutes for a limit it has a way round.
  const run = await runCompletion((args) => {
    if (args[0] === "pr" && args[1] === "create") {
      throw new Error(
        "gh command skipped: GitHub secondary rate limit cool-down (API rate " +
          "limit already exceeded on a burst, hourly quota still available) " +
          "— reset at 11:35Z",
      );
    }
    if (args[0] === "api") {
      return "https://github.com/stSoftwareAU/VibeCoder/pull/174\n";
    }
    return "";
  });

  assertEquals(run.status, "continue", run.reason);
  assertEquals(
    (await listDeferredPrs(run.workDir)).length,
    0,
    "a PR the REST fallback opened is never parked",
  );
  await Deno.remove(run.workDir, { recursive: true });
});

Deno.test("completion - a latched cool-down whose REST fallback also fails defers, not fails", async () => {
  const run = await runCompletion((args) => {
    if (args[0] === "pr" && args[1] === "create") {
      throw new Error(
        "gh command skipped: GitHub secondary rate limit cool-down (API rate " +
          "limit already exceeded on a burst, hourly quota still available)",
      );
    }
    if (args[0] === "api") {
      throw new Error(
        "HTTP 403: You have exceeded a secondary rate limit and have been " +
          "temporarily blocked from content creation.",
      );
    }
    return "";
  });

  assertEquals(run.status, "early_exit", run.reason);
  assertEquals(run.outcomeKind, "pr_deferred");
  assertEquals((await listDeferredPrs(run.workDir)).length, 1);
  await Deno.remove(run.workDir, { recursive: true });
});
