/**
 * Integration tests for the diff-scoped mutation gate running in the LIVE
 * completion phase (Issue #3393).
 *
 * A changed line whose mutant survives the repository's tests is a change
 * nothing checks. These tests drive `workOnIssueCompletion` with a fake
 * `quality.runMutationCheck` and assert on the observable outcome (whether
 * `gh pr create` ran, what the recovery turn and issue comment said), not on
 * how the gate is called.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import {
  MAX_MUTATION_BUDGET_SECONDS,
  resolveMutationBudgetSeconds,
} from "../lib/mutation_check_invocation.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import { planCodingFailure } from "../lib/coding_failure_ladder.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  MUTATION_TEMP_DIR_UNWRITABLE,
  type MutationCheckResult,
} from "../lib/mutation_gate.ts";
import type { MutationRunInput } from "../lib/mutation_runner.ts";
import { DRAFT_CONTINUATION_MARKER } from "../lib/draft_continuation_pr.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3393;
const PR_URL = `https://github.com/${REPO}/pull/4400`;
const CHANGED_FILE = "worker/deno/lib/example.ts";
const SURVIVOR = {
  file: CHANGED_FILE,
  line: 42,
  description: "negated if condition",
};
const DIFF_TEXT = `diff --git a/${CHANGED_FILE} b/${CHANGED_FILE}
+++ b/${CHANGED_FILE}
@@ -41,0 +42,1 @@
+  if (x) return 1;
`;

const ISSUE_BODY = "## Problem\n\nChanged lines are not pinned by tests.\n";

const DOCS_SWEEP_LINE =
  "**Docs sweep** — grep: `BrokerBalance`; section: `docs/reporting-api.md#decisions-report`; no hits; siblings: none — no existing set gained a member";

const SUMMARY = `## Summary

Changed the example. Closes #${ISSUE}.

${DOCS_SWEEP_LINE}

**Branch outcomes:** none added

## Test Plan

- \`worker/deno/tests/example_test.ts\`
`;

const SUMMARY_WITH_EXEMPTION = `${SUMMARY}
\`${CHANGED_FILE}:42\` exempt (untestable): logging only
`;

/** A PR-triggered CI job that runs the mutation tool and can fail (Issue #4617). */
const CI_BLOCKING_WORKFLOW = `name: mutants
on: pull_request
jobs:
  mutants:
    runs-on: ubuntu-latest
    steps:
      - run: cargo mutants --in-diff x
`;

