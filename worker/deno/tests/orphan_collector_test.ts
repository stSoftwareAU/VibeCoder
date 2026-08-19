/**
 * Tests for the orphaned-descendant collector (Issue #4382).
 *
 * Observed live on host-23: the agent was SIGKILLed by the VM's OOM killer
 * and its Bash-tool shell (`timeout 3000 ./quality.sh` → `deno run` →
 * `deno test` over the whole tree) survived, re-parented to PID 1, running
 * beside the in-process retry — which then met a heavier VM and was killed
 * at ~90 s. The runner only ever killed descendants when its own watchdog
 * fired; after an external kill `pgrep -P <pid>` finds nothing, because the
 * kernel has already re-parented the children.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DescendantTracker,
  type OrphanCollectorDeps,
} from "../lib/orphan_collector.ts";
import type { Logger } from "../types.ts";

/** A fake process table: pid → { ppid, alive, etimes }. */
interface FakeProc {
  ppid: number;
  alive: boolean;
  elapsedSeconds: number;
}

function fakeTable(initial: Record<number, FakeProc>) {
  const table = new Map<number, FakeProc>(
    Object.entries(initial).map(([k, v]) => [Number(k), { ...v }]),
  );
  const signals: Array<{ pid: number; signal: string }> = [];
  const deps: OrphanCollectorDeps = {
    getDescendants: (pid) => {
      // Bottom-up, like pid_guard.getDescendants.
      const out: number[] = [];
      const walk = (parent: number) => {
        for (const [p, proc] of table) {
          if (proc.alive && proc.ppid === parent) {
            walk(p);
            out.push(p);
          }
        }
      };
      walk(pid);
      return Promise.resolve(out);
    },
    getParentPid: (pid) => {
      const proc = table.get(pid);
      return Promise.resolve(proc && proc.alive ? proc.ppid : null);
    },
    getElapsedSeconds: (pid) => {
      const proc = table.get(pid);
      return Promise.resolve(proc && proc.alive ? proc.elapsedSeconds : null);
    },
    isRunning: (pid) => Promise.resolve(table.get(pid)?.alive === true),
    sendSignal: (pid, signal) => {
      signals.push({ pid, signal });
      const proc = table.get(pid);
      // TERM is honoured by everything except a "stubborn" marker pid 999.
      if (proc && (signal === "KILL" || pid !== 999)) proc.alive = false;
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
  };
  return { table, signals, deps };
}

function capturingLogger(): {
  logger: Logger;
  security: string[];
  warns: string[];
} {
  const security: string[] = [];
  const warns: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (m) => {
      warns.push(m);
    },
    error: () => {},
    debug: () => {},
    security: (event, details) => {
      security.push(`[${event}] ${details}`);
    },
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, security, warns };
}

const CHILD = 100;

Deno.test("orphan collector - after the child dies, its re-parented descendants are terminated bottom-up (Issue #4382)", async () => {
  // claude(100) → bash(101) → timeout(102) → deno run(103) → deno test(104)
  const { table, signals, deps } = fakeTable({
    100: { ppid: 20, alive: true, elapsedSeconds: 900 },
    101: { ppid: 100, alive: true, elapsedSeconds: 88 },
    102: { ppid: 101, alive: true, elapsedSeconds: 88 },
    103: { ppid: 102, alive: true, elapsedSeconds: 87 },
    104: { ppid: 103, alive: true, elapsedSeconds: 87 },
  });
  const tracker = new DescendantTracker(CHILD, deps, {
    nowMs: () => 1_000_000,
  });
  await tracker.refresh();
  assertEquals([...tracker.snapshot()].sort(), [101, 102, 103, 104]);

  // The OOM killer takes claude; the kernel re-parents bash to PID 1.
  table.get(100)!.alive = false;
  table.get(101)!.ppid = 1;

  const { logger, security } = capturingLogger();
  const result = await tracker.collectOrphans({
    reason: "AGENT_KILLED",
    maxWaitSeconds: 2,
    logger,
  });
  assertEquals(result.collected.sort(), [101, 102, 103, 104]);
  // Deepest first: deno test before its parents.
  assertEquals(signals.map((s) => s.pid), [104, 103, 102, 101]);
  assert(signals.every((s) => s.signal === "TERM"), "TERM suffices here");
  assert(
    security.some((s) =>
      s.startsWith("[ORPHANS_COLLECTED]") && s.includes("after=AGENT_KILLED") &&
      s.includes("pids=104,103,102,101")
    ),
    `security line: ${JSON.stringify(security)}`,
  );
});

