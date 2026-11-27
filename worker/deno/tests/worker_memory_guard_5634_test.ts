/**
 * Tests for the worker-wide memory guard (Issue #5634).
 *
 * The guest wedged during an agent turn with 208 MiB available two minutes
 * before it went silent. The per-run guard (Issue #5529) only acts inside one
 * agent run's tree, so memory held by anything else the worker started (a
 * quality gate run through sudo, a merge check) was never acted on. The
 * worker-wide guard watches the worker's own tree and kills the largest
 * process in it, never an agent CLI itself.
 *
 * These tests drive `WorkerMemoryGuard.tick()` with injected seams.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  killWorkerTreeProcess,
  productionWorkerMemoryGuardDeps,
  startWorkerMemoryGuard,
  WorkerMemoryGuard,
  type WorkerMemoryGuardDeps,
} from "../lib/worker_memory_guard.ts";
import {
  listActiveAgentRuns,
  resetAgentRunsTerminating,
  runClaudeWithTimeout,
  terminateActiveAgentRuns,
} from "../lib/claude_runner.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import type { MemoryPressureReading } from "../lib/memory_pressure.ts";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const WORKER = 500;
const AGENT = 600;

const LOW: MemoryPressureReading = {
  level: "high",
  totalBytes: 16 * GIB,
  availableBytes: 208 * MIB,
};
const HIGH: MemoryPressureReading = {
  level: "ok",
  totalBytes: 16 * GIB,
  availableBytes: 8 * GIB,
};

const HEADER = "  PID  PPID       RSS     ELAPSED COMMAND";

/** The worker tree: a gate (3 GiB) under sudo, and an agent CLI with a child. */
const GATE_PS = `${HEADER}
  500     1    204800       10:00 deno run worker
  510   500      9216       05:00 sudo ./quality.sh
  511   510   3145728       04:59 cargo test --release
  600   500   2097152       03:00 /usr/local/bin/claude --model opus
  601   600    409600       02:59 node helper.js`;

/** The agent CLI is the largest process of all. */
const AGENT_LARGEST_PS = `${HEADER}
  500     1    204800       10:00 deno run worker
  600   500   4194304       03:00 /usr/local/bin/claude --model opus
  610   500   1048576       02:00 /usr/bin/ld -o gate`;

/** The only big process hangs off init, outside the worker's tree. */
const OUTSIDE_PS = `${HEADER}
  500     1    204800       10:00 deno run worker
  900     1   3145728       04:00 /usr/bin/ld -o /tmp/unrelated`;

function harness(options: {
  readings: MemoryPressureReading[] | (() => MemoryPressureReading);
  ps?: string | (() => string);
  startTime?: (pid: number, call: number) => string;
  killThrows?: Error;
  probeThrows?: boolean;
  psThrows?: boolean;
}) {
  const logs: string[] = [];
  const killed: number[] = [];
  let psCalls = 0;
  let probes = 0;
  const reads = new Map<number, number>();
  const guard = new WorkerMemoryGuard({
    workerPid: WORKER,
    probe: () => {
      if (options.probeThrows) return Promise.reject(new Error("probe boom"));
      const r = typeof options.readings === "function"
        ? options.readings()
        : options.readings[Math.min(probes++, options.readings.length - 1)]!;
      return Promise.resolve(r);
    },
    runPs: () => {
      psCalls++;
      if (options.psThrows) return Promise.reject(new Error("ps failed"));
      const ps = options.ps ?? GATE_PS;
      return Promise.resolve(typeof ps === "function" ? ps() : ps);
    },
    kill: (pid) => {
      if (options.killThrows) throw options.killThrows;
      killed.push(pid);
    },
    log: (m) => logs.push(m),
    activeAgentPids: () => [AGENT],
    readStartTime: (pid) => {
      const n = reads.get(pid) ?? 0;
      reads.set(pid, n + 1);
      return Promise.resolve(
        options.startTime ? options.startTime(pid, n) : `start-${pid}`,
      );
    },
  });
  return { guard, logs, killed, psCalls: () => psCalls };
}

Deno.test("worker_memory_guard #5634 - kills the gate process outside any agent tree, not the agent child", async () => {
  const h = harness({ readings: [LOW] });
  await h.guard.tick();
  assertEquals(h.killed, [511]);
  assertEquals(h.logs.length, 1, JSON.stringify(h.logs));
  const line = h.logs[0]!;
  assert(line.includes("Guest memory critically low"), line);
  assert(line.includes("pid=511"), line);
  assert(line.includes("the largest process the worker started"), line);
  assert(line.includes("Issue #5634"), line);
});