/** The same job, marked `continue-on-error`, so CI cannot fail on it. */
const CI_CONTINUE_ON_ERROR_WORKFLOW = `name: mutants
on: pull_request
jobs:
  mutants:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: cargo mutants --in-diff x
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
  summary?: string;
  /** Result the fake runner returns; omit to leave the runner unwired. */
  mutation?: MutationCheckResult | Error;
  /** Make every full `git diff` (the mutation diff) fail. */
  fullDiffFails?: boolean;
  repoConfig?: Record<string, unknown>;
  /** Written as `.github/workflows/mutants.yml` before the run (Issue #4617). */
  workflow?: string;
  /** The branch already has an open PR, so the existing-PR path runs. */
  existingPrForBranch?: boolean;
  /** `gh pr create` fails on the primary quota, so the REST fallback opens the PR (Issue #4617). */
  prCreateRateLimited?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  category?: string;
  categories?: readonly string[];
  claudeCalls: number;
  prompts: string[];
  prCreateCalls: number;
  /** Every `gh` call's arguments, in order. */
  ghCalls: string[][];
  /** How often auto-merge was armed through `deps.pr.finalisePr`. */
  finalisePrCalls: number;
  comments: string[];
  runnerInputs: MutationRunInput[];
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
  if (scenario.workflow !== undefined) {
    await Deno.mkdir(`${repoPath}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${repoPath}/.github/workflows/mutants.yml`,
      scenario.workflow,
    );
  }

  const comments: string[] = [];
  const prompts: string[] = [];
  const runnerInputs: MutationRunInput[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const ghCalls: string[][] = [];
  let prCreateCalls = 0;
  let finalisePrCalls = 0;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;
  if (scenario.repoConfig) {
    config.repoConfig = { [REPO]: scenario.repoConfig };
  }

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check the mutation gate",
    issueBody: ISSUE_BODY,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-mutation`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const mutation = scenario.mutation;
  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(comments),
      runGhCommand: (args: string[]) => {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "create") {
          prCreateCalls++;
          if (scenario.prCreateRateLimited) {
            return Promise.reject(
              new Error("GraphQL: API rate limit exceeded for user ID 1."),
            );
          }
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
      ...(mutation === undefined ? {} : {
        runMutationCheck: (input: MutationRunInput) => {
          runnerInputs.push(input);
          return mutation instanceof Error
            ? Promise.reject(mutation)
            : Promise.resolve(mutation);
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
        scenario.existingPrForBranch
          ? Promise.resolve({ ok: true as const, value: PR_URL })
          : Promise.resolve({ ok: false as const, error: new Error("none") }),
      recoverExistingPr: () =>
        Promise.resolve({ ok: true, value: "recovered" }),
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
    category: result.status === "failure" || result.status === "early_exit"
      ? result.category
      : undefined,
    categories: result.status === "failure" ? result.categories : undefined,
    claudeCalls: prompts.length,
    prompts,
    prCreateCalls,
    ghCalls,
    finalisePrCalls,
    comments,
    runnerInputs,
    warnings,
    infos,
  };
}

const completed = (survivors: typeof SURVIVOR[]): MutationCheckResult => ({
  kind: "completed",
  language: "deno",
  survivors,
  killed: 3 - survivors.length,
  total: 3,
});

Deno.test("completion - a surviving mutant is noted and the PR is still raised", async () => {
  const outcome = await runCompletion({ mutation: completed([SURVIVOR]) });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(outcome.runnerInputs.length >= 1, true);
  assertEquals(outcome.claudeCalls, 1, "one in-session note");
  assertStringIncludes(outcome.prompts[0]!, `${CHANGED_FILE}:42`);
  assertStringIncludes(outcome.prompts[0]!, "negated if condition");
  assertEquals(outcome.comments.length, 1);
  assertStringIncludes(outcome.comments[0]!, `${CHANGED_FILE}:42`);
  assertStringIncludes(outcome.comments[0]!, "negated if condition");
  assertStringIncludes(outcome.comments[0]!, "auto-merge stays armed");
  // The gate is advisory, so its log line must not say it blocked the PR (Issue #4579).
  assertEquals(
    outcome.warnings.includes("Mutation gate reported findings"),
    true,
    `warnings: ${JSON.stringify(outcome.warnings)}`,
  );
  assertEquals(
    outcome.warnings.some((w) => w.includes("blocked PR creation")),
    false,
    `warnings: ${JSON.stringify(outcome.warnings)}`,
  );
});

Deno.test("completion - the runner is given the PR diff and the default budget", async () => {
  const outcome = await runCompletion({ mutation: completed([]) });

  assertEquals(outcome.runnerInputs.length, 1);
  assertEquals(outcome.runnerInputs[0]!.diff, DIFF_TEXT);
  assertEquals(outcome.runnerInputs[0]!.budgetSeconds, 300);
});

Deno.test("completion - mutation_check_budget_seconds overrides the budget", async () => {
  const outcome = await runCompletion({
    mutation: completed([]),
    repoConfig: { mutationCheckBudgetSeconds: 90 },
  });

  assertEquals(outcome.runnerInputs[0]!.budgetSeconds, 90);
});

Deno.test("completion - an exempted survivor does not block", async () => {
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    summary: SUMMARY_WITH_EXEMPTION,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
});

Deno.test("completion - all mutants killed raises the PR", async () => {
  const outcome = await runCompletion({ mutation: completed([]) });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(outcome.claudeCalls, 0);
  assertEquals(outcome.comments.length, 0);
});

Deno.test("completion - budget exhausted with no survivor raises the PR and warns", async () => {
  const outcome = await runCompletion({
    mutation: {
      kind: "budget_exhausted",
      language: "deno",
      survivors: [],
      killed: 1,
      tested: 1,
      total: 5,
      budgetSeconds: 300,
    },
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(
    outcome.warnings.some((w) => w.includes("mutation budget exhausted")),
    true,
    `warnings: ${JSON.stringify(outcome.warnings)}`,
  );
});

Deno.test("completion - a runner error is noted and the PR is still raised", async () => {
  const outcome = await runCompletion({
    mutation: { kind: "error", reason: "cargo mutants crashed" },
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertStringIncludes(outcome.comments[0] ?? "", "cargo mutants crashed");
});

Deno.test("completion - a throwing runner is noted and the PR is still raised", async () => {
  const outcome = await runCompletion({ mutation: new Error("boom") });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertStringIncludes(outcome.comments[0] ?? "", "boom");
});

Deno.test("completion - an unwritable mutation temp dir is noted as a worker fault, not a quality failure, and the PR is still raised", async () => {
  // Issue #4127 classifies an unwritable temp directory as a worker fault.
  // Issue #4319 then notes a completion-gate finding and still raises the
  // pull request, so the issue is not failed as a quality failure.
  const outcome = await runCompletion({
    mutation: {
      kind: "error",
      reason:
        `${MUTATION_TEMP_DIR_UNWRITABLE}: Permission denied (os error 13): tmpdir`,
    },
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(outcome.category, undefined);
  assertEquals(outcome.claudeCalls, 1, "one in-session note");
  assertEquals(outcome.comments.length, 1);
  assertStringIncludes(
    outcome.comments[0]!,
    "## Mutation check: could not run (worker fault)",
  );
  assertStringIncludes(outcome.comments[0]!, MUTATION_TEMP_DIR_UNWRITABLE);
  assertEquals(
    outcome.comments[0]!.includes(
      "## Mutation check: changed lines are not pinned",
    ),
    false,
  );
  assertStringIncludes(outcome.comments[0]!, "auto-merge stays armed");
});

Deno.test("completion - a read-only mutation filesystem stops as infrastructure without charging the issue", async () => {
  // Issue #4360 stops on host-disk fallout before the informational mutation
  // path from #4127/#4319. A generic temp-directory permission error still
  // takes that informational path in the preceding test.
  const reason =
    `${MUTATION_TEMP_DIR_UNWRITABLE}: Read-only file system (os error 30): tmpdir`;
  const outcome = await runCompletion({ mutation: { kind: "error", reason } });
  assertEquals(outcome.status, "failure");
  assertEquals(outcome.category, "internal_error");
  assertEquals(outcome.reason, reason);
  assertEquals(outcome.prCreateCalls, 0);
  assertEquals(outcome.claudeCalls, 0);
  assertEquals(outcome.comments, []);
  const plan = planCodingFailure({
    success: false,
    expectedSkip: false,
    category: "internal_error",
    reason,
  });
  assertEquals(
    plan.applyLadder,
    false,
    "host-disk fallout must not charge the issue",
  );
});

Deno.test("completion - an uncollectable PR diff is noted and the runner is not called", async () => {
  const outcome = await runCompletion({
    mutation: completed([]),
    fullDiffFails: true,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(outcome.runnerInputs.length, 0);
  assertStringIncludes(
    outcome.comments[0] ?? "",
    "could not collect the PR diff",
  );
});

Deno.test("completion - skip_mutation_check never calls the runner", async () => {
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    repoConfig: { skipMutationCheck: true },
  });

  assertEquals(outcome.runnerInputs.length, 0);
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
});

Deno.test("completion - an unwired runner does not block", async () => {
  const outcome = await runCompletion({});

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(
    outcome.warnings.some((w) => w.includes("Mutation runner not wired")),
    true,
  );
});

Deno.test("completion - a mutation survivor is named on the pull request", async () => {
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    summary: SUMMARY.replace("**Branch outcomes:** none added\n", ""),
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(outcome.comments.length, 1);
  assertEquals(
    outcome.comments[0]!.includes("Branch outcomes not recorded"),
    false,
  );
  assertStringIncludes(outcome.comments[0]!, `${CHANGED_FILE}:42`);
});

Deno.test("completion - the recovery turn for a mutation survivor is allowed to change tests", async () => {
  const outcome = await runCompletion({ mutation: completed([SURVIVOR]) });

  assertEquals(outcome.claudeCalls, 1);
  const prompt = outcome.prompts[0]!;
  assertStringIncludes(prompt, "adding or strengthening tests");
  // The documentation-only wording would leave an exemption as the way out.
  assertEquals(prompt.includes("so do not change it."), false);
});

Deno.test("completion - a survivor folded into another gate's block still lets the recovery turn change tests", async () => {
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    summary: SUMMARY.replace("**Branch outcomes:** none added\n", ""),
  });

  assertStringIncludes(outcome.prompts[0]!, "adding or strengthening tests");
  assertEquals(outcome.prompts[0]!.includes("so do not change it."), false);
});

Deno.test("completion - a not-applicable mutation check is logged with its reason", async () => {
  const outcome = await runCompletion({
    mutation: { kind: "not_applicable", reason: "no Deno project found" },
  });

  assertEquals(outcome.status, "continue");
  assertEquals(
    outcome.infos.some((m) =>
      m.includes("mutation check not applicable: no Deno project found")
    ),
    true,
    outcome.infos.join(" | "),
  );
});

Deno.test("completion - a capped mutation run warns that mutants were left untested", async () => {
  const outcome = await runCompletion({
    mutation: {
      kind: "budget_exhausted",
      language: "deno",
      survivors: [],
      killed: 40,
      tested: 40,
      total: 55,
      budgetSeconds: 300,
      limit: "mutant_cap",
    },
  });

  assertEquals(outcome.status, "continue");
  assertEquals(
    outcome.warnings.some((w) => w.includes("mutation cap reached: 40 of 55")),
    true,
  );
});

Deno.test("resolveMutationBudgetSeconds - default, valid and invalid values", () => {
  const warned: string[] = [];
  const warn = (m: string) => warned.push(m);
  assertEquals(resolveMutationBudgetSeconds("", warn), 300);
  assertEquals(resolveMutationBudgetSeconds("120", warn), 120);
  assertEquals(warned.length, 0);
  for (
    const bad of [
      "0",
      "-5",
      "1.5",
      "abc",
      "NaN",
      `${MAX_MUTATION_BUDGET_SECONDS + 1}`,
    ]
  ) {
    assertEquals(resolveMutationBudgetSeconds(bad, warn), 300, bad);
  }
  assertEquals(warned.length, 6);
  assertEquals(
    resolveMutationBudgetSeconds(`${MAX_MUTATION_BUDGET_SECONDS}`, warn),
    MAX_MUTATION_BUDGET_SECONDS,
  );
});

Deno.test("completion - a declared quality credential reaches the mutation runner and an undeclared one does not", async () => {
  const declared = await runCompletion({
    mutation: completed([]),
    repoConfig: {
      qualityCredentials: { mint: "printf 'DECLARED_KEY=minted\\n'" },
    },
  });
  assertEquals(declared.runnerInputs.length, 1);
  assertEquals(declared.runnerInputs[0]!.credentialEnv, {
    DECLARED_KEY: "minted",
  });

  const undeclared = await runCompletion({ mutation: completed([]) });
  assertEquals(undeclared.runnerInputs[0]!.credentialEnv, {});
});

Deno.test("completion - a failed credential mint is not applicable with a warning, never a run without them", async () => {
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    repoConfig: { qualityCredentials: { mint: "exit 7" } },
  });

  assertEquals(outcome.runnerInputs.length, 0, "runner must not run");
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(
    outcome.warnings.some((w) => w.includes("quality_credentials")),
    true,
  );
  assertEquals(
    outcome.infos.some((i) => i.includes("quality_credentials")),
    true,
  );
});

// ---------------------------------------------------------------------------
// A repository whose CI blocks on a mutants job (Issue #4617)
// ---------------------------------------------------------------------------

/** The arguments of the one `gh pr create` call, asserted present. */
function createCall(outcome: Outcome): string[] {
  const call = outcome.ghCalls.find((args) =>
    args[0] === "pr" && args[1] === "create"
  );
  assertEquals(call !== undefined, true, "a gh pr create call");
  return call ?? [];
}

/** The value after `flag` in a `gh` call, or "" when absent. */
function flagValue(args: string[], flag: string): string {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] ?? "" : "";
}

/** Every `gh pr <verb>` call. */
function prVerbCalls(outcome: Outcome, verb: string): string[][] {
  return outcome.ghCalls.filter((args) => args[0] === "pr" && args[1] === verb);
}

Deno.test("completion - a survivor the repository's CI blocks on holds the PR as a draft", async () => {
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    workflow: CI_BLOCKING_WORKFLOW,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.claudeCalls, 1, "one in-session recovery turn");
  assertStringIncludes(outcome.prompts[0]!, `${CHANGED_FILE}:42`);
  assertStringIncludes(outcome.prompts[0]!, "CI job 'mutants'");
  assertEquals(outcome.prCreateCalls, 1);
  const create = createCall(outcome);
  assertEquals(create.includes("--draft"), true, "raised as a draft");
  const body = flagValue(create, "--body");
  assertStringIncludes(body, DRAFT_CONTINUATION_MARKER);
  assertStringIncludes(body, "validation incomplete");
  assertStringIncludes(body, "Part of #3393");
  assertEquals(
    body.includes("Closes #3393"),
    false,
    "no closing keyword in the held body",
  );
  assertEquals(
    prVerbCalls(outcome, "merge").length,
    0,
    "auto-merge is not armed",
  );
  assertEquals(outcome.finalisePrCalls, 0, "finalisePr is never called");
  assertEquals(outcome.comments.length, 1);
  assertStringIncludes(outcome.comments[0]!, "could not finish validation");
  assertEquals(
    outcome.comments[0]!.includes("auto-merge stays armed"),
    false,
  );
});

Deno.test("completion - a summary exemption does not clear a survivor the repository's CI blocks on", async () => {
  const held = await runCompletion({
    mutation: completed([SURVIVOR]),
    summary: SUMMARY_WITH_EXEMPTION,
    workflow: CI_BLOCKING_WORKFLOW,
  });

  assertEquals(held.prCreateCalls, 1);
  assertEquals(createCall(held).includes("--draft"), true);
  assertEquals(held.finalisePrCalls, 0);

  // Positive control: the same summary with no blocking CI job raises a ready
  // PR, so the exemption is what clears the survivor there.
  const ready = await runCompletion({
    mutation: completed([SURVIVOR]),
    summary: SUMMARY_WITH_EXEMPTION,
  });

  assertEquals(ready.prCreateCalls, 1);
  assertEquals(createCall(ready).includes("--draft"), false);
  assertEquals(ready.claudeCalls, 0);
  assertEquals(ready.finalisePrCalls, 1, "auto-merge is armed");
});

Deno.test("completion - a CI-blocking mutants job with every mutant killed raises a ready PR and arms it", async () => {
  const outcome = await runCompletion({
    mutation: completed([]),
    workflow: CI_BLOCKING_WORKFLOW,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.claudeCalls, 0);
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(createCall(outcome).includes("--draft"), false);
  assertEquals(outcome.finalisePrCalls, 1, "auto-merge is armed");
  assertEquals(outcome.comments.length, 0);
});

Deno.test("completion - a runner error with a blocking CI job is noted, unvalidated, and the PR is raised ready", async () => {
  const outcome = await runCompletion({
    mutation: { kind: "error", reason: "cargo mutants crashed" },
    workflow: CI_BLOCKING_WORKFLOW,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(createCall(outcome).includes("--draft"), false);
  assertStringIncludes(outcome.comments[0] ?? "", "unvalidated, not passed");
});

Deno.test("completion - a CI mutants job marked continue-on-error does not hold the PR", async () => {
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    workflow: CI_CONTINUE_ON_ERROR_WORKFLOW,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.claudeCalls, 1, "one in-session note");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(createCall(outcome).includes("--draft"), false);
  assertEquals(outcome.comments.length, 1);
  assertStringIncludes(outcome.comments[0]!, "auto-merge stays armed");
});

Deno.test("completion - a held survivor on an existing PR converts it to a draft and never marks it ready", async () => {
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    workflow: CI_BLOCKING_WORKFLOW,
    existingPrForBranch: true,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 0);
  const ready = prVerbCalls(outcome, "ready");
  assertEquals(
    ready.some((args) => args.includes("--undo")),
    true,
    "the existing PR is turned back into a draft",
  );
  assertEquals(
    ready.some((args) => !args.includes("--undo")),
    false,
    "the existing PR is never marked ready",
  );
  assertEquals(prVerbCalls(outcome, "merge").length, 0);
  assertEquals(outcome.finalisePrCalls, 0);
});

Deno.test("completion - a held PR the REST fallback opens is converted to a draft and not armed", async () => {
  // gh cannot open a draft on the primary quota, so the REST pulls endpoint
  // raises the PR ready-for-review; the held PR must be turned back into a draft.
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    workflow: CI_BLOCKING_WORKFLOW,
    prCreateRateLimited: true,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1, "gh pr create was attempted");
  assertEquals(
    outcome.ghCalls.some((args) =>
      args[0] === "api" && args.includes(`repos/${REPO}/pulls`)
    ),
    true,
    "the PR was opened through the REST fallback",
  );
  const ready = prVerbCalls(outcome, "ready");
  assertEquals(
    ready.some((args) => args.includes("--undo")),
    true,
    "the REST-opened PR is turned back into a draft",
  );
  assertEquals(
    ready.some((args) => !args.includes("--undo")),
    false,
    "the held PR is never marked ready",
  );
  const edits = prVerbCalls(outcome, "edit");
  assertEquals(
    edits.some((args) =>
      flagValue(args, "--body").includes(DRAFT_CONTINUATION_MARKER)
    ),
    true,
    "the PR body carries the hold marker",
  );
  assertEquals(
    prVerbCalls(outcome, "merge").length,
    0,
    "auto-merge is not armed",
  );
  assertEquals(outcome.finalisePrCalls, 0, "finalisePr is never called");
});
