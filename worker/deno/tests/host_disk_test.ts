/**
 * Tests for the host free-disk awareness (Issue #226).
 *
 * Inside the container `df` on the work volume reports the virtual volume
 * image, not the host filesystem it is thin-provisioned on — so the worker
 * must reason from the launcher's baseline plus the volume's growth. These
 * tests pin that arithmetic, the floors, and the monitor's transitions.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyHostDisk,
  DEFAULT_LOW_FLOOR_GB,
  DEFAULT_LOW_FLOOR_PERCENT,
  type DiskReading,
  estimateHostFree,
  HOST_DISK_AVAIL_ENV,
  HOST_DISK_LOW_FLOOR_GB_ENV,
  HOST_DISK_TOTAL_ENV,
  HostDiskMonitor,
  type HostDiskRefresh,
  lowFloorBytes,
  parseDfKP,
  parseHostDiskRefresh,
  readHostDiskBaseline,
  resolveDiskFloors,
} from "../lib/host_disk.ts";

const GIB = 1_073_741_824;

Deno.test("parseDfKP - reads total, used and available from df -kP", () => {
  const out = "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
    "/dev/disk3s5 482797652 436000000 24000000 95% /System/Volumes/Data\n";
  const r = parseDfKP(out)!;
  assertEquals(r.totalBytes, 482797652 * 1024);
  assertEquals(r.usedBytes, 436000000 * 1024);
  assertEquals(r.availableBytes, 24000000 * 1024);
  assertEquals(parseDfKP("nonsense"), null);
  assertEquals(parseDfKP(""), null);
});

Deno.test("resolveDiskFloors - defaults, and env overrides that are sane", () => {
  assertEquals(resolveDiskFloors(() => undefined), {
    lowFloorGb: DEFAULT_LOW_FLOOR_GB,
    lowFloorPercent: DEFAULT_LOW_FLOOR_PERCENT,
    // Issue #732: each term now says where it came from.
    lowFloorGbSource: "default",
    lowFloorPercentSource: "default",
  });
  const env = (n: string) => n === HOST_DISK_LOW_FLOOR_GB_ENV ? "50" : "abc";
  assertEquals(resolveDiskFloors(env).lowFloorGb, 50);
  assertEquals(
    resolveDiskFloors(env).lowFloorPercent,
    DEFAULT_LOW_FLOOR_PERCENT,
  );
});

Deno.test("lowFloorBytes - the larger of the GB floor and the percent floor", () => {
  const floors = {
    lowFloorGb: 20,
    lowFloorPercent: 10,
    lowFloorGbSource: "default" as const,
    lowFloorPercentSource: "default" as const,
  };
  // 100 GB disk: 10% = 10 GB < 20 GB → 20 GB.
  assertEquals(lowFloorBytes(100 * GIB, floors), 20 * GIB);
  // 1 TB disk: 10% = 100 GB > 20 GB → 100 GB.
  assertEquals(lowFloorBytes(1000 * GIB, floors), 100 * GIB);
});

Deno.test("estimateHostFree - host loses every byte the volume gains, never regains", () => {
  const baseline = { availableBytes: 50 * GIB, totalBytes: 460 * GIB };
  assertEquals(estimateHostFree(baseline, 10 * GIB, 18 * GIB), 42 * GIB);
  // Shrinkage inside the volume does not come back to the host.
  assertEquals(estimateHostFree(baseline, 10 * GIB, 4 * GIB), 50 * GIB);
  // Unknown volume usage → the baseline stands.
  assertEquals(estimateHostFree(baseline, null, 18 * GIB), 50 * GIB);
  // Never negative.
  assertEquals(estimateHostFree(baseline, 0, 100 * GIB), 0);
});

Deno.test("classifyHostDisk - the crashed host (23 GB of 460 GB) is low; a roomy host is ok", () => {
  const floors = {
    lowFloorGb: 20,
    lowFloorPercent: 10,
    lowFloorGbSource: "default" as const,
    lowFloorPercentSource: "default" as const,
  };
  // 23 GB free is above 20 GB but below 10% of 460 GB (46 GB) → low.
  const low = classifyHostDisk(23 * GIB, 460 * GIB, floors);
  assertEquals(low.level, "low");
  assertStringIncludes(low.detail, "below the floor");
  assertEquals(classifyHostDisk(200 * GIB, 460 * GIB, floors).level, "ok");
});

Deno.test("readHostDiskBaseline - present and sane, or null", () => {
  const env = (n: string) =>
    n === HOST_DISK_AVAIL_ENV
      ? "1000"
      : n === HOST_DISK_TOTAL_ENV
      ? "5000"
      : undefined;
  assertEquals(readHostDiskBaseline(env), {
    availableBytes: 1000,
    totalBytes: 5000,
  });
  assertEquals(readHostDiskBaseline(() => undefined), null);
  assertEquals(readHostDiskBaseline(() => "x"), null);
});

function monitor(options: {
  baseline?: { avail: number; total: number };
  readings: Array<DiskReading | null>;
  sampleIntervalMs?: number;
  /** The launcher's reading file, when the test wants one (Issue #1550). */
  refresh?: () => HostDiskRefresh | null;
  refreshMaxAgeMs?: number;
}) {
  let i = 0;
  let now = 0;
  const log: string[] = [];
  const env = (n: string) => {
    if (!options.baseline) return undefined;
    if (n === HOST_DISK_AVAIL_ENV) return String(options.baseline.avail);
    if (n === HOST_DISK_TOTAL_ENV) return String(options.baseline.total);
    return undefined;
  };
  const m = new HostDiskMonitor({
    workDir: "/work",
    env,
    probe: () => {
      const r = options.readings[Math.min(i, options.readings.length - 1)]!;
      i++;
      return Promise.resolve(r);
    },
    now: () => now,
    sampleIntervalMs: options.sampleIntervalMs ?? 60_000,
    log: (m) => log.push(m),
    ...(options.refresh
      ? {
        refreshFile: "/home/vibe/logs/host-disk.json",
        readRefresh: () => Promise.resolve(options.refresh!()),
      }
      : {}),
    ...(options.refreshMaxAgeMs !== undefined
      ? { refreshMaxAgeMs: options.refreshMaxAgeMs }
      : {}),
  });
  return { m, log, advance: (ms: number) => (now += ms) };
}

