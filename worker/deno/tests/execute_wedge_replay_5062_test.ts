/**
 * Bounded replay of the Issue #5062 wedge through the real runner.
 *
 * Both incidents had one shape: the worker's last step was the issue `agent
 * turn`, the agent's stream went silent (about 49 min and 54m 20s), and the
 * launcher watchdog reaped the container because the issue run never armed
 * the runner's no-output (silence) watchdog. The host incident archive was
 * not reachable, so this replays that shape instead of the recorded logs:
 *
 * 1. the issue run's runner options are built the way production builds them
 *    — `workOnIssueExecuteClaude` with mock deps — and captured where they are
 *    handed to `runClaudeWithRetry`;
 * 2. the captured `noOutputTimeout` is fed into the real `runClaudeWithTimeout`
 *    with a stub agent that prints one stream-json line and then blocks
 *    silently, on a fake clock (no real sleeps);
 * 3. the outcome is asserted: killed in-container by the silence watchdog,
 *    long before the hard deadline that stands in for the launcher's.
 *
 * A control replays the same silent stub with `noOutputTimeout` undefined —
 * what the base code passed — and shows the run only ends at the hard
 * deadline.
 *
 * Out of scope: a frozen guest (the launcher's guest probe "did not answer")
 * cannot be reproduced in-process. The launcher watchdog remains that
 * backstop.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";
import {
  runClaudeWithTimeout,
  TIMEOUT_EXIT_CODE,
} from "../lib/claude_runner.ts";
import { agentStubGate, withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import { createLogger } from "../lib/logger.ts";

/** The configured silence budget for the replay, in seconds. */
const NO_OUTPUT_SECONDS = 5;

/**
 * The hard budget, in seconds — the stand-in for the launcher deadline that
 * reaped the container (the incidents went silent for ~49 and ~54 minutes).
 */
const LAUNCHER_DEADLINE_SECONDS = 3_600;

/**
 * The agent's activity in the incident: one stream-json event (a tool call
 * starting), then silence for good. The gate is never released, so the stub
 * only ends when the runner kills it.
 */
const SILENT_AFTER_ONE_LINE_STUB =
  `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"cargo test"}}]}}'\n` +
  agentStubGate();

/**
 * Drive the issue run as production does and return the options it handed to
 * `runClaudeWithRetry` (the pattern of `execute_phase_routing_test.ts`).
 */
async function captureIssueRunnerCalls(
  config: WorkerConfig,
): Promise<Array<Record<string, unknown>>> {
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 5062,
    issueTitle: "Wedged agent turn",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-5062-wedged-agent-turn",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const seen: Array<Record<string, unknown>> = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: Record<string, unknown>) => {
        seen.push(options);
        return Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });
  await workOnIssueExecuteClaude(ctx, state, deps);
  return seen;
}

Deno.test({
  name:
    "replay (Issue #5062) - a silent issue agent turn is killed in-container by the no-output watchdog",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // The worker's last operation: the issue agent turn, built by production.
    const seen = await captureIssueRunnerCalls({
      ...buildDefaultWorkerConfig(),
      claudeNoOutputTimeout: NO_OUTPUT_SECONDS,
    });
    assert(seen.length >= 1, "the issue run must reach the runner");
    const issueTurn = seen[0]!;
    assertEquals(issueTurn.phase, "issue");
    const noOutputTimeout = issueTurn.noOutputTimeout as number | undefined;

    // The agent's activity: one stream-json line, then silence. Only the
    // silence budget moves first; the hard deadline is an hour away.
    const result = await withAgentStub(
      SILENT_AFTER_ONE_LINE_STUB,
      async (stub) => {
        const clock = fakeClock();
        const firstLine = Promise.withResolvers<void>();
        const logLines: string[] = [];
        const run = runClaudeWithTimeout({
          clock,
          prompt: "replay",
          agentBinaryPath: stub.path,
          timeoutSeconds: LAUNCHER_DEADLINE_SECONDS,
          killAfterSeconds: 2,
          ...(noOutputTimeout !== undefined ? { noOutputTimeout } : {}),
          onActivity: () => firstLine.resolve(),
          logger: createLogger({
            write: (line) => logLines.push(line),
            host: "",
          }),
        });
        // The one line has landed (re-arming any silence watchdog) and the
        // hard watchdog is up — only now does time move.
        await firstLine.promise;
        await clock.armedFor(LAUNCHER_DEADLINE_SECONDS * 1000);
        await clock.advance(NO_OUTPUT_SECONDS * 1000);
        // The silence kill logs synchronously as it fires. If it did not fire
        // (the watchdog was never armed — the incident), run on to the hard
        // deadline so the replay ends, bounded, and the outcome below says
        // which watchdog reaped the agent instead of the test hanging.
        if (!logLines.some((line) => line.includes("produced no output"))) {
          await clock.advance(
            (LAUNCHER_DEADLINE_SECONDS - NO_OUTPUT_SECONDS) * 1000,
          );
        }
        return await run;
      },
      { prefix: "replay_5062_" },
    );

    // The outcome: killed by the silence watchdog, not the hard deadline.
    assert(
      result.ok,
      `expected ok result, got ${!result.ok && result.error.message}`,
    );
    if (!result.ok) return;
    assertEquals(result.value.timedOut, true);
    assertEquals(
      result.value.timeoutReason,
      "no-output",
      "the silent issue agent turn must be killed in-container by the " +
        "no-output watchdog, not left to the hard (launcher) deadline",
    );
    assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
  },
});

Deno.test({
  name:
    "replay (Issue #5062) - control: without noOutputTimeout the silent turn runs to the hard deadline",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // What the base code passed: no `noOutputTimeout` at all.
    const result = await withAgentStub(
      SILENT_AFTER_ONE_LINE_STUB,
      async (stub) => {
        const clock = fakeClock();
        const firstLine = Promise.withResolvers<void>();
        let settled = false;
        const run = runClaudeWithTimeout({
          clock,
          prompt: "replay",
          agentBinaryPath: stub.path,
          timeoutSeconds: LAUNCHER_DEADLINE_SECONDS,
          killAfterSeconds: 2,
          onActivity: () => firstLine.resolve(),
        }).finally(() => {
          settled = true;
        });
        await firstLine.promise;
        await clock.armedFor(LAUNCHER_DEADLINE_SECONDS * 1000);
        // Well past the silence budget, nothing fires: the run is still
        // going, exactly as the wedged containers were.
        await clock.advance(NO_OUTPUT_SECONDS * 1000 * 10);
        assertEquals(
          settled,
          false,
          "nothing may end the run before the hard deadline",
        );
        // Only the hard deadline ends it.
        await clock.advance(
          LAUNCHER_DEADLINE_SECONDS * 1000 - NO_OUTPUT_SECONDS * 1000 * 10,
        );
        return await run;
      },
      { prefix: "replay_5062_" },
    );

    assert(
      result.ok,
      `expected ok result, got ${!result.ok && result.error.message}`,
    );
    if (!result.ok) return;
    assertEquals(result.value.timedOut, true);
    // `timedOut` latches on the first watchdog to fire, so "hard-timeout"
    // proves the silence watchdog never fired along the way.
    assertEquals(result.value.timeoutReason, "hard-timeout");
    assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
  },
});
