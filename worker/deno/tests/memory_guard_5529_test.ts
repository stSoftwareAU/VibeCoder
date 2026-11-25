/**
 * Tests for the in-guest early-OOM guard (Issue #5529).
 *
 * A heavy build in one agent run's tree exhausted the guest's memory: six
 * `/usr/bin/ld` linkers at about 1.9 GiB each in a 15.7 GiB guest with no swap,
 * available memory falling from 1.1 GiB to 168 MiB in ten seconds. The kernel
 * did not OOM-kill, the guest thrashed, stopped answering `container exec`, and
 * the launcher reaped every lane. The guard kills the largest process in the
 * agent run's own tree once the guest is below its floor, so the guest does
 * not wedge.
 *
 * The pure tests pin the victim choice against a realistic `ps` table: never
 * the agent, never an unrelated process however large, never the worker itself,
 * and nothing when the reading carries no byte counts or the tree has nothing
 * worth killing. The runner tests drive the real memory watch on the injected
 * clock: a critical reading kills the tree's largest member and logs it, and a
 * high reading above the floor kills nothing and still logs the pressure warning.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import {
  formatMemoryGuardKill,
  isBelowMemoryGuardFloor,
  MEMORY_GUARD_MIN_VICTIM_RSS_KB,
  memoryGuardFloorBytes,
  selectMemoryGuardVictim,
} from "../lib/memory_guard.ts";
import { parseProcessTable } from "../lib/kill_diagnostics.ts";
import type { MemoryPressureReading } from "../lib/memory_pressure.ts";
import type { Logger } from "../types.ts";
import {
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
} from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** The 15.7 GiB guest from the incident, as a reading with byte counts. */
const TOTAL_15_7_GIB = 15.7 * GIB;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A `ps -eo pid,ppid,rss,etime,args` table as the incident shape: the agent
 * (100) runs a shell, cargo, rustc and cc; cc spawns two linkers in the same
 * tree. An unrelated linker (200, ppid 1) is larger than either and must
 * never be chosen. The agent itself is the largest row of all.
 */
const INCIDENT_PS = `  PID  PPID       RSS     ELAPSED COMMAND
  100     1   3145728       01:10 /usr/local/bin/claude --model opus --effort high
  101   100      9216       01:09 /bin/bash -c ./quality.sh
  102   101    450112       01:08 cargo build --release
  103   102   1200128       01:07 rustc --crate-name vibe_worker --edition 2021
  104   103     88064       01:07 cc -o target/release/deps/vibe_worker
  105   104   1992294       01:06 /usr/bin/ld -o target/release/deps/vibe_worker
  106   103   1572864       01:06 /usr/bin/ld -o target/release/deps/other_crate
  200     1   2621440       04:12 /usr/bin/ld -o /tmp/unrelated`;

const INCIDENT_ROWS = parseProcessTable(INCIDENT_PS);

/** Below the 3% floor of a 15.7 GiB guest, with 168 MiB free. */
const CRITICAL_READING: MemoryPressureReading = {
  level: "high",
  totalBytes: TOTAL_15_7_GIB,
  availableBytes: 168 * MIB,
};

/** Above the floor: 1.1 GiB free in the same 15.7 GiB guest. */
const ABOVE_FLOOR_READING: MemoryPressureReading = {
  level: "high",
  totalBytes: TOTAL_15_7_GIB,
  availableBytes: 1.1 * GIB,
};

// ---------------------------------------------------------------------------
// Floor
// ---------------------------------------------------------------------------

Deno.test("memory_guard #5529 - the floor is 3% of total, never under 256 MiB", () => {
  // 3% of 15.7 GiB is about 482 MiB, well above the minimum.
  assertEquals(
    Math.round(memoryGuardFloorBytes(TOTAL_15_7_GIB) / MIB),
    Math.round(0.03 * TOTAL_15_7_GIB / MIB),
  );
  // 3% of 8 GiB is about 246 MiB, so the 256 MiB minimum applies.
  assertEquals(memoryGuardFloorBytes(8 * GIB), 256 * MIB);
});

