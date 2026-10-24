/**
 * Shared harness for the completion-phase summary-rule tests (Issues #2189,
 * #4234): drives the LIVE `workOnIssueCompletion` over a scripted summary,
 * agent stub and git stub, and reports what the run did.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { workOnIssueCompletion } from "../../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../../lib/issue_worker_types.ts";
import { createMockDeps } from "../../lib/issue_worker_wiring.ts";
import type {
  PrePrVerifierInput,
  PrePrVerifierResult,
} from "../../lib/pre_pr_verifier.ts";
import { AutoMergeResult } from "../../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../../types.ts";
import { buildDefaultWorkerConfig } from "../../lib/config_defaults.ts";
import {
  RUN_MAX_SECONDS_ENV,
  RUN_STARTED_EPOCH_ENV,
} from "../../lib/run_hard_cap.ts";
import {
  DRIFT_VERDICT_CLOSE,
  DRIFT_VERDICT_OPEN,
} from "../../lib/pr_feedback_drift_check.ts";

export const SHA = "5e4d3c2b1a0918273645540fedcba98877665544";
export const REPO = "stSoftwareAU/VibeCoder";
export const ISSUE = 2189;
export const PR_URL = `https://github.com/${REPO}/pull/1208`;

/** The repo-relative path the completion phase reads the PR summary from. */
export const ISSUE_SUMMARY_PATH =
  `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;

/**
 * A model claim-check reply (Issue #4234): the drift verdict block naming each
 * sentence in `file`, as the claim check's own parser reads it.
 */
export function claimVerdictReply(
  file: string,
  sentences: readonly string[],
): string {
  const findings = sentences.map((sentence) => ({
    file,
    sentence,
    reason: "the head does not match the sentence",
  }));
  return [
    "Verdict below.",
    DRIFT_VERDICT_OPEN,
    JSON.stringify({ findings }),
    DRIFT_VERDICT_CLOSE,
  ].join("\n");
}

export const ISSUE_WITH_CRITERIA = `## Problem

A block with no PR ends the run instead of recovering in-run.

## Acceptance criteria

- [ ] The first block launches one recovery invocation.
- [ ] A second block in the same run fails as today.
`;

/** A bug report that states no acceptance criteria. */
export const ISSUE_WITHOUT_CRITERIA = `## Problem

The gate ends the run instead of recovering in-run.
`;

/** The summary the agent wrote: no closure block at all. */
export const SUMMARY_WITHOUT_BLOCK = `## Summary

Recovered in-run. Closes #${ISSUE}.

## Test Plan

- \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\`
`;

/** The summary the recovery invocation writes once told what is missing. */
export const SUMMARY_WITH_BLOCK = `## Summary

Recovered in-run. Closes #${ISSUE}.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the first block launches one recovery invocation — evidence: \`worker/deno/lib/summary_rule_gate_retry.ts\` — reviewer: met
- **met** — a second block in the same run fails as today — evidence: \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling

**Docs sweep** — grep: \`recoverFromSummaryRuleBlock\`; section: \`docs/EXTENDING.md#summary-rule-recovery\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added

## Test Plan

- \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\`
`;

/** A bug-labelled run's summary with no `## Reproduction` block. */
export const BUG_SUMMARY_WITHOUT_REPRODUCTION = `## Summary

Fixed the fault. Closes #${ISSUE}.

## Test Plan

- \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\`
`;

/** The same summary once the reproduction gate's comment has been answered. */
export const BUG_SUMMARY_WITH_REPRODUCTION = `## Summary

Fixed the fault. Closes #${ISSUE}.

## Reproduction

- **symptom** — the gate ended the run instead of recovering
- **status** — \`verified\` — the regression test failed against the unfixed code and passes after the fix
- **regression test** — \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts::completion - a first summary-rule block re-invokes the agent once and the PR is raised\`

**Docs sweep** — grep: \`recoverFromSummaryRuleBlock\`; section: \`docs/EXTENDING.md#summary-rule-recovery\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added

## Test Plan

- \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\`
`;

