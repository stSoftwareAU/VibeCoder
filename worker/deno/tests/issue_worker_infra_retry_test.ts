/**
 * Tests for in-process infrastructure retry behaviour (Issue #1550).
 *
 * Verifies that infrastructure-category failures (zero_output, rate_limit,
 * internal_error, push_failure) are retried in-process once before falling
 * through to `handleIssueFailure` / the `failed-once` label path.
 *
 * Non-infrastructure categories (quality_check, no_changes, etc.) must NOT
 * trigger the retry — behaviour for real work failures is unchanged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  MAX_INFRA_RETRIES_PER_PHASE,
  resetInfraRetryCount,
  shouldRetryInfrastructureFailure,
} from "../lib/infra_retry.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";
import type { Logger } from "../types.ts";
import {
  type IssueContext,
  workOnIssueCompletion,
  workOnIssueExecuteClaude,
  workOnIssueQualityGate,
} from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-42-test",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...overrides,
  };
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/test-repo",
    issueNumber: 42,
    issueTitle: "Test issue",
    issueBody: "Body",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: { ...buildDefaultWorkerConfig(), ...(overrides?.config ?? {}) },
    ...overrides,
  };
}

/** Capturing logger — records warn() calls for assertions. */
interface CapturedLog {
  level: string;
  msg: string;
  ctx?: unknown;
}
function makeCapturingLogger(captured: CapturedLog[]): Logger {
  return {
    info: (msg, ctx) => captured.push({ level: "info", msg, ctx }),
    warn: (msg, ctx) => captured.push({ level: "warn", msg, ctx }),
    error: (msg, ctx) => captured.push({ level: "error", msg, ctx }),
    debug: (msg, ctx) => captured.push({ level: "debug", msg, ctx }),
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

/** Instant sleep for tests — no real delay. */
const instantSleep = (_ms: number) => Promise.resolve();

// ---------------------------------------------------------------------------
// shouldRetryInfrastructureFailure — direct unit tests
// ---------------------------------------------------------------------------

Deno.test("infra retry - zero_output triggers first-time retry", async () => {
  const state = makeState();
  const logs: CapturedLog[] = [];
  const logger = makeCapturingLogger(logs);

  const retry = await shouldRetryInfrastructureFailure(
    "execute",
    "Claude produced zero output during processing",
    state,
    logger,
    { sleepFn: instantSleep },
  );

  assertEquals(retry, true);
  assertEquals(state.infraRetryCounts?.execute, 1);
  assertEquals(
    logs.some((l) =>
      l.level === "warn" && l.msg.includes("Retrying infrastructure")
    ),
    true,
  );
});

Deno.test("infra retry - rate_limit triggers retry", async () => {
  const state = makeState();
  const retry = await shouldRetryInfrastructureFailure(
    "execute",
    "Claude was rate limit during call",
    state,
    makeCapturingLogger([]),
    { sleepFn: instantSleep },
  );
  assertEquals(retry, true);
});

Deno.test("infra retry - internal_error triggers retry", async () => {
  const state = makeState();
  const retry = await shouldRetryInfrastructureFailure(
    "execute",
    "Error: ENOENT internal CLI error at Module.load",
    state,
    makeCapturingLogger([]),
    { sleepFn: instantSleep },
  );
  assertEquals(retry, true);
});

Deno.test("infra retry - push_failure triggers retry", async () => {
  const state = makeState();
  const retry = await shouldRetryInfrastructureFailure(
    "completion",
    "Git push failed due to network",
    state,
    makeCapturingLogger([]),
    { sleepFn: instantSleep },
  );
  assertEquals(retry, true);
  assertEquals(state.infraRetryCounts?.completion, 1);
});

Deno.test("infra retry - quality_check does NOT trigger retry (non-infrastructure)", async () => {
  const state = makeState();
  const retry = await shouldRetryInfrastructureFailure(
    "quality_gate",
    "quality.sh failed: 2 tests failed",
    state,
    makeCapturingLogger([]),
    { sleepFn: instantSleep },
  );
  assertEquals(retry, false);
  assertEquals(state.infraRetryCounts?.quality_gate, undefined);
});

Deno.test("infra retry - no_changes does NOT trigger retry", async () => {
  const state = makeState();
  const retry = await shouldRetryInfrastructureFailure(
    "execute",
    "Claude finished without making any changes",
    state,
    makeCapturingLogger([]),
    { sleepFn: instantSleep },
  );
  assertEquals(retry, false);
});

Deno.test("infra retry - second call for same phase returns false (cap at 1)", async () => {
  const state = makeState();
  const logger = makeCapturingLogger([]);

  const first = await shouldRetryInfrastructureFailure(
    "execute",
    "Claude produced zero output",
    state,
    logger,
    { sleepFn: instantSleep },
  );
  assertEquals(first, true);
  assertEquals(state.infraRetryCounts?.execute, 1);

  const second = await shouldRetryInfrastructureFailure(
    "execute",
    "Claude produced zero output",
    state,
    logger,
    { sleepFn: instantSleep },
  );
  assertEquals(second, false);
  // Counter unchanged after denied retry
  assertEquals(state.infraRetryCounts?.execute, 1);
});

Deno.test("infra retry - separate phases each get their own retry", async () => {
  const state = makeState();
  const logger = makeCapturingLogger([]);

  const execRetry = await shouldRetryInfrastructureFailure(
    "execute",
    "Claude produced zero output",
    state,
    logger,
    { sleepFn: instantSleep },
  );
  const qualityRetry = await shouldRetryInfrastructureFailure(
    "quality_gate",
    "Error: internal CLI error",
    state,
    logger,
    { sleepFn: instantSleep },
  );
  const completionRetry = await shouldRetryInfrastructureFailure(
    "completion",
    "Git push failed",
    state,
    logger,
    { sleepFn: instantSleep },
  );

  assertEquals(execRetry, true);
  assertEquals(qualityRetry, true);
  assertEquals(completionRetry, true);
  assertEquals(state.infraRetryCounts?.execute, 1);
  assertEquals(state.infraRetryCounts?.quality_gate, 1);
  assertEquals(state.infraRetryCounts?.completion, 1);
});

Deno.test("infra retry - invokes injected sleepFn with backoffMs", async () => {
  const state = makeState();
  const logger = makeCapturingLogger([]);
  let capturedMs: number | undefined;
  const captureSleep = (ms: number) => {
    capturedMs = ms;
    return Promise.resolve();
  };

  await shouldRetryInfrastructureFailure(
    "execute",
    "zero output detected",
    state,
    logger,
    { sleepFn: captureSleep, backoffMs: 250 },
  );

  assertEquals(capturedMs, 250);
});

Deno.test("infra retry - honours AbortSignal to short-circuit backoff", async () => {
  const state = makeState();
  const logger = makeCapturingLogger([]);
  const controller = new AbortController();
  controller.abort();

  // Issue #2434: with the signal already aborted, the 60s backoff must be
  // short-circuited entirely. Race against a generous deadline so a regression
  // that ignores the signal (and waits the full 60s) fails as a hang, without
  // asserting on wall-clock time, which depends on machine speed and CI load.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("aborted backoff was not short-circuited")),
      10_000,
    );
  });
  try {
    const retry = await Promise.race([
      shouldRetryInfrastructureFailure(
        "execute",
        "zero output detected",
        state,
        logger,
        { backoffMs: 60_000, abortSignal: controller.signal },
      ),
      deadline,
    ]);
    assertEquals(retry, true);
  } finally {
    clearTimeout(timeoutId);
  }
});