Deno.test("memory_guard #5529 - the floor boundary on an 8 GiB guest", () => {
  const at = (availableBytes: number) =>
    isBelowMemoryGuardFloor({
      level: "high",
      totalBytes: 8 * GIB,
      availableBytes,
    });
  assert(at(250 * MIB), "250 MiB is below the 256 MiB floor");
  assert(!at(260 * MIB), "260 MiB is not below the 256 MiB floor");
});

Deno.test("memory_guard #5529 - a reading without byte counts is never below the floor", () => {
  // The darwin shape: a pressure level and no numbers.
  assertEquals(isBelowMemoryGuardFloor({ level: "high" }), false);
  assertEquals(isBelowMemoryGuardFloor({ level: "unknown" }), false);
});

// ---------------------------------------------------------------------------
// Victim selection
// ---------------------------------------------------------------------------

Deno.test("memory_guard #5529 - below the floor the guard kills the largest tree member, not the agent or the larger unrelated linker", () => {
  const victim = selectMemoryGuardVictim({
    reading: CRITICAL_READING,
    rows: INCIDENT_ROWS,
    agentPid: 100,
    knownDescendants: [],
    selfPid: 999_999,
  });
  assertEquals(victim?.pid, 105);
});

Deno.test("memory_guard #5529 - the control: 1.1 GiB free is above the floor, so nothing is chosen", () => {
  const victim = selectMemoryGuardVictim({
    reading: ABOVE_FLOOR_READING,
    rows: INCIDENT_ROWS,
    agentPid: 100,
    knownDescendants: [],
    selfPid: 999_999,
  });
  assertEquals(victim, undefined);
});

Deno.test("memory_guard #5529 - a reading without byte counts chooses nothing", () => {
  const victim = selectMemoryGuardVictim({
    reading: { level: "high" },
    rows: INCIDENT_ROWS,
    agentPid: 100,
    knownDescendants: [],
    selfPid: 999_999,
  });
  assertEquals(victim, undefined);
});

Deno.test("memory_guard #5529 - a tree whose largest member is under 256 MiB chooses nothing", () => {
  const small = parseProcessTable(`  PID  PPID       RSS     ELAPSED COMMAND
  100     1   3145728       01:10 /usr/local/bin/claude --model opus
  101   100      9216       01:09 /bin/bash -c ./quality.sh
  102   101    200000       01:08 cargo build --release
  200     1   2621440       04:12 /usr/bin/ld -o /tmp/unrelated`);
  // 200000 KiB is under the 256 MiB minimum victim size; the 2.5 GiB linker is
  // outside the tree.
  assert(200_000 < MEMORY_GUARD_MIN_VICTIM_RSS_KB);
  const victim = selectMemoryGuardVictim({
    reading: CRITICAL_READING,
    rows: small,
    agentPid: 100,
    knownDescendants: [],
    selfPid: 999_999,
  });
  assertEquals(victim, undefined);
});

Deno.test("memory_guard #5529 - the worker's own pid is never chosen", () => {
  // Make the worker itself the largest tree member; it must be passed over.
  const rows = parseProcessTable(`  PID  PPID       RSS     ELAPSED COMMAND
  100     1   3145728       01:10 /usr/local/bin/claude --model opus
  105   100   1992294       01:06 /usr/bin/ld -o target/release/deps/vibe_worker
  106   105   1572864       01:06 /usr/bin/ld -o target/release/deps/other_crate`);
  const victim = selectMemoryGuardVictim({
    reading: CRITICAL_READING,
    rows,
    agentPid: 100,
    knownDescendants: [],
    selfPid: 105,
  });
  assertEquals(victim?.pid, 106);
});

Deno.test("memory_guard #5529 - the knownDescendants snapshot puts a re-parented member in the tree", () => {
  // 105 has been re-parented to init (the kill orphaned it), so only the
  // snapshot still ties it to the agent run.
  const rows = parseProcessTable(`  PID  PPID       RSS     ELAPSED COMMAND
  100     1   3145728       01:10 /usr/local/bin/claude --model opus
  105     1   1992294       01:06 /usr/bin/ld -o target/release/deps/vibe_worker
  200     1   2621440       04:12 /usr/bin/ld -o /tmp/unrelated`);
  const victim = selectMemoryGuardVictim({
    reading: CRITICAL_READING,
    rows,
    agentPid: 100,
    knownDescendants: [105],
    selfPid: 999_999,
  });
  assertEquals(victim?.pid, 105);
});