Deno.test("orphan collector - grandchildren born after the last snapshot are still collected (Issue #4382)", async () => {
  const { table, signals, deps } = fakeTable({
    100: { ppid: 20, alive: true, elapsedSeconds: 900 },
    101: { ppid: 100, alive: true, elapsedSeconds: 30 },
  });
  const tracker = new DescendantTracker(CHILD, deps, {
    nowMs: () => 1_000_000,
  });
  await tracker.refresh();
  // Later, the shell spawned the gate — never snapshotted.
  table.set(105, { ppid: 101, alive: true, elapsedSeconds: 5 });
  table.get(100)!.alive = false;
  table.get(101)!.ppid = 1;

  const result = await tracker.collectOrphans({
    reason: "AGENT_KILLED",
    maxWaitSeconds: 2,
  });
  assertEquals(result.collected.sort(), [101, 105]);
  assertEquals(signals[0]?.pid, 105, "the fresh grandchild goes first");
});

Deno.test("orphan collector - a snapshot pid reused by an unrelated younger process is left alone (Issue #4382)", async () => {
  const { table, signals, deps } = fakeTable({
    100: { ppid: 20, alive: true, elapsedSeconds: 900 },
    101: { ppid: 100, alive: true, elapsedSeconds: 40 },
  });
  let now = 1_000_000;
  const tracker = new DescendantTracker(CHILD, deps, { nowMs: () => now });
  await tracker.refresh();
  // 60 s later the shell has exited and pid 101 belongs to something else
  // that started 3 s ago (its parent is not in our snapshot either).
  now += 60_000;
  table.set(101, { ppid: 1, alive: true, elapsedSeconds: 3 });
  table.get(100)!.alive = false;

  const result = await tracker.collectOrphans({
    reason: "AGENT_KILLED",
    maxWaitSeconds: 2,
  });
  assertEquals(result.collected, []);
  assertEquals(result.skipped, [101]);
  assertEquals(signals, []);
});

Deno.test("orphan collector - a descendant that ignores SIGTERM is SIGKILLed after the wait (Issue #4382)", async () => {
  const { table, signals, deps } = fakeTable({
    100: { ppid: 20, alive: true, elapsedSeconds: 900 },
    999: { ppid: 100, alive: true, elapsedSeconds: 50 },
  });
  const tracker = new DescendantTracker(CHILD, deps, {
    nowMs: () => 1_000_000,
  });
  await tracker.refresh();
  table.get(100)!.alive = false;
  table.get(999)!.ppid = 1;

  const result = await tracker.collectOrphans({
    reason: "AGENT_KILLED",
    maxWaitSeconds: 1,
  });
  assertEquals(result.collected, [999]);
  assertEquals(signals.map((s) => s.signal), ["TERM", "KILL"]);
});

Deno.test("orphan collector - nothing to do when no descendant survived (Issue #4382)", async () => {
  const { table, deps } = fakeTable({
    100: { ppid: 20, alive: true, elapsedSeconds: 900 },
    101: { ppid: 100, alive: true, elapsedSeconds: 10 },
  });
  const tracker = new DescendantTracker(CHILD, deps, {
    nowMs: () => 1_000_000,
  });
  await tracker.refresh();
  table.get(100)!.alive = false;
  table.get(101)!.alive = false;
  const { logger, security } = capturingLogger();
  const result = await tracker.collectOrphans({
    reason: "AGENT_KILLED",
    maxWaitSeconds: 1,
    logger,
  });
  assertEquals(result.collected, []);
  assertEquals(security, [], "no line when nothing was collected");
});

Deno.test("orphan collector - refresh runs one probe at a time and settle() awaits it (Issue #4382)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const deps: OrphanCollectorDeps = {
    getDescendants: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight--;
      return [7];
    },
    getParentPid: () => Promise.resolve(1),
    getElapsedSeconds: () => Promise.resolve(100),
    isRunning: () => Promise.resolve(true),
    sendSignal: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
  };
  const tracker = new DescendantTracker(CHILD, deps, { nowMs: () => 0 });
  const a = tracker.refresh();
  const b = tracker.refresh(); // coalesced — no second probe while one runs
  release?.();
  await Promise.all([a, b]);
  await tracker.settle();
  assertEquals(maxInFlight, 1);
  assertEquals([...tracker.snapshot()], [7]);
});
