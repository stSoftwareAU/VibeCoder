/**
 * Tests for the killed-run branch in the live execute phase
 * (`lib/phases/execute_phase.ts`, Issue #4202).
 *
 * Observed live on host-23: the agent process was SIGKILLed (VM OOM killer) at
 * 539 s of a 3600 s budget, and the phase reported "Claude timed out" with a
 * "Timeout: 3600s" diagnostic — a claim that was false and sent triage down
 * the wrong path. The runner now reports such a run as `killed` with the raw
 * exit preserved, and the phase must name the kill faithfully, classify it as
 * infrastructure (so the #1550 retry wrapper may fire), and never call it a
 * timeout.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  detectFailureCategory,
  isInfrastructureFailure,
} from "../lib/failure_diagnosis.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

function makeConfig(): WorkerConfig {
  // A fast infra-retry backoff: the killed category is infrastructure, so
  // the phase's own #1550 wrapper retries once — the tests assert that
  // without paying the production 15 s backoff.
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 50 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "An issue the VM killed mid-run",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-42-killed-mid-run",
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

Deno.test("execute_phase - a killed run fails as killed, never as a timeout (Issue #4202)", async () => {
  const result = await runPhaseWith({
    output: "Now wiring the production side",
    exitCode: 137,
    rawExitCode: 137,
    killed: true,
    timedOut: false,
  });

  assertEquals(result.status, "failure");
  const reason = result.reason ?? "";
  assert(reason.includes("SIGKILL"), `reason must name the signal: ${reason}`);
  assert(
    reason.includes("137"),
    `reason must carry the raw exit code: ${reason}`,
  );
  assert(
    !reason.toLowerCase().includes("timed out"),
    `a kill must not be reported as a timeout: ${reason}`,
  );

  // The reason classifies as infrastructure, so the #1550 in-process retry
  // wrapper is allowed one bounded retry — memory pressure is transient.
  const category = detectFailureCategory(reason);
  assertEquals(category, "killed");
  assertEquals(isInfrastructureFailure(category), true);
});

Deno.test("execute_phase - a killed run still self-heals when a PR already exists (Issue #4202)", async () => {
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: {
            output: "pushed the branch, opening the PR",
            exitCode: 137,
            rawExitCode: 137,
            killed: true,
            timedOut: false,
          },
        })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({
          ok: true,
          value: { number: 7, url: "https://github.com/org/repo/pull/7" },
        })) as never,
    },
  });
  const config = makeConfig();
  const result = await workOnIssueExecuteClaude(
    makeContext(config),
    makeState(),
    deps,
  );

  // A kill late in the run may follow a pushed PR (Issue #386): credit it.
  assertEquals(result.status, "continue");
});

Deno.test("execute_phase - a genuine watchdog timeout names the watchdog and the raw exit (Issue #4202)", async () => {
  const result = await runPhaseWith({
    output: "partial work",
    exitCode: 124,
    rawExitCode: 143,
    timedOut: true,
    timeoutReason: "hard-timeout",
  });

  assertEquals(result.status, "failure");
  const reason = result.reason ?? "";
  assert(reason.includes("timed out"), reason);
  assert(
    reason.includes("hard-timeout"),
    `the diagnostics must name which watchdog fired: ${reason}`,
  );
  assert(
    reason.includes("143"),
    `the diagnostics must carry the raw exit status: ${reason}`,
  );
});

// ---------------------------------------------------------------------------
// Issue #4374 — the #1550 retry after a kill is evidence-led
// ---------------------------------------------------------------------------

/**
 * Drive the phase with a sequence of runner results (one per invocation;
 * the last repeats) and a capturing logger.
 */
async function runPhaseSequence(
  runnerValues: Array<Record<string, unknown>>,
): Promise<
  { status: string; reason?: string; runnerCalls: number; warns: string[] }
> {
  let runnerCalls = 0;
  const warns: string[] = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() => {
        const value =
          runnerValues[Math.min(runnerCalls, runnerValues.length - 1)];
        runnerCalls++;
        return Promise.resolve({ ok: true, value });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });
  const baseLogger = deps.logger;
  deps.logger = {
    ...baseLogger,
    warn: (message: string, context?: Record<string, unknown>) => {
      warns.push(message);
      baseLogger.warn(message, context);
    },
  };
  const config = makeConfig();
  const result = await workOnIssueExecuteClaude(
    makeContext(config),
    makeState(),
    deps,
  ) as { status: string; reason?: string };
  return { ...result, runnerCalls, warns };
}

