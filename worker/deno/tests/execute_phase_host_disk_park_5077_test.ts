/**
 * Tests for a host-disk park raised while the agent runs in the execute phase
 * (Issue #5077).
 *
 * Before Issue #5077 the in-flight host-disk guard stopped the agent with a
 * plain Error, which the phase turned into `internal_error`: the run was
 * logged as an ERROR, released as a worker fault, and its uncommitted work was
 * not preserved. The park is now a typed `HostDiskParkError`. The phase keeps
 * the work on the issue branch with a `wip:` commit and a handover note,
 * releases the run as `host_disk` (infrastructure, not the issue), and logs
 * the failed run at WARN rather than ERROR.
 *
 * The composition test drives the real claude runner under the phase, so the
 * park is raised inside execute by the heavy-build gate, not stubbed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  enableInFlightHostDiskGate,
  type HeavyBuildDiskReading,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import { logIssueRunFailure } from "../lib/issue_run_failure_log.ts";
import { classifyRunFailure } from "../lib/run_outcome_classifier.ts";
import { detectHostFault } from "../lib/host_fault.ts";
import { deriveRunOutcome, describeRunOutcome } from "../lib/run_outcome.ts";
import { planCodingFailure } from "../lib/coding_failure_ladder.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { Logger, WorkerConfig } from "../types.ts";
import {
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
} from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import { gitOk, setupGitRepoFixture } from "./support/git_repo_fixture.ts";
import { commitAndPushPending } from "../lib/git_push.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { handoverFilePath } from "../lib/preserved_wip_branch.ts";

const ISSUE = 5077;
const REPO = "org/repo";
const BRANCH = "issue-5077-host-disk-park";
const DIRTY = "worker/deno/lib/parser.ts";
/** What the agent writes before the disk drops. */
const AGENT_WORK = "export const parsed = true;";
const GIB = 1_073_741_824;
/** The reason the guard writes when the host disk crosses its floor. */
const PARK_REASON =
  "host disk below its floor — 45 GB free, floor 46.0 GB; a repository build or test would grow host disk further, so it waits until the host recovers (Issue #3178) Parked as infrastructure (Issue #4360).";

function reading(freeGb: number): HeavyBuildDiskReading {
  return {
    status: {
      level: freeGb < 46 ? "low" : "ok",
      availableBytes: freeGb * GIB,
      totalBytes: 460 * GIB,
      source: "launch-baseline",
      detail: `${freeGb} GB free, floor 46.0 GB`,
    },
    floorBytes: 46 * GIB,
    trimRefused: true,
  };
}

interface CapturedLog {
  logger: Logger;
  errors: string[];
  warns: string[];
}

/** A logger that records every ERROR and WARN line it is given. */
function captureLogger(): CapturedLog {
  const errors: string[] = [];
  const warns: string[] = [];
  const logger = {
    info: () => {},
    warn: (message: string) => {
      warns.push(message);
    },
    error: (message: string) => {
      errors.push(message);
    },
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  } as Logger;
  return { logger, errors, warns };
}

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 10 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Park the agent at the host disk floor without an ERROR line",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(repoPath: string): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now() - 1_800_000,
    executeStartHeadSha: "abc123",
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