Deno.test("worker_memory_guard #5634 - an agent CLI is never the victim; the next largest is", async () => {
  const h = harness({ readings: [LOW], ps: AGENT_LARGEST_PS });
  await h.guard.tick();
  assertEquals(h.killed, [610]);
});

Deno.test("worker_memory_guard #5634 - above the floor nothing is read, killed or logged", async () => {
  const h = harness({ readings: [HIGH] });
  await h.guard.tick();
  assertEquals(h.psCalls(), 0);
  assertEquals(h.killed, []);
  assertEquals(h.logs, []);
});

Deno.test("worker_memory_guard #5634 - no victim in the worker's tree is logged once per low spell", async () => {
  const h = harness({
    readings: [LOW, LOW, HIGH, LOW],
    ps: OUTSIDE_PS,
  });
  const noVictim = () =>
    h.logs.filter((l) => l.includes("no process of at least 256 MiB"));
  await h.guard.tick();
  await h.guard.tick();
  assertEquals(h.killed, []);
  assertEquals(noVictim().length, 1, JSON.stringify(h.logs));
  assertEquals(
    noVictim()[0]!,
    "Worker memory guard found no process to kill: guest memory critically " +
      "low (208 MiB of 16.0 GiB available, floor 492 MiB), and no process " +
      "of at least 256 MiB in the worker's own tree (Issue #5634)",
  );
  assert(noVictim()[0]!.includes("(Issue #5634)"));
  await h.guard.tick(); // above the floor: resets the latch
  await h.guard.tick();
  assertEquals(noVictim().length, 2, JSON.stringify(h.logs));
});

Deno.test("worker_memory_guard #5634 - a process-table failure is logged and kills nothing", async () => {
  const h = harness({ readings: [LOW], psThrows: true });
  await h.guard.tick();
  assertEquals(h.killed, []);
  assertEquals(h.logs.length, 1);
  assert(
    h.logs[0]!.includes("could not read the process table: ps failed"),
    h.logs[0],
  );
});

Deno.test("worker_memory_guard #5634 - a victim whose start time changes is left alone, for the victim's own reason", async () => {
  // Only the victim's token moves on later reads; the worker root stays put,
  // so the root check passes and the victim re-verification is what refuses.
  const h = harness({
    readings: [LOW],
    startTime: (pid, call) =>
      pid === 511 && call > 0 ? `other-${pid}` : `start-${pid}`,
  });
  await h.guard.tick();
  assertEquals(h.killed, []);
  assertEquals(h.logs, [
    "Worker memory guard left pid=511 alone: the pid changed hands between " +
    "selection and the kill (Issue #5634)",
  ]);
});

Deno.test("worker_memory_guard #5634 - a worker root whose start time changes refuses the kill, for the root's own reason", async () => {
  const h = harness({
    readings: [LOW],
    startTime: (pid, call) =>
      pid === WORKER && call > 0 ? `other-${pid}` : `start-${pid}`,
  });
  await h.guard.tick();
  assertEquals(h.killed, []);
  assertEquals(h.logs, [
    "Worker memory guard left pid=511 alone: the root pid no longer holds " +
    "the process it held (Issue #5634)",
  ]);
});

Deno.test("worker_memory_guard #5634 - a kill that throws is logged and the tick resolves", async () => {
  const h = harness({ readings: [LOW], killThrows: new Error("EPERM nope") });
  await h.guard.tick();
  assert(
    h.logs.some((l) =>
      l.includes("could not kill pid=") && l.includes("EPERM nope")
    ),
    JSON.stringify(h.logs),
  );
});

Deno.test("worker_memory_guard #5634 - a throwing probe kills nothing and logs nothing", async () => {
  const h = harness({ readings: [LOW], probeThrows: true });
  await h.guard.tick();
  assertEquals(h.killed, []);
  assertEquals(h.logs, []);
});

