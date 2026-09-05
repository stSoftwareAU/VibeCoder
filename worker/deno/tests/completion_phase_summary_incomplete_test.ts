/**
 * A PR-summary document rule broken *after* the work reached a PR is an
 * incomplete summary, not a failed run (Issue #1140).
 *
 * The three summary gates sit at the completion phase's PR-creation
 * chokepoint, which is normally ahead of the PR — but not always: the agent
 * raises its own PR from inside the execute phase often enough that the phase
 * carries a self-healing recovery path for it. On 2026-09-05 four fleet runs
 * raised a PR and were recorded `failure` 25-68 seconds later on a summary
 * rule, and all four PRs merged. A `failure` cools the issue down and returns
 * it to the claimable pool, so a sibling host redid finished work at a mean
 * $10.80 a run.
 *
 * These tests drive `workOnIssueCompletion` — the path `issue_worker.ts`
 * actually runs — and assert on the outcome it reports, both ways round: with
 * no PR the gate still blocks, and with a PR the run reports
 * `summary_incomplete` against that PR. The security-fix gate is the deliberate
 * exception and is asserted to keep failing with a PR in hand.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { describeRunOutcome } from "../lib/run_outcome.ts";

const SHA = "3c2b1a0908f7e6d5c4b3a29180716253440fedcb";
const PR_URL = "https://github.com/stSoftwareAU/VibeCoder/pull/1107";

const ISSUE_WITH_CRITERIA = `## Problem

A finished run is reported as a failure.

## Acceptance criteria

- [ ] A run that raised a PR is never recorded as a failure for a format rule.
- [ ] Such a run does not return its issue to the claimable pool.
`;

/**
 * The exact shortfall the fleet hit four times: the `unrequested` entry names
 * no `reviewer:` verdict, so the independent-review gate blocks.
 */
const SUMMARY_MISSING_REVIEWER = `## Summary

Distinguished the outcomes. Closes #1140.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — a run that raised a PR is never recorded as a failure — evidence: \`worker/deno/tests/completion_phase_summary_incomplete_test.ts\` — reviewer: met
- **met** — such a run does not return its issue to the pool — evidence: \`worker/deno/lib/run_outcome.ts\` — reviewer: met
- **unrequested** — tidied an adjacent comment — reason: it named a removed symbol

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling

## Test Plan

- \`worker/deno/tests/completion_phase_summary_incomplete_test.ts\`
`;

/** The same work with the verdict recorded — nothing for the gate to block. */
const SUMMARY_COMPLETE = SUMMARY_MISSING_REVIEWER.replace(
  "— reason: it named a removed symbol",
  "— reviewer: unrequested — reason: it named a removed symbol",
);

/** A `bug` run whose summary carries no `## Reproduction` block. */
const SUMMARY_NO_REPRODUCTION = `## Summary

Fixed the fault. Closes #1140.

## Test Plan

- \`worker/deno/tests/completion_phase_summary_incomplete_test.ts\`
`;

/** A `security` run with every scrap of verification evidence removed. */
const SUMMARY_NO_SECURITY_EVIDENCE = `## Summary

Closed the injection flaw. Closes #1140.
`;

/**
 * A `security` run that breaks a summary format rule **as well as** the
 * vulnerability-fix rule — the ordering case. The summary gates stop being a
 * hard failure once a PR exists, so a security run must not be able to leave
 * through one of them before the security gate has had its say.
 */
const SUMMARY_NO_SECURITY_EVIDENCE_AND_NO_REVIEW = `## Summary

Closed the injection flaw. Closes #1140.

## Test Plan

- \`worker/deno/tests/injection_test.ts\`
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
  issueBody: string;
  summary: string;
  labels: string[];
  /** Whether the run's branch already carries an open PR. */
  prExistsForBranch: boolean;
  /** The URL that lookup returns; defaults to a well-formed one. */
  prUrl?: string;
}

interface Observed {
  status: string;
  reason?: string;
  outcomeLabel: string;
  outcomeKind?: string;
  outcomePrNumber?: number;
  outcomeProblem?: string;
  prCreateCalls: number;
  recoverCalls: number;
  finaliseCalls: number;
  comments: string[];
}

/** Drive the live completion phase and report what it did. */
async function runCompletion(scenario: Scenario): Promise<Observed> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-1140.md`,
    scenario.summary,
  );

  const comments: string[] = [];
  let prCreateCalls = 0;
  let recoverCalls = 0;
  let finaliseCalls = 0;

  const config = buildDefaultWorkerConfig();
  // Never inherit the host's work directory: the security-fix gate persists
  // its verdict under it (Issue #1098's rule).
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 1140,
    issueTitle: "A finished run must not be reported as a failure",
    issueBody: scenario.issueBody,
    issueLabels: scenario.labels,
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-1140-outcome",
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
          return ok("worker/deno/lib/run_outcome.ts");
        }
        return ok("");
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve(
          scenario.prExistsForBranch
            ? { ok: true as const, value: scenario.prUrl ?? PR_URL }
            : { ok: false as const, error: new Error("none") },
        ),
      recoverExistingPr: () => {
        recoverCalls++;
        return Promise.resolve({ ok: true, value: "recovered" });
      },
      finalisePr: () => {
        finaliseCalls++;
        return Promise.resolve({ ok: true, value: "auto-merge armed" });
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

  const outcome = result.status === "early_exit" ? result.outcome : undefined;
  return {
    status: result.status,
    reason: result.status === "failure" || result.status === "early_exit"
      ? result.reason
      : undefined,
    outcomeLabel: describeRunOutcome(outcome),
    outcomeKind: outcome?.kind,
    outcomePrNumber: outcome && outcome.kind === "summary_incomplete"
      ? outcome.prNumber
      : undefined,
    outcomeProblem: outcome && outcome.kind === "summary_incomplete"
      ? outcome.problem
      : undefined,
    prCreateCalls,
    recoverCalls,
    finaliseCalls,
    comments,
  };
}

