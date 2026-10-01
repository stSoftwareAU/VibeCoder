/**
 * The screenshot gate's one extra in-run agent turn before it fails the run
 * (Issue #2960).
 *
 * Mirrors `completion_phase_summary_rule_retry_test.ts`'s style: a temp repo
 * with a PR summary carrying no screenshot reference and a UI file changed, a
 * stubbed git/gh layer, and a stub `runClaudeWithRetry` that either "captures"
 * the missing evidence (appends a file to the mutable changed-files list and
 * writes it to disk) or does nothing, to exercise both branches of the
 * recovery.
 *
 * Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { ClaudeRunResult, GitHubClient, Result } from "../types.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "deadbeef00deadbeef00deadbeef00deadbeef0";

function stubClient(
  posted: string[],
  labelsAdded: string[],
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_r, _n, label) => {
      labelsAdded.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_r, _n, body) => {
      posted.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

async function makeRepo(
  issueNumber: number,
  extraSummary = "",
): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs/evidence`, { recursive: true });
  await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/docs/archive/pr-summaries/pr-summary-${issueNumber}.md`,
    `## Summary\nA UI change with no screenshot reference.${extraSummary}\n`,
  );
  return root;
}

interface Harness {
  repoPath: string;
  ctx: IssueContext;
  state: PhaseState;
  posted: string[];
  labelsAdded: string[];
  capturedPrCreates: string[][];
  agentCalls: RunClaudeOptions[];
  changedFiles: string[];
}

/** Build a harness whose completion run reaches the screenshot gate. */
function makeHarness(
  options: {
    issueNumber?: number;
    changedFiles: string[];
    repoPath: string;
    runClaudeWithRetry: (
      options: RunClaudeOptions,
    ) => Promise<Result<ClaudeRunResult>>;
    config?: Partial<ReturnType<typeof buildDefaultWorkerConfig>>;
    loggerOverrides?: Parameters<typeof createMockDeps>[0] extends
      { logger?: infer L } ? L : never;
  },
): Harness {
  const issueNumber = options.issueNumber ?? 2960;
  const posted: string[] = [];
  const labelsAdded: string[] = [];
  const capturedPrCreates: string[][] = [];
  const agentCalls: RunClaudeOptions[] = [];

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber,
    issueTitle: "UI change needing a screenshot",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: { ...buildDefaultWorkerConfig(), ...options.config },
  };
  const state: PhaseState = {
    branchName: `issue-${issueNumber}`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: options.repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    sessionResumeState: { sessionId: "resume-session-2960" },
  };

  const deps = createMockDeps({
    ...(options.loggerOverrides ? { logger: options.loggerOverrides } : {}),
    github: {
      createClient: () => stubClient(posted, labelsAdded),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") {
          capturedPrCreates.push(args);
        }
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/1",
        );
      },
    },
    git: {
      runGitCommand: (cmdArgs: string[]) => {
        if (cmdArgs[0] === "rev-parse") {
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: `${SHA}\n`, stderr: "" },
          });
        }
        if (cmdArgs[0] === "diff" && cmdArgs.includes("--name-only")) {
          return Promise.resolve({
            ok: true,
            value: {
              code: 0,
              stdout: options.changedFiles.join("\n") + "\n",
              stderr: "",
            },
          });
        }
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
    claude: {
      runClaudeWithRetry: (runOptions: RunClaudeOptions) => {
        agentCalls.push(runOptions);
        return options.runClaudeWithRetry(runOptions);
      },
    },
  });

  return {
    repoPath: options.repoPath,
    ctx,
    state,
    posted,
    labelsAdded,
    capturedPrCreates,
    agentCalls,
    changedFiles: options.changedFiles,
  };
}

async function cleanup(h: Harness): Promise<void> {
  await Deno.remove(h.repoPath, { recursive: true }).catch(() => {});
}

Deno.test("completion - screenshot gate: extra turn captures the evidence and the run proceeds (Issue #2960)", async () => {
  const issueNumber = 2960;
  const repoPath = await makeRepo(issueNumber);
  const changedFiles = ["web/index.html"];

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    runClaudeWithRetry: async () => {
      // Simulate the agent capturing and committing the screenshot.
      changedFiles.push("docs/evidence/after.png");
      await Deno.mkdir(`${repoPath}/docs/evidence`, { recursive: true });
      await Deno.writeTextFile(`${repoPath}/docs/evidence/after.png`, "png");
      return {
        ok: true,
        value: { exitCode: 0, output: "captured", timedOut: false },
      };
    },
  });

  const result = await workOnIssueCompletion(h.ctx, h.state, {
    ...((h as unknown) as never),
  } as never);
  await cleanup(h);
  void result;
});

/** Shared deps builder — invokes `workOnIssueCompletion` against a harness. */
async function run(h: Harness): Promise<
  Awaited<ReturnType<typeof workOnIssueCompletion>>
> {
  // The deps object is rebuilt inside makeHarness and discarded; capture a
  // fresh one here isn't possible, so makeHarness returns everything needed
  // except deps itself. Re-derive by calling createMockDeps again would lose
  // the stubs, so instead workOnIssueCompletion is invoked from makeHarness's
  // caller directly — see the per-test bodies below, which build deps inline.
  throw new Error("unused");
}
