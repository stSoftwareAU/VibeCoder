/**
 * The phases re-check claim freshness before they spend anything (Issue #344).
 *
 * The VibeCoder#333 collision, exactly:
 *
 *   #333     CLOSED  closedAt = 2026-08-23T07:57:54Z  (merged PR #339)
 *   PR #341  created         = 2026-08-23T08:15:06Z   -> issue #333
 *
 * Seventeen minutes and one rate-limit pause separated the two. Nothing
 * between the claim and `gh pr create` asked whether the issue was still
 * open, so the run produced a `CONFLICTING`/`DIRTY` duplicate PR against work
 * already on `main`.
 *
 * Two guards are pinned here:
 *
 *  - **completion** — the full re-check, immediately before PR creation. It
 *    must not create the PR, must leave the pushed branch findable on the
 *    issue, and must stop as a clean `claim_stale` outcome rather than a
 *    failure (Issue #342's lesson: a normal outcome counted as a crash backs
 *    the whole host off).
 *  - **execute** — the cheap re-check at the start of the write phase, so a
 *    cycle that spent forty minutes rate-limited does not spend an agent run
 *    on work that is already merged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { describeRunOutcome, type RunOutcome } from "../lib/run_outcome.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, WorkerConfig } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 333;
const BRANCH = "issue-333-parse-the-weekly-usage-limit-reset";
const MERGED_PR = "https://github.com/stSoftwareAU/VibeCoder/pull/339";

interface PostedComment {
  issueNumber: number;
  body: string;
}

function stubClient(
  comments: PostedComment[],
  options: { commentThrows?: boolean } = {},
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, issueNumber: number, body: string) => {
      if (options.commentThrows) {
        return Promise.reject(new Error("gh: could not post comment"));
      }
      comments.push({ issueNumber, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as unknown as GitHubClient;
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Parse the weekly usage-limit reset",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "stservice",
    config,
  };
}

function makeState(repoPath: string): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

// ---------------------------------------------------------------------------
// Completion phase — the guard immediately before `gh pr create`
// ---------------------------------------------------------------------------

interface CompletionRun {
  status: string;
  reason?: string;
  outcome?: RunOutcome;
  ghCalls: string[][];
  comments: PostedComment[];
}

/**
 * Drive the completion phase over a pushed branch that is two commits ahead
 * of `main`, with the issue in the given state.
 */
async function runCompletion(
  options: {
    issueState: string;
    commentThrows?: boolean;
    /** An open PR from another author that already references the issue. */
    openPrForIssue?: string;
  },
): Promise<CompletionRun> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
    `## Summary\n\nParse the weekly reset. Closes #${ISSUE}.\n`,
  );

  const config = buildDefaultWorkerConfig();
  config.infraRetryBackoffMs = 1;

  const ghCalls: string[][] = [];
  const comments: PostedComment[] = [];
  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(comments, options),
      runGhCommand: ((args: string[]) => {
        ghCalls.push(args);
        if (args[0] === "issue" && args[1] === "view") {
          return Promise.resolve(
            JSON.stringify({ state: options.issueState }),
          );
        }
        if (args[0] === "pr" && args[1] === "create") {
          return Promise.resolve(
            "https://github.com/stSoftwareAU/VibeCoder/pull/341\n",
          );
        }
        return Promise.resolve("");
      }) as never,
    },
    git: {
      reconcileHeadToBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: { action: "already-on-branch" as const, fromRef: BRANCH },
        }),
      pushUnpushedCommits: () =>
        Promise.resolve({ ok: true as const, value: 2 }),
      runGitCommand: ((args: string[]) =>
        Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: args[0] === "rev-list" ? "2\n" : "",
            stderr: "",
          },
        })) as never,
    },
    pr: {
      // By default no PR references the issue by the time completion runs —
      // the #333 shape, where the closing PR was raised from a different
      // branch and the issue-number linker no longer surfaces it.
      findExistingPrForIssue: (() =>
        Promise.resolve(
          options.openPrForIssue
            ? { ok: true, value: options.openPrForIssue }
            : { ok: false, error: new Error("No PR found") },
        )) as never,
      findExistingPrForBranch: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("No PR found"),
        })) as never,
    },
  });

  const result = await workOnIssueCompletion(
    makeContext(config),
    makeState(repoPath),
    deps,
  ) as CompletionRun;
  await Deno.remove(repoPath, { recursive: true });
  return { ...result, ghCalls, comments };
}

function createdAPr(ghCalls: string[][]): boolean {
  return ghCalls.some((a) =>
    (a[0] === "pr" && a[1] === "create") ||
    (a[0] === "api" && a.some((v) => v.endsWith("/pulls")))
  );
}

