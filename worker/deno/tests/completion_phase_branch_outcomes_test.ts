/**
 * Integration tests for the PR-summary branch-outcomes gate running in the
 * LIVE completion phase (Issue #3147).
 *
 * "Every outcome of a branch you add needs a test that reaches it" (rule
 * #3069) was prose only — nothing checked a `Branch outcomes:` list even
 * existed, let alone that a test it named was real. These tests drive
 * `workOnIssueCompletion` and assert on the observable outcome (whether
 * `gh pr create` was invoked, whether the in-run recovery fired, whether the
 * block was folded with another gate's), not on how the gate is called.
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
const ISSUE = 3147;
const PR_URL = `https://github.com/${REPO}/pull/4311`;
const EXISTING_TEST =
  "worker/deno/tests/completion_phase_branch_outcomes_test.ts";
const MISSING_TEST = "worker/deno/tests/does_not_exist_test.ts";

const ISSUE_BODY = `## Problem

Nothing checks the PR summary for a \`Branch outcomes:\` list.
`;

const DOCS_SWEEP_LINE =
  "**Docs sweep** — grep: `BrokerBalance`; section: `docs/reporting-api.md#decisions-report`; no hits";

function summaryWith(branchOutcomesBlock: string): string {
  return `## Summary

Changed the broker balance card. Closes #${ISSUE}.

${DOCS_SWEEP_LINE}
${branchOutcomesBlock}

## Test Plan

- \`${EXISTING_TEST}\`
`;
}

/** (a) Docs sweep present, no Branch outcomes list at all. */
const SUMMARY_NO_BRANCH_OUTCOMES = summaryWith("");

/** (b) Branch outcomes list names a test that does not exist at the head. */
const SUMMARY_WITH_MISSING_TEST = summaryWith(
  `
**Branch outcomes:**
- \`crates/report/src/decisions.rs:42\` — error — \`${MISSING_TEST}::rejects bad input\``,
);

/** (c) Branch outcomes list names only an existing test. */
const SUMMARY_WITH_EXISTING_TEST = summaryWith(
  `
**Branch outcomes:**
- \`crates/report/src/decisions.rs:42\` — error — \`${EXISTING_TEST}::rejects bad input\``,
);

/** (d) Honest negative. */
const SUMMARY_NONE_ADDED = summaryWith(`
**Branch outcomes:** none added`);

/**
 * (g) A bug-labelled summary missing BOTH the `## Reproduction` block AND
 * the `Branch outcomes:` list.
 */
const SUMMARY_BUG_MISSING_BOTH = summaryWith("");

/** (g) The same bug summary with both gaps fixed. */
const SUMMARY_BUG_BOTH_FIXED = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

${DOCS_SWEEP_LINE}

**Branch outcomes:**
- \`crates/report/src/decisions.rs:42\` — error — \`${EXISTING_TEST}::rejects bad input\`

## Reproduction

- **symptom** — the broker balance card showed a stale figure after a refill
- **status** — \`not-run\` — reason: the fault needs a live broker the container cannot reach
- **regression test** — \`${EXISTING_TEST}\`

## Test Plan

- \`${EXISTING_TEST}\`
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
  /** Test paths `ls-tree` reports as existing at HEAD. */
  existingTestsAtHead?: string[];
  /** Test paths `ls-tree` reports as existing at HEAD, for the retry's lookup. */
  existingTestsAtHeadAfterRetry?: string[];
  /** Make the `ls-tree` lookup fail (non-zero exit), simulating an unverifiable lookup. */
  lsTreeFails?: boolean;
  /** Issue labels. Defaults to a non-bug enhancement. */
  issueLabels?: string[];
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  prCreateCalls: number;
  comments: string[];
}

/** Drive the live completion phase over a (possibly) blocked branch-outcomes gate. */
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
  let retried = false;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check the branch-outcomes gate",
    issueBody: ISSUE_BODY,
    issueLabels: scenario.issueLabels ?? ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-branch-outcomes`,
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
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return ok(scenario.changedFiles);
        }
        if (cmdArgs[0] === "--literal-pathspecs" && cmdArgs[1] === "ls-tree") {
          if (scenario.lsTreeFails) return ok("", 1);
          const existing = retried
            ? scenario.existingTestsAtHeadAfterRetry ??
              scenario.existingTestsAtHead ?? []
            : scenario.existingTestsAtHead ?? [];
          return ok(existing.join("\n"));
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (_options: { prompt: string }) => {
        claudeCalls++;
        if (scenario.retryWrites !== undefined) {
          Deno.writeTextFileSync(summaryPath, scenario.retryWrites);
          retried = true;
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

// (a)
Deno.test(
  "completion - a code diff with no Branch outcomes list blocks PR creation",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_NO_BRANCH_OUTCOMES,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Branch outcomes");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "Branch outcomes not recorded");
  },
);

// (b)
Deno.test(
  "completion - a Branch outcomes list naming a test absent from HEAD blocks, naming the missing path",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_MISSING_TEST,
      changedFiles: "crates/report/src/decisions.rs",
      existingTestsAtHead: [EXISTING_TEST],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", MISSING_TEST);
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, MISSING_TEST);
  },
);

// (c)
Deno.test(
  "completion - a Branch outcomes list naming only an existing test raises the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_EXISTING_TEST,
      changedFiles: "crates/report/src/decisions.rs",
      existingTestsAtHead: [EXISTING_TEST],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0);
    assertEquals(outcome.comments.length, 0);
  },
);

// (d)
Deno.test(
  "completion - 'none added' raises the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_NONE_ADDED,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.comments.length, 0);
  },
);

// (e)
Deno.test(
  "completion - a docs-only diff with no Branch outcomes list raises the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_NO_BRANCH_OUTCOMES,
      changedFiles: "docs/guide.md",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.comments.length, 0);
  },
);

// (f)
Deno.test(
  "completion - in-run recovery: the first block, then a fixed retry summary, raises the PR after one claude call",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_NO_BRANCH_OUTCOMES,
      retryWrites: SUMMARY_WITH_EXISTING_TEST,
      changedFiles: "crates/report/src/decisions.rs",
      existingTestsAtHead: [EXISTING_TEST],
      existingTestsAtHeadAfterRetry: [EXISTING_TEST],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);

// (g)
Deno.test(
  "completion - a bug issue missing BOTH the Reproduction block and the Branch outcomes list names both in one block",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_BUG_MISSING_BOTH,
      issueLabels: ["bug", "work-on"],
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.reason ?? "", "Reproduction");
    assertStringIncludes(outcome.reason ?? "", "Branch outcomes");
    assertStringIncludes(outcome.comments[0]!, "Reproduction");
    assertStringIncludes(outcome.comments[0]!, "Branch outcomes not recorded");
  },
);

Deno.test(
  "completion - a recovery fixing both the Reproduction block and the Branch outcomes list raises the PR once",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_BUG_MISSING_BOTH,
      retryWrites: SUMMARY_BUG_BOTH_FIXED,
      issueLabels: ["bug", "work-on"],
      changedFiles: "crates/report/src/decisions.rs",
      existingTestsAtHead: [EXISTING_TEST],
      existingTestsAtHeadAfterRetry: [EXISTING_TEST],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);

// (h)
Deno.test(
  "completion - a failed ls-tree lookup with named tests blocks (fail closed)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_EXISTING_TEST,
      changedFiles: "crates/report/src/decisions.rs",
      lsTreeFails: true,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", "Branch outcomes");
    assertStringIncludes(outcome.comments[0]!, "could not confirm");
  },
);