Deno.test("HostDiskMonitor - container mode: baseline minus the volume's growth, trips to low as the volume fills", async () => {
  const { m, log, advance } = monitor({
    baseline: { avail: 60 * GIB, total: 460 * GIB },
    readings: [
      { availableBytes: 0, usedBytes: 30 * GIB, totalBytes: 504 * GIB },
      { availableBytes: 0, usedBytes: 50 * GIB, totalBytes: 504 * GIB }, // +20 GB
    ],
  });
  const first = await m.check();
  assertEquals(first.level, "ok");
  assertEquals(first.source, "launch-baseline");
  assertEquals(first.availableBytes, 60 * GIB);
  advance(61_000);
  const second = await m.check();
  assertEquals(second.availableBytes, 40 * GIB);
  // 40 GB < 10% of 460 GB (46 GB) → low.
  assertEquals(second.level, "low");
  assertEquals(log.filter((l) => l.includes("low")).length, 1);
});

Deno.test("HostDiskMonitor - native mode: df on the work dir is the truth", async () => {
  const { m } = monitor({
    readings: [{
      availableBytes: 5 * GIB,
      usedBytes: 95 * GIB,
      totalBytes: 100 * GIB,
    }],
  });
  const status = await m.check();
  assertEquals(status.source, "native-df");
  assertEquals(status.level, "low");
});

Deno.test("HostDiskMonitor - no baseline and df unreadable never gates", async () => {
  const { m } = monitor({ readings: [null] });
  const status = await m.check();
  assertEquals(status.level, "unknown");
  assertEquals(status.source, "none");
});

Deno.test("HostDiskMonitor - probes on a bounded cadence", async () => {
  let probes = 0;
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: () => undefined,
    probe: () => {
      probes++;
      return Promise.resolve({
        availableBytes: 50 * GIB,
        usedBytes: 50 * GIB,
        totalBytes: 100 * GIB,
      });
    },
    now: () => 0,
    sampleIntervalMs: 60_000,
  });
  await m.check();
  await m.check();
  await m.check();
  assertEquals(probes, 1);
});

