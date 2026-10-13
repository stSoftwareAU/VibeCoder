/**
 * Integration tests for the execution-capable pre-PR verifier running in the
 * LIVE completion phase (Issue #3395).
 *
 * The pre-PR Spec and Standards reviewers are read-only and diff-only and run
 * before the summary exists; the fleet reviewer that later blocks the PR
 * executes code and reads the summary. These tests drive
 * `workOnIssueCompletion` with a scripted `runPrePrVerifier` seam and assert
 * on observable outcomes (whether `gh pr create` ran, whether the in-run
 * recovery fired, what the recovery prompt and posted comment say).
 *
 * Mirrors `completion_phase_summary_claim_check_test.ts`'s harness.
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
  PRE_PR_VERIFIER_COMMENT_HEADING,
  type PrePrVerifierInput,
  type PrePrVerifierResult,
  type ReviewFinding,
} from "../lib/pre_pr_verifier.ts";
import {
  DRIFT_VERDICT_CLOSE,
  DRIFT_VERDICT_OPEN,
} from "../lib/pr_feedback_drift_check.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3395;
const PR_URL = `https://github.com/${REPO}/pull/4412`;
const SUMMARY_REL = `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;

/** An issue body with no `## Acceptance Criteria` section. */
const ISSUE_BODY = `## Problem

Problems only the fleet reviewer sees surface after the PR is raised.
`;

const SUMMARY_CLEAN = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

## Test Plan

- manually verified
`;

const SUMMARY_FIXED = `## Summary

Changed the broker balance card, and fixed the rounding. Closes #${ISSUE}.

## Test Plan

- manually verified
`;

const SUMMARY_PLACEHOLDER = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

- Full \`./quality.sh\`: QUALITY_RESULT_PLACEHOLDER

## Test Plan

- manually verified
`;

const CLAIM_SENTENCE =
  "`phraseAnywhere()` escapes the phrase and joins its words with `\\s+`.";

const SUMMARY_WRONG_CLAIM = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

${CLAIM_SENTENCE}

## Test Plan

