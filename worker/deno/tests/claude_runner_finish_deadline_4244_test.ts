/**
 * Agent sessions are clamped to the two-hour finish deadline (Issue #4244).
 *
 * The clock is injected. A session started at 1 h 50 m is given no more time
 * than the finish deadline leaves after the kill grace and the WIP reserve,
 * and the user prompt — never the system prompt — states that deadline.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { TIMEOUT_EXIT_CODE } from "../lib/claude_executor.ts";
import { WIP_CHECKPOINT_RESERVE_SECONDS } from "../lib/run_hard_cap.ts";
import {
  DEFAULT_RUN_FINISH_SECONDS,
  resetRunTimelineForTests,
  resolveRunTimeline,
  setRunTimeline,
} from "../lib/run_timeline.ts";
import type { Logger } from "../types.ts";
import { createAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const STARTED_MS = 1_700_000_000_000;
const KILL_AFTER_SECONDS = 30;
const REQUESTED_TIMEOUT_SECONDS = 3600;
const SYSTEM_PROMPT = "system-prompt-bytes-v1";
const USER_PROMPT = "user-prompt-bytes-v1";

function capturingLogger(lines: string[]): Logger {
  const push = (message: string) => lines.push(message);
  return {
    info: push,
    warn: push,
    error: push,
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

/** A timeline whose finish is `finishMs`, with no hard-kill clamp. */
function publishTimeline(finishMs: number): void {
  setRunTimeline(resolveRunTimeline({
    startedMs: finishMs - DEFAULT_RUN_FINISH_SECONDS * 1000,
    runDurationSeconds: 3600,
    runFinishSeconds: DEFAULT_RUN_FINISH_SECONDS,
    env: () => undefined,
    killAfterSeconds: KILL_AFTER_SECONDS,
    warn: () => {},
  }));
}

/** Stub that records argv and stdin, prints one result line, and exits 0. */
function recordingStubBody(dirToken: string): string {
  return [
    `printf '%s\\n' "$@" > "$(dirname "$0")/${dirToken}.argv"`,
    `cat > "$(dirname "$0")/${dirToken}.stdin"`,
    `printf '%s\\n' '{"type":"result","result":"done"}'`,
    "exit 0",
  ].join("\n");
}

