/**
 * Integration tests for the coverage carry-over gate running in the LIVE
 * completion phase (Issue #3795).
 *
 * A test the PR edits or removes may have been the only thing reaching a
 * line; if the PR leaves that line uncovered, nothing checks it any more.
 * These tests drive `workOnIssueCompletion` with a fake
 * `quality.runCoverageCarryOverCheck` and assert on the observable outcome
 * (whether `gh pr create` ran, what the recovery turn and issue comment
 * said, what the runner was given), not on how the gate is called.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CarriedLine,
  type CoverageCarryOverResult,
  DEFAULT_COVERAGE_CARRYOVER_BUDGET_SECONDS,
} from "../lib/coverage_carryover_gate.ts";
import type { CoverageCarryOverInput } from "../lib/coverage_carryover_runner.ts";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3795;
const PR_URL = `https://github.com/${REPO}/pull/4401`;
const CHANGED_FILE = "worker/deno/lib/example.ts";
const TEST_FILE = "worker/deno/tests/example_test.ts";
const UNCOVERED: CarriedLine = { file: CHANGED_FILE, line: 42 };
const DIFF_TEXT = `diff --git a/${TEST_FILE} b/${TEST_FILE}
+++ b/${TEST_FILE}
@@ -10,1 +10,0 @@
-  assertEquals(x, 1);
`;

const ISSUE_BODY =
  "## Problem\n\nA test edited by this PR no longer reaches a changed line.\n";

const DOCS_SWEEP_LINE =
  "**Docs sweep** — grep: `BrokerBalance`; section: `docs/reporting-api.md#decisions-report`; no hits; siblings: none — no existing set gained a member";

const SUMMARY = `## Summary

Changed the example test. Closes #${ISSUE}.

${DOCS_SWEEP_LINE}

**Branch outcomes:** none added

## Test Plan

- \`${TEST_FILE}\`
`;

const SUMMARY_WITH_EXEMPTION = `${SUMMARY}
\`${CHANGED_FILE}:42\` exempt (untestable): logging only
`;

const completed = (uncovered: CarriedLine[]): CoverageCarryOverResult => ({
  kind: "completed",
  changedTests: [TEST_FILE],
  carried: 3,
  uncovered,
});

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
  summary?: string;
  /**
   * Result the fake runner returns; an Error makes it throw. Omit to leave
   * the runner unwired.
   */
  coverage?: CoverageCarryOverResult | Error;
  /** Make every `git diff --unified=0` (the PR diff) fail. */
  fullDiffFails?: boolean;
  repoConfig?: Record<string, unknown>;
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  prompts: string[];
  prCreateCalls: number;
  comments: string[];
  runnerInputs: CoverageCarryOverInput[];
  /** The argument list of every `git diff --unified=0` the phase ran. */
  diffArgs: string[][];
  warnings: string[];
  infos: string[];
}

