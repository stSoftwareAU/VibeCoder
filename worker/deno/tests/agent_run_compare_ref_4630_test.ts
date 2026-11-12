/**
 * An issue run's recovery agents hand their own pre-push hook the run's base
 * as `ciCargoCompareRef`, so a CI cargo failure the base already has is no
 * verdict on the agent's push (Issue #4630 review). The execute, completion,
 * pre-push-retry and security-fix runs are asserted beside their own tests.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { PhaseResult } from "../lib/issue_worker_types.ts";
import { recoverFromScreenshotGateBlock } from "../lib/screenshot_gate_retry.ts";
import { recoverFromSummaryRuleBlock } from "../lib/summary_rule_gate_retry.ts";
import { recoverFromPrBodyLength } from "../lib/pr_body_length.ts";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";

function context(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 4630,
    issueTitle: "Shift left",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
}

function state(milestoneBranch?: string): PhaseState {
  return {
    branchName: "issue-4630",
    baseBranch: milestoneBranch ?? "main",
    defaultBranch: "main",
    ...(milestoneBranch === undefined ? {} : { milestoneBranch }),
    repoPath: "/tmp/agent-run-compare-ref-4630",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    baselineFailedChecks: [],
  };
}

const CONTINUE: PhaseResult = { status: "continue" } as PhaseResult;

/** Mock deps whose agent records the compare ref of each run. */
function recordingDeps(refs: unknown[]) {
  return createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: { ciCargoCompareRef?: string }) => {
        refs.push(options.ciCargoCompareRef);
        return Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        });
      }) as never,
    },
    quality: {
      runQualityGate: (() =>
        Promise.resolve({
          ok: true,
          value: {
            checks: [{ name: "deno test", status: "FAILED" }],
            summary: { text: "failed", passed: false },
            passed: false,
            output: "deno test failed",
          },
        })) as never,
      collectDiffableGateFindings: () => Promise.resolve([]),
    },
  });
}

Deno.test("screenshot gate retry - the agent's own push compares CI cargo against the run's base (Issue #4630 review)", async () => {
  const refs: unknown[] = [];
  const phase = state("milestone/7");
  phase.screenshotGateBlock = { failureMessage: "capture the screenshot" };
  await recoverFromScreenshotGateBlock(
    context(),
    phase,
    recordingDeps(refs),
    () => Promise.resolve(CONTINUE),
  );
  assertEquals(refs, ["origin/milestone/7"]);
});

Deno.test("summary rule gate retry - the agent's own push compares CI cargo against the run's base (Issue #4630 review)", async () => {
  const refs: unknown[] = [];
  const phase = state();
  phase.summaryRuleBlocks = [{ reason: "rule", comment: "fix the summary" }];
  await recoverFromSummaryRuleBlock(
    context(),
    phase,
    recordingDeps(refs),
    CONTINUE,
    () => Promise.resolve(CONTINUE),
  );
  assertEquals(refs.length > 0, true, "the retry agent must have run");
  assertEquals([...new Set(refs)], ["origin/main"]);
});

Deno.test("PR body length retry - the agent's own push compares CI cargo against the run's base (Issue #4630 review)", async () => {
  const refs: unknown[] = [];
  const phase = state();
  phase.prBodyLengthBlock = { prompt: "shorten the summary" };
  await recoverFromPrBodyLength(
    context(),
    phase,
    recordingDeps(refs),
    () => Promise.resolve(CONTINUE),
  );
  assertEquals(refs, ["origin/main"]);
});

Deno.test("quality gate remediation - the agent's own push compares CI cargo against the run's base (Issue #4630 review)", async () => {
  const refs: unknown[] = [];
  await workOnIssueQualityGate(
    context(),
    state("milestone/7"),
    recordingDeps(refs),
  );
  assertEquals(refs.length > 0, true, "the fix agent must have run");
  assertEquals([...new Set(refs)], ["origin/milestone/7"]);
});