Deno.test({
  name:
    "execute_phase #5077 - a host-disk park mid-execute is preserved, released as host_disk, and logged as a warning",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    // A real remote and clone: preservation is proved by what the remote
    // issue branch holds, not by what a stub was asked to do.
    const fixture = await setupGitRepoFixture("host_disk_5077_");
    const repoPath = fixture.clone;
    const captured = captureLogger();
    const clock = fakeClock();
    const ready = Promise.withResolvers<void>();
    let freeGb = 75.9;
    registerHeavyBuildDiskProbe(() => Promise.resolve(reading(freeGb)));
    enableInFlightHostDiskGate(true);
    // The agent does real work in its working directory, records each start,
    // then blocks on the gate. A resumed agent would record a second start or
    // pass the gate and write the finish marker.
    const stub = await createAgentStub(
      `echo started >> "$0.starts"\n` +
        `mkdir -p "$(dirname '${DIRTY}')"\n` +
        `printf '%s\\n' '${AGENT_WORK}' > '${DIRTY}'\n` +
        `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
        agentStubGate() + `echo finished >> "$0.finished"\nexit 0\n`,
    );
    try {
      await gitOk(["checkout", "-b", BRANCH], repoPath);
      const startSha = (await gitOk(["rev-parse", "HEAD"], repoPath)).trim();
      const deps = createMockDeps({
        logger: captured.logger,
        claude: {
          // The phase's agent invocation runs the REAL runner. The disk drops
          // below the floor once the agent has started, so the in-flight gate
          // parks it mid-execute.
          runClaudeWithRetry: ((runOptions: Record<string, unknown>) => {
            const run = runClaudeWithTimeout({
              ...runOptions,
              agentBinaryPath: stub.path,
              clock,
              logger: captured.logger,
              timeoutSeconds: 3600,
              killAfterSeconds: 1,
              hostDiskPollMs: 30_000,
              progressIntervalMs: 86_400_000,
              descendantSnapshotIntervalMs: 86_400_000,
              onActivity: () => ready.resolve(),
            } as never);
            return (async () => {
              await ready.promise;
              freeGb = 45;
              await clock.advance(30_000);
              return await run;
            })();
          }) as never,
        },
        pr: {
          findExistingPrForIssue: (() =>
            Promise.resolve({ ok: false, error: new Error("No PR") })) as never,
        },
        // Real git against the fixture: the preserving commit and push run
        // for real.
        git: { runGitCommand, commitAndPushPending },
      });
      const config = makeConfig();
      const state = makeState(repoPath);
      state.executeStartHeadSha = startSha;
      const result = await workOnIssueExecuteClaude(
        makeContext(config),
        state,
        deps,
      );

      // The run is released as host infrastructure, not as a worker fault.
      assertEquals(result.status, "failure");
      const category = "category" in result ? result.category : undefined;
      assertEquals(category, "host_disk");
      const reason = "reason" in result ? result.reason ?? "" : "";
      assertStringIncludes(reason, "host disk below its floor");

      // The classification the phase returns is the one filing and outcome
      // derivation use, so assert it on the result.
      const classification = "classification" in result
        ? result.classification
        : undefined;
      assert(
        classification !== undefined,
        "the phase returns its classification",
      );
      assertEquals(classification?.failureClass, "disk-full");
      assertEquals(classification?.fixability, "not_code_fixable");

      // The interrupted work is on the issue branch of the remote, with the
      // handover describing the park.
      const remoteBranch = (await gitOk(
        ["rev-parse", "--verify", `refs/heads/${BRANCH}`],
        fixture.remote,
      )).trim();
      assertEquals(
        await gitOk(["show", `${remoteBranch}:${DIRTY}`], fixture.remote),
        `${AGENT_WORK}\n`,
        "the agent's file reached the remote issue branch",
      );
      const handoverPath = handoverFilePath(ISSUE);
      const handover = await gitOk(
        ["show", `${remoteBranch}:${handoverPath}`],
        fixture.remote,
      );
      assertStringIncludes(handover, "parked at the host disk floor");
      assertEquals(
        (await gitOk(["status", "--porcelain"], repoPath)).trim(),
        "",
        "nothing is left only in the local clone",
      );

      // The released preservation reference names that stored branch and file.
      assertEquals(state.preservedWip?.branch, BRANCH);
      assertEquals(state.preservedWip?.handoverPath, handoverPath);
      assertStringIncludes(reason, `pushed to '${BRANCH}'`);

      // The parked agent is not resumed: it started once, and never ran on.
      assertEquals(
        (await Deno.readTextFile(`${stub.path}.starts`)).trim().split("\n"),
        ["started"],
        "the agent was started exactly once",
      );
      await assertRejects(
        () => Deno.stat(`${stub.path}.finished`),
        Deno.errors.NotFound,
        undefined,
        "the parked agent did not carry on",
      );

      // The run's outcome and its planned failure handling.
      const outcome = deriveRunOutcome({
        success: false,
        phase: "execute",
        reason,
        category: category as never,
        classification,
      });
      assertEquals(describeRunOutcome(outcome), "no_pr:host_disk:execute");
      const plan = planCodingFailure({
        success: false,
        expectedSkip: false,
        reason,
        category: category as never,
        classification,
        phase: "execute",
      });
      assertEquals(plan.applyLadder, false);
      assertEquals(
        (plan as { cooldownKind?: unknown }).cooldownKind,
        undefined,
        "the attempt is not charged",
      );

      // The caller's failure log: a WARN naming the host disk, never an ERROR.
      logIssueRunFailure(
        captured.logger,
        `${REPO}#${ISSUE}`,
        { reason, phase: "execute", category },
        false,
      );
      assertEquals(captured.errors, [], "no ERROR line for a protective park");
      assert(
        captured.warns.some((line) => line.includes("host disk")),
        "a WARN names the host disk",
      );
    } finally {
      await releaseAgentStub(stub);
      await stub.dispose();
      enableInFlightHostDiskGate(false);
      registerHeavyBuildDiskProbe(undefined);
      await fixture.cleanup();
    }
  },
});

Deno.test("issue_run_failure_log #5077 - a non-disk failure still logs at ERROR", () => {
  const captured = captureLogger();
  logIssueRunFailure(
    captured.logger,
    `${REPO}#${ISSUE}`,
    {
      reason: "Claude execution failed: boom",
      phase: "execute",
      category: "internal_error",
    },
    false,
  );
  assertEquals(captured.errors.length, 1);
  assertEquals(
    captured.errors[0],
    `Issue ${REPO}#${ISSUE} failed at phase 'execute': Claude execution failed: boom`,
  );
  assertEquals(captured.warns, []);
});

Deno.test("issue_run_failure_log #5077 - a host-disk failure logs at WARN, naming the park", () => {
  const captured = captureLogger();
  logIssueRunFailure(
    captured.logger,
    `${REPO}#${ISSUE}`,
    { reason: PARK_REASON, phase: "execute", category: "host_disk" },
    false,
  );
  assertEquals(captured.errors, []);
  assertEquals(captured.warns.length, 1);
  assertEquals(
    captured.warns[0],
    `Issue ${REPO}#${ISSUE} parked for the host disk at phase 'execute': ${PARK_REASON}`,
  );
});

Deno.test("classifyRunFailure #5077 - host_disk is a not-code-fixable disk-full park", () => {
  const classification = classifyRunFailure("host_disk", PARK_REASON, true);
  assertEquals(classification.failureClass, "disk-full");
  assertEquals(classification.fixability, "not_code_fixable");
  assertEquals(detectHostFault(PARK_REASON, "host_disk"), "disk-full");
});