Deno.test("worker_memory_guard #5634 - a rejected async kill is logged as a failure, not as a kill", async () => {
  const logs: string[] = [];
  const guard = new WorkerMemoryGuard({
    workerPid: WORKER,
    probe: () => Promise.resolve(LOW),
    runPs: () => Promise.resolve(GATE_PS),
    kill: () =>
      Promise.reject(new Error("sudo -n -u agent -- kill exited 1: denied")),
    log: (m) => logs.push(m),
    activeAgentPids: () => [AGENT],
    readStartTime: (pid) => Promise.resolve(`start-${pid}`),
  });
  await guard.tick();
  assertEquals(logs, [
    "Worker memory guard could not kill pid=511: sudo -n -u agent -- kill " +
    "exited 1: denied (Issue #5634)",
  ]);
  assert(
    !logs.some((l) => l.startsWith("Guest memory critically low")),
    JSON.stringify(logs),
  );
});

Deno.test("worker_memory_guard #5634 - a failed first worker fingerprint is retried on the next tick", async () => {
  const logs: string[] = [];
  const killed: number[] = [];
  let workerReads = 0;
  const guard = new WorkerMemoryGuard({
    workerPid: WORKER,
    probe: () => Promise.resolve(LOW),
    runPs: () => Promise.resolve(GATE_PS),
    kill: (pid) => {
      killed.push(pid);
    },
    log: (m) => logs.push(m),
    activeAgentPids: () => [AGENT],
    readStartTime: (pid) =>
      Promise.resolve(
        pid === WORKER && workerReads++ === 0 ? "" : `start-${pid}`,
      ),
  });
  await guard.tick();
  assertEquals(killed, []);
  assert(
    logs.some((l) =>
      l.includes("left pid=511 alone") && l.includes("fingerprinted")
    ),
    JSON.stringify(logs),
  );
  await guard.tick();
  assertEquals(killed, [511]);
});

/** Deps for a guard below the floor with the gate process as the victim. */
function lowDeps(overrides: Partial<WorkerMemoryGuardDeps>) {
  const logs: string[] = [];
  const killed: number[] = [];
  const deps: WorkerMemoryGuardDeps = {
    workerPid: WORKER,
    probe: () => Promise.resolve(LOW),
    runPs: () => Promise.resolve(GATE_PS),
    kill: (pid) => {
      killed.push(pid);
    },
    log: (m) => logs.push(m),
    activeAgentPids: () => [AGENT],
    readStartTime: (pid) => Promise.resolve(`start-${pid}`),
    ...overrides,
  };
  return { deps, logs, killed };
}

Deno.test("worker_memory_guard #5634 - a seam that throws outside the kill step is logged once and tick still resolves", async () => {
  const h = lowDeps({
    activeAgentPids: () => {
      throw new Error("agent table unreadable");
    },
  });
  await new WorkerMemoryGuard(h.deps).tick();
  assertEquals(h.killed, []);
  assertEquals(h.logs, [
    "Worker memory guard failed: agent table unreadable (Issue #5634)",
  ]);
});

Deno.test("worker_memory_guard #5634 - a rejected worker fingerprint read is logged as a failed tick, nothing is killed", async () => {
  const h = lowDeps({
    readStartTime: () =>
      Promise.reject(new Error("cat /proc/500/stat timed out")),
  });
  await new WorkerMemoryGuard(h.deps).tick();
  assertEquals(h.killed, []);
  assertEquals(h.logs, [
    "Worker memory guard failed: cat /proc/500/stat timed out (Issue #5634)",
  ]);
});

Deno.test("worker_memory_guard #5634 - a tick that throws and whose log throws too still resolves", async () => {
  const h = lowDeps({
    activeAgentPids: () => {
      throw new Error("agent table unreadable");
    },
    log: () => {
      throw new Error("log sink closed");
    },
  });
  await new WorkerMemoryGuard(h.deps).tick();
  assertEquals(h.killed, []);
});

Deno.test("worker_memory_guard #5634 - a tick that overlaps a running one does nothing, so the victim is signalled once", async () => {
  let releaseProbe: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let probes = 0;
  const h = lowDeps({
    probe: async () => {
      probes++;
      await gate;
      return LOW;
    },
  });
  const guard = new WorkerMemoryGuard(h.deps);
  const first = guard.tick();
  await guard.tick(); // overlaps: returns at once, without probing
  assertEquals(probes, 1);
  assertEquals(h.killed, []);
  releaseProbe();
  await first;
  assertEquals(h.killed, [511]);
  // A tick after the first finishes runs again: the flag is released.
  await guard.tick();
  assertEquals(probes, 2);
});

