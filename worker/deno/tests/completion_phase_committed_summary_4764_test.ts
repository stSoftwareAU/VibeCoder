/**
 * The PR body never comes from uncommitted PR summary content (Issue #4764).
 *
 * A summary the recovery turn rewrote but never committed must not reach
 * `gh pr create` or `gh pr edit --body`. When the summary is dirty, the body
 * is built from the copy committed at HEAD. A failed git status is a loud
 * failure, and the body then falls back to the minimal one.
 *
 * The agent, `gh` and git are injected. Nothing here calls GitHub.
 *
 * Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  loadSummaryForPublication,
  workOnIssueCompletion,
} from "../lib/phases/completion_phase.ts";
import { createLogger } from "../lib/logger.ts";
import { prSummaryCandidatePaths } from "../lib/pr_summary_loader.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const ISSUE = 4764;
const SUMMARY_PATH = `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
const SHA = "4764a1b2c3d4e5f60718293a4b5c6d7e8f901234";
const PR_URL = "https://github.com/stSoftwareAU/VibeCoder/pull/4764";
const COMMITTED_MARKER = "COMMITTED-SUMMARY-4764";
const UNCOMMITTED_MARKER = "UNCOMMITTED-EDIT-4764";

function summaryText(marker: string): string {
  return [
    "## Summary",
    "",
    `${marker}. Closes #${ISSUE}.`,
    "",
    "## Test Plan",
    "",
    "- `worker/deno/tests/completion_phase_committed_summary_4764_test.ts`",
    "",
  ].join("\n");
}

const COMMITTED_SUMMARY = summaryText(COMMITTED_MARKER);
const EDITED_SUMMARY = summaryText(UNCOMMITTED_MARKER);

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

interface PublicationOptions {
  /** `git status --porcelain` stdout; defaults to the summary being dirty. */
  porcelain?: string;
  /** Make `git status` fail at the process level. */
  statusFails?: boolean;
  /** Whether the run's branch already carries an open PR. */
  existingPr?: boolean;
}

interface PublicationRun {
  status: string;
  ghCalls: string[][];
  recoveredBodies: string[];
  agentCalls: number;
}

/** Drive the live completion phase with the working-tree summary edited. */
async function runPublication(
  options: PublicationOptions,
): Promise<PublicationRun> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
      recursive: true,
    });
    // The working tree holds the uncommitted edit; HEAD holds the committed copy.
    await Deno.writeTextFile(`${repoPath}/${SUMMARY_PATH}`, EDITED_SUMMARY);

    const config = buildDefaultWorkerConfig();
    // Never inherit the host's work directory.
    config.workDir = workDir;

    const ctx: IssueContext = {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: ISSUE,
      issueTitle: "Publish the committed PR summary",
      issueBody: "",
      issueLabels: [],
      issueComments: "",
      githubUser: "testbot",
      config,
    };
    const state: PhaseState = {
      branchName: `issue-${ISSUE}-committed-summary`,
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
    const recoveredBodies: string[] = [];
    let agentCalls = 0;

    const deps = createMockDeps({
      github: {
        createClient: () => stubClient(),
        runGhCommand: (args: string[]) => {
          ghCalls.push(args);
          return Promise.resolve(PR_URL);
        },
      },
      git: {
        runGitCommand: (cmdArgs: string[]) => {
          const ok = (stdout: string) =>
            Promise.resolve({
              ok: true as const,
              value: { code: 0, stdout, stderr: "" },
            });
          if (cmdArgs[0] === "status") {
            if (options.statusFails) {
              return Promise.resolve({
                ok: false as const,
                error: new Error("fatal: index.lock is held"),
              });
            }
            return ok(options.porcelain ?? ` M ${SUMMARY_PATH}\0`);
          }
          if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
          if (cmdArgs[0] === "ls-tree" && cmdArgs.includes(SHA)) {
            return ok(`${SUMMARY_PATH}\0`);
          }
          if (
            cmdArgs[0] === "show" && cmdArgs[1] === `${SHA}:${SUMMARY_PATH}`
          ) {
            return ok(COMMITTED_SUMMARY);
          }
          return ok("");
        },
      },
      claude: {
        runClaudeWithRetry: () => {
          agentCalls++;
          return Promise.resolve({
            ok: true as const,
            value: { exitCode: 0, output: "", timedOut: false },
          });
        },
      },
      pr: {
        ...(options.existingPr
          ? {
            findExistingPrForBranch: () =>
              Promise.resolve({ ok: true as const, value: PR_URL }),
            recoverExistingPr: (
              _repo: string,
              _issueNumber: number,
              _prUrl: string,
              prBody?: string,
            ) => {
              if (prBody !== undefined) recoveredBodies.push(prBody);
              return Promise.resolve({
                ok: true as const,
                value: "recovered",
              });
            },
          }
          : {}),
      },
    });

    const result = await workOnIssueCompletion(ctx, state, deps);
    return { status: result.status, ghCalls, recoveredBodies, agentCalls };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
}

function createdBody(ghCalls: string[][]): string | undefined {
  const create = ghCalls.find((args) =>
    args[0] === "pr" && args[1] === "create"
  );
  if (!create) return undefined;
  const index = create.indexOf("--body");
  return index >= 0 ? create[index + 1] : undefined;
}

Deno.test(
  "completion - a new PR body is built from the committed summary, not the uncommitted edit (Issue #4764)",
  async () => {
    const run = await runPublication({});
    assertEquals(run.status, "continue", JSON.stringify(run));
    assertEquals(run.agentCalls, 0, "no agent turn is needed");

    const body = createdBody(run.ghCalls);
    assert(body !== undefined, "gh pr create must run");
    assertStringIncludes(body, COMMITTED_MARKER);
    assert(
      !body.includes(UNCOMMITTED_MARKER),
      "the uncommitted edit must not reach the PR body",
    );
  },
);