Deno.test("infra retry - resetInfraRetryCount allows another retry", async () => {
  const state = makeState();
  const logger = makeCapturingLogger([]);

  await shouldRetryInfrastructureFailure(
    "execute",
    "zero output",
    state,
    logger,
    { sleepFn: instantSleep },
  );
  assertEquals(state.infraRetryCounts?.execute, 1);

  resetInfraRetryCount(state, "execute");
  assertEquals(state.infraRetryCounts?.execute, undefined);

  const again = await shouldRetryInfrastructureFailure(
    "execute",
    "zero output",
    state,
    logger,
    { sleepFn: instantSleep },
  );
  assertEquals(again, true);
});

Deno.test("infra retry - MAX_INFRA_RETRIES_PER_PHASE is 1", () => {
  assertEquals(MAX_INFRA_RETRIES_PER_PHASE, 1);
});

// ---------------------------------------------------------------------------
// Integration — quality gate phase
// ---------------------------------------------------------------------------

Deno.test(
  "qualityGate - zero_output failure then success on retry does NOT call handleIssueFailure",
  async () => {
    const ctx = makeContext();
    const state = makeState({
      infraRetryCounts: {/* test mode: zero backoff */},
    });

    let qualityCalls = 0;
    let handleFailureCalls = 0;

    const deps = createMockDeps({
      quality: {
        // First phase attempt: infra failure (output contains "zero output");
        // quality_gate internal loop does one Claude-fix attempt and fails
        // again with the same output. After our outer infra retry, succeed.
        runQualityGate: () => {
          qualityCalls++;
          // First (phase attempt 1) + its internal fix retry = 2 calls with
          // infra failure. Third call (after infra retry backoff) passes.
          if (qualityCalls <= 2) {
            return Promise.resolve({
              ok: true,
              value: {
                checks: [],
                summary: { text: "failed", passed: false },
                passed: false,
                output: "zero output detected in subprocess",
              },
            });
          }
          return Promise.resolve({
            ok: true,
            value: {
              checks: [],
              summary: { text: "passed", passed: true },
              passed: true,
              output: "all checks passed",
            },
          });
        },
      },
      github: {
        handleIssueFailure: (() => {
          handleFailureCalls++;
          return Promise.resolve({
            ok: true,
            value: {
              markedAsFailed: false,
              markedAsFailedOnce: true,
              failureCategory: "zero_output",
              isInfrastructure: true,
            },
          });
        }) as never,
      },
    });

    // Use instant sleep for the test via config override — we override the
    // phase via a small wrapper to avoid touching production code for the
    // sleep injection; see infra_retry.ts default backoff is 15s.
    // Instead of waiting, pre-populate infraRetryCounts with a very small
    // backoff by monkey-patching via the helper's abort signal indirectly:
    // we can't easily inject — we rely on aborting via the state.
    //
    // Simplest: set config.infraRetryBackoffMs = 0 via state? The phase does
    // not accept options today. So we emulate by arranging for success on
    // the 3rd quality gate call, and accept the ~15s sleep.
    //
    // To keep the test fast we aborting via injected config — see
    // shouldRetryInfrastructureFailure; the phase calls it without options,
    // so the test would block. Instead we inject config.infraRetryBackoffMs
    // via WorkerConfig (if wired) — see implementation.
    ctx.config.infraRetryBackoffMs = 0;

    const result = await workOnIssueQualityGate(ctx, state, deps);

    assertEquals(
      result.status,
      "continue",
      "Retry should succeed, phase continues",
    );
    assertEquals(
      handleFailureCalls,
      0,
      "handleIssueFailure must NOT be called on success-after-retry",
    );
    assertEquals(state.infraRetryCounts?.quality_gate, 1);
  },
);

