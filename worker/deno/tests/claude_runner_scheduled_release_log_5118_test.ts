/**
 * A scheduled release is not an ERROR in the runner's log (Issue #5118).
 *
 * When the finish deadline or the run hard cap stops a progressing run, the
 * watchdog's kill line ("Claude timed out after ...") used to be logged at
 * ERROR even though the run is released on schedule with its work preserved.
 * It now logs at INFO. Every other kill keeps ERROR.
 *
 * Drives the real `runClaudeWithTimeout` with an agent stub and a fake clock.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { WIP_CHECKPOINT_RESERVE_SECONDS } from "../lib/run_hard_cap.ts";
import {
  DEFAULT_RUN_FINISH_SECONDS,
  resetRunTimelineForTests,
  resolveRunTimeline,
  setRunTimeline,
} from "../lib/run_timeline.ts";
import { agentStubGate, createAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import type { Logger } from "../types.ts";

const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Edit","input":{"file_path":"worker/deno/lib/x.ts"}}]}}`;

function toolThenWait(): string {
  return `printf '%s\\n' '${TOOL_LINE}'\n` + agentStubGate();
}

interface Lines {
  logger: Logger;
  info: string[];
  warn: string[];
  error: string[];
}

function levelLogger(): Lines {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const logger = {
    info: (m: string) => info.push(m),
    warn: (m: string) => warn.push(m),
    error: (m: string) => error.push(m),
    debug: () => {},
  } as unknown as Logger;
  return { logger, info, warn, error };
}

const KILL_LINE = "Claude timed out after";

async function drive(
  ceilingLabel: "the finish deadline" | undefined,
  extension: boolean,
) {
  const stub = await createAgentStub(toolThenWait(), {
    prefix: "sched_release_log_",
  });
  const log = levelLogger();
  const clock = fakeClock();
  const first = Promise.withResolvers<void>();
  try {
    const run = runClaudeWithTimeout({
      clock,
      prompt: "test",
      agentBinaryPath: stub.path,
      timeoutSeconds: 1,
      killAfterSeconds: 1,
      logger: log.logger,
      onActivity: () => first.resolve(),
      progressIntervalMs: 86_400_000,
      descendantSnapshotIntervalMs: 86_400_000,
      ...(extension
        ? {
          progressExtension: {
            policy: {
              enabled: true,
              grantSeconds: 1,
              activityStallSeconds: 60,
            },
            treeProbe: () => Promise.resolve("advanced" as const),
            ceilingMs: clock.now() + 1_000,
            ...(ceilingLabel ? { ceilingLabel } : {}),
          },
        }
        : {}),
    });
    await first.promise;
    await clock.advance(1_000);
    const result = await run;
    assert(result.ok, "the runner must return a result");
    return { value: result.ok ? result.value : undefined, log };
  } finally {
    await stub.dispose();
  }
}

Deno.test({
  name:
    "runClaudeWithTimeout #5118 - a finish-deadline release logs its kill at INFO, with no ERROR",
  ignore: Deno.build.os === "windows",
  permissions: { run: true, read: true, write: true, env: true },
  async fn() {
    const { value, log } = await drive("the finish deadline", true);
    assertEquals(value?.scheduledRelease, "finish-deadline");
    assertEquals(value?.finishDeadline, true);
    assert(
      log.info.some((l) => l.startsWith(KILL_LINE)),
      `the kill line is at INFO: ${JSON.stringify(log.info)}`,
    );
    assertEquals(log.error, [], "no ERROR line for a scheduled release");
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout #5118 - a hard-cap release logs its kill at INFO, with no ERROR",
  ignore: Deno.build.os === "windows",
  permissions: { run: true, read: true, write: true, env: true },
  async fn() {
    const { value, log } = await drive(undefined, true);
    assertEquals(value?.scheduledRelease, "hard-cap");
    assert(
      log.info.some((l) => l.startsWith(KILL_LINE)),
      `the kill line is at INFO: ${JSON.stringify(log.info)}`,
    );
    assertEquals(log.error, [], "no ERROR line for a scheduled release");
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout #5118 - an own-budget timeout still logs its kill at ERROR (control)",
  ignore: Deno.build.os === "windows",
  permissions: { run: true, read: true, write: true, env: true },
  async fn() {
    const { value, log } = await drive(undefined, false);
    assertEquals(value?.scheduledRelease, undefined);
    assertEquals(value?.timedOut, true);
    assert(
      log.error.some((l) => l.startsWith(KILL_LINE)),
      `the kill line stays at ERROR: ${JSON.stringify(log.error)}`,
    );
  },
});

const CLAMP_STARTED_MS = 1_700_000_000_000;
const CLAMP_KILL_AFTER_SECONDS = 30;

for (const requested of [3600, 120]) {
  const bounded = requested === 3600;
  Deno.test({
    name: bounded
      ? "runClaudeWithTimeout #5118 - a session ended by the finish clamp logs its kill at INFO, with no ERROR"
      : "runClaudeWithTimeout #5118 - an own-budget timeout within the finish allowance still logs its kill at ERROR (control)",
    ignore: Deno.build.os === "windows",
    permissions: { run: true, read: true, write: true, env: true },
    async fn() {
      resetRunTimelineForTests();
      const clock = fakeClock(CLAMP_STARTED_MS + 110 * 60 * 1000);
      const finishMs = CLAMP_STARTED_MS + DEFAULT_RUN_FINISH_SECONDS * 1000;
      setRunTimeline(resolveRunTimeline({
        startedMs: CLAMP_STARTED_MS,
        runDurationSeconds: 3600,
        runFinishSeconds: DEFAULT_RUN_FINISH_SECONDS,
        env: () => undefined,
        killAfterSeconds: CLAMP_KILL_AFTER_SECONDS,
        warn: () => {},
      }));
      const allowed = Math.min(
        requested,
        600 - CLAMP_KILL_AFTER_SECONDS - WIP_CHECKPOINT_RESERVE_SECONDS,
      );
      assert(finishMs > clock.now());
      const stub = await createAgentStub(
        `printf '%s\\n' '{"type":"result","result":"still working"}'\n` +
          agentStubGate(),
        { prefix: "sched_release_log_clamp_" },
      );
      const log = levelLogger();
      const first = Promise.withResolvers<void>();
      try {
        const run = runClaudeWithTimeout({
          prompt: "test",
          timeoutSeconds: requested,
          killAfterSeconds: CLAMP_KILL_AFTER_SECONDS,
          clock,
          logger: log.logger,
          agentBinaryPath: stub.path,
          onActivity: () => first.resolve(),
          progressIntervalMs: 86_400_000,
          descendantSnapshotIntervalMs: 86_400_000,
        });
        await first.promise;
        await clock.advance(allowed * 1000);
        const result = await run;
        assert(result.ok, "the runner must return a result");
        if (!result.ok) return;
        assertEquals(result.value.timeoutReason, "hard-timeout");
        assertEquals(result.value.scheduledRelease, undefined);
        if (bounded) {
          assertEquals(result.value.finishDeadline, true);
          assert(
            log.info.some((l) => l.startsWith(KILL_LINE)),
            `the kill line is at INFO: ${JSON.stringify(log.info)}`,
          );
          assertEquals(log.error, [], "no ERROR line for the finish clamp");
        } else {
          assertEquals(result.value.finishDeadline, undefined);
          assert(
            log.error.some((l) => l.startsWith(KILL_LINE)),
            `the kill line stays at ERROR: ${JSON.stringify(log.error)}`,
          );
        }
      } finally {
        await stub.dispose();
        resetRunTimelineForTests();
      }
    },
  });
}
