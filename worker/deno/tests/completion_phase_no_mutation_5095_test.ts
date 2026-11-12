/**
 * The live completion phase runs no automatic mutation testing (Issue #5095).
 *
 * The owner rejected automatic mutation testing, so completion no longer runs
 * `cargo mutants` or reads the repository's CI for a mutants job. A PR-triggered,
 * blocking mutants job therefore neither holds the pull request as a draft nor
 * spends a recovery turn. These tests drive `workOnIssueCompletion` and assert
 * on what the fakes observed: the PR that was created, the comments posted, and
 * every command recorded by the fakes.
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
const ISSUE = 5095;
const PR_URL = `https://github.com/${REPO}/pull/5101`;
const CHANGED_FILE = "worker/deno/lib/example.ts";
const DIFF_TEXT = `diff --git a/${CHANGED_FILE} b/${CHANGED_FILE}
+++ b/${CHANGED_FILE}
@@ -41,0 +42,1 @@
+  if (x) return 1;
`;

const ISSUE_BODY =
  "## Problem\n\nThe completion phase runs an extra test gate.\n";

const DOCS_SWEEP_LINE =
  "**Docs sweep** — grep: `BrokerBalance`; section: `docs/reporting-api.md#decisions-report`; no hits; siblings: none — no existing set gained a member";

const SUMMARY = `## Summary

Changed the example. Closes #${ISSUE}.

${DOCS_SWEEP_LINE}

**Branch outcomes:** none added

## Test Plan

- \`worker/deno/tests/example_test.ts\`
`;

/** A PR-triggered, blocking CI job that runs the mutation tool. */
const CI_BLOCKING_MUTANTS_WORKFLOW = `name: mutants
on: pull_request
jobs:
  mutants:
    runs-on: ubuntu-latest
    steps:
      - run: cargo mutants --in-diff x
`;

/** Matches any mention of the retired mutation testing in observable text. */
const MUTATION_TEXT = /mutation|mutant/i;

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
  /** Written as `.github/workflows/mutants.yml` before the run. */
  workflow?: string;
  /** Issue labels; the default is an ordinary, non-security issue. */
  labels?: string[];
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  prompts: string[];
  prCreateCalls: number;
  /** The arguments of `gh pr create`, when it ran. */
  createArgs?: string[];
  recoveredBodies: string[];
  /** Every `gh` call's arguments, in order. */
  ghCalls: string[][];
  /** Every git command's arguments, in order. */
  gitCalls: string[][];
  /** How often auto-merge was armed through `deps.pr.finalisePr`. */
  finalisePrCalls: number;
  comments: string[];
  warnings: string[];
  mutationCalls: number;
}

async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  const summaryPath =
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath, SUMMARY);
  if (scenario.workflow !== undefined) {
    await Deno.mkdir(`${repoPath}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${repoPath}/.github/workflows/mutants.yml`,
      scenario.workflow,
    );
  }

  const comments: string[] = [];
  const recoveredBodies: string[] = [];
  const prompts: string[] = [];
  const warnings: string[] = [];
  const ghCalls: string[][] = [];
  const gitCalls: string[][] = [];
  let createArgs: string[] | undefined;
  let prCreateCalls = 0;
  let finalisePrCalls = 0;
  let mutationCalls = 0;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Retire automatic mutation testing",
    issueBody: ISSUE_BODY,
    issueLabels: scenario.labels ?? ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-retire-testing`,
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
        ghCalls.push(args);
        if (args[0] === "api" && args[1]?.includes("rules/branches/")) {
          return Promise.resolve(JSON.stringify([[{
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "mutants" }] },
          }]]));
        }
        if (args[0] === "api" && args[1]?.includes("/branches/")) {
          return Promise.resolve(
            JSON.stringify({ protection: { enabled: false } }),
          );
        }
        if (args[0] === "pr" && args[1] === "create") {
          prCreateCalls++;
          createArgs = args;
        }
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(
            JSON.stringify({ state: "OPEN", isDraft: false }),
          );
        }
        return Promise.resolve(PR_URL);
      },
    },
    git: {
      runGitCommand: (
        cmdArgs: string[],
      ): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
        gitCalls.push(cmdArgs);
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
          return ok(DIFF_TEXT);
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
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
    },
    pr: {
      recoverExistingPr: (_repo, _issue, _url, body) => {
        recoveredBodies.push(body ?? "");
        return Promise.resolve({ ok: true as const, value: "recovered" });
      },
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false as const, error: new Error("none") }),
      finalisePr: () => {
        finalisePrCalls++;
        return Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        });
      },
    },
  });

  // Trap the retired external operation even if an invocation is restored.
  Object.assign(deps.quality, {
    runMutationCheck: () => {
      mutationCalls++;
      throw new Error("automatic mutation runner must stay retired");
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
    createArgs,
    recoveredBodies,
    ghCalls,
    gitCalls,
    finalisePrCalls,
    comments,
    warnings,
    mutationCalls,
  };
}

function flagValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? "" : args[index + 1] ?? "";
}

function assertNoMutationTesting(outcome: Outcome): void {
  assertEquals(outcome.mutationCalls, 0, "no local mutation runner is invoked");
  const texts = [
    ...outcome.comments,
    ...outcome.recoveredBodies,
    ...outcome.warnings,
    ...outcome.prompts,
    flagValue(outcome.createArgs ?? [], "--body"),
  ];
  for (const text of texts) {
    assertEquals(
      MUTATION_TEXT.test(text),
      false,
      `no mutation text is posted or logged: ${text.slice(0, 200)}`,
    );
  }
}

Deno.test("completion - a PR-triggered blocking mutants job in CI neither drafts the PR nor spends a recovery turn (Issue #5095)", async () => {
  const outcome = await runCompletion({
    workflow: CI_BLOCKING_MUTANTS_WORKFLOW,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1, "the PR is created");
  assertEquals(outcome.claudeCalls, 0, "no recovery turn is spent");
  const create = outcome.createArgs ?? [];
  assertEquals(create.includes("--draft"), false, "the PR is not a draft");
  assertEquals(
    outcome.ghCalls.some((args) =>
      args[0] === "pr" && args[1] === "ready" && args.includes("--undo")
    ),
    false,
    "the PR is never converted to a draft",
  );
  assertEquals(
    outcome.finalisePrCalls,
    1,
    "auto-merge is armed as for any ready PR",
  );
  assertEquals(
    outcome.ghCalls.some((args) =>
      args[0] === "api" && args.includes(".draft")
    ),
    false,
    "a newly created ready PR needs no REST-fallback draft check",
  );
  assertNoMutationTesting(outcome);
});

Deno.test("completion - the same mutants fixture still stops PR creation when a security-fix gate fails (Issue #5095)", async () => {
  const outcome = await runCompletion({
    workflow: CI_BLOCKING_MUTANTS_WORKFLOW,
    labels: ["security", "work-on"],
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
  assertStringIncludes(outcome.reason ?? "", "PR creation blocked");
  assertEquals(outcome.comments.length, 1);
  assertStringIncludes(outcome.comments[0]!, "PR creation blocked");
  assertNoMutationTesting(outcome);
});