// ---------------------------------------------------------------------------
// The kill line
// ---------------------------------------------------------------------------

Deno.test("memory_guard #5529 - the kill line names the reading, the floor, the pid and the Issue", () => {
  const victim = INCIDENT_ROWS.find((r) => r.pid === 105)!;
  const line = formatMemoryGuardKill({
    reading: CRITICAL_READING,
    victim,
    floorBytes: memoryGuardFloorBytes(TOTAL_15_7_GIB),
  });
  assert(
    line.startsWith("Guest memory critically low"),
    `the prefix names the condition: ${line}`,
  );
  assert(line.includes("pid=105"), line);
  assert(line.includes("(Issue #5529)"), line);
  assert(line.includes("168 MiB of 15.7 GiB available"), line);
  assert(line.includes("floor 482 MiB"), line);
  assert(line.includes("rss=1946 MiB"), line);
  assert(!line.includes("\n"), "the line is one line");
});

Deno.test("memory_guard #5529 - a long command is cut to 90 characters with an ellipsis", () => {
  const victim = {
    pid: 105,
    ppid: 104,
    rssKb: 1992294,
    elapsed: "01:06",
    command: "x".repeat(200),
  };
  const line = formatMemoryGuardKill({
    reading: CRITICAL_READING,
    victim,
    floorBytes: memoryGuardFloorBytes(TOTAL_15_7_GIB),
  });
  assert(line.includes(`${"x".repeat(89)}…`), line);
  assert(!line.includes("x".repeat(90)), "no more than 90 characters survive");
});

// ---------------------------------------------------------------------------
// Through the real runner
// ---------------------------------------------------------------------------

/** The descendant the guard should pick: in the agent's tree, 2 GiB. */
const TREE_DESCENDANT_PID = 424_242;
/** A large process outside the agent's tree; never to be chosen. */
const UNRELATED_PID = 999_001;

/** Basename of the file the stub writes its own pid to. */
const CHILD_PID_FILE = "child.pid";

/** The `ps` table the memory watch reads, keyed on the real child's pid. */
function runnerPsTable(childPid: number): string {
  return [
    "  PID  PPID       RSS     ELAPSED COMMAND",
    `${childPid}     1   3145728       00:10 claude --model sonnet`,
    `${TREE_DESCENDANT_PID} ${childPid}   2097152       00:09 /usr/bin/ld -o target/release/deps/worker`,
    `${UNRELATED_PID}     1   4194304       05:00 /usr/bin/ld -o /tmp/unrelated`,
  ].join("\n");
}

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

function capturingLogger(onWarn?: (message: string) => void): {
  logger: Logger;
  warns: string[];
} {
  const warns: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (message) => {
      warns.push(message);
      onWarn?.(message);
    },
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, warns };
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

