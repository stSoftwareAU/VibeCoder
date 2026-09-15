/**
 * A gate that blocks *after* the agent already opened the PR must say so
 * (Issue #2044).
 *
 * On 2026-09-12 a run's agent raised its own PR with `gh pr create`, and
 * thirty seconds later the changed-workflow gate refused. The gate runs
 * whether or not a PR exists — by design, the finding is a defect in the
 * change — but everything it *reported* was written for the no-PR case: the
 * comment said "so no PR was raised" while the PR sat on the run's own head,
 * the failure diagnosed as `unknown` for a block the worker itself had
 * authored, and the outcome carried no PR number. The archive recorded a host
 * that delivered nothing on a run whose work merged unchanged three hours
 * later.
 *
 * These tests drive `workOnIssueCompletion` — the path `issue_worker.ts`
 * actually runs — over a workflow file the run added with a tag-pinned action,
 * both ways round: with a PR on the head and without one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  deriveRunOutcome,
  describeRunOutcome,
  type RunOutcome,
} from "../lib/run_outcome.ts";
import {
  detectFailureCategory,
  getFailureCategoryDisplay,
} from "../lib/failure_diagnosis.ts";
import { callbackOutcomeFromRun } from "../lib/run_callback_context.ts";

const SHA = "5f4e3d2c1b0a99887766554433221100ffeeddcc";
const PR_URL = "https://github.com/stSoftwareAU/VibeCoder/pull/2100";
const WORKFLOW_PATH = ".github/workflows/ci.yml";

/**
 * A workflow the run added whose checkout is pinned to a hijackable tag — one
 * `action-pins` finding, and the file is absent at base so nothing in it is
 * pre-existing.
 */
const WORKFLOW_WITH_FINDING = `name: Unit Tests

on:
  pull_request:
    branches: [main, milestone/*]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Run tests
        run: |
          set -euo pipefail
          deno test --allow-none
`;

/** A summary that satisfies every other completion gate. */
const SUMMARY = `## Summary

Provisioned the unit-test workflow. Closes #2044.

## Test Plan

- \`worker/deno/tests/completion_phase_workflow_gate_pr_test.ts\`
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

interface Observed {
  status: string;
  reason: string;
  comments: string[];
  prCreateCalls: number;
  /** The outcome `issue_worker.ts` derives from the phase's state. */
  outcome: RunOutcome;
}

/**
 * Drive the live completion phase over a branch that added
 * {@link WORKFLOW_PATH}, then derive the run outcome exactly as
 * `workOnIssue` does — from the failed result plus the PR fields the phase
 * recorded on its state.
 */
async function runCompletion(
  opts: { prExistsForBranch: boolean; prUrl?: string },
): Promise<Observed> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-2044.md`,
    SUMMARY,
  );
  await Deno.mkdir(`${repoPath}/.github/workflows`, { recursive: true });
  await Deno.writeTextFile(
    `${repoPath}/${WORKFLOW_PATH}`,
    WORKFLOW_WITH_FINDING,
  );

  const comments: string[] = [];
  let prCreateCalls = 0;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 2044,
    issueTitle: "A gate that blocks after the PR exists must say so",
    issueBody: "## Problem\n\nThe block reports no PR was raised.\n",
    issueLabels: ["enhancement"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-2044-gate-reporting",
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
        return Promise.resolve(opts.prUrl ?? PR_URL);
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
          return ok(`${WORKFLOW_PATH}\n`);
        }
        // Empty `ls-tree` output: the branch ADDED the file, so no finding in
        // it is pre-existing (Issue #2043's baseline).
        if (cmdArgs[0] === "ls-tree") return ok("");
        return ok("");
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve(
          opts.prExistsForBranch
            ? { ok: true as const, value: opts.prUrl ?? PR_URL }
            : { ok: false as const, error: new Error("none") },
        ),
    },
  });

  let result;
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }

  const reason = result.status === "continue" ? "" : result.reason;
  return {
    status: result.status,
    reason,
    comments,
    prCreateCalls,
    // The composition `workOnIssue` performs: the failed result, plus the PR
    // the phase recorded on its state.
    outcome: deriveRunOutcome({
      success: false,
      phase: "completion",
      reason,
      prUrl: state.prUrl,
      prNumber: state.prNumber,
      elapsedSeconds: 42,
    }),
  };
}

