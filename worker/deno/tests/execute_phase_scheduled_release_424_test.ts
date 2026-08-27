/**
 * A cycle-end or hard-cap release is not "Claude ran out of time"
 * (Issue #424, parent #397).
 *
 * With the cycle deadline no longer truncating a claim (Issue #420), the two
 * ways a progressing run is stopped by the fleet rather than by its own
 * budget are the supervisor's wall-clock hard cap (Issue #421) and the
 * worker's own shutdown at cycle end. Both wear a timeout's clothes — the
 * worker's watchdog fires, the child dies on SIGTERM, `Timeout: Ns` lands in
 * the diagnostics — so a comment built from the exit status alone told a
 * human to split an issue that was progressing perfectly well.
 *
 * These tests pin the operator-facing half: the reason the phase returns
 * carries the scheduled-release wording, never the timeout diagnosis, and a
 * run that genuinely exhausted its own budget is untouched.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  detectFailureCategory,
  getFailureDiagnosis,
  getFailureDiagnosisOneliner,
  isInfrastructureFailure,
  isTimeoutClassFailureReason,
} from "../lib/failure_diagnosis.ts";
import { deriveRunOutcome } from "../lib/run_outcome.ts";
import { renderRunOutcomeClause } from "../lib/heartbeat_storage.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 50 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 424,
    issueTitle: "An issue the fleet handed over mid-run",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-424-handed-over",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** Drive the phase with a runner result and return the phase outcome. */
async function runPhaseWith(
  runnerValue: Record<string, unknown>,
): Promise<{ status: string; reason?: string; runnerCalls: number }> {
  let runnerCalls = 0;
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() => {
        runnerCalls++;
        return Promise.resolve({ ok: true, value: runnerValue });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });
  const config = makeConfig();
  const result = await workOnIssueExecuteClaude(
    makeContext(config),
    makeState(),
    deps,
  ) as { status: string; reason?: string };
  return { ...result, runnerCalls };
}

/** Everything the comment must never say about a scheduled release. */
function assertNoTimeoutBlame(reason: string): void {
  const diagnosis = getFailureDiagnosis(detectFailureCategory(reason));
  const oneliner = getFailureDiagnosisOneliner(detectFailureCategory(reason));
  for (const text of [reason, diagnosis, oneliner]) {
    assert(
      !text.includes("ran out of time"),
      `a scheduled release must never say the agent ran out of time: ${text}`,
    );
    assert(
      !text.includes("sub-issues"),
      `a scheduled release must never advise splitting the issue: ${text}`,
    );
  }
}

Deno.test("execute_phase #424 - a hard-cap release reports the handover, not a timeout", async () => {
  const result = await runPhaseWith({
    output: "Wiring the production side; tests next",
    exitCode: 124,
    rawExitCode: 143,
    timedOut: true,
    timeoutReason: "hard-timeout",
    scheduledRelease: "hard-cap",
  });

  assertEquals(result.status, "failure");
  const reason = result.reason ?? "";
  assertStringIncludes(reason, "Released on schedule:");
  assertStringIncludes(reason, "run hard cap");
  assertStringIncludes(reason, "WIP preserved, resumes next cycle");
  assertEquals(detectFailureCategory(reason), "scheduled_release");
  assertNoTimeoutBlame(reason);

  // Not infrastructure, so the #1550 wrapper does not burn a second billed
  // start on a run that has no runway left: exactly one runner call.
  assertEquals(isInfrastructureFailure("scheduled_release"), false);
  assertEquals(result.runnerCalls, 1);
  // And it never feeds the escalating timeout cooldown.
  assertEquals(isTimeoutClassFailureReason(reason), false);
});

Deno.test("execute_phase #424 - the worker's own shutdown releases on schedule, naming the cycle end", async () => {
  const result = await runPhaseWith({
    output: "Halfway through the refactor",
    exitCode: 143,
    rawExitCode: 143,
    timedOut: false,
    terminated: true,
  });

  assertEquals(result.status, "failure");
  const reason = result.reason ?? "";
  assertStringIncludes(reason, "Released on schedule:");
  assertStringIncludes(reason, "the cycle ended");
  assertEquals(detectFailureCategory(reason), "scheduled_release");
  assertNoTimeoutBlame(reason);
  assertEquals(result.runnerCalls, 1);
});

Deno.test("execute_phase #424 - a run that exhausted its own budget keeps today's timeout diagnosis", async () => {
  const result = await runPhaseWith({
    output: "Still reading the codebase",
    exitCode: 124,
    rawExitCode: 143,
    timedOut: true,
    timeoutReason: "hard-timeout",
  });

  assertEquals(result.status, "failure");
  const reason = result.reason ?? "";
  assertStringIncludes(reason, "Claude timed out");
  assert(
    !reason.includes("Released on schedule:"),
    `a genuine timeout must not claim to be scheduled: ${reason}`,
  );
  assertEquals(detectFailureCategory(reason), "timeout");
  // Unchanged wording — this is the case the split-into-sub-issues advice is
  // actually for.
  assertStringIncludes(getFailureDiagnosis("timeout"), "ran out of time");
  assertStringIncludes(getFailureDiagnosis("timeout"), "sub-issues");
});

Deno.test("execute_phase #424 - the release comment states the handover, not a timeout", async () => {
  // End to end over the operator-facing path: the reason the phase returns
  // becomes the run outcome, and the outcome is what the claim-release
  // comment renders. That comment is the only thing a human reads.
  const result = await runPhaseWith({
    output: "Wiring the production side; tests next",
    exitCode: 124,
    rawExitCode: 143,
    timedOut: true,
    timeoutReason: "hard-timeout",
    scheduledRelease: "hard-cap",
  });

  const outcome = deriveRunOutcome({
    success: false,
    phase: "execute",
    reason: result.reason ?? "",
    elapsedSeconds: 10_800,
  });
  assert(outcome.kind === "no_pr");
  assertEquals(outcome.category, "scheduled_release");

  const clause = renderRunOutcomeClause(outcome);
  assertStringIncludes(clause, "no PR raised — `scheduled-release`");
  assertStringIncludes(clause, "WIP preserved");
  assertStringIncludes(clause, "resumes next cycle");
  assertNoTimeoutBlame(clause);
});
