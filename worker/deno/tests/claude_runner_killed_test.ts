/**
 * Tests for faithful exit-code evidence in `runClaudeWithRetry()`
 * (Issue #4202).
 *
 * Observed live on host-23: the agent process died at 539 s of a 3600 s budget
 * and the phase reported "Claude timed out exitCode=124". The run loop used to
 * remap ANY child exit of 124 or 137 to the timeout exit code and fabricate
 * `timedOut: true`, destroying the evidence — a SIGKILL from the VM's OOM
 * killer became indistinguishable from a genuine watchdog timeout.
 *
 * The contract these tests pin:
 * - `rawExitCode` always carries the child's true exit status.
 * - `timedOut` is true ONLY when a worker watchdog genuinely fired.
 * - A bare 137 (SIGKILL, no memory evidence, no watchdog) is classified
 *   `killed`, keeps exit 137, and is terminal at the runner level — the
 *   phase-level infrastructure retry owns any retry policy.
 * - A child that exits 124 by itself is reported faithfully as a plain
 *   non-zero exit, not claimed as a timeout.
 *
 * The clock is injected (PR #1170 follow-up). Three of these cases used to
 * sleep — 30 s of stub against a 1 s watchdog, 1.5 s before an orphan-making
 * self-kill, 1.2 s of memory-watch ticks — and a loaded host turns each of
 * those durations into a different test. Now the stub waits at a gate, the
 * test moves the runner's clock to the instant it wants, and every wake is
 * the test's decision.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { TIMEOUT_EXIT_CODE } from "../lib/claude_executor.ts";
import type { Logger } from "../types.ts";
import {
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
  withAgentStub,
} from "./support/agent_stub.ts";
import { type AgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import { DEFAULT_ORPHAN_COLLECTOR_DEPS } from "../lib/orphan_collector.ts";

// ---------------------------------------------------------------------------
// Stub harness — a fake agent, named by path (Issue #959), that records how
// many times it ran, prints a chosen final line, sleeps if asked, and exits
// with a chosen code.
// ---------------------------------------------------------------------------

/** Basename of the file the stub appends one line to per invocation. */
const RUN_LOG = "runs.log";

/** Basename of the file the orphan stub records its child's pid in. */
const PID_FILE = "child.pid";

interface StubClaude {
  /** Absolute path to the stub, passed to the runner as `agentBinaryPath`. */
  path: string;
  runLog: string;
  /** The stub itself, for {@link releaseAgentStub}. */
  stub: AgentStub;
}

/**
 * Run `fn` with a stub agent that logs its invocation, prints `lastLine` and
 * exits `exitCode`.
 *
 * With `gated`, it stops after printing and waits for
 * {@link releaseAgentStub} — the replacement for a `sleep` long enough to
 * outlast whatever watchdog the case is about. The test then drives the
 * watchdog on the injected clock and releases the agent (or never does, and
 * lets the kill find it).
 */
function withStub<T>(
  lastLine: string,
  exitCode: number,
  fn: (stub: StubClaude) => Promise<T>,
  gated = false,
): Promise<T> {
  // The run log is located from `$0`, so no path is baked into the body.
  const body = [
    `printf 'run\\n' >> "$(dirname "$0")/${RUN_LOG}"`,
    `printf '%s\\n' '{"type":"result","result":"${lastLine}"}'`,
    ...(gated ? [agentStubGate().trimEnd()] : []),
    `exit ${exitCode}`,
  ].join("\n");
  return withAgentStub(
    body,
    (stub) => fn({ path: stub.path, runLog: `${stub.dir}/${RUN_LOG}`, stub }),
    { prefix: "claude_killed_stub_" },
  );
}

/** Resolves when the runner has folded the agent's nth stdout chunk in. */
function chunkSignals() {
  const chunks: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let seen = 0;
  const at = (index: number) => (chunks[index] ??= Promise.withResolvers());
  return {
    onActivity: () => at(seen++).resolve(),
    chunk: (n: number) => at(n - 1).promise,
  };
}