const KILLED_OK_PRESSURE = {
  output: "Running the full quality gate",
  exitCode: 137,
  rawExitCode: 137,
  killed: true,
  timedOut: false,
  memoryPressureAtKill: {
    level: "ok",
    totalBytes: 16 * 1024 ** 3,
    availableBytes: 8 * 1024 ** 3,
  },
};

const KILLED_HIGH_PRESSURE = {
  ...KILLED_OK_PRESSURE,
  memoryPressureAtKill: {
    level: "high",
    totalBytes: 16 * 1024 ** 3,
    availableBytes: 400 * 1024 ** 2,
  },
};

Deno.test("execute_phase - a killed run is retried once, and a second kill on the same claim is never retried again (Issue #4374)", async () => {
  const result = await runPhaseSequence([KILLED_OK_PRESSURE]);
  assertEquals(result.status, "failure");
  // Exactly two starts: the original and the single #1550 retry. The
  // second kill releases the claim — no third billed start.
  assertEquals(result.runnerCalls, 2);
  assert(
    result.warns.some((w) => w.includes("Retrying infrastructure failure")),
    `the one retry is logged: ${JSON.stringify(result.warns)}`,
  );
});

Deno.test("execute_phase - a kill under high memory pressure is not retried in-process (Issue #4374)", async () => {
  const result = await runPhaseSequence([KILLED_HIGH_PRESSURE]);
  assertEquals(result.status, "failure");
  // The retry re-runs the same workload into the same memory: when the
  // probe says the pressure is still high at the kill, skip it and release.
  assertEquals(result.runnerCalls, 1);
  assert(
    !result.warns.some((w) => w.includes("Retrying infrastructure failure")),
    `no retry may be attempted: ${JSON.stringify(result.warns)}`,
  );
  assert(
    result.warns.some((w) =>
      /memory pressure/i.test(w) && /not retry/i.test(w)
    ),
    `the skip is explained: ${JSON.stringify(result.warns)}`,
  );
});

Deno.test("execute_phase - the failure message carries the memory-pressure reading at the kill (Issue #4374)", async () => {
  const result = await runPhaseSequence([KILLED_HIGH_PRESSURE]);
  const reason = result.reason ?? "";
  assert(
    /Memory pressure at kill: high/.test(reason),
    `the diagnostics name the reading: ${reason}`,
  );
  assert(
    reason.includes("400 MiB") && reason.includes("16.0 GiB"),
    `the diagnostics carry the numbers: ${reason}`,
  );
});

Deno.test("execute_phase - a kill with an unknown pressure reading keeps the single retry (Issue #4374)", async () => {
  const result = await runPhaseSequence([
    { ...KILLED_OK_PRESSURE, memoryPressureAtKill: { level: "unknown" } },
  ]);
  assertEquals(result.status, "failure");
  assertEquals(result.runnerCalls, 2);
  assert(
    /Memory pressure at kill: unknown/.test(result.reason ?? ""),
    result.reason,
  );
});

Deno.test("execute_phase - the failure message carries the kill-time process table (Issue #4382)", async () => {
  const result = await runPhaseSequence([
    {
      ...KILLED_HIGH_PRESSURE,
      killDiagnostics:
        "Top processes by RSS at the kill (8 total):\npid=6487 ppid=6485 rss=336 MiB up=01:28 [agent-tree] deno run quality",
    },
  ]);
  const reason = result.reason ?? "";
  assert(reason.includes("Processes at the kill"), reason);
  assert(
    reason.includes("pid=6487") && reason.includes("[agent-tree]"),
    reason,
  );
});

// ---------------------------------------------------------------------------
// VibeCoder#174 — a watchdog timeout is not an external kill; a retry needs
// runway; preserved checkpoints are reported truthfully.
// ---------------------------------------------------------------------------

import {
  hasRunwayForInfraRetry,
  MIN_INFRA_RETRY_RUNWAY_SECONDS,
} from "../lib/infra_retry.ts";

const WATCHDOG_TIMEOUT_143 = {
  output: "partial work",
  exitCode: 124,
  rawExitCode: 143,
  timedOut: true,
  timeoutReason: "hard-timeout",
};

