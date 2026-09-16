/**
 * In-run recovery from a PR-summary rule block met with no PR (Issue #2189).
 *
 * On GRQ-23 a quarter of the runs that reached completion were failed by the
 * acceptance-criteria closure gate: VibeCoder#2099 and #2156 overnight on
 * 2026-09-16, both with a pushed, quality-gated branch and a summary that
 * omitted the `## Acceptance Criteria` block. Each block cost a whole further
 * run. The first block in a run now launches one agent invocation carrying
 * the gate's comment and re-runs completion; a second block stands.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSummaryRuleRetryPrompt,
  workOnIssueCompletion,
} from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { reviewBlockTemplateLines } from "../lib/review_block_template.ts";

const SHA = "2189218921892189218921892189218921892189";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 2156;

/** The planner's sub-issue body: two stated criteria. */
const ISSUE_BODY = `## Summary

Let the per-run MCP config carry additional servers.

## Acceptance Criteria

- [ ] The per-run MCP config accepts additional servers independent of the Playwright grant
- [ ] A test proves an extra server survives the grant being absent
`;

/** What the agent left on the branch: no closure block at all. */
const BARE_SUMMARY = `## Summary

Additional MCP servers ride the per-run config. Closes #${ISSUE}.
`;

/** What the recovery invocation writes: the template both gates accept. */
const COMPLIANT_SUMMARY = [
  BARE_SUMMARY,
  ...reviewBlockTemplateLines(),
  "",
].join("\n");

function stubClient(comments: string[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo, _issue, body) => {
      comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

function summaryPath(repoPath: string): string {
  return `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
}

interface Scenario {
  /** Summary the recovery invocation writes; omitted, the agent changes nothing. */
  retryWrites?: string;
  /** Make the recovery invocation itself fail (a rate limit, a spawn failure). */
  retryInvocationFails?: boolean;
  /** The agent edited the summary but did not commit it. */
  leftUncommitted?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  claudePrompts: string[];
  prCreateCalls: number;
  commits: string[][];
  comments: string[];
  summaryRuleBlocks: number;
}

async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath(repoPath), BARE_SUMMARY);

  const comments: string[] = [];
  const claudePrompts: string[] = [];
  const commits: string[][] = [];
  let prCreateCalls = 0;
  let summaryDirty = false;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Let the per-run MCP config carry additional servers",
    issueBody: ISSUE_BODY,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-mcp-servers`,
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
        return Promise.resolve(`https://github.com/${REPO}/pull/2190`);
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
        if (cmdArgs[0] === "rev-list") return ok("3\n");
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return ok(
            "worker/deno/lib/agent_mcp_config.ts\n" +
              `docs/archive/pr-summaries/pr-summary-${ISSUE}.md\n`,
          );
        }
        if (cmdArgs[0] === "status" && cmdArgs[1] === "--porcelain") {
          return ok(summaryDirty ? ` M ${cmdArgs[cmdArgs.length - 1]}\n` : "");
        }
        if (cmdArgs[0] === "commit") {
          commits.push(cmdArgs);
          summaryDirty = false;
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        claudePrompts.push(options.prompt);
        if (scenario.retryInvocationFails) {
          return Promise.resolve({
            ok: false as const,
            error: new Error("rate limited"),
          });
        }
        if (scenario.retryWrites !== undefined) {
          Deno.writeTextFileSync(summaryPath(repoPath), scenario.retryWrites);
          summaryDirty = scenario.leftUncommitted === true;
        }
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "done", timedOut: false },
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
    reason: result.status === "failure" ? result.reason : undefined,
    claudePrompts,
    prCreateCalls,
    commits,
    comments,
    summaryRuleBlocks: state.summaryRuleBlocks?.length ?? 0,
  };
}

Deno.test("completion - the first closure-gate block with no PR runs one recovery invocation carrying the gate comment, then raises the PR (Issue #2189)", async () => {
  const outcome = await runCompletion({ retryWrites: COMPLIANT_SUMMARY });

  assertEquals(outcome.status, "continue", outcome.reason);
  assertEquals(
    outcome.claudePrompts.length,
    1,
    "exactly one recovery invocation",
  );
  const prompt = outcome.claudePrompts[0]!;
  assertStringIncludes(prompt, "Acceptance-criteria closure missing");
  assertStringIncludes(prompt, `pr-summary-${ISSUE}.md`);
  assertStringIncludes(prompt, "Do NOT push");
  assertEquals(outcome.prCreateCalls, 1, "the PR is raised on the re-run");
  assertEquals(outcome.summaryRuleBlocks, 1, "the block was recorded once");
  assert(
    outcome.comments.some((c) =>
      c.includes("Acceptance-criteria closure missing")
    ),
    "the gate's remediation comment is on the issue thread",
  );
});

Deno.test("completion - a summary the recovery edited but did not commit is committed by the worker before the re-run (Issue #2189)", async () => {
  const outcome = await runCompletion({
    retryWrites: COMPLIANT_SUMMARY,
    leftUncommitted: true,
  });

  assertEquals(outcome.status, "continue", outcome.reason);
  assertEquals(outcome.commits.length, 1, "one commit, by the worker");
  const commit = outcome.commits[0]!;
  assert(commit.includes(`docs/archive/pr-summaries/pr-summary-${ISSUE}.md`));
  assertStringIncludes(commit.join(" "), `Issue #${ISSUE}`);
  assertEquals(outcome.prCreateCalls, 1);
});

Deno.test("completion - a second block in the same run stands as the failure, with no third invocation (Issue #2189)", async () => {
  // The agent changes nothing: the re-run meets the same block.
  const outcome = await runCompletion({});

  assertEquals(outcome.status, "failure");
  assertStringIncludes(
    outcome.reason ?? "",
    "Acceptance criteria not closed out",
  );
  assertEquals(outcome.claudePrompts.length, 1, "one recovery, never a loop");
  assertEquals(outcome.prCreateCalls, 0);
  assertEquals(outcome.summaryRuleBlocks, 2);
  assertEquals(
    outcome.comments.filter((c) =>
      c.includes("Acceptance-criteria closure missing")
    ).length,
    1,
    "the identical remediation comment is posted once, not once per block",
  );
});

Deno.test("completion - a recovery invocation that cannot launch leaves the block as the failure it was (Issue #2189)", async () => {
  const outcome = await runCompletion({ retryInvocationFails: true });

  assertEquals(outcome.status, "failure");
  assertStringIncludes(
    outcome.reason ?? "",
    "Acceptance criteria not closed out",
  );
  assertEquals(outcome.claudePrompts.length, 1);
  assertEquals(outcome.prCreateCalls, 0);
});

Deno.test("buildSummaryRuleRetryPrompt - names the file, the reason, the commit, and the gate's comment, and forbids code, gate and push", () => {
  const prompt = buildSummaryRuleRetryPrompt(
    {
      reason: "Acceptance criteria not closed out in the PR summary: x",
      comment: "⚠️ the comment body",
    },
    2099,
  );
  assertStringIncludes(prompt, "docs/archive/pr-summaries/pr-summary-2099.md");
  assertStringIncludes(
    prompt,
    "> Acceptance criteria not closed out in the PR summary: x",
  );
  assertStringIncludes(prompt, "⚠️ the comment body");
  assertStringIncludes(prompt, "Change nothing else");
  assertStringIncludes(prompt, "Do NOT run the quality gate");
  assertStringIncludes(prompt, "git commit -m");
  assertStringIncludes(prompt, "Do NOT push");
});