// --- Reclaim support (Issue #242) ------------------------------------------

Deno.test("HostDiskMonitor - shortfallBytes says how much the reclaim must free", async () => {
  const { m } = monitor({
    readings: [{
      availableBytes: 30 * GIB,
      usedBytes: 70 * GIB,
      totalBytes: 100 * GIB,
    }],
  });
  // Nothing probed yet — nothing to reclaim against.
  assertEquals(m.shortfallBytes, 0);
  const status = await m.check();
  assertEquals(status.level, "ok");
  assertEquals(m.shortfallBytes, 0, "an ok host asks for nothing");

  const low = monitor({
    readings: [{
      availableBytes: 5 * GIB,
      usedBytes: 95 * GIB,
      totalBytes: 100 * GIB,
    }],
  });
  await low.m.check();
  // Floor is max(20 GB, 10% of 100 GB) = 20 GB; 5 GB free is 15 GB short.
  assertEquals(low.m.shortfallBytes, 15 * GIB);
});

Deno.test("HostDiskMonitor - a forced check re-reads inside the cadence", async () => {
  let probes = 0;
  const readings = [
    { availableBytes: 5 * GIB, usedBytes: 95 * GIB, totalBytes: 100 * GIB },
    { availableBytes: 40 * GIB, usedBytes: 60 * GIB, totalBytes: 100 * GIB },
  ];
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: () => undefined,
    probe: () => {
      const reading = readings[Math.min(probes, readings.length - 1)]!;
      probes++;
      return Promise.resolve(reading);
    },
    now: () => 0,
    sampleIntervalMs: 60_000,
  });
  assertEquals((await m.check()).level, "low");
  // The cadence would hold the stale reading; the reclaim's re-read must not.
  assertEquals((await m.check()).level, "low");
  assertEquals((await m.check({ force: true })).level, "ok");
  assertEquals(probes, 2);
});

// --- The volume image only grows (Issue #384) -------------------------------

Deno.test("HostDiskMonitor - guest deletion does not hand the host its blocks back (Issue #384)", async () => {
  const { m, advance } = monitor({
    baseline: { avail: 60 * GIB, total: 460 * GIB },
    readings: [
      { availableBytes: 0, usedBytes: 10 * GIB, totalBytes: 504 * GIB },
      { availableBytes: 0, usedBytes: 30 * GIB, totalBytes: 504 * GIB },
      // The tier reclaim deletes 18 GB INSIDE the guest. The volume image
      // keeps those blocks: the host is no better off than at the peak.
      { availableBytes: 0, usedBytes: 12 * GIB, totalBytes: 504 * GIB },
    ],
  });
  await m.check();
  advance(61_000);
  assertEquals((await m.check()).availableBytes, 40 * GIB);
  advance(61_000);
  const afterReclaim = await m.check();
  assertEquals(
    afterReclaim.availableBytes,
    40 * GIB,
    "a guest-side delete must not be credited to the host",
  );
  assertEquals(afterReclaim.level, "low");
});

Deno.test("HostDiskMonitor - the low alarm names the volume image as where the space went (Issue #384)", async () => {
  const { m, advance } = monitor({
    baseline: { avail: 60 * GIB, total: 460 * GIB },
    readings: [
      { availableBytes: 0, usedBytes: 13 * GIB, totalBytes: 504 * GIB },
      { availableBytes: 0, usedBytes: 36 * GIB, totalBytes: 504 * GIB },
      { availableBytes: 0, usedBytes: 13 * GIB, totalBytes: 504 * GIB },
    ],
  });
  await m.check();
  advance(61_000);
  await m.check();
  advance(61_000);
  const status = await m.check();
  assertStringIncludes(status.detail, "volume image still holds");
  // Issue #478 widened the clause: the remedy is the launcher's recreate
  // where the runtime refuses the discard, not a trim that always works.
  assertStringIncludes(status.detail, "Issues #384, #478");
  assertEquals(m.workVolumeRatchet.ratcheted, true);
  assertEquals(m.workVolumeRatchet.deadBytes, 23 * GIB);
});