/** Wait for a file the stub writes, so "the child got that far" is provable. */
async function waitForFile(path: string): Promise<string> {
  // Bounded so a stub that never writes fails the case rather than hanging
  // the suite; the poll is real time, which a busy host only lengthens.
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      const text = (await Deno.readTextFile(path)).trim();
      if (text.length > 0) return text;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the stub never wrote ${path}`);
}

async function readRunCount(runLog: string): Promise<number> {
  try {
    const text = await Deno.readTextFile(runLog);
    return text.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

// A retry config that allows three retries and waits for none of them, so a
// loop that wrongly entered the rate-limit path re-invokes the stub and the
// run log says so. The previous spelling used a 300 s first wait and proved
// the same point by the run finishing quickly — a wall-clock argument, and
// one the injected clock cannot make: a fake sleep nobody advances does not
// finish slowly, it does not finish at all. Counting invocations is the same
// claim stated as behaviour.
const NO_RETRY_WAIT = {
  maxRetries: 3,
  maxWaitSeconds: 600,
  initialWaitInterval: 0,
} as const;

const COMMON_OPTS = {
  prompt: "test",
  model: "sonnet",
  enableModelFallback: true,
  timeoutSeconds: 30,
  killAfterSeconds: 2,
} as const;

// ---------------------------------------------------------------------------
// (a) Bare SIGKILL: classified `killed`, exit preserved, no fabricated timeout
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - bare exit 137 is killed, not a timeout (Issue #4202)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Mid-work output with no memory evidence — the OOM-killer case: the
    // process is SIGKILLed and prints nothing about memory.
    const { result, runs } = await withStub(
      "Now wiring the production side",
      137,
      async (stub) => {
        const result = await runClaudeWithRetry(
          { ...COMMON_OPTS, clock: fakeClock(), agentBinaryPath: stub.path },
          NO_RETRY_WAIT,
        );
        return { result, runs: await readRunCount(stub.runLog) };
      },
    );

    assert(result.ok, `expected ok result, got ${!result.ok && result.error}`);
    if (!result.ok) return;

    assertEquals(result.value.killed, true);
    assertEquals(result.value.exitCode, 137);
    assertEquals(result.value.rawExitCode, 137);
    // The evidence is no longer destroyed: this was never a timeout.
    assertEquals(result.value.timedOut, false);
    assert(
      result.value.outOfMemory !== true,
      "no memory evidence — must not claim OOM",
    );
    // Terminal at the runner level: exactly one invocation, no retry wait.
    assertEquals(runs, 1);
  },
});

// ---------------------------------------------------------------------------
// (b) A child that exits 124 by itself is reported faithfully
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - a self-exited 124 is not claimed as a timeout (Issue #4202)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, runs } = await withStub(
      "internal wrapper exited",
      124,
      async (stub) => {
        const result = await runClaudeWithRetry(
          { ...COMMON_OPTS, clock: fakeClock(), agentBinaryPath: stub.path },
          NO_RETRY_WAIT,
        );
        return { result, runs: await readRunCount(stub.runLog) };
      },
    );

    assert(result.ok);
    if (!result.ok) return;

    assertEquals(result.value.exitCode, 124);
    assertEquals(result.value.rawExitCode, 124);
    assertEquals(result.value.timedOut, false);
    assert(result.value.killed !== true, "a self-exit is not a kill");
    assertEquals(runs, 1);
  },
});

// ---------------------------------------------------------------------------
// (c) A genuine watchdog timeout keeps timeout semantics AND the raw evidence
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - a genuine watchdog fire is a timeout carrying the raw exit (Issue #4202)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // The stub waits at the gate past the 1 s hard timeout, so the watchdog
    // kills it — at the instant the test moves the clock there, not whenever
    // a loaded host gets round to the timer.
    const { result, runs } = await withStub(
      "still working",
      0,
      async (stub) => {
        const clock = fakeClock();
        const signals = chunkSignals();
        const run = runClaudeWithRetry(
          {
            ...COMMON_OPTS,
            clock,
            agentBinaryPath: stub.path,
            timeoutSeconds: 1,
            killAfterSeconds: 1,
            onActivity: signals.onActivity,
          },
          NO_RETRY_WAIT,
        );
        await signals.chunk(1);
        await clock.advance(1_000);
        const result = await run;
        return { result, runs: await readRunCount(stub.runLog) };
      },
      true,
    );

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(runs, 1, "a watchdog timeout is terminal — no re-invocation");

    assertEquals(result.value.timedOut, true);
    assertEquals(result.value.timeoutReason, "hard-timeout");
    assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
    // The child's true exit status (a signal death from the watchdog's own
    // kill) survives alongside the classification.
    assertEquals(
      typeof result.value.rawExitCode,
      "number",
      "the raw exit status must be preserved on a watchdog timeout",
    );
    assert(result.value.killed !== true, "a watchdog fire is a timeout");
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a killed run carries its stderr evidence (Issue #4237)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // A V8 heap abort writes its FATAL ERROR to stderr; the killed
    // classification must carry that stream, not discard it — scanning
    // stdout alone misread the agent's own heap ceiling as an external kill.
    const stub = await createAgentStub(
      `echo '{"type":"result","result":"working"}'\necho "last words on stderr" >&2\nexit 137\n`,
      { prefix: "claude_killed_stderr_" },
    );
    try {
      const result = await runClaudeWithRetry(
        { ...COMMON_OPTS, clock: fakeClock(), agentBinaryPath: stub.path },
        NO_RETRY_WAIT,
      );
      assert(result.ok);
      if (!result.ok) return;
      assertEquals(result.value.killed, true);
      assert(
        (result.value.stderr ?? "").includes("last words on stderr"),
        `stderr evidence must survive: ${JSON.stringify(result.value.stderr)}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a heap abort on stderr classifies as OOM, not killed (Issue #4237)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await createAgentStub(
      `echo '{"type":"result","result":"working"}'\necho "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory" >&2\nexit 137\n`,
      { prefix: "claude_oom_stderr_" },
    );
    try {
      const result = await runClaudeWithRetry(
        { ...COMMON_OPTS, clock: fakeClock(), agentBinaryPath: stub.path },
        NO_RETRY_WAIT,
      );
      assert(result.ok);
      if (!result.ok) return;
      assertEquals(
        result.value.outOfMemory,
        true,
        "stderr evidence must reach the OOM detector",
      );
      assert(result.value.killed !== true);
    } finally {
      await stub.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// (e) The kill carries the memory-pressure reading (Issue #4374)
// ---------------------------------------------------------------------------

function capturingLogger(onWarn?: (message: string) => void): {
  logger: Logger;
  security: Array<{ event: string; details: string }>;
  warns: string[];
} {
  const security: Array<{ event: string; details: string }> = [];
  const warns: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (message) => {
      warns.push(message);
      onWarn?.(message);
    },
    error: () => {},
    debug: () => {},
    security: (event, details) => {
      security.push({ event, details });
    },
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, security, warns };
}

Deno.test({
  name:
    "runClaudeWithRetry - a killed run probes memory pressure, logs it beside AGENT_KILLED and carries the reading (Issue #4374)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { logger, security, warns } = capturingLogger();
    let probes = 0;
    const { result } = await withStub(
      "Running the full quality gate",
      137,
      async (stub) => {
        const result = await runClaudeWithRetry(
          {
            ...COMMON_OPTS,
            clock: fakeClock(),
            agentBinaryPath: stub.path,
            logger,
            probeMemoryPressure: () => {
              probes++;
              return Promise.resolve({
                level: "high" as const,
                totalBytes: 16 * 1024 ** 3,
                availableBytes: 512 * 1024 ** 2,
              });
            },
          },
          NO_RETRY_WAIT,
        );
        return { result, runs: await readRunCount(stub.runLog) };
      },
    );

    assert(result.ok, `expected ok result, got ${!result.ok && result.error}`);
    if (!result.ok) return;
    assertEquals(result.value.killed, true);
    // At least the kill-time probe; the #4384 memory watch may have probed
    // on a tick as well.
    assert(probes >= 1, "the probe runs at the kill");
    // The reading rides on the result so the phase can decide and report.
    assertEquals(result.value.memoryPressureAtKill?.level, "high");
    assertEquals(
      result.value.memoryPressureAtKill?.availableBytes,
      512 * 1024 ** 2,
    );
    // ...and beside the AGENT_KILLED security line, so the log itself is
    // the OOM evidence rather than an inference from exit 137.
    const killed = security.find((s) => s.event === "AGENT_KILLED");
    assert(killed, "AGENT_KILLED must be logged");
    assert(
      killed.details.includes("memory_pressure=high"),
      `AGENT_KILLED must carry the reading: ${killed.details}`,
    );
    assert(
      killed.details.includes("available_mib=512"),
      `AGENT_KILLED must carry the available memory: ${killed.details}`,
    );
    assert(
      warns.some((w) => w.includes("memory pressure: high")),
      `the warning names the pressure: ${JSON.stringify(warns)}`,
    );
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a killed run reports memory_pressure=unknown when the probe cannot read (Issue #4374)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { logger, security } = capturingLogger();
    const { result } = await withStub("mid-run", 137, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          ...COMMON_OPTS,
          clock: fakeClock(),
          agentBinaryPath: stub.path,
          logger,
          probeMemoryPressure: () => Promise.reject(new Error("no sysctl")),
        },
        NO_RETRY_WAIT,
      );
      return { result, runs: await readRunCount(stub.runLog) };
    });
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.killed, true);
    assertEquals(result.value.memoryPressureAtKill?.level, "unknown");
    const killed = security.find((s) => s.event === "AGENT_KILLED");
    assert(
      killed?.details.includes("memory_pressure=unknown"),
      killed?.details,
    );
  },
});