async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  const summaryPath =
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath, scenario.summary ?? SUMMARY);

  const comments: string[] = [];
  const prompts: string[] = [];
  const runnerInputs: CoverageCarryOverInput[] = [];
  const diffArgs: string[][] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  let prCreateCalls = 0;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;
  if (scenario.repoConfig) {
    config.repoConfig = { [REPO]: scenario.repoConfig };
  }

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check the coverage carry-over gate",
    issueBody: ISSUE_BODY,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-coverage-carryover`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const coverage = scenario.coverage;
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
          if (cmdArgs.includes("--diff-filter=ACMR")) return ok("");
          return ok(CHANGED_FILE);
        }
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--unified=0") {
          diffArgs.push([...cmdArgs]);
          return scenario.fullDiffFails ? ok("", 1) : ok(DIFF_TEXT);
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        prompts.push(options.prompt);
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
      ...(coverage === undefined ? {} : {
        runCoverageCarryOverCheck: (input: CoverageCarryOverInput) => {
          runnerInputs.push(input);
          return coverage instanceof Error
            ? Promise.reject(coverage)
            : Promise.resolve(coverage);
        },
      }),
    },
    logger: {
      debug: () => {},
      info: (message: string) => {
        infos.push(message);
      },
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
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
    claudeCalls: prompts.length,
    prompts,
    prCreateCalls,
    comments,
    runnerInputs,
    diffArgs,
    warnings,
    infos,
  };
}

Deno.test("completion - an uncovered carried line blocks the PR and names file:line", async () => {
  const outcome = await runCompletion({ coverage: completed([UNCOVERED]) });

  assertEquals(
    outcome.runnerInputs.length >= 1,
    true,
    "positive control: runner ran",
  );
  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
  assertEquals(outcome.claudeCalls, 1, "one in-run recovery turn");
  assertStringIncludes(outcome.prompts[0]!, `${CHANGED_FILE}:42`);
  assertEquals(outcome.comments.length, 1);
  assertStringIncludes(
    outcome.comments[0]!,
    "## Coverage carry-over: lines the edited or removed tests reached are untested",
  );
  assertStringIncludes(outcome.comments[0]!, `${CHANGED_FILE}:42`);
});

Deno.test("completion - the runner is given the --no-renames PR diff, the base and the default budget", async () => {
  const outcome = await runCompletion({ coverage: completed([]) });

  assertEquals(outcome.runnerInputs.length, 1);
  const input = outcome.runnerInputs[0]!;
  assertEquals(input.diff, DIFF_TEXT);
  assertEquals(input.budgetSeconds, DEFAULT_COVERAGE_CARRYOVER_BUDGET_SECONDS);
  assertEquals(input.base.length > 0, true, "base must be a non-empty ref");
  assertEquals(
    outcome.diffArgs.find((args) => args.includes("--no-renames")),
    ["diff", "--unified=0", "--no-renames", `${input.base}...HEAD`],
    `diff calls: ${JSON.stringify(outcome.diffArgs)}`,
  );
});

Deno.test("completion - an exempted uncovered line does not block", async () => {
  const outcome = await runCompletion({
    coverage: completed([UNCOVERED]),
    summary: SUMMARY_WITH_EXEMPTION,
  });

  assertEquals(outcome.runnerInputs.length, 1, "positive control: runner ran");
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(outcome.claudeCalls, 0);
});

Deno.test("completion - completed with no uncovered line raises the PR", async () => {
  const outcome = await runCompletion({ coverage: completed([]) });

  assertEquals(outcome.runnerInputs.length, 1, "positive control: runner ran");
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(outcome.claudeCalls, 0);
  assertEquals(outcome.comments.length, 0);
});

Deno.test("completion - budget exhausted raises the PR and warns", async () => {
  const outcome = await runCompletion({
    coverage: {
      kind: "budget_exhausted",
      changedTests: [TEST_FILE],
      budgetSeconds: DEFAULT_COVERAGE_CARRYOVER_BUDGET_SECONDS,
    },
  });

  assertEquals(outcome.runnerInputs.length, 1, "positive control: runner ran");
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(
    outcome.warnings.some((w) => w.toLowerCase().includes("budget")),
    true,
    `warnings: ${JSON.stringify(outcome.warnings)}`,
  );
});

Deno.test("completion - a runner error blocks the PR (fail closed)", async () => {
  const outcome = await runCompletion({
    coverage: { kind: "error", reason: "coverage tests crashed" },
  });

  assertEquals(
    outcome.runnerInputs.length >= 1,
    true,
    "positive control: runner ran",
  );
  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0);
  assertStringIncludes(outcome.reason ?? "", "coverage tests crashed");
});

Deno.test("completion - a throwing runner blocks the PR (fail closed)", async () => {
  const outcome = await runCompletion({ coverage: new Error("boom") });

  assertEquals(
    outcome.runnerInputs.length >= 1,
    true,
    "positive control: runner ran",
  );
  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0);
  assertStringIncludes(outcome.reason ?? "", "boom");
});

Deno.test("completion - an uncollectable PR diff blocks the PR and the runner is not called", async () => {
  const outcome = await runCompletion({
    coverage: completed([]),
    fullDiffFails: true,
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0);
  assertEquals(outcome.runnerInputs.length, 0, "runner must not run");
  assertStringIncludes(outcome.reason ?? "", "could not collect the PR diff");
  assertEquals(
    outcome.warnings.some((w) =>
      w.includes(
        "Could not collect the PR diff for the coverage carry-over check",
      )
    ),
    true,
    `warnings: ${JSON.stringify(outcome.warnings)}`,
  );
});

Deno.test("completion - skip_coverage_carryover_check never calls the runner and raises the PR", async () => {
  const outcome = await runCompletion({
    coverage: completed([UNCOVERED]),
    repoConfig: { skipCoverageCarryOverCheck: true },
  });

  assertEquals(outcome.runnerInputs.length, 0, "runner must not run");
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(
    outcome.infos.some((m) =>
      m.includes(
        "coverage carry-over check skipped by skip_coverage_carryover_check",
      )
    ),
    true,
    `infos: ${JSON.stringify(outcome.infos)}`,
  );
});

Deno.test("completion - an unwired runner does not block", async () => {
  const outcome = await runCompletion({});

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(
    outcome.warnings.some((w) =>
      w.includes("Coverage carry-over runner not wired")
    ),
    true,
    `warnings: ${JSON.stringify(outcome.warnings)}`,
  );
});