/** Wait for a file the stub writes, so the child's pid is known. */
async function waitForFile(path: string): Promise<string> {
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

/**
 * A stub that records its own pid, prints one result line, then waits at a
 * gate so the test controls when the run ends.
 */
function guardStubBody(): string {
  return [
    `echo $$ > "$(dirname "$0")/${CHILD_PID_FILE}"`,
    `printf '%s\\n' '{"type":"result","result":"working"}'`,
    agentStubGate("guard").trimEnd(),
    "exit 0",
  ].join("\n");
}

Deno.test({
  name:
    "runClaudeWithRetry - a critically low guest SIGKILLs the largest process in the agent's tree and logs it (Issue #5529)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await createAgentStub(guardStubBody(), {
      prefix: "memory_guard_5529_stub_",
    });
    try {
      const { logger, warns } = capturingLogger();
      const clock = fakeClock();
      const signals = chunkSignals();
      const killed: number[] = [];
      const guardKilled = Promise.withResolvers<void>();
      const childPidFile = `${stub.dir}/${CHILD_PID_FILE}`;
      const run = runClaudeWithRetry(
        {
          ...COMMON_OPTS,
          clock,
          agentBinaryPath: stub.path,
          logger,
          descendantSnapshotIntervalMs: 100,
          onActivity: signals.onActivity,
          probeMemoryPressure: () => Promise.resolve(CRITICAL_READING),
          memoryWatchRunPs: async () =>
            runnerPsTable(Number(await waitForFile(childPidFile))),
          memoryGuardKill: (pid) => {
            killed.push(pid);
            guardKilled.resolve();
          },
        },
        NO_RETRY_WAIT,
      );
      await signals.chunk(1);
      // First tick: the reading is below the floor, so the guard acts.
      await clock.advance(100);
      await guardKilled.promise;
      await releaseAgentStub(stub, "guard");
      const result = await run;

      assert(
        result.ok,
        `expected ok result, got ${!result.ok && result.error}`,
      );
      assertEquals(killed, [TREE_DESCENDANT_PID]);
      const guardWarns = warns.filter((w) =>
        w.startsWith("Guest memory critically low")
      );
      assertEquals(guardWarns.length, 1, JSON.stringify(warns));
      assert(
        guardWarns[0]!.includes(`pid=${TREE_DESCENDANT_PID}`),
        guardWarns[0],
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a high reading above the guard floor kills nothing and still logs the pressure warning (Issue #5529)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await createAgentStub(guardStubBody(), {
      prefix: "memory_guard_5529_control_",
    });
    try {
      const firstWarn = Promise.withResolvers<void>();
      const { logger, warns } = capturingLogger((message) => {
        if (message.startsWith("Memory pressure high during the agent run")) {
          firstWarn.resolve();
        }
      });
      const clock = fakeClock();
      const signals = chunkSignals();
      const killed: number[] = [];
      const childPidFile = `${stub.dir}/${CHILD_PID_FILE}`;
      const run = runClaudeWithRetry(
        {
          ...COMMON_OPTS,
          clock,
          agentBinaryPath: stub.path,
          logger,
          descendantSnapshotIntervalMs: 100,
          memoryWatchMinIntervalMs: 60_000,
          onActivity: signals.onActivity,
          probeMemoryPressure: () => Promise.resolve(ABOVE_FLOOR_READING),
          memoryWatchRunPs: async () =>
            runnerPsTable(Number(await waitForFile(childPidFile))),
          memoryGuardKill: (pid) => {
            killed.push(pid);
          },
        },
        NO_RETRY_WAIT,
      );
      await signals.chunk(1);
      await clock.advance(100);
      await firstWarn.promise;
      await releaseAgentStub(stub, "guard");
      const result = await run;

      assert(
        result.ok,
        `expected ok result, got ${!result.ok && result.error}`,
      );
      assertEquals(killed, [], "above the floor the guard never kills");
      assert(
        warns.some((w) =>
          w.startsWith("Memory pressure high during the agent run")
        ),
        `the pressure warning is still logged: ${JSON.stringify(warns)}`,
      );
      assert(
        !warns.some((w) => w.startsWith("Guest memory critically low")),
        `no guard line above the floor: ${JSON.stringify(warns)}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a guard kill that throws is logged as a warning naming the pid and the error (Issue #5529)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await createAgentStub(guardStubBody(), {
      prefix: "memory_guard_5529_fail_",
    });
    try {
      const attempted = Promise.withResolvers<void>();
      const { logger, warns } = capturingLogger();
      const clock = fakeClock();
      const signals = chunkSignals();
      const childPidFile = `${stub.dir}/${CHILD_PID_FILE}`;
      const run = runClaudeWithRetry(
        {
          ...COMMON_OPTS,
          clock,
          agentBinaryPath: stub.path,
          logger,
          descendantSnapshotIntervalMs: 100,
          onActivity: signals.onActivity,
          probeMemoryPressure: () => Promise.resolve(CRITICAL_READING),
          memoryWatchRunPs: async () =>
            runnerPsTable(Number(await waitForFile(childPidFile))),
          memoryGuardKill: () => {
            attempted.resolve();
            throw new Error("No such process");
          },
        },
        NO_RETRY_WAIT,
      );
      await signals.chunk(1);
      await clock.advance(100);
      await attempted.promise;
      await releaseAgentStub(stub, "guard");
      const result = await run;

      assert(
        result.ok,
        `expected ok result, got ${!result.ok && result.error}`,
      );
      assert(
        warns.some((w) =>
          w.includes(`pid=${TREE_DESCENDANT_PID}`) &&
          w.includes("No such process")
        ),
        `the failed kill is logged, not swallowed: ${JSON.stringify(warns)}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});
