/**
 * Integration tests for the PR-summary result-placeholder gate running in
 * the LIVE completion phase (Issue #3124).
 *
 * A fill-in-later token such as `QUALITY_RESULT_PLACEHOLDER` left where a
 * command's actual result belongs used to sail through PR creation
 * unchecked. These tests drive `workOnIssueCompletion` and assert on the
 * observable outcome (whether `gh pr create` was invoked, whether the in-run
 * recovery fired, whether the block was folded with another gate's), not on
 * how the gate is called.
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

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3124;
const PR_URL = `https://github.com/${REPO}/pull/4211`;

const ISSUE_BODY = `## Problem

Nothing checks the PR summary for a left-over result placeholder.
`;

/** A clean summary, with a Docs sweep line already answered, with a bare placeholder token. */
const SUMMARY_WITH_BARE_TOKEN = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

**Docs sweep** — grep: \`BrokerBalance\`; section: \`docs/reporting-api.md#decisions-report\`; no hits

**Branch outcomes:** none added

- Full \`./quality.sh\`: QUALITY_RESULT_PLACEHOLDER

## Test Plan

- \`worker/deno/tests/completion_phase_result_placeholder_test.ts\`
`;

/** A clean summary with the GRQ#5164 structural-backstop token (Issue #3248). */
const SUMMARY_WITH_GATE_OUTCOME_PENDING = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

**Docs sweep** — grep: \`BrokerBalance\`; section: \`docs/reporting-api.md#decisions-report\`; no hits

**Branch outcomes:** none added

- \`./quality.sh < /dev/null\` on the head: GATE_OUTCOME_PENDING

## Test Plan

- \`worker/deno/tests/completion_phase_result_placeholder_test.ts\`
`;

/** The same summary once the token has been replaced with the actual outcome. */
const SUMMARY_WITH_TOKEN_RESOLVED = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

**Docs sweep** — grep: \`BrokerBalance\`; section: \`docs/reporting-api.md#decisions-report\`; no hits

**Branch outcomes:** none added

- Full \`./quality.sh\`: passed

## Test Plan

- \`worker/deno/tests/completion_phase_result_placeholder_test.ts\`
`;

/** A clean summary mentioning the token name only inside backticks (discussion, not a result). */
const SUMMARY_WITH_BACKTICK_ONLY_TOKEN = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

**Docs sweep** — grep: \`BrokerBalance\`; section: \`docs/reporting-api.md#decisions-report\`; no hits

**Branch outcomes:** none added

- Full \`./quality.sh\`: passed. The template placeholder for this line is \`QUALITY_RESULT_PLACEHOLDER\`, now filled in.

## Test Plan

- \`worker/deno/tests/completion_phase_result_placeholder_test.ts\`
`;

/** A summary carrying a bare token AND missing the docs-sweep line entirely. */
const SUMMARY_WITH_TOKEN_AND_NO_DOCS_SWEEP = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

- Full \`./quality.sh\`: QUALITY_RESULT_PLACEHOLDER

## Test Plan

- \`worker/deno/tests/completion_phase_result_placeholder_test.ts\`
`;

/**
 * A bug-labelled summary: the docs sweep is answered, but the reproduction
 * block is missing and a bare placeholder stands in for the gate result.
 * The reproduction gate is the earlier block, so the placeholder folds into it.
 */
const SUMMARY_BUG_MISSING_REPRO_WITH_TOKEN = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

**Docs sweep** — grep: \`BrokerBalance\`; section: \`docs/reporting-api.md#decisions-report\`; no hits

**Branch outcomes:** none added

- Full \`./quality.sh\`: QUALITY_RESULT_PLACEHOLDER

## Test Plan

- \`worker/deno/tests/completion_phase_result_placeholder_test.ts\`
`;

/** The same bug summary once both the reproduction block and the token are fixed. */
const SUMMARY_BUG_BOTH_FIXED = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

**Docs sweep** — grep: \`BrokerBalance\`; section: \`docs/reporting-api.md#decisions-report\`; no hits

**Branch outcomes:** none added

- Full \`./quality.sh\`: passed

## Reproduction

- **symptom** — the broker balance card showed a stale figure after a refill
- **status** — \`not-run\` — reason: the fault needs a live broker the container cannot reach
- **regression test** — \`worker/deno/tests/completion_phase_result_placeholder_test.ts\`

## Test Plan

- \`worker/deno/tests/completion_phase_result_placeholder_test.ts\`
`;

/** The same summary once BOTH the docs-sweep line and the token have been fixed. */
const SUMMARY_WITH_BOTH_FIXED = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