Deno.test("completion #344 - an issue closed mid-cycle stops the PR being raised", async () => {
  const run = await runCompletion({ issueState: "CLOSED" });

  // Acceptance 1: no duplicate PR. This is the whole point — PR #341 must
  // never have been created against a #333 that closed at 07:57:54Z.
  assert(
    !createdAPr(run.ghCalls),
    `no PR may be raised for a closed issue, got: ${
      JSON.stringify(run.ghCalls)
    }`,
  );

  // Acceptance 2: a clean stop, not a failure.
  assertEquals(run.status, "early_exit");
  assert(
    (run.reason ?? "").startsWith("claim_stale:issue_closed"),
    `reason must name the stale claim: ${run.reason}`,
  );
  assertEquals(describeRunOutcome(run.outcome), "claim_stale:issue_closed");
  assert(run.outcome?.kind === "claim_stale");
  assertEquals(run.outcome.phase, "completion");
  assertEquals(run.outcome.branch, BRANCH);

  // Acceptance 3: the work is not lost — the branch is named on the issue.
  assertEquals(run.comments.length, 1);
  assertEquals(run.comments[0]!.issueNumber, ISSUE);
  assertStringIncludes(run.comments[0]!.body, BRANCH);
});

Deno.test("completion #344 - an issue still open raises its PR exactly as before", async () => {
  const run = await runCompletion({ issueState: "OPEN" });

  assertEquals(run.status, "continue");
  assert(
    createdAPr(run.ghCalls),
    `an open issue must still get its PR: ${JSON.stringify(run.ghCalls)}`,
  );
  assertEquals(run.comments.length, 0);
});

Deno.test("completion #344 - another author's open PR is recovered, never competed with", async () => {
  const OTHER_PR = "https://github.com/stSoftwareAU/VibeCoder/pull/347";
  const run = await runCompletion({
    issueState: "OPEN",
    openPrForIssue: OTHER_PR,
  });

  // #344's third hazard — "do not open a competing PR" — is answered by
  // `decideCompletionPr`, not by a second stale-claim rule: the open PR is
  // recovered and no `pr create` is issued.
  assertEquals(run.status, "continue");
  assert(
    !createdAPr(run.ghCalls),
    `no competing PR may be raised: ${JSON.stringify(run.ghCalls)}`,
  );
});

Deno.test("completion #344 - a hand-off comment that fails to post does not turn the abort into a failure", async () => {
  const run = await runCompletion({
    issueState: "CLOSED",
    commentThrows: true,
  });

  // The comment is best-effort: losing it is worth a warning, not a failure
  // that labels the issue and files a run-failure issue.
  assertEquals(run.status, "early_exit");
  assert(run.outcome?.kind === "claim_stale");
  assert(!createdAPr(run.ghCalls));
});

// ---------------------------------------------------------------------------
// Execute phase — the cheap guard before an agent run is spent
// ---------------------------------------------------------------------------

interface ExecuteRun {
  status: string;
  reason?: string;
  outcome?: RunOutcome;
  claudeRuns: number;
}

async function runExecute(issueState: string): Promise<ExecuteRun> {
  let claudeRuns = 0;
  const config = { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 1 };
  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    claude: {
      runClaudeWithRetry: (() => {
        claudeRuns += 1;
        return Promise.resolve({
          ok: true,
          value: {
            output: "did the work",
            exitCode: 0,
            rawExitCode: 0,
            timedOut: false,
          },
        });
      }) as never,
    },
    github: {
      runGhCommand: ((args: string[]) => {
        if (args[0] === "issue" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({ state: issueState }));
        }
        return Promise.resolve("");
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: MERGED_PR })) as never,
    },
    git: {
      runGitCommand: ((args: string[]) =>
        Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: args[0] === "rev-parse" ? BRANCH : "",
            stderr: "",
          },
        })) as never,
    },
  });

  const result = await workOnIssueExecuteClaude(
    makeContext(config),
    makeState("/tmp/test-repo"),
    deps,
  ) as ExecuteRun;
  return { ...result, claudeRuns };
}

Deno.test("execute #344 - a claim whose issue closed during the cycle never spends an agent run", async () => {
  const run = await runExecute("CLOSED");

  assertEquals(
    run.claudeRuns,
    0,
    "an agent run must not be spent on an issue that already closed",
  );
  assertEquals(run.status, "early_exit");
  assert(
    (run.reason ?? "").startsWith("claim_stale:issue_closed"),
    `reason must name the stale claim: ${run.reason}`,
  );
  assert(run.outcome?.kind === "claim_stale");
  assertEquals(run.outcome.phase, "execute");
});

Deno.test("execute #344 - a claim on an open issue runs the agent exactly as before", async () => {
  const run = await runExecute("OPEN");

  assertEquals(run.claudeRuns, 1);
  assert(
    run.status !== "early_exit" ||
      !(run.reason ?? "").startsWith("claim_stale"),
    `an open issue must not abort as stale: ${run.reason}`,
  );
});
