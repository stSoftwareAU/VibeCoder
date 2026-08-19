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
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { TIMEOUT_EXIT_CODE } from "../lib/claude_executor.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Stub harness — a fake `claude` on PATH that records how many times it ran,
// prints a chosen final line, sleeps if asked, and exits with a chosen code.
// ---------------------------------------------------------------------------

interface StubClaude {
  dir: string;
  runLog: string;
}

async function withStub<T>(
  lastLine: string,
  exitCode: number,
  fn: (stub: StubClaude) => Promise<T>,
  sleepSeconds = 0,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "claude_killed_stub_" });
  const runLog = `${dir}/runs.log`;
  const body = [
    `printf 'run\\n' >> '${runLog}'`,
    `printf '%s\\n' '{"type":"result","result":"${lastLine}"}'`,
    ...(sleepSeconds > 0 ? [`sleep ${sleepSeconds}`] : []),
    `exit ${exitCode}`,
  ].join("\n");
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(stubPath, `#!/usr/bin/env bash\n${body}\n`);
  await Deno.chmod(stubPath, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  try {
    return await fn({ dir, runLog });
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true }).catch(() => {
      /* best-effort */
    });
  }
}

async function readRunCount(runLog: string): Promise<number> {
  try {
    const text = await Deno.readTextFile(runLog);
    return text.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

// A retry config whose wait would overrun a bounded run if the loop ever
// entered the rate-limit path — a fast completion proves no wait accrued.
const SLOW_IF_RETRIED = {
  maxRetries: 3,
  maxWaitSeconds: 600,
  initialWaitInterval: 300,
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
        const result = await runClaudeWithRetry(COMMON_OPTS, SLOW_IF_RETRIED);
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
        const result = await runClaudeWithRetry(COMMON_OPTS, SLOW_IF_RETRIED);
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
    // The stub sleeps past the 1 s hard timeout, so the watchdog kills it.
    const { result } = await withStub(
      "still working",
      0,
      async (stub) => {
        const result = await runClaudeWithRetry(
          { ...COMMON_OPTS, timeoutSeconds: 1, killAfterSeconds: 1 },
          SLOW_IF_RETRIED,
        );
        return { result, runs: await readRunCount(stub.runLog) };
      },
      30,
    );

    assert(result.ok);
    if (!result.ok) return;

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
    const dir = await Deno.makeTempDir({ prefix: "claude_killed_stderr_" });
    const stubPath = `${dir}/claude`;
    await Deno.writeTextFile(
      stubPath,
      `#!/usr/bin/env bash\necho '{"type":"result","result":"working"}'\necho "last words on stderr" >&2\nexit 137\n`,
    );
    await Deno.chmod(stubPath, 0o755);
    const originalPath = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", `${dir}:${originalPath}`);
    try {
      const result = await runClaudeWithRetry(COMMON_OPTS, SLOW_IF_RETRIED);
      assert(result.ok);
      if (!result.ok) return;
      assertEquals(result.value.killed, true);
      assert(
        (result.value.stderr ?? "").includes("last words on stderr"),
        `stderr evidence must survive: ${JSON.stringify(result.value.stderr)}`,
      );
    } finally {
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a heap abort on stderr classifies as OOM, not killed (Issue #4237)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "claude_oom_stderr_" });
    const stubPath = `${dir}/claude`;
    await Deno.writeTextFile(
      stubPath,
      `#!/usr/bin/env bash\necho '{"type":"result","result":"working"}'\necho "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory" >&2\nexit 137\n`,
    );
    await Deno.chmod(stubPath, 0o755);
    const originalPath = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", `${dir}:${originalPath}`);
    try {
      const result = await runClaudeWithRetry(COMMON_OPTS, SLOW_IF_RETRIED);
      assert(result.ok);
      if (!result.ok) return;
      assertEquals(
        result.value.outOfMemory,
        true,
        "stderr evidence must reach the OOM detector",
      );
      assert(result.value.killed !== true);
    } finally {
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ---------------------------------------------------------------------------
// (e) The kill carries the memory-pressure reading (Issue #4374)
// ---------------------------------------------------------------------------

function capturingLogger(): {
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
          SLOW_IF_RETRIED,
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
          logger,
          probeMemoryPressure: () => Promise.reject(new Error("no sysctl")),
        },
        SLOW_IF_RETRIED,
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
    const dir = await Deno.makeTempDir({ prefix: "claude_orphan_stub_" });
    const pidFile = `${dir}/child.pid`;
    // The stub emits one chunk (so a snapshot is requested straight away),
    // spawns a detached child that outlives it, then SIGKILLs itself —
    // the OOM-killer shape: no watchdog, exit 137, an orphan left behind.
    const stubPath = `${dir}/claude`;
    await Deno.writeTextFile(
      stubPath,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' '{"type":"result","result":"working"}'`,
        `sleep 300 >/dev/null 2>&1 &`,
        `echo $! > '${pidFile}'`,
        "sleep 1.5",
        "kill -9 $$",
      ].join("\n") + "\n",
    );
    await Deno.chmod(stubPath, 0o755);
    const originalPath = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", `${dir}:${originalPath}`);
    let orphanPid = 0;
    try {
      const { logger, security, warns } = capturingLogger();
      const result = await runClaudeWithRetry(
        {
          ...COMMON_OPTS,
          logger,
          descendantSnapshotIntervalMs: 200,
          probeMemoryPressure: () => Promise.resolve({ level: "ok" as const }),
        },
        SLOW_IF_RETRIED,
      );
      orphanPid = Number((await Deno.readTextFile(pidFile)).trim());
      assert(orphanPid > 0, "the stub recorded its child's pid");

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
      Deno.env.set("PATH", originalPath);
      if (orphanPid > 0) {
        await new Deno.Command("kill", {
          args: ["-9", String(orphanPid)],
          stdout: "null",
          stderr: "null",
        }).output().catch(() => {});
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
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
    const { logger, warns } = capturingLogger();
    let probes = 0;
    // A stub that runs long enough for several 100 ms ticks.
    const { result } = await withStub("working", 0, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          ...COMMON_OPTS,
          logger,
          descendantSnapshotIntervalMs: 100,
          memoryWatchMinIntervalMs: 60_000,
          probeMemoryPressure: () => {
            probes++;
            return Promise.resolve({
              level: "high" as const,
              totalBytes: 16 * 1024 ** 3,
              availableBytes: 700 * 1024 ** 2,
            });
          },
        },
        SLOW_IF_RETRIED,
      );
      return { result, runs: await readRunCount(stub.runLog) };
    }, 1.2);
    assert(result.ok);
    if (!result.ok) return;
    assert(probes >= 2, `the watch probes on the ticks: ${probes}`);
    const pressureWarns = warns.filter((w) =>
      w.startsWith("Memory pressure high during the agent run")
    );
    assertEquals(pressureWarns.length, 1, JSON.stringify(warns));
    assert(pressureWarns[0]!.includes("700 MiB of 16.0 GiB available"));
    assert(/pid=\d+/.test(pressureWarns[0]!), "the process table is attached");
  },
});
