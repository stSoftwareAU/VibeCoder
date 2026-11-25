/**
 * Each potentially blocking setup step logs one fixed start line, and the
 * hard-kill report names the step from it (Issue #5128).
 *
 * Drives the real `workOnIssueSetupBranch`. The expected lines and labels are
 * literals on purpose: they are the public contract.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueSetupBranch } from "../lib/phases/setup_branch_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";
import { resetMilestoneArmSyncMemo } from "../lib/milestone_presync.ts";
import { hardKillLastStep } from "../lib/hard_kill_report.ts";
import {
  HARD_KILL_EVIDENCE_VERSION,
  type HardKillEvidence,
} from "../lib/hard_kill_evidence.ts";

const REPO = "stSoftwareAU/VibeCoder";

function buildState(): PhaseState {
  return {
    branchName: "",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

function buildContext(workDir: string, milestoneTitle?: string): IssueContext {
  return {
    repo: REPO,
    issueNumber: 5128,
    issueTitle: "Setup steps log as they start",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    ...(milestoneTitle ? { milestoneTitle } : {}),
    config: { ...buildDefaultWorkerConfig(), workDir },
  };
}

const logged = (message: string) =>
  `[2026-11-03 05:15:07Z] INFO: [s1 ${REPO}#5128] ${message} host=s1`;
const TICKER = logged(
  "[phase] setup (stSoftwareAU/GRQ#5515): still running · 2h 10m elapsed",
);

/** Evidence whose worker log tail is the captured lines, then ticker lines. */
function evidenceFrom(captured: string[]): HardKillEvidence {
  const lines = [...captured.map(logged), TICKER, TICKER, TICKER];
  return {
    version: HARD_KILL_EVIDENCE_VERSION,
    capturedAt: "2026-11-03T05:30:00.000Z",
    host: "s1",
    container: "vibe-coder-s1-5128",
    runId: "vibe-mh5abc-abcdef",
    trigger: "watchdog",
    reason: "the launcher's watchdog deadline expired",
    lastLogLine: TICKER,
    lastLogTimestamp: "2026-11-03 05:15:07Z",
    lastToolCall: "",
    evidence: {
      workerLogTail: lines.join("\n"),
      agentTranscriptTail: "",
      bootLogs: "",
      guest: {
        ps: "",
        meminfo: "",
        pressureCpu: "",
        pressureMemory: "",
        pressureIo: "",
      },
      hostState: { disk: "", memory: "" },
    },
  };
}

function stepLines(captured: string[]): string[] {
  return captured.filter((line) => line.startsWith("[setup-step] "));
}

Deno.test("#5128 - a failed repository setup logs its start line and the report names it", async () => {
  resetMilestoneArmSyncMemo();
  const workDir = await Deno.makeTempDir({ prefix: "issue5128-setup-" });
  try {
    const captured: string[] = [];
    const deps = createMockDeps({
      logger: { info: (message: string) => void captured.push(message) },
      git: {
        setupRepo: () =>
          Promise.resolve({ ok: false as const, error: new Error("clone") }),
      },
    });
    const state = buildState();
    const result = await workOnIssueSetupBranch(
      buildContext(workDir),
      state,
      deps,
    );
    assertEquals(result.status, "failure");
    assertEquals(stepLines(captured), [
      "[setup-step] issue claim: started",
      "[setup-step] claim churn check: started",
      "[setup-step] repository setup: started",
    ]);
    assert(!captured.includes("[setup-step] heartbeat start: started"));
    assertEquals(
      hardKillLastStep(evidenceFrom(stepLines(captured))),
      "setup: repository setup",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#5128 - a refused claim logs only the issue claim line and the report names it", async () => {
  resetMilestoneArmSyncMemo();
  const workDir = await Deno.makeTempDir({ prefix: "issue5128-setup-" });
  try {
    const captured: string[] = [];
    const deps = createMockDeps({
      logger: { info: (message: string) => void captured.push(message) },
      issues: {
        claimIssue: () =>
          Promise.resolve({ ok: false as const, error: new Error("nope") }),
      },
    });
    const result = await workOnIssueSetupBranch(
      buildContext(workDir),
      buildState(),
      deps,
    );
    assertEquals(result.status, "failure");
    assertEquals(stepLines(captured), ["[setup-step] issue claim: started"]);
    assertEquals(
      hardKillLastStep(evidenceFrom(stepLines(captured))),
      "setup: issue claim",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#5128 - a completed setup logs all eight start lines in order", async () => {
  resetMilestoneArmSyncMemo();
  const workDir = await Deno.makeTempDir({ prefix: "issue5128-setup-" });
  const state = buildState();
  try {
    const captured: string[] = [];
    const deps = createMockDeps({
      logger: { info: (message: string) => void captured.push(message) },
    });
    const result = await workOnIssueSetupBranch(
      buildContext(workDir),
      state,
      deps,
    );
    assertEquals(result.status, "continue");
    assertEquals(stepLines(captured), [
      "[setup-step] issue claim: started",
      "[setup-step] claim churn check: started",
      "[setup-step] repository setup: started",
      "[setup-step] heartbeat start: started",
      "[setup-step] default branch sync: started",
      "[setup-step] session resume: started",
      "[setup-step] feature branch: started",
      "[setup-step] pre-setup command: started",
    ]);
    assertEquals(
      hardKillLastStep(evidenceFrom(stepLines(captured))),
      "setup: pre-setup command",
    );
  } finally {
    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("#5529 - a milestone setup inside the pre-sync agent reports milestone pre-sync, and a completed milestone setup logs the milestone steps in order", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue5529-setup-" });
  const state = buildState();
  const completedState = buildState();
  try {
    // Behind the default branch, so the pre-sync reaches its conflict-agent
    // call. Snapshot what the run has logged by the time that call is made.
    resetMilestoneArmSyncMemo();
    const captured: string[] = [];
    let atAgentCall: string[] = [];
    const deps = createMockDeps({
      logger: { info: (message: string) => void captured.push(message) },
      git: {
        countCommitsAhead: () =>
          Promise.resolve({ ok: true as const, value: 2 }),
        syncMilestoneBranchWithDefault: () => {
          atAgentCall = stepLines(captured);
          return Promise.resolve({
            ok: true as const,
            value: { message: "merged main down" },
          });
        },
      },
    });
    await workOnIssueSetupBranch(
      buildContext(workDir, "M1"),
      state,
      deps,
    );
    assertEquals(
      hardKillLastStep(evidenceFrom(atAgentCall)),
      "setup: milestone pre-sync",
    );

    // A level milestone branch: the run completes, and every step logs once,
    // in run order.
    resetMilestoneArmSyncMemo();
    const completed: string[] = [];
    const result = await workOnIssueSetupBranch(
      buildContext(workDir, "M1"),
      completedState,
      createMockDeps({
        logger: { info: (message: string) => void completed.push(message) },
        git: {
          countCommitsAhead: () =>
            Promise.resolve({ ok: true as const, value: 0 }),
        },
      }),
    );
    assertEquals(result.status, "continue");
    assertEquals(stepLines(completed), [
      "[setup-step] issue claim: started",
      "[setup-step] claim churn check: started",
      "[setup-step] repository setup: started",
      "[setup-step] heartbeat start: started",
      "[setup-step] default branch sync: started",
      "[setup-step] milestone branch: started",
      "[setup-step] milestone pre-sync: started",
      "[setup-step] session resume: started",
      "[setup-step] feature branch: started",
      "[setup-step] pre-setup command: started",
    ]);
  } finally {
    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
    if (completedState.heartbeatHandle) {
      await stopHeartbeat(completedState.heartbeatHandle);
    }
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