Deno.test("HostDiskMonitor - a volume that has not shrunk says nothing about a ratchet (Issue #384)", async () => {
  const { m, advance } = monitor({
    baseline: { avail: 60 * GIB, total: 460 * GIB },
    readings: [
      { availableBytes: 0, usedBytes: 10 * GIB, totalBytes: 504 * GIB },
      { availableBytes: 0, usedBytes: 30 * GIB, totalBytes: 504 * GIB },
    ],
  });
  await m.check();
  advance(61_000);
  const status = await m.check();
  assertEquals(m.workVolumeRatchet.ratcheted, false);
  assertEquals(status.detail.includes("Issue #384"), false);
});

Deno.test("HostDiskMonitor - native mode reads df directly, so there is no ratchet to claim (Issue #384)", async () => {
  const { m, advance } = monitor({
    readings: [
      { availableBytes: 40 * GIB, usedBytes: 60 * GIB, totalBytes: 100 * GIB },
      { availableBytes: 70 * GIB, usedBytes: 30 * GIB, totalBytes: 100 * GIB },
    ],
  });
  await m.check();
  advance(61_000);
  const status = await m.check();
  assertEquals(status.source, "native-df");
  assertEquals(
    status.availableBytes,
    70 * GIB,
    "on a native host df is the host: freed space is genuinely free",
  );
  assertEquals(m.workVolumeRatchet.ratcheted, false);
});

// ---------------------------------------------------------------------------
// Issue #1550: the launcher keeps measuring, and the worker adopts it
// ---------------------------------------------------------------------------

Deno.test("HostDiskMonitor - a newer launcher reading raises the estimate above the floor mid-run (Issue #1550)", async () => {
  // Launch: 39 GB free — below the 46 GB floor. The host then frees space;
  // the launcher's next tick says 66 GB.
  let file: HostDiskRefresh | null = null;
  const { m, log, advance } = monitor({
    baseline: { avail: 39 * GIB, total: 460 * GIB },
    readings: [
      { availableBytes: 0, usedBytes: 30 * GIB, totalBytes: 504 * GIB },
    ],
    refresh: () => file,
  });
  advance(1_000);
  const first = await m.check();
  assertEquals(first.level, "low");
  assertEquals(first.availableBytes, 39 * GIB);

  // The launcher measured 5 minutes later; the worker checks a minute after.
  file = { availableBytes: 66 * GIB, totalBytes: 460 * GIB, measuredAt: 300 };
  advance(360_000);
  const second = await m.check();
  assertEquals(second.level, "ok");
  assertEquals(second.availableBytes, 66 * GIB);
  assertEquals(second.source, "launch-baseline");
  assert(second.detail.includes("launcher's reading"), second.detail);
  assert(
    log.some((l) => l.includes("adopted the launcher's reading")),
    log.join("\n"),
  );
});

Deno.test("HostDiskMonitor - a newer launcher reading lowers the estimate when another account consumed space (Issue #1550)", async () => {
  let file: HostDiskRefresh | null = null;
  const { m, advance } = monitor({
    baseline: { avail: 60 * GIB, total: 460 * GIB },
    readings: [
      { availableBytes: 0, usedBytes: 30 * GIB, totalBytes: 504 * GIB },
    ],
    refresh: () => file,
  });
  advance(1_000);
  assertEquals((await m.check()).level, "ok");
  file = { availableBytes: 23 * GIB, totalBytes: 460 * GIB, measuredAt: 300 };
  advance(360_000);
  const after = await m.check();
  assertEquals(after.level, "low");
  assertEquals(after.availableBytes, 23 * GIB);
});

