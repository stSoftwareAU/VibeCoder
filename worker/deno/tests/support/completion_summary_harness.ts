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

export const SHA = "5e4d3c2b1a0918273645540fedcba98877665544";
export const REPO = "stSoftwareAU/VibeCoder";
export const ISSUE = 2189;
export const PR_URL = `https://github.com/${REPO}/pull/1208`;

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

export function stubClient(comments: string[]): GitHubClient {
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
}

/** Drive the live completion phase over a blocked summary rule. */
export async function runCompletion(scenario: Scenario): Promise<Outcome> {
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
          value: { exitCode: 0, output: "done", timedOut: false },
        });
      },
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
  };
}