Deno.test({
  name:
    "runClaudeWithTimeout - a session at 1h 50m is clamped to the finish deadline and the user prompt states it (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    resetRunTimelineForTests();
    const clock = fakeClock(STARTED_MS + 110 * 60 * 1000);
    const now = clock.now();
    const finishMs = STARTED_MS + DEFAULT_RUN_FINISH_SECONDS * 1000;
    publishTimeline(finishMs);
    const lines: string[] = [];
    const stub = await createAgentStub(recordingStubBody("clamp"), {
      prefix: "finish_deadline_clamp_",
    });
    try {
      const result = await runClaudeWithTimeout({
        prompt: USER_PROMPT,
        systemPrompt: SYSTEM_PROMPT,
        timeoutSeconds: REQUESTED_TIMEOUT_SECONDS,
        killAfterSeconds: KILL_AFTER_SECONDS,
        clock,
        agentBinaryPath: stub.path,
        logger: capturingLogger(lines),
        progressIntervalMs: 86_400_000,
        descendantSnapshotIntervalMs: 86_400_000,
      });
      assert(result.ok, `expected a run, got ${!result.ok && result.error}`);
      if (!result.ok) return;
      const allowed = 600 - KILL_AFTER_SECONDS -
        WIP_CHECKPOINT_RESERVE_SECONDS;
      const running = lines.find((line) => line.startsWith("Running "));
      assert(running, lines.join("\n"));
      const logged = Number(running.match(/with (\d+)s timeout/)?.[1]);
      assert(logged <= allowed, `timeout ${logged}s exceeds ${allowed}s`);
      assertStringIncludes(
        running,
        `(clamped to finish deadline ${new Date(finishMs).toISOString()})`,
      );
      const stdin = await Deno.readTextFile(`${stub.dir}/clamp.stdin`);
      assert(
        stdin.endsWith(
          `Finish deadline: ${new Date(finishMs).toISOString()} (${
            Math.floor((finishMs - now) / 1000)
          } seconds remaining). Commit and push your work before then.`,
        ),
        stdin,
      );
      assert(stdin.startsWith(USER_PROMPT), stdin);
      const argv = await Deno.readTextFile(`${stub.dir}/clamp.argv`);
      const systemAt = argv.split("\n").indexOf("--system-prompt");
      assert(systemAt >= 0, argv);
      assertEquals(argv.split("\n")[systemAt + 1], SYSTEM_PROMPT);
    } finally {
      await stub.dispose();
      resetRunTimelineForTests();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - less than the minimum session is not spawned and carries finishDeadline (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    resetRunTimelineForTests();
    const clock = fakeClock(
      STARTED_MS + DEFAULT_RUN_FINISH_SECONDS * 1000 - 30_000,
    );
    publishTimeline(STARTED_MS + DEFAULT_RUN_FINISH_SECONDS * 1000);
    const stub = await createAgentStub(
      `printf 'ran\\n' > "$(dirname "$0")/ran"; exit 0`,
      { prefix: "finish_deadline_refuse_" },
    );
    try {
      const result = await runClaudeWithTimeout({
        prompt: USER_PROMPT,
        systemPrompt: SYSTEM_PROMPT,
        timeoutSeconds: REQUESTED_TIMEOUT_SECONDS,
        killAfterSeconds: KILL_AFTER_SECONDS,
        clock,
        agentBinaryPath: stub.path,
      });
      assert(
        result.ok,
        `expected a typed result, got ${!result.ok && result.error}`,
      );
      if (!result.ok) return;
      assertEquals(result.value.finishDeadline, true);
      assertEquals(result.value.timedOut, true);
      assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
      let ran = false;
      try {
        await Deno.stat(`${stub.dir}/ran`);
        ran = true;
      } catch {
        ran = false;
      }
      assertEquals(ran, false);
    } finally {
      await stub.dispose();
      resetRunTimelineForTests();
    }
  },
});

for (
  const { requested, finalSetupSeconds } of [
    { requested: REQUESTED_TIMEOUT_SECONDS, finalSetupSeconds: 0 },
    { requested: 120, finalSetupSeconds: 0 },
    { requested: 400, finalSetupSeconds: 60 },
  ]
) {
  Deno.test({
    name: finalSetupSeconds > 0
      ? "runClaudeWithTimeout - synchronous final preparation carries the absolute finish clamp into the result (Issue #4244)"
      : requested === REQUESTED_TIMEOUT_SECONDS
      ? "runClaudeWithTimeout - a session ended by the finish clamp carries finishDeadline (Issue #4244)"
      : "runClaudeWithTimeout - an own-budget timeout within the finish allowance is not a scheduled release (Issue #4244)",
    permissions: { run: true, read: true, write: true, env: true },
    ignore: Deno.build.os === "windows",
    async fn() {
      resetRunTimelineForTests();
      // 1 h 50 m, so the clamp is 600 − kill grace − reserve, long enough to
      // spawn and short enough that the injected clock can fire it.
      const timers = fakeClock(STARTED_MS + 110 * 60 * 1000);
      let setupElapsedMs = 0;
      const clock = { ...timers, now: () => timers.now() + setupElapsedMs };
      const finishMs = STARTED_MS + DEFAULT_RUN_FINISH_SECONDS * 1000;
      publishTimeline(finishMs);
      const allowed = Math.min(
        requested,
        600 - finalSetupSeconds - KILL_AFTER_SECONDS -
          WIP_CHECKPOINT_RESERVE_SECONDS,
      );
      const stub = await createAgentStub(
        [
          `printf '%s\\n' '{"type":"result","result":"still working"}'`,
          // Block until the watchdog kills the process.
          `while [ ! -f "$(dirname "$0")/go" ]; do sleep 0.05; done`,
          "exit 0",
        ].join("\n"),
        { prefix: "finish_deadline_kill_" },
      );
      try {
        const signals = (() => {
          let seen = 0;
          const chunks: ReturnType<typeof Promise.withResolvers<void>>[] = [];
          const at = (
            index: number,
          ) => (chunks[index] ??= Promise.withResolvers());
          return {
            onActivity: () => at(seen++).resolve(),
            chunk: (n: number) => at(n - 1).promise,
          };
        })();
        const run = runClaudeWithTimeout({
          prompt: USER_PROMPT,
          timeoutSeconds: requested,
          killAfterSeconds: KILL_AFTER_SECONDS,
          clock,
          logger: {
            ...capturingLogger([]),
            info: (message) => {
              // The last preparation log is synchronous and precedes spawn.
              if (message.startsWith("Prompt file:")) {
                setupElapsedMs = finalSetupSeconds * 1000;
              }
            },
          },
          agentBinaryPath: stub.path,
          onActivity: signals.onActivity,
          progressIntervalMs: 86_400_000,
          descendantSnapshotIntervalMs: 86_400_000,
        });
        await signals.chunk(1);
        await clock.advance(allowed * 1000);
        const result = await run;
        assert(result.ok, `expected a run, got ${!result.ok && result.error}`);
        if (!result.ok) return;
        assertEquals(result.value.timedOut, true);
        assertEquals(result.value.timeoutReason, "hard-timeout");
        assertEquals(
          result.value.finishDeadline,
          requested > allowed ? true : undefined,
        );
      } finally {
        await stub.dispose();
        resetRunTimelineForTests();
      }
    },
  });
}

Deno.test({
  name:
    "runClaudeWithTimeout - with no timeline the prompt, arguments and timeout are unchanged (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    resetRunTimelineForTests();
    const lines: string[] = [];
    const clock = fakeClock(STARTED_MS);
    const stub = await createAgentStub(recordingStubBody("plain"), {
      prefix: "finish_deadline_plain_",
    });
    try {
      const result = await runClaudeWithTimeout({
        prompt: USER_PROMPT,
        systemPrompt: SYSTEM_PROMPT,
        timeoutSeconds: 42,
        killAfterSeconds: KILL_AFTER_SECONDS,
        clock,
        agentBinaryPath: stub.path,
        logger: capturingLogger(lines),
      });
      assert(result.ok);
      if (!result.ok) return;
      assertEquals(result.value.finishDeadline, undefined);
      const running = lines.find((line) => line.startsWith("Running "));
      assert(running, lines.join("\n"));
      assertStringIncludes(running, "with 42s timeout");
      assert(!running.includes("clamped to finish deadline"), running);
      const stdin = await Deno.readTextFile(`${stub.dir}/plain.stdin`);
      assertEquals(stdin, USER_PROMPT);
    } finally {
      await stub.dispose();
      resetRunTimelineForTests();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - the system prompt is byte-identical with and without a timeline (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const systemArg = async (withTimeline: boolean): Promise<string> => {
      resetRunTimelineForTests();
      if (withTimeline) {
        publishTimeline(STARTED_MS + DEFAULT_RUN_FINISH_SECONDS * 1000);
      }
      const stub = await createAgentStub(recordingStubBody("sys"), {
        prefix: "finish_deadline_sys_",
      });
      try {
        const result = await runClaudeWithTimeout({
          prompt: USER_PROMPT,
          systemPrompt: SYSTEM_PROMPT,
          timeoutSeconds: 42,
          killAfterSeconds: 2,
          clock: fakeClock(STARTED_MS),
          agentBinaryPath: stub.path,
        });
        assert(result.ok);
        const argv = (await Deno.readTextFile(`${stub.dir}/sys.argv`)).split(
          "\n",
        );
        const at = argv.indexOf("--system-prompt");
        assert(at >= 0, argv.join("\n"));
        return argv[at + 1] ?? "";
      } finally {
        await stub.dispose();
        resetRunTimelineForTests();
      }
    };
    const without = await systemArg(false);
    const withTimeline = await systemArg(true);
    assertEquals(withTimeline, without);
    assertEquals(withTimeline, SYSTEM_PROMPT);
  },
});

for (const remainingSeconds of [300, 600]) {
  Deno.test({
    name:
      `runClaudeWithTimeout - preparation consumes the finish budget (${remainingSeconds}s remaining)`,
    permissions: { run: true, read: true, write: true, env: true },
    ignore: Deno.build.os === "windows",
    async fn() {
      resetRunTimelineForTests();
      const clock = fakeClock(STARTED_MS);
      const finishMs = STARTED_MS + remainingSeconds * 1000;
      publishTimeline(finishMs);
      const lines: string[] = [];
      const agent = await createAgentStub(recordingStubBody("prepared"), {
        prefix: "finish_prepare_",
      });
      const makeTempFile = Deno.makeTempFile;
      let preparationDelayed = false;
      Deno.makeTempFile = async (options) => {
        const path = await makeTempFile(options);
        if (options?.prefix === "vibe-agent-prompt-") {
          preparationDelayed = true;
          await clock.advance(60_000);
        }
        return path;
      };
      try {
        const result = await runClaudeWithTimeout({
          prompt: USER_PROMPT,
          systemPrompt: SYSTEM_PROMPT,
          timeoutSeconds: REQUESTED_TIMEOUT_SECONDS,
          killAfterSeconds: KILL_AFTER_SECONDS,
          clock,
          agentBinaryPath: agent.path,
          logger: capturingLogger(lines),
        });
        assert(
          preparationDelayed,
          "the async prompt-file setup must consume time",
        );
        assert(result.ok);
        if (!result.ok) return;
        if (remainingSeconds === 300) {
          assertEquals(result.value.finishDeadline, true);
          assertEquals(result.value.timedOut, true);
          let spawned = false;
          try {
            await Deno.stat(`${agent.dir}/prepared.argv`);
            spawned = true;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          assertEquals(
            spawned,
            false,
            "90 usable seconds is below the session floor",
          );
        } else {
          const running = lines.find((line) => line.startsWith("Running ")) ??
            "";
          assertStringIncludes(running, "with 390s timeout");
          const prompt = await Deno.readTextFile(`${agent.dir}/prepared.stdin`);
          assertStringIncludes(prompt, "540 seconds remaining");
        }
      } finally {
        Deno.makeTempFile = makeTempFile;
        await agent.dispose();
        resetRunTimelineForTests();
      }
    },
  });
}
