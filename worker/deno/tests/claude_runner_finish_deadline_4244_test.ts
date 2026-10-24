/**
 * Every agent session is clamped to the run's finish deadline (Issue #4244).
 *
 * A session started late in the run must not outlive the finish. Its timeout
 * is the smaller of the one its caller asked for and the time left before the
 * finish, less the kill grace and the WIP checkpoint reserve. A session with
 * under MIN_AGENT_SESSION_SECONDS left is refused before anything is spawned.
 * A session that may run is told the deadline on the last line of its user
 * prompt, never in the system prompt, whose bytes the prompt cache keys on.
 *
 * The contract these tests pin:
 * - A clamped session logs its effective timeout and the clamp, and its
 *   prompt on stdin ends with the worker's deadline line.
 * - Under the floor, the session is not spawned and reports finishDeadline.
 * - A watchdog stop at the clamp reports finishDeadline; a stop at the
 *   session's own timeout does not.
 * - With no timeline set, nothing changes: the prompt, the timeout and the
 *   argv are exactly what the caller passed.
 * - The retry ladder does not retry, wait or fall back for a refused session.
 *
 * The timeline is process-wide, so every test resets it in a finally.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  runClaudeWithRetry,
  runClaudeWithTimeout,
} from "../lib/claude_runner.ts";
import { TIMEOUT_EXIT_CODE } from "../lib/claude_executor.ts";
import { WIP_CHECKPOINT_RESERVE_SECONDS } from "../lib/run_hard_cap.ts";
import {
  resetRunTimelineForTests,
  resolveRunTimeline,
  type RunTimeline,
  setRunTimeline,
} from "../lib/run_timeline.ts";
import type { Logger } from "../types.ts";
import { agentStubGate, withAgentStub } from "./support/agent_stub.ts";
import type { AgentStub } from "./support/agent_stub.ts";
import { FAKE_CLOCK_EPOCH_MS, fakeClock } from "./support/fake_clock.ts";

/** Basename of the file the stub records its argv in. */
const ARGV_LOG = "argv.log";
/** Basename of the file the stub records the bytes it read from stdin in. */
const STDIN_LOG = "stdin.txt";
/** Basename of the marker the stub touches if it was ever spawned. */
const SPAWNED_MARKER = "spawned";

/** The run's configured finish, in seconds from its start (two hours). */
const FINISH_SECONDS = 7200;
/** The kill grace the runner is given in these tests. */
const KILL_AFTER_SECONDS = 30;
/** The one-hour target, which these tests never reach. */
const TARGET_SECONDS = 3600;

/** The caller's own prompt; the worker note is appended to it when clamped. */
const PROMPT = "Refactor the widget — keep the tests green.\nSecond line.";

/**
 * A recording body: writes its argv and stdin to the stub directory, then
 * emits one stream-json result.
 */
const RECORDING_BODY = [
  `printf '%s\\n' "$@" > "$(dirname "$0")/${ARGV_LOG}"`,
  `cat > "$(dirname "$0")/${STDIN_LOG}"`,
  `printf '%s\\n' '{"type":"result","result":"done"}'`,
  "exit 0",
].join("\n");

/** Run `fn` with a recording stub (see {@link RECORDING_BODY}). */
function withRecordingStub<T>(
  fn: (stub: AgentStub) => Promise<T>,
): Promise<T> {
  return withAgentStub(RECORDING_BODY, fn, {
    prefix: "claude_finish_deadline_stub_",
  });
}

/** Read what a recording stub captured. */
async function readCapture(stub: AgentStub): Promise<{
  argv: string;
  stdin: string;
}> {
  return {
    argv: await Deno.readTextFile(`${stub.dir}/${ARGV_LOG}`),
    stdin: await Deno.readTextFile(`${stub.dir}/${STDIN_LOG}`),
  };
}

/** Whether a file exists. */
async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

/** A logger that keeps every line it is given, for assertions. */
function captureLogger(logs: string[]): Logger {
  const sink = (message: string) => {
    logs.push(message);
  };
  return {
    info: sink,
    warn: sink,
    error: sink,
    debug: () => undefined,
    security: () => undefined,
    skipReason: () => undefined,
    timing: () => undefined,
    scanSummary: () => undefined,
    workerSummary: () => undefined,
  } as unknown as Logger;
}

