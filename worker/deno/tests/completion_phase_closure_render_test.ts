/**
 * The worker renders the closure block, and commits what the recovery produced
 * (Issue #2242).
 *
 * The #2189 recovery depended on the model writing a document whose shape is
 * fixed and machine-checked; on VibeCoder#2104 it wrote an essay instead and
 * the run died on the second block, with the summary left untracked. These
 * tests drive the LIVE completion phase with a model stub that answers the
 * structured verdict question, and assert on the observable outcome — whether
 * the PR is raised, how many questions were asked, and what reached the commit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  CLOSURE_VERDICT_CLOSE,
  CLOSURE_VERDICT_OPEN,
} from "../lib/closure_verdict.ts";
import { validateAcceptanceClosure } from "../lib/acceptance_criteria_gate.ts";
import { validateIndependentReview } from "../lib/independent_review_gate.ts";

const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 2242;
const PR_URL = `https://github.com/${REPO}/pull/2243`;

const CRITERIA = [
  "the closure block is rendered from a structured verdict",
  "the rendered block passes both PR-summary gates",
  "a short verdict is asked for once more",
  "what the recovery produced is committed",
  "a still-blocked recovery fails as before",
];

const ISSUE_BODY = `## Problem

The recovery writes prose instead of the closure block.

## Acceptance Criteria

${CRITERIA.map((c) => `- [ ] ${c}`).join("\n")}
`;

/** The prose the recovery invocation actually wrote on #2104 — no block. */
const PROSE_SUMMARY = `## Summary

Rendered the closure block. Closes #${ISSUE}.

## Evidence

The independent standards review found everything in order, and every
acceptance criterion is met.
`;

/** The verdict reply a compliant model returns. */
function verdictReply(covered: number): string {
  return [
    "Judged the diff against each criterion.",
    CLOSURE_VERDICT_OPEN,
    "```json",
    JSON.stringify({
      criteria: CRITERIA.slice(0, covered).map((criterion, index) => ({
        criterion,
        status: "met",
        evidence: `worker/deno/tests/closure_verdict_test.ts::case ${index}`,
      })),
      standards: [{
        status: "clean",
        finding: "Australian English, TDD, fail-loud error handling",
      }],
    }),
    "```",
    CLOSURE_VERDICT_CLOSE,
  ].join("\n");
}

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
  /** How many of the five criteria each verdict covers. */
  covered: number;
  /** The model answers the verdict question with prose instead. */
  refuseVerdict?: boolean;
  /** The commit of the recovered summary fails (a pre-flight gate, a lock). */
  commitFails?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  /** Prompts the model was given, in order. */
  prompts: string[];
  prCreateCalls: number;
  comments: string[];
  /** The summary on disk when the phase finished. */
  summary: string;
  /** Branches named to `commitAndPushPending`, in order. */
  committedOn: string[];
  /** The commit messages the worker used. */
  commitMessages: string[];
  /** Whether HEAD was reconciled to the branch before the commit. */
  reconciledBefore: boolean;
}

