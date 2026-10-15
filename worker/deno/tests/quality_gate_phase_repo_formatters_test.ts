/**
 * The repository's formatters run before each local quality-gate attempt
 * (part of #2932, building on #2967).
 *
 * A formatting-only `./quality.sh` failure used to cost a whole agent
 * remediation round. The phase now runs the formatters over the branch's
 * changed files first; a formatter that fails or throws never fails the
 * phase on its own — the gate still runs and still reports the problem.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { CheckResult } from "../lib/quality_helpers.ts";

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 2932,
    issueTitle: "Format before the gate",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-2932",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    baselineFailedChecks: [],
  };
}

function gate(passed: boolean) {
  return Promise.resolve({
    ok: true as const,
    value: {
      checks: (passed
        ? []
        : [{ name: "deno test", status: "FAILED" }]) as CheckResult[],
      summary: { text: passed ? "passed" : "failed", passed },
      passed,
      output: passed ? "All checks passed" : "deno test failed",
    },
  });
}

function makeDeps(
  outcomes: boolean[],
  format: () => Promise<unknown>,
  order: string[],
) {
  let call = 0;
  return createMockDeps({
    quality: {
      runQualityGate: () => {
        order.push("gate");
        return gate(outcomes[call++] ?? false);
      },
      collectDiffableGateFindings: () => Promise.resolve([]),
    },
    git: {
      formatBranchChanges: (async (_repo: string, baseRef?: string) => {
        order.push(`format:${baseRef}`);
        return await format();
      }) as never,
    },
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({ ok: true, value: { output: "fixed" } })) as never,
    },
  });
}

const noChange = () =>
  Promise.resolve({ runs: [], failures: [], committed: false });

Deno.test("quality gate - formatters run against the PR base before every gate attempt", async () => {
  const order: string[] = [];
  const result = await workOnIssueQualityGate(
    makeContext(),
    makeState(),
    makeDeps([false, true], noChange, order),
  );
  assertEquals(result.status, "continue");
  assertEquals(order, [
    "format:origin/main",
    "gate",
    "format:origin/main",
    "gate",
  ]);
});

Deno.test("quality gate - a formatter that throws never fails the phase; the gate still decides", async () => {
  const order: string[] = [];
  const passing = await workOnIssueQualityGate(
    makeContext(),
    makeState(),
    makeDeps([true], () => Promise.reject(new Error("boom")), order),
  );
  assertEquals(passing.status, "continue");
  assertEquals(order, ["format:origin/main", "gate"]);

  // Opposite direction: the formatters cannot wave a real failure through.
  const failing = await workOnIssueQualityGate(
    makeContext(),
    makeState(),
    makeDeps([false, false], noChange, []),
  );
  assertEquals(failing.status, "failure");
});
