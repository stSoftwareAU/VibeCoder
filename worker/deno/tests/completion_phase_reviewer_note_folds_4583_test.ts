/**
 * The reviewer note carries every blocked summary gate's finding (Issue #4583).
 *
 * The acceptance-criteria closure gate, the independent Spec/Standards review
 * gate and the bug reproduction-status gate each report their own finding.
 * When the closure gate reports first, the review and reproduction findings
 * are folded into its one in-session note and its one pull-request comment,
 * so the agent and the reviewer read all of them rather than only the first.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { PrePrVerifierResult } from "../lib/pre_pr_verifier.ts";
import {
  buildClosureGateComment,
  validateAcceptanceClosure,
} from "../lib/acceptance_criteria_gate.ts";
import {
  buildIndependentReviewComment,
  validateIndependentReview,
} from "../lib/independent_review_gate.ts";
import {
  buildReproductionGateComment,
  validateReproductionStatus,
} from "../lib/reproduction_status_gate.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 4583;
const PR_URL = `https://github.com/${REPO}/pull/4412`;
const SUMMARY_REL = `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;

const ISSUE_BODY = `## Problem

The reviewer note drops the independent review and reproduction findings.

## Acceptance Criteria

- [ ] The reviewer note names every blocked gate
- [ ] The pull request comment names every blocked gate
`;

// Closes the issue but carries no closure block, no Standards or Spec review
// blocks and no reproduction block, so the closure, review and reproduction
// gates each have a finding to report.
const SUMMARY = `## Summary

Fixed the reviewer note. Closes #${ISSUE}.

## Test Plan

- the repository tests passed
`;

const SUMMARY_WITH_CLOSURE = `## Summary

Fixed the reviewer note. Closes #${ISSUE}.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the reviewer note names every blocked gate — evidence: \`worker/deno/lib/phases/completion_phase.ts\` — reviewer: met
- **met** — the pull request comment names every blocked gate — evidence: \`worker/deno/lib/phases/completion_phase.ts\` — reviewer: met

## Test Plan

- the repository tests passed
`;

/**
 * The first line of a gate's comment is its stable heading paragraph. The
 * builders produce it from one string with no newline, so the first line is
 * the whole heading.
 */
function headline(comment: string): string {
  return comment.split("\n")[0]!;
}

const closureHeadline = headline(
  buildClosureGateComment(
    validateAcceptanceClosure({
      issueBody: ISSUE_BODY,
      prSummaryContent: SUMMARY,
    }),
  ),
);
const reviewHeadline = headline(
  buildIndependentReviewComment(
    validateIndependentReview({
      issueBody: ISSUE_BODY,
      prSummaryContent: SUMMARY,
    }),
  ),
);
const reproductionHeadline = headline(
  buildReproductionGateComment(
    validateReproductionStatus({
      issueLabels: "bug,work-on",
      prSummaryContent: SUMMARY,
    }),
  ),
);

function verifierClean(): PrePrVerifierResult {
  return {
    status: "checked",
    review: {
      summary: "clean",
      findings: [],
      testChanges: "none",
      testChangeNotes: [],
      unrelatedIssues: [],
      checklist: [],
      closure: [],
    },
  };
}