- manually verified
`;

const FINDING: ReviewFinding = {
  file: "src/balance.ts",
  line: 42,
  problem: "rounding drops the final cent on negative balances",
  fix: "round half away from zero",
};

function checked(findings: ReviewFinding[]): PrePrVerifierResult {
  return {
    status: "checked",
    review: {
      summary: findings.length ? "one problem" : "nothing found",
      findings,
      testChanges: "none",
      testChangeNotes: [],
      unrelatedIssues: [],
    },
  };
}

const NOT_CHECKED: PrePrVerifierResult = {
  status: "not_checked",
  reason: "the verifier timed out",
};

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
  summary: string;
  /** Summary the recovery invocation writes; omitted, it changes nothing. */
  retryWrites?: string;
  changedFiles?: string;
  /** Scripted verifier results, one per call (repeats the last). */
  verifier: PrePrVerifierResult[];
  /** When true, an open PR already exists for this run's branch. */
  existingPr?: boolean;
  /** When true, no summary file is written. */
  noSummaryFile?: boolean;
  /** When true, no base ref resolves (rev-parse and fetch fail). */
  baseUnresolvable?: boolean;
  /** Scripted claim-check question reply (default: no findings). */
  claimReply?: string;
  /** Model configured for the run (default: the config default). */
  claudeModel?: string;
}

interface Outcome {
  status: string;
  reason?: string;
  outcomeKind?: string;
  claudePrompts: string[];
  verifierInputs: PrePrVerifierInput[];
  prCreateCalls: number;
  comments: string[];
  summaryText: string;
  claudeRunStats: PhaseState["claudeRunStats"];
  config: ReturnType<typeof buildDefaultWorkerConfig>;
}

async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  const summaryPath = `${repoPath}/${SUMMARY_REL}`;
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  if (!scenario.noSummaryFile) {
    await Deno.writeTextFile(summaryPath, scenario.summary);
  }

  const comments: string[] = [];
  let prCreateCalls = 0;
  const claudePrompts: string[] = [];
  const verifierInputs: PrePrVerifierInput[] = [];

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;
  if (scenario.claudeModel !== undefined) {
    config.claudeModel = scenario.claudeModel;
  }

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Run a pre-PR verifier",
    issueBody: ISSUE_BODY,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-pre-pr-verifier`,
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
        const ok = (stdout: string, code = 0) =>
          Promise.resolve({
            ok: true as const,
            value: { code, stdout, stderr: "" },
          });
        if (
          scenario.baseUnresolvable && cmdArgs.some((a) => a.includes("main"))
        ) {
          return ok("", 128);
        }
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          if (cmdArgs.includes("--diff-filter=ACMR")) return ok("");
          return ok(scenario.changedFiles ?? "docs/notes.md");
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        claudePrompts.push(options.prompt);
        if (scenario.retryWrites !== undefined) {
          Deno.writeTextFileSync(summaryPath, scenario.retryWrites);
        }
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "done", timedOut: false },
        });
      },
      runSummaryClaimQuestion: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            exitCode: 0,
            output: scenario.claimReply ??
              `${DRIFT_VERDICT_OPEN}\n{"findings":[]}\n${DRIFT_VERDICT_CLOSE}`,
            timedOut: false,
          },
        }),
      runPrePrVerifier: (input: PrePrVerifierInput) => {
        verifierInputs.push(input);
        const i = Math.min(
          verifierInputs.length - 1,
          scenario.verifier.length - 1,
        );
        return Promise.resolve(scenario.verifier[i]!);
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
        scenario.existingPr
          ? Promise.resolve({ ok: true as const, value: PR_URL })
          : Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        scenario.existingPr
          ? Promise.resolve({ ok: true as const, value: PR_URL })
          : Promise.resolve({ ok: false as const, error: new Error("none") }),
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
  let summaryText = "";
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
    try {
      summaryText = await Deno.readTextFile(summaryPath);
    } catch {
      summaryText = "";
    }
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }

  return {
    status: result.status,
    reason: result.status === "failure" || result.status === "early_exit"
      ? result.reason
      : undefined,
    outcomeKind: result.status === "early_exit"
      ? result.outcome?.kind
      : undefined,
    claudePrompts,
    verifierInputs,
    prCreateCalls,
    comments,
    summaryText,
    claudeRunStats: state.claudeRunStats,
    config,
  };
}

const VERIFIER_WORDS = "The pre-PR verifier found blocking problems";

// (a)
Deno.test(
  "completion - verifier findings block; the one recovery turn gets them and the re-run is clean, so the PR is raised",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      retryWrites: SUMMARY_FIXED,
      verifier: [checked([FINDING]), checked([])],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudePrompts.length, 1, "one recovery turn");
    const prompt = outcome.claudePrompts[0]!;
    assertStringIncludes(prompt, FINDING.problem);
    assertStringIncludes(prompt, VERIFIER_WORDS);
    assertStringIncludes(prompt, "can name a defect in the code itself");
    assertEquals(outcome.verifierInputs.length, 2);
  },
);

// (b)
Deno.test(
  "completion - findings that persist with no PR fail the run and post the verifier comment once",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([FINDING])],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    const posted = outcome.comments.filter((c) =>
      c.includes(PRE_PR_VERIFIER_COMMENT_HEADING)
    );
    assertEquals(posted.length, 1);
    assertStringIncludes(posted[0]!, FINDING.problem);
  },
);

// (c)
Deno.test(
  "completion - findings that persist over an existing PR end as summary_incomplete",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([FINDING])],
      existingPr: true,
    });

    assertEquals(outcome.status, "early_exit");
    assertEquals(outcome.outcomeKind, "summary_incomplete");
  },
);

// (d)
Deno.test(
  "completion - a verifier that was not checked does not block and costs no recovery turn",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [NOT_CHECKED],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudePrompts.length, 0);
    assertEquals(outcome.verifierInputs.length, 1);
  },
);

