/**
 * Tests for the work volume's standing view (Issue #345).
 *
 * The walk is injected, so the assertions are about what the monitor
 * *believes* after a reading: an all-zero probe is `unknown`, a real one is
 * known, the cadence bounds the `du` cost, and the end-of-cycle sample can
 * force a fresh walk.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { WorkVolumeMonitor } from "../lib/work_volume_monitor.ts";
import type { WorkVolumeUsage } from "../lib/work_volume_usage.ts";

const GIB = 1_073_741_824;

/** A reading where every directory sized to `bytesEach`. */
function usage(count: number, bytesEach: number): WorkVolumeUsage {
  const entries = Array.from({ length: count }, (_, i) => ({
    name: `GRQ-${i}`,
    bytes: bytesEach,
  }));
  return {
    totalBytes: count * bytesEach,
    monitored: { bytes: count * bytesEach, count, entries },
    side: { bytes: 0, count: 0, entries: [] },
    caches: { bytes: 0, count: 0, entries: [] },
    other: { bytes: 0, count: 0, entries: [] },
    artefacts: { bytes: 0, count: 0, entries: [] },
    measured: count,
    skipped: 0,
    truncated: false,
    budgetMs: 120_000,
    unmeasured: [],
    errors: [],
  };
}

Deno.test("WorkVolumeMonitor - status is unknown until something has been walked", () => {
  const monitor = new WorkVolumeMonitor({
    workDir: "/work",
    monitoredRepos: ["org/GRQ-23"],
    scan: () => Promise.resolve(usage(2, GIB)),
  });
  assertEquals(monitor.status.probed, false);
  assertEquals(monitor.status.known, false);
});

Deno.test("WorkVolumeMonitor - a real reading is known and carries the total (Issue #345)", async () => {
  const monitor = new WorkVolumeMonitor({
    workDir: "/work",
    monitoredRepos: ["org/GRQ-23"],
    scan: () => Promise.resolve(usage(3, 2 * GIB)),
  });
  const status = await monitor.probe();
  assertEquals(status.known, true);
  assertEquals(status.reason, null);
  assertEquals(status.totalBytes, 6 * GIB);
  assertStringIncludes(await monitor.report(), "Work volume: total 6.0 GB");
});

Deno.test("WorkVolumeMonitor - an all-zero walk is unknown, and the line says so (Issue #345)", async () => {
  const monitor = new WorkVolumeMonitor({
    workDir: "/work",
    monitoredRepos: ["org/GRQ-23"],
    scan: () => Promise.resolve(usage(12, 0)),
  });
  const status = await monitor.probe();
  assertEquals(status.known, false);
  assert(status.reason !== null);
  const line = await monitor.report();
  assertStringIncludes(line, "Work volume: unknown");
  assert(!line.includes("total 0.0 GB"), line);
});

Deno.test("WorkVolumeMonitor - no monitored list is unknown, never a published split", async () => {
  const monitor = new WorkVolumeMonitor({
    workDir: "/work",
    monitoredRepos: [],
    scan: () => {
      throw new Error("must not walk without a monitored list");
    },
  });
  const status = await monitor.probe();
  assertEquals(status.known, false);
  assertStringIncludes(
    await monitor.report(),
    "Work volume: unknown — standing totals skipped",
  );
});

Deno.test("WorkVolumeMonitor - the cadence bounds the du cost, and force overrides it", async () => {
  let walks = 0;
  let clock = 0;
  const monitor = new WorkVolumeMonitor({
    workDir: "/work",
    monitoredRepos: ["org/GRQ-23"],
    now: () => clock,
    sampleIntervalMs: 300_000,
    scan: () => {
      walks++;
      return Promise.resolve(usage(1, GIB));
    },
  });

  await monitor.probe();
  clock += 60_000;
  await monitor.report({ label: "Work volume" });
  assertEquals(walks, 1, "a second look inside the cadence reuses the reading");

  // End of cycle: usage peaks here, so the sample must be fresh.
  await monitor.report({ label: "Work volume (end of run)", force: true });
  assertEquals(walks, 2);

  clock += 300_001;
  await monitor.probe();
  assertEquals(walks, 3, "past the cadence the monitor walks again");
});

Deno.test("WorkVolumeMonitor - the label reaches the line", async () => {
  const monitor = new WorkVolumeMonitor({
    workDir: "/work",
    monitoredRepos: ["org/GRQ-23"],
    scan: () => Promise.resolve(usage(1, GIB)),
  });
  assertStringIncludes(
    await monitor.report({ label: "Work volume (end of run)" }),
    "Work volume (end of run): total 1.0 GB",
  );
});