Deno.test(
  "qualityGate - zero_output failure on both attempts invokes handleIssueFailure exactly once",
  async () => {
    const ctx = makeContext();
    ctx.config.infraRetryBackoffMs = 0;
    const state = makeState();

    let handleFailureCalls = 0;

    const deps = createMockDeps({
      quality: {
        // Always fail with infrastructure output.
        runQualityGate: () =>
          Promise.resolve({
            ok: true,
            value: {
              checks: [],
              summary: { text: "failed", passed: false },
              passed: false,
              output: "zero output from subprocess",
            },
          }),
      },
      github: {
        handleIssueFailure: (() => {
          handleFailureCalls++;
          return Promise.resolve({
            ok: true,
            value: {
              markedAsFailed: false,
              markedAsFailedOnce: true,
              failureCategory: "zero_output",
              isInfrastructure: true,
            },
          });
        }) as never,
      },
    });

    const result = await workOnIssueQualityGate(ctx, state, deps);

    assertEquals(result.status, "failure");
    assertEquals(
      handleFailureCalls,
      1,
      "handleIssueFailure should be called exactly once after retry still fails",
    );
    assertEquals(state.infraRetryCounts?.quality_gate, 1);
  },
);

Deno.test(
  "qualityGate - quality_check (non-infrastructure) failure does NOT trigger retry",
  async () => {
    const ctx = makeContext();
    ctx.config.infraRetryBackoffMs = 0;
    const state = makeState();

    let qualityCalls = 0;
    let handleFailureCalls = 0;

    const deps = createMockDeps({
      quality: {
        runQualityGate: () => {
          qualityCalls++;
          return Promise.resolve({
            ok: true,
            value: {
              checks: [],
              summary: { text: "failed", passed: false },
              passed: false,
              // Plain quality.sh lint failure — category = quality_check.
              output: "quality.sh: 2 tests failed\nESLint: 3 errors",
            },
          });
        },
      },
      github: {
        handleIssueFailure: (() => {
          handleFailureCalls++;
          return Promise.resolve({
            ok: true,
            value: {
              markedAsFailed: false,
              markedAsFailedOnce: true,
              failureCategory: "quality_check",
              isInfrastructure: false,
            },
          });
        }) as never,
      },
    });

    const result = await workOnIssueQualityGate(ctx, state, deps);

    assertEquals(result.status, "failure");
    assertEquals(
      handleFailureCalls,
      1,
      "handleIssueFailure should be called for quality failures",
    );
    assertEquals(
      state.infraRetryCounts?.quality_gate,
      undefined,
      "Non-infrastructure failures must not consume an infra retry",
    );
    // Existing maxAttempts=2 loop: initial + 1 Claude fix = 2 quality runs.
    // With NO infra retry, we expect exactly 2 calls — not 4.
    assertEquals(
      qualityCalls,
      2,
      "quality gate should run only its existing 2 attempts, no extra infra retry",
    );
  },
);