**Docs sweep** — grep: \`BrokerBalance\`; section: \`docs/reporting-api.md#decisions-report\`; no hits

**Branch outcomes:** none added

- Full \`./quality.sh\`: passed

## Test Plan

- \`worker/deno/tests/completion_phase_result_placeholder_test.ts\`
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
  /** The branch's changed files, as `git diff --name-only` reports them. */
  changedFiles: string;
  /** Whether the run's branch already carries an open PR. */
  prExistsForBranch?: boolean;
  /** Issue labels. Defaults to a non-bug enhancement, so only the placeholder gate applies. */
  issueLabels?: string[];
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  prCreateCalls: number;
  comments: string[];
}

/** Drive the live completion phase over a (possibly) blocked result-placeholder gate. */
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

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check the result-placeholder gate",
    issueBody: ISSUE_BODY,
    issueLabels: scenario.issueLabels ?? ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-result-placeholder`,
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
          return ok(scenario.changedFiles);
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (_options: { prompt: string }) => {
        claudeCalls++;
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
    prCreateCalls,
    comments,
  };
}

Deno.test(
  "completion - a bare result-placeholder token blocks PR creation and posts a comment",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_BARE_TOKEN,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "placeholder");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "QUALITY_RESULT_PLACEHOLDER");
  },
);

Deno.test(
  "completion - a token mentioned only inside backticks is not blocked",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_BACKTICK_ONLY_TOKEN,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0, "no recovery invocation needed");
    assertEquals(outcome.comments.length, 0);
  },
);

Deno.test(
  "completion - a clean summary with no placeholder token is not blocked",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_TOKEN_RESOLVED,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0);
    assertEquals(outcome.comments.length, 0);
  },
);

Deno.test(
  "completion - a bare token folds with the docs-sweep gate into one recovery turn",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_TOKEN_AND_NO_DOCS_SWEEP,
      retryWrites: SUMMARY_WITH_BOTH_FIXED,
      changedFiles: "crates/report/src/decisions.rs",
    });

    // Both gates fail on the first pass; the docs-sweep gate runs first in
    // the pipeline, so the fold is observed through its block, naming the
    // placeholder token too, and recovers in exactly one turn.
    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);

Deno.test(
  "completion - a bare token AND a missing docs-sweep line are both named in the one block (no earlier gate failing)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_TOKEN_AND_NO_DOCS_SWEEP,
      changedFiles: "crates/report/src/decisions.rs",
    });

    // Neither the closure, review nor reproduction gates apply here, so this
    // is caught by the standalone docs-sweep block — which must fold in the
    // placeholder verdict too, so the one recovery turn is told about both.
    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.reason ?? "", "Docs sweep");
    assertStringIncludes(outcome.reason ?? "", "placeholder");
    assertStringIncludes(outcome.comments[0]!, "Docs sweep");
    assertStringIncludes(outcome.comments[0]!, "QUALITY_RESULT_PLACEHOLDER");
  },
);

Deno.test(
  "completion - a bare token folds into the reproduction gate's one block (Issue #3124)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_BUG_MISSING_REPRO_WITH_TOKEN,
      issueLabels: ["bug", "work-on"],
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.reason ?? "", "Reproduction");
    assertStringIncludes(outcome.reason ?? "", "QUALITY_RESULT_PLACEHOLDER");
    assertStringIncludes(outcome.comments[0]!, "Reproduction");
    assertStringIncludes(outcome.comments[0]!, "QUALITY_RESULT_PLACEHOLDER");
  },
);

Deno.test(
  "completion - a recovery fixing the reproduction block and the placeholder raises the PR once (Issue #3124)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_BUG_MISSING_REPRO_WITH_TOKEN,
      retryWrites: SUMMARY_BUG_BOTH_FIXED,
      issueLabels: ["bug", "work-on"],
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "QUALITY_RESULT_PLACEHOLDER");
  },
);

Deno.test(
  "completion - the recovery replacing the token with the actual outcome raises the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_BARE_TOKEN,
      retryWrites: SUMMARY_WITH_TOKEN_RESOLVED,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);

Deno.test(
  "completion - a GATE_OUTCOME_PENDING result token blocks PR creation (Issue #3248)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_GATE_OUTCOME_PENDING,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "placeholder");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "GATE_OUTCOME_PENDING");
  },
);

Deno.test(
  "completion - a recovery replacing GATE_OUTCOME_PENDING with the actual outcome raises the PR (Issue #3248)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_GATE_OUTCOME_PENDING,
      retryWrites: SUMMARY_WITH_TOKEN_RESOLVED,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);