// ---------------------------------------------------------------------------
// (f) Orphaned descendants are collected after an external kill (Issue #4382)
// ---------------------------------------------------------------------------

async function pidAlive(pid: number): Promise<boolean> {
  const out = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return out.success;
}

Deno.test({
  name:
    "runClaudeWithRetry - a SIGKILLed agent's surviving descendant is collected and the kill diagnostics name it (Issue #4382)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // The stub emits one chunk, spawns a detached child that outlives it,
    // records its pid, emits a second chunk — which is what makes the runner
    // snapshot a tree that now HAS the descendant in it — and only then
    // SIGKILLs itself: the OOM-killer shape, no watchdog, exit 137, an orphan
    // left behind. Every step waits for the test, so the snapshot provably
    // lands between the spawn and the kill instead of inside a 1.5 s guess.
    const stub = await createAgentStub(
      [
        `printf '%s\\n' '{"type":"result","result":"working"}'`,
        `sleep 300 >/dev/null 2>&1 &`,
        `echo $! > "$(dirname "$0")/${PID_FILE}"`,
        agentStubGate("snapshot").trimEnd(),
        `printf '%s\\n' '{"type":"result","result":"still working"}'`,
        agentStubGate("die").trimEnd(),
        "kill -9 $$",
      ].join("\n"),
      { prefix: "claude_orphan_stub_" },
    );
    const pidFile = `${stub.dir}/${PID_FILE}`;
    let orphanPid = 0;
    try {
      const { logger, security, warns } = capturingLogger();
      const clock = fakeClock();
      const signals = chunkSignals();
      // The real descendant probe, wrapped only to say when it has seen the
      // descendant — the rendezvous the old `sleep 1.5` was standing in for.
      const sawDescendant = Promise.withResolvers<void>();
      const run = runClaudeWithRetry(
        {
          ...COMMON_OPTS,
          clock,
          agentBinaryPath: stub.path,
          logger,
          descendantSnapshotIntervalMs: 200,
          onActivity: signals.onActivity,
          orphanCollectorDeps: {
            ...DEFAULT_ORPHAN_COLLECTOR_DEPS,
            getDescendants: async (pid: number) => {
              const found = await DEFAULT_ORPHAN_COLLECTOR_DEPS.getDescendants(
                pid,
              );
              if (found.length > 0) sawDescendant.resolve();
              return found;
            },
          },
          probeMemoryPressure: () => Promise.resolve({ level: "ok" as const }),
        },
        NO_RETRY_WAIT,
      );
      await signals.chunk(1);
      orphanPid = Number(await waitForFile(pidFile));
      assert(orphanPid > 0, "the stub recorded its child's pid");
      // Past the chunk-driven snapshot throttle (a quarter of the interval),
      // so the next chunk requests a fresh snapshot rather than being skipped.
      await clock.advance(200);
      await releaseAgentStub(stub, "snapshot");
      await signals.chunk(2);
      await sawDescendant.promise;
      await releaseAgentStub(stub, "die");
      const result = await run;

      assert(
        result.ok,
        `expected ok result, got ${!result.ok && result.error}`,
      );
      if (!result.ok) return;
      assertEquals(result.value.killed, true);
      // The orphan is gone.
      assertEquals(
        await pidAlive(orphanPid),
        false,
        `orphan ${orphanPid} must have been collected`,
      );
      const collected = security.find((s) => s.event === "ORPHANS_COLLECTED");
      assert(
        collected,
        `ORPHANS_COLLECTED logged: ${JSON.stringify(security)}`,
      );
      assert(
        collected.details.includes(`${orphanPid}`) &&
          collected.details.includes("after=AGENT_KILLED"),
        collected.details,
      );
      // And the kill diagnostics carried the process table.
      assert(
        result.value.killDiagnostics?.includes("Top processes by RSS"),
        `diagnostics: ${result.value.killDiagnostics}`,
      );
      assert(
        warns.some((w) => w.startsWith("Kill diagnostics:")),
        `the diagnostics are logged at the kill: ${JSON.stringify(warns)}`,
      );
    } finally {
      if (orphanPid > 0) {
        await new Deno.Command("kill", {
          args: ["-9", String(orphanPid)],
          stdout: "null",
          stderr: "null",
        }).output().catch(() => {});
      }
      await stub.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// (g) Pre-kill evidence: high memory pressure during the run is logged with
//     the process table, rate-limited (Issue #4384)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - high memory pressure during the run logs a bounded process table, at most once per window (Issue #4384)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    let probes = 0;
    // The watch rides the descendant-snapshot tick, so the test simply moves
    // the clock two ticks on and releases the agent. The old spelling ran the
    // stub for 1.2 s and hoped at least two 100 ms ticks landed inside it.
    const firstWarn = Promise.withResolvers<void>();
    const { logger, warns } = capturingLogger((message) => {
      if (message.startsWith("Memory pressure high during the agent run")) {
        firstWarn.resolve();
      }
    });
    const { result } = await withStub("working", 0, async (stub) => {
      const clock = fakeClock();
      const signals = chunkSignals();
      const run = runClaudeWithRetry(
        {
          ...COMMON_OPTS,
          clock,
          agentBinaryPath: stub.path,
          logger,
          descendantSnapshotIntervalMs: 100,
          memoryWatchMinIntervalMs: 60_000,
          onActivity: signals.onActivity,
          probeMemoryPressure: () => {
            probes++;
            return Promise.resolve({
              level: "high" as const,
              totalBytes: 16 * 1024 ** 3,
              availableBytes: 700 * 1024 ** 2,
            });
          },
        },
        NO_RETRY_WAIT,
      );
      await signals.chunk(1);
      // First tick: pressure reads high, so the process table is logged.
      await clock.advance(100);
      await firstWarn.promise;
      // Second tick, well inside the 60 s window: probed again, logged once.
      await clock.advance(100);
      await releaseAgentStub(stub.stub);
      const result = await run;
      return { result, runs: await readRunCount(stub.runLog) };
    }, true);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(probes, 2, "the watch probes on every tick");
    const pressureWarns = warns.filter((w) =>
      w.startsWith("Memory pressure high during the agent run")
    );
    assertEquals(pressureWarns.length, 1, JSON.stringify(warns));
    assert(pressureWarns[0]!.includes("700 MiB of 16.0 GiB available"));
    assert(/pid=\d+/.test(pressureWarns[0]!), "the process table is attached");
  },
});