Deno.test(
  "completion - an existing PR is recovered with the committed summary, not the uncommitted edit (Issue #4764)",
  async () => {
    const run = await runPublication({ existingPr: true });
    assertEquals(run.status, "continue", JSON.stringify(run));
    assertEquals(run.recoveredBodies.length, 1, "the PR is recovered once");

    const body = run.recoveredBodies[0]!;
    assertStringIncludes(body, COMMITTED_MARKER);
    assert(
      !body.includes(UNCOMMITTED_MARKER),
      "the uncommitted edit must not reach the PR body",
    );
  },
);

Deno.test(
  "completion - a clean summary tree still publishes the working-tree text (Issue #4764)",
  async () => {
    const run = await runPublication({ porcelain: "" });
    assertEquals(run.status, "continue", JSON.stringify(run));

    const body = createdBody(run.ghCalls);
    assert(body !== undefined, "gh pr create must run");
    assertStringIncludes(body, UNCOMMITTED_MARKER);
    assert(
      !body.includes(COMMITTED_MARKER),
      "a clean tree reads the working tree, not the committed copy",
    );
  },
);

Deno.test(
  "completion - a failed git status falls back to the minimal body, never the uncommitted edit (Issue #4764)",
  async () => {
    const run = await runPublication({ statusFails: true });

    const body = createdBody(run.ghCalls);
    assert(body !== undefined, "gh pr create must run");
    assert(
      !body.includes(UNCOMMITTED_MARKER),
      "the uncommitted edit must not reach the PR body",
    );
    assert(
      !body.includes(COMMITTED_MARKER),
      "a failed status publishes no summary content",
    );
  },
);

type GitReply =
  | { ok: true; value: { code: number; stdout: string; stderr: string } }
  | { ok: false; error: Error };

interface DirectRun {
  result: Awaited<ReturnType<typeof loadSummaryForPublication>>;
  calls: { args: string[]; cwd: string | undefined }[];
}

/** Call `loadSummaryForPublication` directly with scripted git replies. */
async function loadDirect(
  replies: { status: GitReply; revParse?: GitReply },
): Promise<DirectRun> {
  const calls: DirectRun["calls"] = [];
  const deps = createMockDeps({
    git: {
      runGitCommand: (cmdArgs: string[], opts?: { cwd?: string }) => {
        calls.push({ args: cmdArgs, cwd: opts?.cwd });
        if (cmdArgs[0] === "status") return Promise.resolve(replies.status);
        if (cmdArgs[0] === "rev-parse" && replies.revParse) {
          return Promise.resolve(replies.revParse);
        }
        return Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: "", stderr: "" },
        });
      },
    },
  });
  const state = { repoPath: "/repo-4764" } as PhaseState;
  const result = await loadSummaryForPublication(
    state,
    ISSUE,
    deps,
    createLogger({ write: () => {} }),
  );
  return { result, calls };
}

const DIRTY: GitReply = {
  ok: true,
  value: { code: 0, stdout: ` M ${SUMMARY_PATH}\0`, stderr: "" },
};

Deno.test(
  "loadSummaryForPublication - git status asks for every summary candidate, NUL-separated, untracked files included (Issue #4764)",
  async () => {
    const { calls } = await loadDirect({
      status: { ok: false, error: new Error("boom") },
    });
    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.args, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--",
      ...prSummaryCandidatePaths(ISSUE),
    ]);
    assertEquals(calls[0]!.cwd, "/repo-4764");
  },
);

Deno.test(
  "loadSummaryForPublication - a git status process failure is an error result (Issue #4764)",
  async () => {
    const { result } = await loadDirect({
      status: { ok: false, error: new Error("index.lock is held") },
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertStringIncludes(result.error.message, "index.lock");
  },
);

Deno.test(
  "loadSummaryForPublication - a non-zero git status exit is an error result naming the exit (Issue #4764)",
  async () => {
    const { result } = await loadDirect({
      status: {
        ok: true,
        value: { code: 128, stdout: "", stderr: "fatal: not a repo\n" },
      },
    });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "exit 128");
      assertStringIncludes(result.error.message, "fatal: not a repo");
    }
  },
);

Deno.test(
  "loadSummaryForPublication - a dirty summary resolves HEAD in the repo directory (Issue #4764)",
  async () => {
    const { calls } = await loadDirect({
      status: DIRTY,
      revParse: {
        ok: true,
        value: { code: 0, stdout: `${SHA}\n`, stderr: "" },
      },
    });
    const revParse = calls.find((c) => c.args[0] === "rev-parse");
    assert(revParse !== undefined, "HEAD must be resolved");
    assertEquals(revParse.args, ["rev-parse", "HEAD"]);
    assertEquals(revParse.cwd, "/repo-4764");
  },
);

Deno.test(
  "loadSummaryForPublication - a failed rev-parse process is an error result, never the working tree (Issue #4764)",
  async () => {
    const { result } = await loadDirect({
      status: DIRTY,
      revParse: { ok: false, error: new Error("spawn failed") },
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertStringIncludes(result.error.message, "spawn failed");
  },
);

Deno.test(
  "loadSummaryForPublication - a non-zero rev-parse exit is an error result naming the exit (Issue #4764)",
  async () => {
    const { result } = await loadDirect({
      status: DIRTY,
      revParse: {
        ok: true,
        value: { code: 128, stdout: "", stderr: "fatal: bad HEAD\n" },
      },
    });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "exit 128");
      assertStringIncludes(result.error.message, "fatal: bad HEAD");
    }
  },
);
