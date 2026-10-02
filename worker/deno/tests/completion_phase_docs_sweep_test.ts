/**
 * Integration tests for the PR-summary docs-sweep gate running in the LIVE
 * completion phase (Issue #3073).
 *
 * A PR summary carrying no `Docs sweep` line — or one naming no manual
 * `section:` — used to sail through PR creation unchecked. These tests drive
 * `workOnIssueCompletion` and assert on the observable outcome (whether
 * `gh pr create` was invoked, whether the in-run recovery fired), not on how
 * the gate is called.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3073;
const PR_URL = `https://github.com/${REPO}/pull/4210`;

const ISSUE_BODY = `## Problem

Nothing checks the PR summary's Docs sweep line.
`;

/** A summary with no Docs sweep line at all. */
const SUMMARY_WITHOUT_LINE = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

## Test Plan

- \`worker/deno/tests/completion_phase_docs_sweep_test.ts\`
`;

/** The same summary once the gate's comment has been answered. */
const SUMMARY_WITH_LINE = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

**Docs sweep** — grep: \`BrokerBalance\`; section: \`docs/reporting-api.md#decisions-report\`; no hits

## Test Plan

- \`worker/deno/tests/completion_phase_docs_sweep_test.ts\`
`;

function stubClient(comments: string[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, _issue: number, body: string) => {
      comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

interface Scenario {
  /** Summary on the branch when the completion phase starts. */
  summary: string;
  /** Summary the recovery invocation writes; omitted, it changes nothing. */
  retryWrites?: string;
  /** The branch's changed files, as `git diff --name-only` reports them. */
  changedFiles: string;
  /** Whether the run's branch already carries an open PR. */
  prExistsForBranch?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  prCreateCalls: number;
  comments: string[];
}

/** Drive the live completion phase over a (possibly) blocked docs-sweep gate. */
async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  const summaryPath =
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath, scenario.summary);

  const comments: string[] = [];
  let prCreateCalls = 0;
  let claudeCalls = 0;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check the Docs sweep line",
    issueBody: ISSUE_BODY,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-docs-sweep`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(comments),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") prCreateCalls++;
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({ state: "OPEN" }));
        }
        return Promise.resolve(PR_URL);
      },
    },
    git: {
      runGitCommand: (
        cmdArgs: string[],
      ): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
        const ok = (stdout: string) =>
          Promise.resolve({
            ok: true as const,
            value: { code: 0, stdout, stderr: "" },
          });
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return ok(scenario.changedFiles);
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        claudeCalls++;
        if (scenario.retryWrites !== undefined) {
          Deno.writeTextFileSync(summaryPath, scenario.retryWrites);
        }
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "done", timedOut: false },
        });
      },
    },
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            checks: [],
            summary: { text: "All checks passed", passed: true },
            passed: true,
            output: "",
          },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve(
          scenario.prExistsForBranch
            ? { ok: true as const, value: PR_URL }
            : { ok: false as const, error: new Error("none") },
        ),
      recoverExistingPr: () =>
        Promise.resolve({ ok: true, value: "recovered" }),
      finalisePr: () =>
        Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        }),
    },
  });

  let result;
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }

  return {
    status: result.status,
    reason: result.status === "failure" || result.status === "early_exit"
      ? result.reason
      : undefined,
    claudeCalls,
    prCreateCalls,
    comments,
  };
}

Deno.test(
  "completion - code-changing diff without the line recovers once in-run and then raises the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_LINE,
      retryWrites: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);

Deno.test(
  "completion - the recovery not adding the line fails with no PR raised",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_LINE,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Docs sweep");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "section:");
  },
);

Deno.test(
  "completion - a summary with a valid line raises the PR with no comment",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0, "no recovery invocation needed");
    assertEquals(outcome.comments.length, 0);
  },
);

Deno.test(
  "completion - a docs/test-only diff with no line raises the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_LINE,
      changedFiles: "docs/guide.md\nworker/deno/tests/foo_test.ts",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0);
    assertEquals(outcome.comments.length, 0);
  },
);