/**
 * The timeline the tests use: started at the fake clock's epoch, a one-hour
 * target and a two-hour finish, with no hard kill published so the finish is
 * not clamped by the hard kill. The environment is an empty reader, so the
 * real environment is never read.
 */
function testTimeline(): RunTimeline {
  return resolveRunTimeline({
    startedMs: FAKE_CLOCK_EPOCH_MS,
    runDurationSeconds: TARGET_SECONDS,
    runFinishSeconds: FINISH_SECONDS,
    env: () => undefined,
    killAfterSeconds: KILL_AFTER_SECONDS,
    warn: () => undefined,
  });
}

/** The seconds the clamp leaves a session started 1 h 50 m in. */
const CLAMPED_TIMEOUT_SECONDS = 600 - KILL_AFTER_SECONDS -
  WIP_CHECKPOINT_RESERVE_SECONDS;

Deno.test({
  name:
    "runClaudeWithTimeout - a session started late is clamped to the finish deadline and told it on the last prompt line (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const timeline = testTimeline();
    setRunTimeline(timeline);
    try {
      await withRecordingStub(async (stub) => {
        const logs: string[] = [];
        // 1 h 50 m in: 600 s to the finish, so the 3000 s request is clamped.
        const result = await runClaudeWithTimeout({
          clock: fakeClock(FAKE_CLOCK_EPOCH_MS + 6600_000),
          prompt: PROMPT,
          agentBinaryPath: stub.path,
          timeoutSeconds: 3000,
          killAfterSeconds: KILL_AFTER_SECONDS,
          logger: captureLogger(logs),
        });

        assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
        if (!result.ok) return;
        assertEquals(result.value.exitCode, 0);
        assertEquals(result.value.timedOut, false);
        assertEquals(result.value.finishDeadline, undefined);

        const finishIso = new Date(timeline.finishMs).toISOString();
        const line = logs.find((m) => m.startsWith("Running "));
        assert(line !== undefined, `no run line logged: ${logs.join(" | ")}`);
        assert(
          line.includes(`with ${CLAMPED_TIMEOUT_SECONDS}s timeout`),
          `the run line must carry the clamped timeout: ${line}`,
        );
        assert(
          line.includes(`claude_timeout=${CLAMPED_TIMEOUT_SECONDS}`),
          `the run line must carry claude_timeout: ${line}`,
        );
        assert(
          line.includes(`(clamped to finish deadline ${finishIso})`),
          `the run line must name the clamp: ${line}`,
        );

        const { stdin } = await readCapture(stub);
        assertEquals(
          stdin,
          `${PROMPT}\n\nWorker note: this run's finish deadline is ` +
            `${finishIso} (600s remaining). You must commit and push your ` +
            `work before then.`,
          "the prompt must be the original text plus the worker line",
        );
        assert(stdin.startsWith(PROMPT), "the original prompt leads");
        assert(stdin.endsWith("push your work before then."));
      });
    } finally {
      resetRunTimelineForTests();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a session with under the floor left is refused and never spawned (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const timeline = testTimeline();
    setRunTimeline(timeline);
    try {
      await withAgentStub(
        `touch "$(dirname "$0")/${SPAWNED_MARKER}"\n` +
          `printf '%s\\n' '{"type":"result","result":"should not run"}'\n`,
        async (stub) => {
          const logs: string[] = [];
          // 119 s of the finish left after the kill grace and WIP reserve:
          // finish - now = 269 s, reserve = 150 s.
          const result = await runClaudeWithTimeout({
            clock: fakeClock(FAKE_CLOCK_EPOCH_MS + 6931_000),
            prompt: PROMPT,
            agentBinaryPath: stub.path,
            timeoutSeconds: 3000,
            killAfterSeconds: KILL_AFTER_SECONDS,
            logger: captureLogger(logs),
          });

          assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
          if (!result.ok) return;
          assertEquals(result.value.finishDeadline, true);
          assertEquals(result.value.timedOut, false);
          assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
          assert(
            result.value.stderr.includes("only 119s left"),
            `the refusal must name the time left: ${result.value.stderr}`,
          );
          assert(
            logs.some((m) => m.includes("Refused to start the agent")),
            "the refusal must be logged as a warning",
          );
          assertEquals(
            await exists(`${stub.dir}/${SPAWNED_MARKER}`),
            false,
            "a refused session must never spawn the agent",
          );
        },
        { prefix: "claude_finish_deadline_refused_" },
      );
    } finally {
      resetRunTimelineForTests();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a watchdog stop at the finish clamp reports finishDeadline, a stop at the session's own timeout does not (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const timeline = testTimeline();
    setRunTimeline(timeline);
    try {
      // Clamped: the watchdog fires at the clamped timeout, not the request.
      await withAgentStub(
        `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
          agentStubGate(),
        async (stub) => {
          const clock = fakeClock(FAKE_CLOCK_EPOCH_MS + 6600_000);
          const firstChunk = Promise.withResolvers<void>();
          const run = runClaudeWithTimeout({
            clock,
            prompt: PROMPT,
            agentBinaryPath: stub.path,
            timeoutSeconds: 3000,
            killAfterSeconds: KILL_AFTER_SECONDS,
            streamDrainCapSeconds: 1000,
            onActivity: () => firstChunk.resolve(),
          });
          // The agent is up and the watchdog is armed at the clamp.
          await firstChunk.promise;
          await clock.advance(CLAMPED_TIMEOUT_SECONDS * 1000);
          const result = await run;

          assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
          if (!result.ok) return;
          assertEquals(result.value.timedOut, true);
          assertEquals(result.value.timeoutReason, "hard-timeout");
          assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
          assertEquals(
            result.value.finishDeadline,
            true,
            "a stop at the clamp is a finish-deadline stop",
          );
        },
        { prefix: "claude_finish_deadline_clamped_stop_" },
      );

      // Not clamped: plenty of time to the finish, so the same watchdog fires
      // at the session's own requested timeout and reports no finish deadline.
      await withAgentStub(
        `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
          agentStubGate(),
        async (stub) => {
          const clock = fakeClock(FAKE_CLOCK_EPOCH_MS);
          const firstChunk = Promise.withResolvers<void>();
          const run = runClaudeWithTimeout({
            clock,
            prompt: PROMPT,
            agentBinaryPath: stub.path,
            timeoutSeconds: 100,
            killAfterSeconds: KILL_AFTER_SECONDS,
            streamDrainCapSeconds: 1000,
            onActivity: () => firstChunk.resolve(),
          });
          await firstChunk.promise;
          await clock.advance(100_000);
          const result = await run;

          assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
          if (!result.ok) return;
          assertEquals(result.value.timedOut, true);
          assertEquals(result.value.timeoutReason, "hard-timeout");
          assertEquals(
            result.value.finishDeadline,
            undefined,
            "a stop at the session's own timeout carries no finish-deadline flag",
          );
        },
        { prefix: "claude_finish_deadline_own_stop_" },
      );
    } finally {
      resetRunTimelineForTests();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - with no timeline set, the prompt, timeout and log are exactly the caller's (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    resetRunTimelineForTests();
    try {
      await withRecordingStub(async (stub) => {
        const logs: string[] = [];
        // The clock is late in what would be the run, but no timeline exists,
        // so nothing may clamp.
        const result = await runClaudeWithTimeout({
          clock: fakeClock(FAKE_CLOCK_EPOCH_MS + 6600_000),
          prompt: PROMPT,
          agentBinaryPath: stub.path,
          timeoutSeconds: 3000,
          killAfterSeconds: KILL_AFTER_SECONDS,
          logger: captureLogger(logs),
        });

        assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
        if (!result.ok) return;
        assertEquals(result.value.finishDeadline, undefined);
        assertEquals(result.value.timedOut, false);

        const { stdin } = await readCapture(stub);
        assertEquals(
          stdin,
          PROMPT,
          "the prompt must reach the agent unchanged",
        );

        const line = logs.find((m) => m.startsWith("Running "));
        assert(line !== undefined, `no run line logged: ${logs.join(" | ")}`);
        assert(
          line.includes("with 3000s timeout (30s grace period)"),
          `the run line must carry the requested timeout: ${line}`,
        );
        // The argv-side claude_timeout segment predates #4244 and reads the
        // requested value; what must be absent is any clamp.
        assert(
          !/claude_timeout=(?!3000\b)/.test(line),
          `claude_timeout must be the requested value: ${line}`,
        );
        assert(!line.includes("clamped"), `no clamp note: ${line}`);
      });
    } finally {
      resetRunTimelineForTests();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - the system prompt and argv are byte-identical with and without a timeline (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const systemPrompt = "You are the Vibe Coder agent. Stable system bytes.";
    const invoke = (clock: ReturnType<typeof fakeClock>, stub: AgentStub) =>
      runClaudeWithTimeout({
        clock,
        prompt: PROMPT,
        systemPrompt,
        agentBinaryPath: stub.path,
        timeoutSeconds: 3000,
        killAfterSeconds: KILL_AFTER_SECONDS,
      });

    // With a timeline, late in the run, so the session is clamped and the
    // prompt changes; the system prompt and argv must not.
    let withTimelineArgv = "";
    let withTimelineStdin = "";
    setRunTimeline(testTimeline());
    try {
      await withRecordingStub(async (stub) => {
        const result = await invoke(
          fakeClock(FAKE_CLOCK_EPOCH_MS + 6600_000),
          stub,
        );
        assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
        const capture = await readCapture(stub);
        withTimelineArgv = capture.argv;
        withTimelineStdin = capture.stdin;
      });
    } finally {
      resetRunTimelineForTests();
    }

    let withoutTimelineArgv = "";
    let withoutTimelineStdin = "";
    await withRecordingStub(async (stub) => {
      const result = await invoke(
        fakeClock(FAKE_CLOCK_EPOCH_MS + 6600_000),
        stub,
      );
      assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
      const capture = await readCapture(stub);
      withoutTimelineArgv = capture.argv;
      withoutTimelineStdin = capture.stdin;
    });

    assert(
      withoutTimelineArgv.includes(systemPrompt),
      `the system prompt must reach argv: ${withoutTimelineArgv}`,
    );
    assertEquals(
      withTimelineArgv,
      withoutTimelineArgv,
      "argv must be identical with and without a timeline",
    );
    assert(
      withTimelineStdin.startsWith(PROMPT) &&
        withTimelineStdin !== withoutTimelineStdin,
      "only the user prompt on stdin may differ",
    );
    assertEquals(withoutTimelineStdin, PROMPT);
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a refused session returns finishDeadline after one attempt, with no retry, wait or spawn (Issue #4244)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    setRunTimeline(testTimeline());
    try {
      await withAgentStub(
        `touch "$(dirname "$0")/${SPAWNED_MARKER}"\n` +
          `printf '%s\\n' '{"type":"result","result":"should not run"}'\n`,
        async (stub) => {
          // 119 s left: refused. A retry would wait on the fake clock, which
          // only moves when advanced, so a retry would hang rather than pass.
          const result = await runClaudeWithRetry(
            {
              clock: fakeClock(FAKE_CLOCK_EPOCH_MS + 6931_000),
              prompt: PROMPT,
              agentBinaryPath: stub.path,
              model: "sonnet",
              enableModelFallback: false,
              timeoutSeconds: 3000,
              killAfterSeconds: KILL_AFTER_SECONDS,
            },
            { maxRetries: 2, maxWaitSeconds: 1, initialWaitInterval: 1 },
          );

          assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
          if (!result.ok) return;
          assertEquals(result.value.finishDeadline, true);
          assertEquals(result.value.timedOut, false);
          assertEquals(
            result.value.invocationsBilled,
            1,
            "exactly one attempt: the refused session is not retried",
          );
          assertEquals(
            await exists(`${stub.dir}/${SPAWNED_MARKER}`),
            false,
            "the refused session must never spawn the agent",
          );
        },
        { prefix: "claude_finish_deadline_ladder_" },
      );
    } finally {
      resetRunTimelineForTests();
    }
  },
});