Deno.test("HostDiskMonitor - growth after an adopted reading still lowers the estimate, from the new origin (Issue #384, #1550)", async () => {
  let file: HostDiskRefresh | null = null;
  const { m, advance } = monitor({
    baseline: { avail: 39 * GIB, total: 460 * GIB },
    readings: [
      { availableBytes: 0, usedBytes: 30 * GIB, totalBytes: 504 * GIB },
      { availableBytes: 0, usedBytes: 30 * GIB, totalBytes: 504 * GIB },
      { availableBytes: 0, usedBytes: 50 * GIB, totalBytes: 504 * GIB }, // +20 GB since adoption
    ],
    refresh: () => file,
  });
  advance(1_000);
  await m.check();
  file = { availableBytes: 66 * GIB, totalBytes: 460 * GIB, measuredAt: 300 };
  advance(360_000);
  assertEquals((await m.check()).availableBytes, 66 * GIB);
  advance(61_000);
  const grown = await m.check();
  assertEquals(grown.availableBytes, 46 * GIB, "66 GB less 20 GB of growth");
});

Deno.test("HostDiskMonitor - a launcher reading older than the one held, or stale, or from before launch, is ignored (Issue #1550)", async () => {
  let file: HostDiskRefresh | null = null;
  const { m, advance } = monitor({
    baseline: { avail: 39 * GIB, total: 460 * GIB },
    readings: [
      { availableBytes: 0, usedBytes: 30 * GIB, totalBytes: 504 * GIB },
    ],
    refresh: () => file,
    refreshMaxAgeMs: 15 * 60_000,
  });
  // The monitor was constructed at t=0; the launcher's launch-time file
  // (measured at or before that) is the same figure the env baseline holds.
  advance(60_000);
  file = { availableBytes: 66 * GIB, totalBytes: 460 * GIB, measuredAt: 0 };
  assertEquals(
    (await m.check()).availableBytes,
    39 * GIB,
    "not newer than launch",
  );

  // Adopt a fresh one.
  file = { availableBytes: 66 * GIB, totalBytes: 460 * GIB, measuredAt: 300 };
  advance(300_000);
  assertEquals((await m.check()).availableBytes, 66 * GIB);

  // An older reading than the one held changes nothing.
  file = { availableBytes: 10 * GIB, totalBytes: 460 * GIB, measuredAt: 200 };
  advance(61_000);
  assertEquals((await m.check()).availableBytes, 66 * GIB, "older is ignored");

  // A reading newer than the held one but older than the max age is stale:
  // the launcher that wrote it is not the one running now.
  advance(30 * 60_000);
  file = { availableBytes: 10 * GIB, totalBytes: 460 * GIB, measuredAt: 400 };
  assertEquals((await m.check()).availableBytes, 66 * GIB, "stale is ignored");
});

Deno.test("HostDiskMonitor - native mode ignores the launcher file: df on the work dir is the truth (Issue #1550)", async () => {
  const { m, advance } = monitor({
    readings: [
      { availableBytes: 100 * GIB, usedBytes: 1, totalBytes: 460 * GIB },
    ],
    refresh: () => ({
      availableBytes: 1 * GIB,
      totalBytes: 460 * GIB,
      measuredAt: 300,
    }),
  });
  advance(400_000);
  const status = await m.check();
  assertEquals(status.source, "native-df");
  assertEquals(status.availableBytes, 100 * GIB);
});

Deno.test("parseHostDiskRefresh - accepts the launcher's shape and nothing looser (Issue #1550)", () => {
  assertEquals(
    parseHostDiskRefresh(
      '{"availableBytes":1024,"totalBytes":4096,"measuredAt":1700000000,"path":"/x"}',
    ),
    { availableBytes: 1024, totalBytes: 4096, measuredAt: 1700000000 },
  );
  assertEquals(parseHostDiskRefresh(""), null);
  assertEquals(parseHostDiskRefresh("not json"), null);
  assertEquals(parseHostDiskRefresh("[]"), null);
  assertEquals(
    parseHostDiskRefresh(
      '{"availableBytes":"1","totalBytes":4096,"measuredAt":1}',
    ),
    null,
  );
  assertEquals(
    parseHostDiskRefresh('{"availableBytes":1,"totalBytes":0,"measuredAt":1}'),
    null,
  );
  assertEquals(
    parseHostDiskRefresh('{"availableBytes":1,"totalBytes":4096}'),
    null,
  );
});