Deno.test(
  "completion - a summary rule broken with no PR still blocks PR creation",
  async () => {
    const observed = await runCompletion({
      issueBody: ISSUE_WITH_CRITERIA,
      summary: SUMMARY_MISSING_REVIEWER,
      labels: ["enhancement"],
      prExistsForBranch: false,
    });

    assertEquals(observed.status, "failure");
    assertEquals(observed.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(observed.reason ?? "", "Independent Spec/Standards");
    assertEquals(observed.comments.length, 1);
    assertStringIncludes(observed.comments[0]!, "Independent review missing");
  },
);

Deno.test(
  "completion - the same rule broken after the PR exists is summary_incomplete, not failure",
  async () => {
    const observed = await runCompletion({
      issueBody: ISSUE_WITH_CRITERIA,
      summary: SUMMARY_MISSING_REVIEWER,
      labels: ["enhancement"],
      prExistsForBranch: true,
    });

    assertEquals(observed.status, "early_exit");
    assertEquals(observed.outcomeKind, "summary_incomplete");
    assertEquals(observed.outcomePrNumber, 1107);
    assertStringIncludes(
      observed.outcomeProblem ?? "",
      "Independent Spec/Standards",
    );
    assertEquals(observed.outcomeLabel, "summary_incomplete:pr#1107");
    // The work is on the PR the run already raised — never a second one.
    assertEquals(observed.prCreateCalls, 0, "gh pr create must not run");
    // The issue stays attached to that PR: body updated and auto-merge armed.
    assertEquals(observed.recoverCalls, 1);
    assertEquals(observed.finaliseCalls, 1);
    // The shortfall still reaches the issue thread.
    assertEquals(observed.comments.length, 1);
    assertStringIncludes(observed.comments[0]!, "Independent review missing");
  },
);

Deno.test(
  "completion - a missing reproduction block after the PR exists is summary_incomplete",
  async () => {
    const observed = await runCompletion({
      issueBody: "## Problem\n\nThe parser mishandles a leap year.\n",
      summary: SUMMARY_NO_REPRODUCTION,
      labels: ["bug"],
      prExistsForBranch: true,
    });

    assertEquals(observed.status, "early_exit");
    assertEquals(observed.outcomeKind, "summary_incomplete");
    assertStringIncludes(observed.outcomeProblem ?? "", "Reproduction status");
    assertEquals(observed.prCreateCalls, 0);
  },
);

Deno.test(
  "completion - the security-fix gate still fails the run when a PR exists",
  async () => {
    const observed = await runCompletion({
      issueBody: "## Problem\n\nAn injection flaw.\n",
      summary: SUMMARY_NO_SECURITY_EVIDENCE,
      labels: ["security"],
      prExistsForBranch: true,
    });

    assertEquals(
      observed.status,
      "failure",
      "a security-labelled finding with no vulnerability-fix evidence must stop the PR",
    );
    assertStringIncludes(observed.reason ?? "", "PR creation blocked");
    assertEquals(observed.prCreateCalls, 0);
  },
);

Deno.test(
  "completion - a security run that also breaks a summary rule still fails, PR or not",
  async () => {
    for (const prExistsForBranch of [true, false]) {
      const observed = await runCompletion({
        // Criteria-bearing, so the acceptance-closure and independent-review
        // gates both apply and would otherwise fire first.
        issueBody: ISSUE_WITH_CRITERIA,
        summary: SUMMARY_NO_SECURITY_EVIDENCE_AND_NO_REVIEW,
        labels: ["security", "bug"],
        prExistsForBranch,
      });

      assertEquals(
        observed.status,
        "failure",
        `a security-labelled finding must be judged before any summary rule can downgrade the run (PR present: ${prExistsForBranch})`,
      );
      assertStringIncludes(observed.reason ?? "", "PR creation blocked");
      assertEquals(observed.prCreateCalls, 0);
    }
  },
);

Deno.test(
  "completion - a summary rule with an unnumberable PR URL fails rather than naming #0",
  async () => {
    const observed = await runCompletion({
      issueBody: ISSUE_WITH_CRITERIA,
      summary: SUMMARY_MISSING_REVIEWER,
      labels: ["enhancement"],
      prExistsForBranch: true,
      prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/not-a-number",
    });

    assertEquals(observed.status, "failure");
    assertEquals(observed.outcomeKind, undefined);
  },
);

Deno.test(
  "completion - a complete summary is unaffected by the new outcome",
  async () => {
    const observed = await runCompletion({
      issueBody: ISSUE_WITH_CRITERIA,
      summary: SUMMARY_COMPLETE,
      labels: ["enhancement"],
      prExistsForBranch: false,
    });

    assertEquals(observed.status, "continue");
    assertEquals(observed.prCreateCalls, 1);
    assertEquals(observed.comments.length, 0);
  },
);
