/**
 * In-run recovery from a PR-summary rule block (Issue #2189).
 *
 * A summary-rule block with no PR used to end the run: the branch was pushed
 * and quality-gated, and the next whole agent session existed only to add a
 * documentation block to it. A quarter of this host's runs that reached
 * completion ended that way. These tests drive the LIVE completion phase and
 * assert on the observable outcome — how many agent invocations the block
 * caused, what their prompt carried, whether `gh pr create` ran, and what the
 * issue thread was told.
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

const SHA = "5e4d3c2b1a0918273645540fedcba98877665544";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 2189;
const PR_URL = `https://github.com/${REPO}/pull/1208`;

const ISSUE_WITH_CRITERIA = `## Problem

A block with no PR ends the run instead of recovering in-run.

## Acceptance criteria

- [ ] The first block launches one recovery invocation.
- [ ] A second block in the same run fails as today.
`;

/** The summary the agent wrote: no closure block at all. */
const SUMMARY_WITHOUT_BLOCK = `## Summary

Recovered in-run. Closes #${ISSUE}.

## Test Plan

- \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\`
`;

/** The summary the recovery invocation writes once told what is missing. */
const SUMMARY_WITH_BLOCK = `## Summary

Recovered in-run. Closes #${ISSUE}.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the first block launches one recovery invocation — evidence: \`worker/deno/lib/summary_rule_gate_retry.ts\` — reviewer: met
- **met** — a second block in the same run fails as today — evidence: \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling

## Test Plan

- \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\`
`;

/** A bug-labelled run's summary with no `## Reproduction` block. */
const BUG_SUMMARY_WITHOUT_REPRODUCTION = `## Summary

Fixed the fault. Closes #${ISSUE}.

## Test Plan

- \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\`
`;

/** The same summary once the reproduction gate's comment has been answered. */
const BUG_SUMMARY_WITH_REPRODUCTION = `## Summary

Fixed the fault. Closes #${ISSUE}.

## Reproduction

- **symptom** — the gate ended the run instead of recovering
- **status** — \`verified\` — the regression test failed against the unfixed code and passes after the fix
- **regression test** — \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts::completion - a first summary-rule block re-invokes the agent once and the PR is raised\`

## Test Plan

- \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\`
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
  /** Labels on the issue — `bug` engages the reproduction gate. */
  labels?: string[];
  /** Issue body; defaults to the criteria-bearing one. */
  issueBody?: string;
  /** Make the recovery invocation itself fail (a rate limit, a spawn fault). */
  retryInvocationFails?: boolean;
  /** Whether the run's branch already carries an open PR. */
  prExistsForBranch?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  claudePrompts: string[];
  qualityGateRuns: number;
  prCreateCalls: number;
  comments: string[];
}

/** Drive the live completion phase over a blocked summary rule. */
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
  let qualityGateRuns = 0;
  const claudePrompts: string[] = [];

  const config = buildDefaultWorkerConfig();
  // Never inherit the host's work directory — gate state is persisted under it.
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Recover from a summary-rule block in-run",
    issueBody: scenario.issueBody ?? ISSUE_WITH_CRITERIA,
    issueLabels: scenario.labels ?? ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-summary-rule`,
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
          return ok("worker/deno/lib/summary_rule_gate_retry.ts");
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        claudeCalls++;
        claudePrompts.push(options.prompt);
        if (scenario.retryInvocationFails) {
          return Promise.resolve({
            ok: false as const,
            error: new Error("rate limited"),
          });
        }
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
      runQualityGate: () => {
        qualityGateRuns++;
        return Promise.resolve({
          ok: true as const,
          value: {
            checks: [],
            summary: { text: "All checks passed", passed: true },
            passed: true,
            output: "",
          },
        });
      },
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
    claudePrompts,
    qualityGateRuns,
    prCreateCalls,
    comments,
  };
}

Deno.test(
  "completion - a first summary-rule block re-invokes the agent once and the PR is raised",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_BLOCK,
      retryWrites: SUMMARY_WITH_BLOCK,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.qualityGateRuns, 1, "the quality gate re-runs");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);

Deno.test(
  "completion - the recovery prompt carries the gate's own remediation comment",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_BLOCK,
      retryWrites: SUMMARY_WITH_BLOCK,
    });

    assertEquals(outcome.claudePrompts.length, 1);
    const prompt = outcome.claudePrompts[0]!;
    assertStringIncludes(prompt, "PR-SUMMARY GATE RETRY NOTICE");
    assertStringIncludes(prompt, "Acceptance-criteria closure missing");
    assertStringIncludes(prompt, `${REPO}#${ISSUE}`);
    assertStringIncludes(
      prompt,
      `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
    );
    // The comment is on the thread as well, so the shortfall is not only in
    // this host's log.
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "Acceptance-criteria closure");
  },
);

Deno.test(
  "completion - a second block in the same run ends the run with one comment",
  async () => {
    const outcome = await runCompletion({ summary: SUMMARY_WITHOUT_BLOCK });

    assertEquals(outcome.status, "failure");
    // One recovery invocation, then the two bounded closure-verdict questions
    // the worker asks when the recovery's own summary still fails the gate
    // (Issue #2242). The recovery itself is still entered exactly once.
    assertEquals(
      outcome.claudePrompts.filter((p) => p.includes("RETRY NOTICE")).length,
      1,
      "the recovery is not repeated",
    );
    assertEquals(outcome.claudeCalls, 3, "recovery plus two verdict questions");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Acceptance criteria");
    assertEquals(
      outcome.comments.length,
      1,
      "the same verdict is not posted twice",
    );
  },
);

Deno.test(
  "completion - a recovery invocation that cannot be launched leaves the block standing",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_BLOCK,
      retryInvocationFails: true,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.claudeCalls, 1, "launched once, no second attempt");
    assertEquals(outcome.qualityGateRuns, 0, "nothing changed to re-gate");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", "Acceptance criteria");
    assertEquals(outcome.comments.length, 1);
  },
);

Deno.test(
  "completion - the reproduction gate recovers on the same path",
  async () => {
    const outcome = await runCompletion({
      summary: BUG_SUMMARY_WITHOUT_REPRODUCTION,
      retryWrites: BUG_SUMMARY_WITH_REPRODUCTION,
      issueBody: "## Problem\n\nThe gate ends the run.\n",
      labels: ["bug", "work-on"],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1);
    assertEquals(outcome.prCreateCalls, 1);
    assertStringIncludes(
      outcome.claudePrompts[0]!,
      "Reproduction status missing",
    );
  },
);

Deno.test(
  "completion - a block on a run that already has a PR is not re-invoked",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_BLOCK,
      prExistsForBranch: true,
    });

    // Issue #1140's path is unchanged: the PR is finalised and the run reports
    // the shortfall against it, with no agent invocation at all.
    assertEquals(outcome.status, "early_exit");
    assertEquals(outcome.claudeCalls, 0, "no recovery invocation");
    assertEquals(outcome.qualityGateRuns, 0);
  },
);