// ===========================================================================
// Issue #325 — an unkillable descendant must not hold the slot
// ===========================================================================

Deno.test({
  name:
    "runClaudeWithRetry #325 - a descendant holding stdout does not delay settling past the drain cap",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // The 2026-08-22 shape: the agent spawns a descendant that inherits
    // stdout and outlives it. The direct child dies, but the pipe never
    // reaches EOF, so the stream pumps never finish. Awaiting them as part of
    // "settled" held a pool slot for 2473s against a 120s cap — with both
    // slots held, the cycle could not end.
    //
    // Settling is now keyed on the child's *status*, which a dead child
    // reports promptly however long the pipe stays open. This asserts the
    // timing property directly: the run must return in far less than the time
    // the descendant lives.
    const stub = await createAgentStub(
      [
        `printf '%s\\n' '{"type":"result","result":"working"}'`,
        // The descendant inherits stdout and holds it for 60s. Crucially it
        // is NOT redirected, so the write end of the pipe stays open.
        "sleep 60 &",
        `echo $! > "$(dirname "$0")/${PID_FILE}"`,
        "exit 0",
      ].join("\n"),
      { prefix: "claude_pipe_holder_" },
    );
    const pidFile = `${stub.dir}/${PID_FILE}`;
    let holderPid = 0;
    try {
      const { logger } = capturingLogger();
      const clock = fakeClock();
      const signals = chunkSignals();
      const run = runClaudeWithRetry(
        {
          ...COMMON_OPTS,
          clock,
          agentBinaryPath: stub.path,
          logger,
          streamDrainCapSeconds: 2,
          onActivity: signals.onActivity,
          probeMemoryPressure: () => Promise.resolve({ level: "ok" as const }),
        },
        NO_RETRY_WAIT,
      );
      await signals.chunk(1);
      // The drain cap expires. Everything after this is the runner refusing
      // to wait on a pipe it will never see closed.
      await clock.advance(2_000);
      const result = await run;
      holderPid = Number(await waitForFile(pidFile));

      // A fast return is only evidence if the agent ran (Issue #959).
      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assert(
        result.value.output.includes("working"),
        `the stub must have run: ${JSON.stringify(result.value.output)}`,
      );
      // The behavioural form of "it did not wait": the pipe-holder is still
      // alive at the moment the run hands its result back. The old spelling
      // compared a real elapsed reading against 30 s, which says the same
      // thing only on a machine that happens to be idle.
      assertEquals(
        await pidAlive(holderPid),
        true,
        `the descendant still holds stdout, and the run returned anyway`,
      );
    } finally {
      if (holderPid > 0) {
        await new Deno.Command("kill", {
          args: ["-9", String(holderPid)],
          stdout: "null",
          stderr: "null",
        }).output().catch(() => {});
      }
      await stub.dispose();
    }
  },
});
