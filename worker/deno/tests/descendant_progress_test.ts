/**
 * Tests for the descendant-CPU progress probe (Issue #508).
 *
 * The probe is the third progress signal: an agent supervising a long-running
 * job makes tool calls and changes nothing in the checkout, but a descendant
 * process is burning CPU. Everything here runs against an injected `ps`
 * reader, so no test spawns a real workload.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  compareDescendantCpu,
  type DescendantCpuSnapshot,
  parseCpuSeconds,
  parseCpuTable,
  probeDescendantCpu,
  sumDescendantCpu,
} from "../lib/descendant_progress.ts";

/** `ps -eo pid=,ppid=,time=` as Linux prints it. */
const PS_TABLE = [
  "    1     0 00:00:01",
  "  100     1 00:10:00", // the worker
  "  200   100 00:02:30", // the agent
  "  300   200 01:00:00", // the agent's Bash shell
  "  400   300 02:00:00", // the long-running job
  "  500     1 05:00:00", // an unrelated process
].join("\n");

Deno.test("parseCpuSeconds - accepts every ps CPU-time shape", () => {
  assertEquals(parseCpuSeconds("00:00:03"), 3);
  assertEquals(parseCpuSeconds("01:02:03"), 3723);
  assertEquals(parseCpuSeconds("2-01:00:00"), 2 * 86400 + 3600);
  assertEquals(parseCpuSeconds("10:30"), 630);
  // macOS prints hundredths.
  assertEquals(parseCpuSeconds("0:00.50"), 0.5);
  assertEquals(parseCpuSeconds("not-a-time"), null);
  assertEquals(parseCpuSeconds(""), null);
});

Deno.test("parseCpuTable - reads pid, ppid and CPU seconds, skipping noise", () => {
  const rows = parseCpuTable(`  PID  PPID     TIME\n${PS_TABLE}\ngarbage`);
  assertEquals(rows.length, 6);
  const job = rows.find((row) => row.pid === 400);
  assert(job, "the long-running job must be parsed");
  assertEquals(job.ppid, 300);
  assertEquals(job.cpuSeconds, 7200);
});

Deno.test("sumDescendantCpu - sums the whole subtree and excludes the agent itself", () => {
  const rows = parseCpuTable(PS_TABLE);
  const summed = sumDescendantCpu(rows, 200);
  assertEquals(summed.descendants, 2, "the shell and the job it started");
  assertEquals(
    summed.cpuSeconds,
    3600 + 7200,
    "the agent's own CPU must never count — it burns some on every tool call",
  );
});

Deno.test("sumDescendantCpu - an agent with no children has no external work", () => {
  const summed = sumDescendantCpu(parseCpuTable(PS_TABLE), 500);
  assertEquals(summed.descendants, 0);
  assertEquals(summed.cpuSeconds, 0);
});

Deno.test("sumDescendantCpu - a parent cycle cannot hang the walk", () => {
  const rows = parseCpuTable(["  10   11 00:00:05", "  11   10 00:00:05"].join(
    "\n",
  ));
  const summed = sumDescendantCpu(rows, 10);
  assertEquals(summed.descendants, 1);
  assertEquals(summed.cpuSeconds, 5);
});

/** A successful snapshot, for the comparison tests. */
function snapshot(
  overrides: Partial<DescendantCpuSnapshot> = {},
): DescendantCpuSnapshot {
  return {
    ok: true,
    cpuSeconds: 100,
    descendants: 1,
    takenAtMs: 1_000,
    reason: "",
    ...overrides,
  };
}

Deno.test("compareDescendantCpu - CPU burnt between probes is active work", () => {
  const comparison = compareDescendantCpu(
    snapshot({ cpuSeconds: 100 }),
    snapshot({ cpuSeconds: 130, takenAtMs: 61_000 }),
  );
  assertEquals(comparison.outcome, "active");
  assertEquals(comparison.cpuSecondsDelta, 30);
});

Deno.test("compareDescendantCpu - a descendant that burns no CPU is idle", () => {
  // A `sleep 60` poll loop is a live descendant that is doing nothing.
  const comparison = compareDescendantCpu(
    snapshot({ cpuSeconds: 100 }),
    snapshot({ cpuSeconds: 100, takenAtMs: 61_000 }),
  );
  assertEquals(comparison.outcome, "idle");
  assertEquals(comparison.cpuSecondsDelta, 0);
});

Deno.test("compareDescendantCpu - no live descendant at all is idle", () => {
  const comparison = compareDescendantCpu(
    snapshot({ cpuSeconds: 100, descendants: 1 }),
    snapshot({ cpuSeconds: 0, descendants: 0, takenAtMs: 61_000 }),
  );
  assertEquals(comparison.outcome, "idle");
  assert(
    comparison.reason.includes("no live descendant"),
    comparison.reason,
  );
});

Deno.test("compareDescendantCpu - a failed probe is unknown, never idle", () => {
  const failed = snapshot({ ok: false, reason: "ps failed" });
  assertEquals(compareDescendantCpu(snapshot(), failed).outcome, "unknown");
  assertEquals(compareDescendantCpu(failed, snapshot()).outcome, "unknown");
});

Deno.test("compareDescendantCpu - sub-threshold CPU is not evidence of work", () => {
  const comparison = compareDescendantCpu(
    snapshot({ cpuSeconds: 100 }),
    snapshot({ cpuSeconds: 100.2, takenAtMs: 61_000 }),
    { minCpuSecondsDelta: 1 },
  );
  assertEquals(
    comparison.outcome,
    "idle",
    "rounding noise on a sleeping shell must not earn an extension",
  );
});

Deno.test("probeDescendantCpu - reads the live table through the injected reader", async () => {
  const snap = await probeDescendantCpu(200, {
    runPs: () => Promise.resolve(PS_TABLE),
    now: () => 42,
  });
  assertEquals(snap.ok, true);
  assertEquals(snap.descendants, 2);
  assertEquals(snap.cpuSeconds, 10_800);
  assertEquals(snap.takenAtMs, 42);
});

Deno.test("probeDescendantCpu - a reader that throws yields a failed snapshot, not an exception", async () => {
  const snap = await probeDescendantCpu(200, {
    runPs: () => Promise.reject(new Error("ps exploded")),
  });
  assertEquals(snap.ok, false);
  assertEquals(snap.cpuSeconds, 0);
  assert(snap.reason.includes("ps exploded"), snap.reason);
});

Deno.test("probeDescendantCpu - an unparseable table is a failed probe", async () => {
  const snap = await probeDescendantCpu(200, {
    runPs: () => Promise.resolve("total garbage\n"),
  });
  assertEquals(
    snap.ok,
    false,
    "an empty process table means the read failed — the agent itself is in it",
  );
});