// (e)
Deno.test(
  "completion - the verifier runs without acceptance criteria and receives the issue, summary text, summary path and base ref",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([])],
      claudeModel: "some-model",
    });

    assertEquals(outcome.status, "continue");
    assert(outcome.verifierInputs.length >= 1);
    const input = outcome.verifierInputs[0]!;
    assertEquals(input.issueBody, ISSUE_BODY);
    assertEquals(input.summaryContent, SUMMARY_CLEAN);
    assertEquals(input.summaryPath, SUMMARY_REL);
    assertEquals(input.issueNumber, ISSUE);
    assertEquals(input.repo, REPO);
    assertStringIncludes(input.baseRef, "main");
    assertEquals(input.changedFiles, ["docs/notes.md"]);
    assertEquals(input.timeoutSeconds, outcome.config.claudeTimeout);
    assertEquals(input.killAfterSeconds, outcome.config.claudeKillAfter);
    assertEquals(input.maxRetries, outcome.config.maxRateLimitRetries);
    assertEquals(input.model, "some-model");
  },
);

// (j)
Deno.test(
  "completion - the verifier run's stats are recorded on the phase state",
  async () => {
    const run = {
      exitCode: 0,
      output: "",
      stderr: "",
      timedOut: false,
      fallbackModel: "verifier-fallback-model",
      runStats: {
        servedModels: ["verifier-served-model"],
        requestedModel: "verifier-requested-model",
        wallClockMs: 4321,
      },
    } as unknown as NonNullable<PrePrVerifierResult["run"]>;
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [{ ...checked([]), run } as PrePrVerifierResult],
    });

    assertEquals(outcome.status, "continue");
    const recorded = (outcome.claudeRunStats ?? []).filter((e) =>
      e.fallbackModel === "verifier-fallback-model"
    );
    assertEquals(recorded.length, 1);
    assertEquals(recorded[0]!.runStats?.wallClockMs, 4321);
  },
);

// (f)
Deno.test(
  "completion - verifier findings fold into an earlier gate's block as a second REQUIRED ITEM",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_PLACEHOLDER,
      retryWrites: SUMMARY_FIXED,
      verifier: [checked([FINDING]), checked([])],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudePrompts.length, 1, "one recovery turn");
    const prompt = outcome.claudePrompts[0]!;
    assertStringIncludes(prompt, "REQUIRED ITEM 1 of 2");
    assertStringIncludes(prompt, "REQUIRED ITEM 2 of 2");
    const item2 = prompt.indexOf("REQUIRED ITEM 2 of 2");
    assert(prompt.indexOf(FINDING.problem, item2) > item2);
    assert(prompt.indexOf("QUALITY_RESULT_PLACEHOLDER") < item2);
  },
);

// (g)
Deno.test(
  "completion - with no summary file the verifier is not called",
  async () => {
    const outcome = await runCompletion({
      summary: "",
      noSummaryFile: true,
      verifier: [checked([FINDING])],
    });

    assertEquals(outcome.verifierInputs.length, 0);
    assertEquals(
      outcome.comments.some((c) => c.includes(PRE_PR_VERIFIER_COMMENT_HEADING)),
      false,
    );
  },
);

// (h)
Deno.test(
  "completion - verifier findings fold into the summary claim check's block",
  async () => {
    const claimReply = `${DRIFT_VERDICT_OPEN}\n${
      JSON.stringify({
        findings: [{
          file: SUMMARY_REL,
          sentence: CLAIM_SENTENCE,
          reason: "the head's phraseAnywhere builds no regex",
        }],
      })
    }\n${DRIFT_VERDICT_CLOSE}`;
    const outcome = await runCompletion({
      summary: SUMMARY_WRONG_CLAIM,
      retryWrites: SUMMARY_FIXED,
      verifier: [checked([FINDING]), checked([])],
      claimReply,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudePrompts.length, 1, "one recovery turn");
    const prompt = outcome.claudePrompts[0]!;
    assertStringIncludes(prompt, "REQUIRED ITEM 1 of 2");
    assertStringIncludes(prompt, "REQUIRED ITEM 2 of 2");
    assertStringIncludes(prompt, "describes named code wrongly");
    assertStringIncludes(prompt, FINDING.problem);
  },
);

// (i)
Deno.test(
  "completion - with no resolvable base ref the verifier is not called and no verifier comment is posted",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([FINDING])],
      baseUnresolvable: true,
    });

    assertEquals(outcome.verifierInputs.length, 0);
    assertEquals(
      outcome.comments.some((c) => c.includes(PRE_PR_VERIFIER_COMMENT_HEADING)),
      false,
    );
  },
);
