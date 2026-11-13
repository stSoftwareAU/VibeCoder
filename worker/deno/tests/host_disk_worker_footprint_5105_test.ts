/**
 * The worker's own host footprint growth, the term subtracted from a drop
 * before any of it is credited to a babysitter repair (Issue #5105).
 *
 * Every figure is non-zero, so a getter that always returned zero fails here.
 * Each unknown case is paired with the same monitor reporting a real figure.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  HOST_DISK_AVAIL_ENV,
  HOST_DISK_TOTAL_ENV,
  HostDiskMonitor,
  type HostDiskRefresh,
} from "../lib/host_disk.ts";

const GIB = 1024 ** 3;

const baselineEnv = (n: string): string | undefined =>
  n === HOST_DISK_AVAIL_ENV
    ? String(60 * GIB)
    : n === HOST_DISK_TOTAL_ENV
    ? String(460 * GIB)
    : undefined;

Deno.test("Issue #5105 - worker growth sums the work volume across a launcher re-base and adds the ephemeral peak", async () => {
  let usedBytes = 30 * GIB;
  let t = 1_000_000_000_000;
  let launcher: HostDiskRefresh | null = null;
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: baselineEnv,
    probe: () =>
      Promise.resolve({ availableBytes: 0, usedBytes, totalBytes: 504 * GIB }),
    now: () => t,
    refreshFile: "/launcher/host-disk.json",
    readRefresh: () => Promise.resolve(launcher),
  });
  m.recordEphemeralCargoRootBytes(0);
  await m.check({ force: true });
  assertEquals(m.workerFootprintGrowthBytes, 0);

  usedBytes = 35 * GIB;
  t += 60_000;
  await m.check({ force: true });
  assertEquals(m.workerFootprintGrowthBytes, 5 * GIB);

  // The launcher rewrites its reading: the peak re-bases to 35 GiB, but the
  // growth already counted stays.
  launcher = {
    availableBytes: 50 * GIB,
    totalBytes: 460 * GIB,
    measuredAt: Math.floor(t / 1000) + 1,
  };
  t += 60_000;
  await m.check({ force: true });
  assertEquals(m.workerFootprintGrowthBytes, 5 * GIB);
  usedBytes = 41 * GIB;
  t += 60_000;
  await m.check({ force: true });
  assertEquals(m.workerFootprintGrowthBytes, 11 * GIB);

  // The ephemeral cargo root's peak is included, and only rises.
  m.recordEphemeralCargoRootBytes(7 * GIB);
  assertEquals(m.workerFootprintGrowthBytes, 18 * GIB);
  m.recordEphemeralCargoRootBytes(3 * GIB);
  assertEquals(m.workerFootprintGrowthBytes, 18 * GIB);
});

Deno.test("Issue #5105 - an unmeasured or failed ephemeral cargo root is unknown growth, not zero", async () => {
  let usedBytes = 30 * GIB;
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: baselineEnv,
    probe: () =>
      Promise.resolve({ availableBytes: 0, usedBytes, totalBytes: 504 * GIB }),
  });
  await m.check({ force: true });
  usedBytes = 36 * GIB;
  await m.check({ force: true });
  // Never measured: the root applies (the default), so the growth is unknown.
  assertEquals(m.workerFootprintGrowthBytes, undefined);
  m.recordEphemeralCargoRootBytes(4 * GIB);
  assertEquals(m.workerFootprintGrowthBytes, 10 * GIB);
  // A walk that failed leaves the earlier peak stale: unknown again.
  m.recordEphemeralCargoRootBytes(null);
  assertEquals(m.workerFootprintGrowthBytes, undefined);
  m.recordEphemeralCargoRootBytes(4 * GIB);
  assertEquals(m.workerFootprintGrowthBytes, 10 * GIB);
});

Deno.test("Issue #5105 - an ephemeral root that does not apply adds nothing and is not required", async () => {
  const usedBytes = 30 * GIB;
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: baselineEnv,
    probe: () =>
      Promise.resolve({ availableBytes: 0, usedBytes, totalBytes: 504 * GIB }),
    ephemeralCargoRootApplies: () => false,
  });
  await m.check({ force: true });
  assertEquals(m.workerFootprintGrowthBytes, 0);
});

Deno.test("Issue #5105 - growth is unknown while the ephemeral cargo root refresh is in progress", async () => {
  let usedBytes = 30 * GIB;
  let t = 0;
  const walk = Promise.withResolvers<number | null>();
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: baselineEnv,
    probe: () =>
      Promise.resolve({ availableBytes: 0, usedBytes, totalBytes: 504 * GIB }),
    now: () => t,
    measureEphemeralCargoRoot: () => walk.promise,
  });
  m.recordEphemeralCargoRootBytes(1 * GIB);
  await m.check({ force: true });
  assertEquals(m.workerFootprintGrowthBytes, 1 * GIB);

  // Builds grow the root and the volume until the floor trips; the walk that
  // the trip starts has not finished, so the figure may be stale.
  usedBytes = 85 * GIB;
  t = 10 * 60_000;
  assertEquals((await m.check({ force: true })).level, "low");
  assertEquals(m.workerFootprintGrowthBytes, undefined);
  walk.resolve(38 * GIB);
  await m.ephemeralCargoRootSettled();
  assertEquals(m.workerFootprintGrowthBytes, 55 * GIB + 38 * GIB);
});

Deno.test("Issue #5105 - a native df reading has no separable worker growth", async () => {
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: () => undefined,
    probe: () =>
      Promise.resolve({
        availableBytes: 60 * GIB,
        usedBytes: 30 * GIB,
        totalBytes: 460 * GIB,
      }),
  });
  m.recordEphemeralCargoRootBytes(4 * GIB);
  const status = await m.check({ force: true });
  assertEquals(status.source, "native-df");
  assertEquals(m.workerFootprintGrowthBytes, undefined);
});
