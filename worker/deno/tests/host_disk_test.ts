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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyHostDisk,
  type ConfiguredDiskFloors,
  DEFAULT_LOW_FLOOR_GB,
  DEFAULT_LOW_FLOOR_PERCENT,
  describeDiskFloors,
  type DiskReading,
  estimateHostFree,
  HOST_DISK_AVAIL_ENV,
  HOST_DISK_LOW_FLOOR_GB_ENV,
  HOST_DISK_LOW_FLOOR_PERCENT_ENV,
  HOST_DISK_TOTAL_ENV,
  HostDiskMonitor,
  lowFloorBytes,
  parseDfKP,
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
  // Issue #732 added the origins; the floors themselves are unchanged.
  assertEquals(resolveDiskFloors(() => undefined), {
    lowFloorGb: DEFAULT_LOW_FLOOR_GB,
    lowFloorPercent: DEFAULT_LOW_FLOOR_PERCENT,
    lowFloorGbOrigin: "default",
    lowFloorPercentOrigin: "default",
  });
  const env = (n: string) => n === HOST_DISK_LOW_FLOOR_GB_ENV ? "50" : "abc";
  assertEquals(resolveDiskFloors(env).lowFloorGb, 50);
  assertEquals(
    resolveDiskFloors(env).lowFloorPercent,
    DEFAULT_LOW_FLOOR_PERCENT,
  );
});

// --- The configurable claiming floor (Issue #732) ---------------------------
//
// On a 1.875 TB filesystem the 10% term scales to ~187 GB, so 37.5 GB free was
// judged "low" and the host claimed nothing. The formula is unchanged; what
// changed is that the floor can be configured, and that the resolution says
// where each term came from.

/** Floors as a table row: env, config, and what must come out. */
const FLOOR_CASES: Array<{
  name: string;
  env: Record<string, string>;
  config: ConfiguredDiskFloors;
  gb: number;
  percent: number;
  gbOrigin: string;
  percentOrigin: string;
}> = [
  {
    name: "unconfigured — the built-in defaults",
    env: {},
    config: {},
    gb: DEFAULT_LOW_FLOOR_GB,
    percent: DEFAULT_LOW_FLOOR_PERCENT,
    gbOrigin: "default",
    percentOrigin: "default",
  },
  {
    name: ".config.json sets both terms",
    env: {},
    config: { lowFloorGb: 20, lowFloorPercent: 1 },
    gb: 20,
    percent: 1,
    gbOrigin: "config",
    percentOrigin: "config",
  },
  {
    name: "the environment alone",
    env: {
      [HOST_DISK_LOW_FLOOR_GB_ENV]: "30",
      [HOST_DISK_LOW_FLOOR_PERCENT_ENV]: "2",
    },
    config: {},
    gb: 30,
    percent: 2,
    gbOrigin: "environment",
    percentOrigin: "environment",
  },
  {
    name: "both set — the environment wins, per the documented precedence",
    env: {
      [HOST_DISK_LOW_FLOOR_GB_ENV]: "30",
      [HOST_DISK_LOW_FLOOR_PERCENT_ENV]: "2",
    },
    config: { lowFloorGb: 20, lowFloorPercent: 1 },
    gb: 30,
    percent: 2,
    gbOrigin: "environment",
    percentOrigin: "environment",
  },
  {
    name: "each term resolves on its own",
    env: { [HOST_DISK_LOW_FLOOR_PERCENT_ENV]: "2" },
    config: { lowFloorGb: 40 },
    gb: 40,
    percent: 2,
    gbOrigin: "config",
    percentOrigin: "environment",
  },
  {
    name: "an unusable env value falls through to .config.json",
    env: {
      [HOST_DISK_LOW_FLOOR_GB_ENV]: "abc",
      [HOST_DISK_LOW_FLOOR_PERCENT_ENV]: "500",
    },
    config: { lowFloorGb: 20, lowFloorPercent: 1 },
    gb: 20,
    percent: 1,
    gbOrigin: "config",
    percentOrigin: "config",
  },
  {
    name: "a zero floor is a configured floor, not an absent one",
    env: {},
    config: { lowFloorGb: 0, lowFloorPercent: 0 },
    gb: 0,
    percent: 0,
    gbOrigin: "config",
    percentOrigin: "config",
  },
];

for (const testCase of FLOOR_CASES) {
  Deno.test(`resolveDiskFloors - ${testCase.name} (Issue #732)`, () => {
    const resolved = resolveDiskFloors(
      (name) => testCase.env[name],
      testCase.config,
    );
    assertEquals(resolved.lowFloorGb, testCase.gb);
    assertEquals(resolved.lowFloorPercent, testCase.percent);
    assertEquals(resolved.lowFloorGbOrigin, testCase.gbOrigin);
    assertEquals(resolved.lowFloorPercentOrigin, testCase.percentOrigin);
  });
}

Deno.test("classifyHostDisk - a configured floor lets a large filesystem claim (Issue #732)", () => {
  // The reported host: 1.875 TB with 37.5 GB free.
  const total = 1920 * GIB;
  const free = 37.5 * GIB;

  // Unconfigured, the 10% term demands ~192 GB and the host claims nothing.
  const unconfigured = resolveDiskFloors(() => undefined);
  assertEquals(classifyHostDisk(free, total, unconfigured).level, "low");

  // Configured 20 GB / 1%: the floor is 20 GB and the host claims work.
  const configured = resolveDiskFloors(() => undefined, {
    lowFloorGb: 20,
    lowFloorPercent: 1,
  });
  assertEquals(lowFloorBytes(total, configured), 20 * GIB);
  assertEquals(classifyHostDisk(free, total, configured).level, "ok");
});

Deno.test("describeDiskFloors - names both terms and where each came from (Issue #732)", () => {
  const described = describeDiskFloors(
    resolveDiskFloors(
      (name) => name === HOST_DISK_LOW_FLOOR_PERCENT_ENV ? "1" : undefined,
      { lowFloorGb: 20 },
    ),
  );
  assertStringIncludes(
    described,
    "20 GB (.config.json host_disk_low_floor_gb)",
  );
  assertStringIncludes(
    described,
    `1% of the filesystem (${HOST_DISK_LOW_FLOOR_PERCENT_ENV})`,
  );
  assertStringIncludes(described, "whichever is larger");
  assertStringIncludes(
    describeDiskFloors(resolveDiskFloors(() => undefined)),
    `${DEFAULT_LOW_FLOOR_GB} GB (default)`,
  );
});

Deno.test("lowFloorBytes - the larger of the GB floor and the percent floor", () => {
  const floors = { lowFloorGb: 20, lowFloorPercent: 10 };
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
  const floors = { lowFloorGb: 20, lowFloorPercent: 10 };
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