async function runPhaseWithContext(
  runnerValues: Array<Record<string, unknown>>,
  contextExtra: Partial<IssueContext>,
  gitStdout: (args: string[]) => string | undefined = () => undefined,
): Promise<
  { status: string; reason?: string; runnerCalls: number; warns: string[] }
> {
  let runnerCalls = 0;
  const warns: string[] = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() => {
        const value =
          runnerValues[Math.min(runnerCalls, runnerValues.length - 1)];
        runnerCalls++;
        return Promise.resolve({ ok: true, value });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });
  const baseGit = deps.git.runGitCommand;
  deps.git.runGitCommand = ((args: string[], opts?: unknown) => {
    const stdout = gitStdout(args);
    if (stdout !== undefined) {
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout, stderr: "" },
      });
    }
    return baseGit(args, opts as never);
  }) as never;
  const baseLogger = deps.logger;
  deps.logger = {
    ...baseLogger,
    warn: (message: string, context?: Record<string, unknown>) => {
      warns.push(message);
      baseLogger.warn(message, context);
    },
  };
  const config = makeConfig();
  const result = await workOnIssueExecuteClaude(
    { ...makeContext(config), ...contextExtra },
    makeState(),
    deps,
  ) as { status: string; reason?: string };
  return { ...result, runnerCalls, warns };
}

Deno.test("execute_phase - a watchdog timeout (raw exit 143) classifies as timeout and is not retried as a kill (VibeCoder#174)", async () => {
  const result = await runPhaseWithContext([WATCHDOG_TIMEOUT_143], {});
  assertEquals(result.status, "failure");
  const reason = result.reason ?? "";
  assert(reason.includes("143"), reason);
  assertEquals(detectFailureCategory(reason), "timeout");
  assertEquals(result.runnerCalls, 1, "a plain timeout is never retried");
});

Deno.test("execute_phase - a killed run is not retried when the cycle has no runway left (VibeCoder#174)", async () => {
  const result = await runPhaseWithContext([KILLED_OK_PRESSURE], {
    cycleDeadlineEpochMs: Date.now() + 120_000,
  });
  assertEquals(result.status, "failure");
  assertEquals(result.runnerCalls, 1);
  assert(
    result.warns.some((w) => w.includes("cycle runway")),
    `expected a runway warning, got: ${result.warns.join(" | ")}`,
  );
});

Deno.test("execute_phase - a killed run with runway left keeps its single retry (VibeCoder#174)", async () => {
  const result = await runPhaseWithContext([KILLED_OK_PRESSURE], {
    cycleDeadlineEpochMs: Date.now() + 3_600_000,
  });
  assertEquals(result.runnerCalls, 2);
});

Deno.test("hasRunwayForInfraRetry - threshold and no-deadline cases (VibeCoder#174)", () => {
  const now = 1_000_000_000_000;
  assertEquals(hasRunwayForInfraRetry(undefined, now), true);
  assertEquals(
    hasRunwayForInfraRetry(now + MIN_INFRA_RETRY_RUNWAY_SECONDS * 1000, now),
    true,
  );
  assertEquals(
    hasRunwayForInfraRetry(
      now + MIN_INFRA_RETRY_RUNWAY_SECONDS * 1000 - 1,
      now,
    ),
    false,
  );
});

Deno.test("execute_phase - a deadline-bound timeout whose checkpoint already landed reports the preserved work, not 'without creating changes' (VibeCoder#174)", async () => {
  const result = await runPhaseWithContext(
    [WATCHDOG_TIMEOUT_143],
    { cycleDeadlineEpochMs: Date.now() + 800_000 },
    (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
      if (args[0] === "rev-list" && args[1] === "--count") return "1\n";
      if (args[0] === "status") return "";
      return undefined;
    },
  );
  assertEquals(result.status, "failure");
  const reason = result.reason ?? "";
  assert(
    !reason.includes("without creating changes"),
    `the checkpointed work must be acknowledged: ${reason}`,
  );
  assert(reason.includes("work preserved on the branch"), reason);
  assert(reason.includes("1 checkpoint commit pushed"), reason);
  assert(reason.includes("at the cycle deadline"), reason);
  assertEquals(detectFailureCategory(reason), "timeout");
  assertEquals(result.runnerCalls, 1);
});