/** Drive the live completion phase over a summary the agent wrote as prose. */
async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  const summaryPath =
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath, PROSE_SUMMARY);

  const comments: string[] = [];
  const prompts: string[] = [];
  const committedOn: string[] = [];
  const commitMessages: string[] = [];
  let prCreateCalls = 0;
  let reconciles = 0;
  let reconcilesBeforeFirstCommit = -1;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Render the closure block from a structured verdict",
    issueBody: ISSUE_BODY,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-closure-render`,
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
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return ok("worker/deno/lib/closure_verdict.ts");
        }
        return ok("");
      },
      reconcileHeadToBranch: () => {
        reconciles++;
        return Promise.resolve({
          ok: true as const,
          value: { action: "already-on-branch" as const, fromRef: "HEAD" },
        });
      },
      commitAndPushPending: (branch: string, message: string) => {
        if (reconcilesBeforeFirstCommit < 0) {
          reconcilesBeforeFirstCommit = reconciles;
        }
        committedOn.push(branch);
        commitMessages.push(message);
        if (scenario.commitFails) {
          return Promise.resolve({
            ok: false as const,
            error: new Error("pre-flight gate blocked the commit"),
          });
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            committedNewChanges: true,
            commitsPushed: 1,
            finalUnpushedCount: 0,
            finalUnpushedSource: "remote-head" as const,
          },
        });
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        prompts.push(options.prompt);
        const isVerdictQuestion = options.prompt.includes(
          CLOSURE_VERDICT_OPEN,
        );
        const output = isVerdictQuestion && !scenario.refuseVerdict
          ? verdictReply(scenario.covered)
          : "I have written a thorough summary instead.";
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output, timedOut: false },
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
        Promise.resolve({ ok: false as const, error: new Error("none") }),
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
  let summary = "";
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
    summary = await Deno.readTextFile(summaryPath);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }

  return {
    status: result.status,
    reason: result.status === "failure" || result.status === "early_exit"
      ? result.reason
      : undefined,
    prompts,
    prCreateCalls,
    comments,
    summary,
    committedOn,
    commitMessages,
    reconciledBefore: reconcilesBeforeFirstCommit > 0,
  };
}

Deno.test(
  "closure render - a verdict for every criterion is rendered and the PR is raised",
  async () => {
    const outcome = await runCompletion({ covered: CRITERIA.length });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
    // One #2189 recovery invocation, then one verdict question.
    assertEquals(outcome.prompts.length, 2);
    assertStringIncludes(outcome.prompts[1]!, CLOSURE_VERDICT_OPEN);
    assertStringIncludes(outcome.prompts[1]!, "writes no files");

    // The worker rendered the block the model would not write.
    assertStringIncludes(outcome.summary, "## Acceptance Criteria");
    assertStringIncludes(
      outcome.summary,
      '<!-- vibe-spec-review inputs="diff+issue-body" -->',
    );
    assertStringIncludes(outcome.summary, "## Standards Review");
    assertStringIncludes(outcome.summary, "reviewer: met");
    assertEquals(
      validateAcceptanceClosure({
        issueBody: ISSUE_BODY,
        prSummaryContent: outcome.summary,
      }).problems,
      [],
    );
    assertEquals(
      validateIndependentReview({
        issueBody: ISSUE_BODY,
        prSummaryContent: outcome.summary,
      }).problems,
      [],
    );
  },
);

Deno.test(
  "closure render - what the recovery produced is committed on the issue branch",
  async () => {
    const outcome = await runCompletion({ covered: CRITERIA.length });

    assertEquals(outcome.committedOn, [`issue-${ISSUE}-closure-render`]);
    assert(
      outcome.reconciledBefore,
      "HEAD is put back on the branch before the commit",
    );
    assertStringIncludes(outcome.commitMessages[0]!, `#${ISSUE}`);
  },
);

Deno.test(
  "closure render - a verdict short of a criterion is asked for once more",
  async () => {
    const outcome = await runCompletion({ covered: CRITERIA.length - 1 });

    // Recovery invocation, first verdict question, one re-ask — no more.
    assertEquals(outcome.prompts.length, 3);
    assertStringIncludes(outcome.prompts[2]!, "previous verdict was short");
    assertStringIncludes(outcome.prompts[2]!, "4 of 5");

    // Still short, so the block stands and the run fails — with the summary
    // committed, so the next attempt resumes from it.
    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Acceptance criteria");
    assertEquals(outcome.committedOn.length, 1);
    assertStringIncludes(outcome.summary, "## Acceptance Criteria");
  },
);

Deno.test(
  "closure render - a commit that fails is loud, and does not cost the PR",
  async () => {
    const outcome = await runCompletion({
      covered: CRITERIA.length,
      commitFails: true,
    });

    // The summary is on disk, so the PR body still carries the block and the
    // run completes; the loss of the commit is reported, not swallowed.
    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.committedOn.length, 1, "the commit was attempted");
    assertStringIncludes(outcome.summary, "## Acceptance Criteria");
  },
);

Deno.test(
  "closure render - a model that will not answer in shape leaves the summary alone",
  async () => {
    const outcome = await runCompletion({
      covered: CRITERIA.length,
      refuseVerdict: true,
    });

    // Asked twice, no verdict either time; the block stands.
    assertEquals(outcome.prompts.length, 3);
    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.summary, PROSE_SUMMARY, "nothing was invented");
    assertEquals(outcome.committedOn.length, 1, "the prose is still committed");
    // One comment per distinct verdict — the gate's own, already deduped.
    assertEquals(outcome.comments.length, 1);
  },
);
