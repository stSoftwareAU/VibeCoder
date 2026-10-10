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
import {
  MAX_MUTATION_BUDGET_SECONDS,
  resolveMutationBudgetSeconds,
  workOnIssueCompletion,
} from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { MutationCheckResult } from "../lib/mutation_gate.ts";
import type { MutationRunInput } from "../lib/mutation_runner.ts";

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
  "**Docs sweep** — grep: `BrokerBalance`; section: `docs/reporting-api.md#decisions-report`; no hits";

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
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  prompts: string[];
  prCreateCalls: number;
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

  const comments: string[] = [];
  const prompts: string[] = [];
  const runnerInputs: MutationRunInput[] = [];
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

Deno.test("completion - a surviving mutant blocks the PR and names file:line and the mutation", async () => {
  const outcome = await runCompletion({ mutation: completed([SURVIVOR]) });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
  assertEquals(outcome.runnerInputs.length >= 1, true);
  assertStringIncludes(outcome.reason ?? "", "survived");
  assertEquals(outcome.claudeCalls, 1, "one in-run recovery turn");
  assertStringIncludes(outcome.prompts[0]!, `${CHANGED_FILE}:42`);
  assertStringIncludes(outcome.prompts[0]!, "negated if condition");
  assertEquals(outcome.comments.length, 1);
  assertStringIncludes(outcome.comments[0]!, `${CHANGED_FILE}:42`);
  assertStringIncludes(outcome.comments[0]!, "negated if condition");
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

Deno.test("completion - a runner error blocks the PR (fail closed)", async () => {
  const outcome = await runCompletion({
    mutation: { kind: "error", reason: "cargo mutants crashed" },
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0);
  assertStringIncludes(outcome.reason ?? "", "cargo mutants crashed");
});

Deno.test("completion - a throwing runner blocks the PR (fail closed)", async () => {
  const outcome = await runCompletion({ mutation: new Error("boom") });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0);
  assertStringIncludes(outcome.reason ?? "", "boom");
});

Deno.test("completion - an uncollectable PR diff blocks the PR and the runner is not called", async () => {
  const outcome = await runCompletion({
    mutation: completed([]),
    fullDiffFails: true,
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0);
  assertEquals(outcome.runnerInputs.length, 0);
  assertStringIncludes(outcome.reason ?? "", "could not collect the PR diff");
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

Deno.test("completion - a mutation survivor is folded into an earlier gate's block", async () => {
  // Branch-outcomes list missing AND a mutant survives: one block, both named.
  const outcome = await runCompletion({
    mutation: completed([SURVIVOR]),
    summary: SUMMARY.replace("**Branch outcomes:** none added\n", ""),
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.comments.length, 1);
  assertStringIncludes(outcome.comments[0]!, "Branch outcomes not recorded");
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

Deno.test("completion - a summary-only block keeps the documentation-only recovery prompt", async () => {
  const outcome = await runCompletion({
    mutation: completed([]),
    summary: SUMMARY.replace("**Branch outcomes:** none added\n", ""),
  });

  assertEquals(outcome.claudeCalls, 1);
  assertStringIncludes(outcome.prompts[0]!, "so do not change it.");
  assertEquals(
    outcome.prompts[0]!.includes("adding or strengthening tests"),
    false,
  );
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
