/**
 * Completion gates report findings and still raise the pull request
 * (Issue #4234).
 *
 * A run that has implemented its issue and passed the repository's own tests
 * raises its pull request with auto-merge armed even when the pre-PR verifier
 * and a summary gate both report findings. The agent hears the findings once,
 * in the same session. Whatever remains is one comment on the pull request.
 * Nothing is withheld, disarmed, or labelled.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type {
  PrePrVerifierInput,
  PrePrVerifierResult,
  ReviewFinding,
} from "../lib/pre_pr_verifier.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 4234;
const PR_URL = `https://github.com/${REPO}/pull/4412`;
const SUMMARY_REL = `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;

const ISSUE_BODY = `## Problem

The worker should raise the pull request when the issue is implemented.
`;

const SUMMARY = `## Summary

Implemented the issue. Closes #${ISSUE}.

- Full \`./quality.sh\`: QUALITY_RESULT_PLACEHOLDER

## Test Plan

- the repository tests passed
`;

const FINDING: ReviewFinding = {
  file: "worker/deno/lib/phases/completion_phase.ts",
  line: 12,
  problem: "a stubbed verifier finding that must not block the pull request",
  fix: "leave it for the reviewer",
};

function verifierWithFinding(): PrePrVerifierResult {
  return {
    status: "checked",
    review: {
      summary: "one problem",
      findings: [FINDING],
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

Deno.test(
  "completion - verifier and summary-gate findings still raise an armed pull request (Issue #4234)",
  async () => {
    const repoPath = await Deno.makeTempDir();
    const workDir = await Deno.makeTempDir();
    const summaryPath = `${repoPath}/${SUMMARY_REL}`;
    await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
      recursive: true,
    });
    await Deno.writeTextFile(summaryPath, SUMMARY);

    const posted: { number: number; body: string }[] = [];
    const labels: string[] = [];
    const prompts: string[] = [];
    let prCreateCalls = 0;
    let armed = 0;
    let claimQuestions = 0;
    const verifierInputs: PrePrVerifierInput[] = [];

    const config = buildDefaultWorkerConfig();
    config.workDir = workDir;
    const ctx: IssueContext = {
      repo: REPO,
      issueNumber: ISSUE,
      issueTitle: "Make completion gates advisory",
      issueBody: ISSUE_BODY,
      issueLabels: ["bug", "work-on"],
      issueComments: "",
      githubUser: "testbot",
      config,
    };
    const state: PhaseState = {
      branchName: `issue-${ISSUE}-advisory-gates`,
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
        ): Promise<
          Result<{ code: number; stdout: string; stderr: string }>
        > => {
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
        runSummaryClaimQuestion: () => {
          claimQuestions++;
          return Promise.resolve({
            ok: true as const,
            value: { exitCode: 0, output: "", timedOut: false },
          });
        },
        runPrePrVerifier: (input: PrePrVerifierInput) => {
          verifierInputs.push(input);
          return Promise.resolve(verifierWithFinding());
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
        updatePrLabels: (_repo, _number, added) => {
          labels.push(...added);
          return Promise.resolve({ ok: true, value: undefined });
        },
        finalisePr: () => {
          armed++;
          return Promise.resolve({
            ok: true,
            value: { result: AutoMergeResult.Enabled, message: "armed" },
          });
        },
      },
    });

    let result;
    try {
      result = await workOnIssueCompletion(ctx, state, deps);
    } finally {
      await Deno.remove(repoPath, { recursive: true });
      await Deno.remove(workDir, { recursive: true });
    }

    assertEquals(result.status, "continue");
    assertEquals(prCreateCalls, 1);
    assertEquals(armed, 1);
    assertEquals(prompts.length, 1);
    assertEquals(verifierInputs.length, 2);
    assertStringIncludes(prompts[0]!, FINDING.problem);
    assertStringIncludes(prompts[0]!, "QUALITY_RESULT_PLACEHOLDER");
    assertEquals(labels.includes("failed-once"), false);
    assertEquals(labels.includes("failed"), false);
    const onPr = posted.filter((comment) => comment.number === 4412);
    assertEquals(onPr.length, 1);
    assertStringIncludes(onPr[0]!.body, FINDING.problem);
    assertStringIncludes(onPr[0]!.body, "QUALITY_RESULT_PLACEHOLDER");
    assertStringIncludes(onPr[0]!.body, "auto-merge stays armed");
    assertEquals(onPr[0]!.body.includes("failed-once"), false);
    // The claim check is deleted: a stubbed question must not be consulted.
    assertEquals(claimQuestions, 0);
  },
);