Deno.test(
  "completion - a workflow-gate block after the agent raised the PR names that PR",
  async () => {
    const observed = await runCompletion({ prExistsForBranch: true });

    assertEquals(observed.status, "failure", "the finding still stops the run");
    assertEquals(observed.prCreateCalls, 0, "gh pr create must not run");

    // The message the issue thread and the run record both carry.
    assertEquals(observed.comments.length, 1);
    const comment = observed.comments[0]!;
    for (const text of [comment, observed.reason]) {
      assertStringIncludes(text, "#2100");
      assertStringIncludes(text, PR_URL);
      assert(
        !text.includes("no PR was raised"),
        "a live PR on the run's own head must not be reported as no PR",
      );
      // The remediation the next attempt needs is still there.
      assertStringIncludes(text, "[BP-SHA-PIN-actions-checkout]");
      assertStringIncludes(text, WORKFLOW_PATH);
    }
  },
);

Deno.test(
  "completion - a workflow-gate block is a known category, never unknown",
  async () => {
    for (const prExistsForBranch of [true, false]) {
      const observed = await runCompletion({ prExistsForBranch });
      const category = detectFailureCategory(observed.reason);

      assertEquals(
        category,
        "workflow_gate",
        `the worker's own gate must diagnose itself (PR present: ${prExistsForBranch})`,
      );
      assertEquals(getFailureCategoryDisplay(category), "workflow-gate");
    }
  },
);

Deno.test(
  "completion - the blocked run's outcome carries the PR number and the block",
  async () => {
    const observed = await runCompletion({ prExistsForBranch: true });
    const outcome = observed.outcome;

    assertEquals(outcome.kind, "pr");
    assert(outcome.kind === "pr", "narrowing");
    assertEquals(outcome.prNumber, 2100);
    assertEquals(outcome.prUrl, PR_URL);
    assertEquals(outcome.blocked?.phase, "completion");
    assertEquals(outcome.blocked?.category, "workflow_gate");
    assertStringIncludes(
      outcome.blocked?.reason ?? "",
      "[BP-SHA-PIN-actions-checkout]",
    );
    assertEquals(describeRunOutcome(outcome), "pr:#2100:blocked:workflow_gate");

    // What a fleet archive reads (Issue #1947): the PR number AND why the run
    // failed, so "delivered, one finding outstanding" is countable apart from
    // "delivered nothing".
    const callback = callbackOutcomeFromRun({
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 2044,
      result: "failure",
      phase: "completion",
      startedAtEpochMs: 0,
      finishedAtEpochMs: 1000,
      outcome,
    });
    assertEquals(callback?.kind, "pr");
    assertEquals(callback?.prNumber, 2100);
    assertEquals(callback?.phase, "completion");
    assertEquals(callback?.category, "workflow_gate");
    assertEquals(callback?.failureClass, "workflow-gate");
  },
);

Deno.test(
  "completion - with no PR on the head the block reports exactly as before",
  async () => {
    const observed = await runCompletion({ prExistsForBranch: false });

    assertEquals(observed.status, "failure");
    assertEquals(observed.prCreateCalls, 0);
    assertStringIncludes(observed.reason, "no PR was raised");
    assertEquals(observed.outcome.kind, "no_pr");
    assert(observed.outcome.kind === "no_pr", "narrowing");
    // Still a known category: the gate is the worker's own either way.
    assertEquals(observed.outcome.category, "workflow_gate");
  },
);

Deno.test(
  "completion - an unnumberable PR URL names no PR rather than #0",
  async () => {
    const observed = await runCompletion({
      prExistsForBranch: true,
      prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/not-a-number",
    });

    assertEquals(observed.status, "failure");
    assertStringIncludes(observed.reason, "no PR was raised");
    assertEquals(observed.outcome.kind, "no_pr");
  },
);