Deno.test("startWorkerMemoryGuard #5634 - a low reading reaches the kill seam on the timer, and stopping ends it", async () => {
  const h = lowDeps({});
  const kills: number[] = [];
  const stop = startWorkerMemoryGuard({
    ...h.deps,
    kill: (pid) => {
      kills.push(pid);
    },
  }, 5);
  try {
    // The guard's timer is unref'd, so these ref'd waits keep the loop alive.
    for (let i = 0; i < 200 && kills.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    stop();
  }
  assertEquals(kills[0], 511);
  await new Promise((r) => setTimeout(r, 20)); // lets an in-flight tick land
  const afterStop = kills.length;
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(kills.length, afterStop, "nothing is signalled after stop()");
});

Deno.test({
  name:
    "productionWorkerMemoryGuardDeps #5634 - activeAgentPids names a live agent run's pid, and not after it ends",
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAgentRunsTerminating();
    try {
      await withAgentStub(
        // Stays alive until it is told to stop.
        `while [ ! -e "$(dirname "$0")/stop" ]; do sleep 0.05; done\n`,
        async (stub) => {
          const run = runClaudeWithTimeout({
            prompt: "P",
            model: "m",
            agentBinaryPath: stub.path,
            clock: fakeClock(),
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            cwd: await Deno.makeTempDir({ prefix: "wmg-cwd-" }),
            mcpConfig: false,
          });
          const deps = productionWorkerMemoryGuardDeps(() => {});
          for (let i = 0; i < 200 && deps.activeAgentPids().length === 0; i++) {
            await new Promise((r) => setTimeout(r, 25));
          }
          const live = listActiveAgentRuns();
          assertEquals(live.length, 1, "one agent run is live");
          assertEquals(deps.activeAgentPids(), [live[0]!.pid]);
          await Deno.writeTextFile(`${stub.dir}/stop`, "");
          const result = await run;
          assert(result.ok, "the stub agent run resolves");
          assertEquals(deps.activeAgentPids(), []);
        },
        { prefix: "wmg_active_agents_" },
      );
    } finally {
      await terminateActiveAgentRuns("test cleanup");
      resetAgentRunsTerminating();
    }
  },
});

Deno.test("killWorkerTreeProcess #5634 - a direct signal that succeeds runs nothing", async () => {
  const signalled: number[] = [];
  let ran = 0;
  await killWorkerTreeProcess(4242, {
    signal: (pid) => {
      signalled.push(pid);
    },
    run: () => {
      ran++;
      return Promise.resolve({ code: 0, stderr: "" });
    },
  });
  assertEquals(signalled, [4242]);
  assertEquals(ran, 0);
});

Deno.test("killWorkerTreeProcess #5634 - EPERM falls back to sudo -n -u agent -- kill", async () => {
  const argvs: string[][] = [];
  await killWorkerTreeProcess(4242, {
    signal: () => {
      throw new Deno.errors.PermissionDenied("EPERM: Operation not permitted");
    },
    run: (argv) => {
      argvs.push(argv);
      return Promise.resolve({ code: 0, stderr: "" });
    },
  });
  assertEquals(argvs, [
    ["sudo", "-n", "-u", "agent", "--", "kill", "-s", "KILL", "4242"],
  ]);
});

Deno.test("killWorkerTreeProcess #5634 - a failing sudo kill rejects with its cause", async () => {
  let message = "";
  try {
    await killWorkerTreeProcess(4242, {
      signal: () => {
        throw new Deno.errors.PermissionDenied("EPERM");
      },
      run: () =>
        Promise.resolve({
          code: 1,
          stderr: "sudo: a password is required\nsecond line",
        }),
    });
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes("sudo: a password is required"), message);
  assert(message.includes("exited 1"), message);
  assert(!message.includes("second line"), message);
});

Deno.test("killWorkerTreeProcess #5634 - any other signal error is rethrown without running sudo", async () => {
  let ran = 0;
  let caught: unknown;
  try {
    await killWorkerTreeProcess(4242, {
      signal: () => {
        throw new Deno.errors.NotFound("no such process");
      },
      run: () => {
        ran++;
        return Promise.resolve({ code: 0, stderr: "" });
      },
    });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Deno.errors.NotFound);
  assertEquals(ran, 0);
});