function stubClient(
  posted: { number: number; body: string }[],
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, number: number, body: string) => {
      posted.push({ number, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

/**
 * Runs the completion phase for ISSUE against SUMMARY with the given labels,
 * a clean pre-PR verifier, and the GitHub, git and Claude stubs the other
 * completion tests use. Returns what the run did and said.
 */
async function runCompletion(
  issueLabels: string[],
  summary = SUMMARY,
  issueBody = ISSUE_BODY,
) {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(`${repoPath}/${SUMMARY_REL}`, summary);

  const posted: { number: number; body: string }[] = [];
  const prompts: string[] = [];
  let prCreateCalls = 0;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;
  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Reviewer note folds every blocked gate",
    issueBody,
    issueLabels,
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-reviewer-note-folds`,
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
      createClient: () => stubClient(posted),
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
        if (cmdArgs[0] === "rev-list" && cmdArgs[1] === "--count") {
          return ok("1\n");
        }
        if (cmdArgs[0] === "diff" && cmdArgs.includes("--name-only")) {
          return ok("worker/deno/lib/phases/completion_phase.ts\n");
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        prompts.push(options.prompt);
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "noted", timedOut: false },
        });
      },
      runPrePrVerifier: () => Promise.resolve(verifierClean()),
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
      updatePrLabels: () => Promise.resolve({ ok: true, value: undefined }),
      finalisePr: () =>
        Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        }),
    },
  });

  let result: Awaited<ReturnType<typeof workOnIssueCompletion>>;
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
  return {
    result,
    prCreateCalls,
    prompts,
    onPr: posted.filter((comment) => comment.number === 4412),
  };
}

Deno.test(
  "completion - the reviewer note carries the closure, review and reproduction findings together (Issue #4583)",
  async () => {
    const run = await runCompletion(["bug", "work-on"]);

    assertEquals(run.result.status, "continue");
    assertEquals(run.prCreateCalls, 1);
    // prompts[0] is the in-session note. Later prompts, if any, are the
    // closure verdict recovery's questions (Issue #2242), which do not carry it.
    assertStringIncludes(run.prompts[0]!, closureHeadline);
    assertStringIncludes(run.prompts[0]!, reviewHeadline);
    assertStringIncludes(run.prompts[0]!, reproductionHeadline);

    assertEquals(run.onPr.length, 1);
    assertStringIncludes(run.onPr[0]!.body, closureHeadline);
    assertStringIncludes(run.onPr[0]!.body, reviewHeadline);
    assertStringIncludes(run.onPr[0]!.body, reproductionHeadline);
  },
);

Deno.test(
  "completion - review-first note includes review and reproduction once each (Issue #4583)",
  async () => {
    const run = await runCompletion(["bug", "work-on"], SUMMARY_WITH_CLOSURE);

    assertEquals(run.result.status, "continue");
    assertEquals(run.prCreateCalls, 1);
    assertEquals(run.onPr.length, 1);
    const prompt = run.prompts[0]!;
    assertStringIncludes(prompt, "REQUIRED ITEM 1 of 2");
    assertStringIncludes(prompt, "REQUIRED ITEM 2 of 2");
    for (const text of [prompt, run.onPr[0]!.body]) {
      assertEquals(text.split(reviewHeadline).length - 1, 1);
      assertEquals(text.split(reproductionHeadline).length - 1, 1);
    }
  },
);

Deno.test(
  "completion - reproduction-only note includes its finding once (Issue #4583)",
  async () => {
    const run = await runCompletion(
      ["bug", "work-on"],
      SUMMARY,
      "## Problem\n\nThe reviewer note drops a finding.\n",
    );

    assertEquals(run.result.status, "continue");
    assertEquals(run.prCreateCalls, 1);
    assertEquals(run.onPr.length, 1);
    for (const text of [run.prompts[0]!, run.onPr[0]!.body]) {
      assertEquals(text.split(reproductionHeadline).length - 1, 1);
    }
  },
);

Deno.test(
  "completion - a non-bug issue's reviewer note carries no reproduction finding (Issue #4583)",
  async () => {
    const run = await runCompletion(["work-on"]);

    assertEquals(run.result.status, "continue");
    assertEquals(run.prCreateCalls, 1);
    assertStringIncludes(run.prompts[0]!, closureHeadline);
    assertStringIncludes(run.prompts[0]!, reviewHeadline);
    assertEquals(run.prompts[0]!.includes(reproductionHeadline), false);

    assertEquals(run.onPr.length, 1);
    assertStringIncludes(run.onPr[0]!.body, closureHeadline);
    assertStringIncludes(run.onPr[0]!.body, reviewHeadline);
    assertEquals(run.onPr[0]!.body.includes(reproductionHeadline), false);
  },
);