export function stubClient(
  comments: string[],
  failCommentContaining?: string,
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, _issue: number, body: string) => {
      if (
        failCommentContaining !== undefined &&
        body.includes(failCommentContaining)
      ) {
        return Promise.reject(new Error("stub: comment refused"));
      }
      comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

export interface Scenario {
  landedDuringGate?: boolean;
  /** Summary on the branch when the completion phase starts. */
  summary: string;
  /**
   * Summary the recovery invocation writes; omitted, it changes nothing. An
   * array (Issue #4234) is consumed in order, one entry per recovery turn: turn
   * N writes entry N, and a turn past the list writes nothing.
   */
  retryWrites?: string | readonly string[];
  /**
   * Scripted pre-PR verifier results, one per completion pass (Issue #4234); the
   * last one repeats past the end. Omitted, the verifier is the default stub.
   */
  verifier?: PrePrVerifierResult[];
  /** Labels on the issue — `bug` engages the reproduction gate. */
  labels?: string[];
  /** Issue body; defaults to the criteria-bearing one. */
  issueBody?: string;
  /** Make the recovery invocation itself fail (a rate limit, a spawn fault). */
  retryInvocationFails?: boolean;
  /** Whether the run's branch already carries an open PR. */
  prExistsForBranch?: boolean;
  /** Output of `git diff --unified=0 <base>...HEAD`, when a scenario needs it. */
  diffUnified0?: string;
  /**
   * The agent's final message each recovery turn returns (Issue #4234), which
   * the next pre-PR verifier pass receives as its `agentResponse`. Omitted, the
   * turn's output is `done`.
   */
  retryOutput?: string;
  /**
   * Scripted summary-claim model pass, one entry per completion pass (Issue
   * #4234): the sentences the model reports as describing named code wrongly.
   * Each must appear verbatim in the summary. The last entry repeats past the
   * end. Omitted, the model pass is not scripted and reports nothing.
   */
  claimSentences?: readonly (readonly string[])[];
  /** The issue's comments before the run (Issue #4234), as the author's login. */
  issueComments?: readonly { author: string; body: string }[];
  /**
   * A substring: an issue comment whose body contains it fails to post (Issue
   * #4234). Other comments post normally, so only that one post is refused.
   */
  failCommentContaining?: string;
}

export interface Outcome {
  status: string;
  reason?: string;
  /** The `early_exit` outcome's kind, when the run ended that way. */
  outcomeKind?: string;
  claudeCalls: number;
  claudePrompts: string[];
  qualityGateRuns: number;
  prCreateCalls: number;
  comments: string[];
  /** Every pre-PR verifier pass, in order (Issue #4234). */
  verifierInputs: PrePrVerifierInput[];
  /**
   * Calls that finalise a PR, in total: `finalisePr` (a new PR) and
   * `recoverExistingPr` (a PR the agent raised) (Issue #4234).
   */
  finalisePrCalls: number;
  /** The `finalisePrCalls` count at the start of each recovery turn (Issue #4234). */
  finalisedBeforeTurn: number[];
  /** Every logger call the run made, in order (Issue #4234). */
  logs: { level: "info" | "warn" | "error"; message: string }[];
}

/**
 * The host's run-cap variables, which `resolveRunHardCap` reads (Issue #4234).
 * A test must not inherit them: a cap the supervisor set on the host would
 * change a recovery turn's runway, so `runCompletion` removes them for the run.
 */
const HOST_RUN_CAP_ENV = [RUN_MAX_SECONDS_ENV, RUN_STARTED_EPOCH_ENV] as const;

/**
 * Drive the live completion phase over a blocked summary rule. The host's run
 * cap is removed for the duration and restored afterwards (Issue #4234), so the
 * outcome never depends on the environment the test runner happens to inherit.
 */
export async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const saved = HOST_RUN_CAP_ENV.map((name) =>
    [name, Deno.env.get(name)] as const
  );
  for (const name of HOST_RUN_CAP_ENV) Deno.env.delete(name);
  try {
    return await runCompletionWithoutHostCap(scenario);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

async function runCompletionWithoutHostCap(
  scenario: Scenario,
): Promise<Outcome> {
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
  let mergeReads = 0;
  let claudeCalls = 0;
  let qualityGateRuns = 0;
  const claudePrompts: string[] = [];
  const verifierInputs: PrePrVerifierInput[] = [];
  let finalisePrCalls = 0;
  const finalisedBeforeTurn: number[] = [];
  let retryTurn = 0;
  let claimPasses = 0;
  const logs: Outcome["logs"] = [];
  const capture = (level: "info" | "warn" | "error") => (message: string) => {
    logs.push({ level, message });
  };

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
    issueCommentRows: scenario.issueComments?.map((c) => ({
      author: c.author,
      body: c.body,
    })),
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
    logger: {
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
    },
    github: {
      createClient: () => stubClient(comments, scenario.failCommentContaining),
      runGhCommand: (args: string[]) => {
        if (
          scenario.landedDuringGate && args[0] === "pr" && args[1] === "list" &&
          args.includes("merged")
        ) {
          return Promise.resolve(JSON.stringify(
            ++mergeReads > 1
              ? [{
                number: 1208,
                title: `Recover summary (#${ISSUE})`,
                state: "MERGED",
                mergedAt: "2026-10-18T01:44:24Z",
                url: PR_URL,
                headRefName: state.branchName,
                headRefOid: SHA,
                headRepository: { name: "VibeCoder" },
                headRepositoryOwner: { login: "stSoftwareAU" },
                baseRefName: "main",
                mergeCommit: { oid: "b".repeat(40) },
                body: SUMMARY_WITH_BLOCK,
              }]
              : [],
          ));
        }
        if (scenario.landedDuringGate && args[0] === "api") {
          return Promise.resolve("behind");
        }
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
        if (cmdArgs.includes("diff") && cmdArgs.includes("--unified=0")) {
          return ok(scenario.diffUnified0 ?? "");
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        claudeCalls++;
        claudePrompts.push(options.prompt);
        finalisedBeforeTurn.push(finalisePrCalls);
        const turn = retryTurn++;
        if (scenario.retryInvocationFails) {
          return Promise.resolve({
            ok: false as const,
            error: new Error("rate limited"),
          });
        }
        const writes = scenario.retryWrites;
        if (typeof writes === "string") {
          Deno.writeTextFileSync(summaryPath, writes);
        } else if (writes !== undefined && turn < writes.length) {
          Deno.writeTextFileSync(summaryPath, writes[turn]!);
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            exitCode: 0,
            output: scenario.retryOutput ?? "done",
            timedOut: false,
          },
        });
      },
      ...(scenario.claimSentences === undefined ? {} : {
        runSummaryClaimQuestion: () => {
          const scripted = scenario.claimSentences!;
          const pass = Math.min(claimPasses++, scripted.length - 1);
          const sentences = scripted[pass] ?? [];
          return Promise.resolve({
            ok: true as const,
            value: {
              exitCode: 0,
              output: claimVerdictReply(
                ISSUE_SUMMARY_PATH,
                sentences,
              ),
              timedOut: false,
            },
          });
        },
      }),
      ...(scenario.verifier === undefined ? {} : {
        runPrePrVerifier: (input: PrePrVerifierInput) => {
          verifierInputs.push(input);
          const scripted = scenario.verifier!;
          const i = Math.min(verifierInputs.length - 1, scripted.length - 1);
          return Promise.resolve(scripted[i]!);
        },
      }),
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
      // An existing PR is finalised through `recoverExistingPr` (Issue #4234).
      recoverExistingPr: () => {
        finalisePrCalls++;
        return Promise.resolve({ ok: true, value: "recovered" });
      },
      finalisePr: () => {
        finalisePrCalls++;
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

  return {
    status: result.status,
    reason: result.status === "failure" || result.status === "early_exit"
      ? result.reason
      : undefined,
    outcomeKind: result.status === "early_exit"
      ? result.outcome?.kind
      : undefined,
    claudeCalls,
    claudePrompts,
    qualityGateRuns,
    prCreateCalls,
    comments,
    verifierInputs,
    finalisePrCalls,
    finalisedBeforeTurn,
    logs,
  };
}