// ---------------------------------------------------------------------------
// Integration — completion phase (push failure retry)
// ---------------------------------------------------------------------------

Deno.test(
  "completion - push_failure is retried once before being surfaced",
  async () => {
    const ctx = makeContext();
    ctx.config.infraRetryBackoffMs = 0;
    const state = makeState();

    let pushAttempts = 0;

    const deps = createMockDeps({
      git: {
        pushUnpushedCommits: (() => {
          pushAttempts++;
          // Every push attempt fails, AND recovery fails, so the phase
          // returns a push_failure failure. The infra retry wrapper should
          // re-run the phase once before surfacing the failure.
          return Promise.resolve({
            ok: false,
            error: new Error("Git push failed: remote rejected"),
          });
        }) as never,
        recoverFromPushRejection: () =>
          Promise.resolve({ ok: false, error: new Error("rebase conflict") }),
      },
    });

    const result = await workOnIssueCompletion(ctx, state, deps);

    assertEquals(result.status, "failure");
    assertEquals(
      state.infraRetryCounts?.completion,
      1,
      "Completion phase should record one infra retry",
    );
    // Phase body tries push + recovery-push = 2 attempts per invocation.
    // Infra retry re-invokes the phase body once = 4 push attempts total.
    assertEquals(
      pushAttempts,
      2,
      "Phase body runs twice (outer retry), each makes 1 initial push attempt",
    );
  },
);

Deno.test(
  "completion - push_failure recovered on retry avoids permanent failure",
  async () => {
    const ctx = makeContext();
    ctx.config.infraRetryBackoffMs = 0;
    const state = makeState();

    let pushPhaseInvocation = 0;

    const deps = createMockDeps({
      git: {
        pushUnpushedCommits: (() => {
          pushPhaseInvocation++;
          // Fail once, then succeed on the retry.
          if (pushPhaseInvocation === 1) {
            return Promise.resolve({
              ok: false,
              error: new Error("Git push failed: remote rejected"),
            });
          }
          return Promise.resolve({ ok: true, value: 1 });
        }) as never,
        // Disable the inner push recovery so the first invocation cleanly
        // fails and surfaces a push_failure category up to the outer retry.
        recoverFromPushRejection: () =>
          Promise.resolve({
            ok: false,
            error: new Error("skip inner recovery"),
          }),
      },
      github: {
        runGhCommand: () =>
          Promise.resolve("https://github.com/org/repo/pull/1"),
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR") }),
      },
    });

    const result = await workOnIssueCompletion(ctx, state, deps);

    assertEquals(
      result.status,
      "continue",
      "Retry should succeed and phase should continue",
    );
    assertEquals(state.infraRetryCounts?.completion, 1);
  },
);

// ---------------------------------------------------------------------------
// Integration — execute phase (Claude timeout / zero output)
// ---------------------------------------------------------------------------

Deno.test(
  "executeClaude - timeout (zero_output) is retried once before surfacing failure",
  async () => {
    const ctx = makeContext();
    ctx.config.infraRetryBackoffMs = 0;
    const state = makeState();

    let claudeCalls = 0;
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() => {
          claudeCalls++;
          return Promise.resolve({
            ok: true,
            value: {
              output: "",
              exitCode: 0,
              timedOut: true,
            },
          });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR") }),
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(result.status, "failure");
    assertEquals(
      state.infraRetryCounts?.execute,
      1,
      "Execute phase should record one infra retry on timeout",
    );
    assertEquals(
      claudeCalls,
      2,
      "Claude should be invoked once on the first attempt and once on the infra retry",
    );
  },
);
