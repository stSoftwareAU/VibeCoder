/**
 * The ephemeral cargo root is measured and reported (Issue #5105).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type EphemeralCargoRootUsage,
  formatEphemeralCargoRootUsage,
  measureEphemeralCargoRoot,
  reportWorkVolumeWithEphemeralRoot,
} from "../lib/ephemeral_root_telemetry.ts";
import { productionEphemeralRootDeps } from "../lib/heavy_build_gate.ts";
import {
  HOST_DISK_AVAIL_ENV,
  HOST_DISK_TOTAL_ENV,
  HostDiskMonitor,
} from "../lib/host_disk.ts";

const GIB = 1_073_741_824;

function dir(name: string, gib: number) {
  return {
    path: `/var/tmp/vibe-cargo-target/${name}`,
    bytes: gib * GIB,
    lastWriteMs: 0,
  };
}

Deno.test("Issue #5105 - measure sums the dirs and lists the largest first", async () => {
  const usage = await measureEphemeralCargoRoot({
    listTargetDirs: () =>
      Promise.resolve([dir("a", 1), dir("b", 5), dir("c", 2)]),
  });
  assertEquals(usage.bytes, 8 * GIB);
  assertEquals(usage.dirs.map((d) => d.path.split("/").pop()), ["b", "c", "a"]);
  assertEquals(usage.error, null);
});

Deno.test("Issue #5105 - a missing root is a true zero", async () => {
  const usage = await measureEphemeralCargoRoot({
    listTargetDirs: () => Promise.reject(new Deno.errors.NotFound("gone")),
  });
  assertEquals(usage, { bytes: 0, dirs: [], error: null });
});

Deno.test("Issue #5105 - any other failure is unknown, never a clean zero", async () => {
  const usage = await measureEphemeralCargoRoot({
    listTargetDirs: () => Promise.reject(new Error("du timed out")),
  });
  assertEquals(usage.error, "du timed out");
  assertEquals(
    formatEphemeralCargoRootUsage(usage),
    "ephemeral cargo root unknown — /var/tmp/vibe-cargo-target could not be measured: du timed out (Issue #5105)",
  );
});

Deno.test("Issue #5105 - measure with the real listing finds a directory on disk", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/GRQ-core-agent`);
    await Deno.writeFile(
      `${root}/GRQ-core-agent/blob`,
      new Uint8Array(64 * 1024),
    );
    const usage = await measureEphemeralCargoRoot(
      productionEphemeralRootDeps,
      root,
    );
    assertEquals(usage.error, null);
    assertEquals(usage.dirs.length, 1);
    assertEquals(usage.dirs[0]!.path.endsWith("GRQ-core-agent"), true);
    assertEquals(usage.bytes > 0, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Issue #5105 - format names zero, one and many dirs", () => {
  const mk = (names: Array<[string, number]>): EphemeralCargoRootUsage => ({
    bytes: names.reduce((s, [, g]) => s + g * GIB, 0),
    dirs: names.map(([n, g]) => dir(n, g)),
    error: null,
  });
  assertEquals(
    formatEphemeralCargoRootUsage(mk([])),
    "ephemeral cargo root 0.0 GB on the container's own layer, outside the volume (0 target dirs) (Issue #5105)",
  );
  assertEquals(
    formatEphemeralCargoRootUsage(mk([["GRQ-core", 3]])),
    "ephemeral cargo root 3.0 GB on the container's own layer, outside the volume (1 target dir: GRQ-core 3.0 GB) (Issue #5105)",
  );
  assertEquals(
    formatEphemeralCargoRootUsage(
      mk([["a", 4], ["b", 3], ["c", 2], ["d", 1]]),
    ),
    "ephemeral cargo root 10.0 GB on the container's own layer, outside the volume (4 target dirs: a 4.0 GB, b 3.0 GB, c 2.0 GB, …) (Issue #5105)",
  );
});

function reportHarness(trimRefused: boolean, usage: EphemeralCargoRootUsage) {
  const calls = { measure: 0, record: [] as Array<number | null> };
  const run = () =>
    reportWorkVolumeWithEphemeralRoot({ label: "Work volume" }, {
      report: () => Promise.resolve("Work volume: total 1.0 GB"),
      trimRefused: () => trimRefused,
      measure: () => {
        calls.measure++;
        return Promise.resolve(usage);
      },
      record: (b) => calls.record.push(b),
    });
  return { calls, run };
}

Deno.test("Issue #5105 - report leaves the line alone when the trim is not refused", async () => {
  const { calls, run } = reportHarness(false, {
    bytes: 1,
    dirs: [],
    error: null,
  });
  assertEquals(await run(), "Work volume: total 1.0 GB");
  assertEquals(calls.measure, 0);
  assertEquals(calls.record, []);
});

Deno.test("Issue #5105 - report appends the root and records its bytes when trim is refused", async () => {
  const { calls, run } = reportHarness(true, {
    bytes: 2 * GIB,
    dirs: [dir("GRQ-core", 2)],
    error: null,
  });
  assertEquals(
    await run(),
    "Work volume: total 1.0 GB — ephemeral cargo root 2.0 GB on the container's own layer, outside the volume (1 target dir: GRQ-core 2.0 GB) (Issue #5105)",
  );
  assertEquals(calls.record, [2 * GIB]);
});

Deno.test("Issue #5105 - report records null and says unknown when measuring fails", async () => {
  const { calls, run } = reportHarness(true, {
    bytes: 0,
    dirs: [],
    error: "du timed out",
  });
  assertStringIncludes(await run(), "ephemeral cargo root unknown");
  assertEquals(calls.record, [null]);
});

async function hostStatus(record: number | null | undefined) {
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: (n) =>
      n === HOST_DISK_AVAIL_ENV
        ? String(60 * GIB)
        : n === HOST_DISK_TOTAL_ENV
        ? String(460 * GIB)
        : undefined,
    probe: () =>
      Promise.resolve({
        availableBytes: 0,
        usedBytes: 30 * GIB,
        totalBytes: 504 * GIB,
      }),
    now: () => 0,
  });
  if (record !== undefined) m.recordEphemeralCargoRootBytes(record);
  return await m.check({ force: true });
}

Deno.test("Issue #5105 - the host-disk estimate names the root without changing the estimate", async () => {
  const without = await hostStatus(undefined);
  assertEquals(without.source, "launch-baseline");
  assertEquals(without.detail.includes("ephemeral cargo root"), false);

  const withRoot = await hostStatus(12.3 * GIB);
  assertStringIncludes(withRoot.detail, "ephemeral cargo root 12.3 GB");
  assertStringIncludes(withRoot.detail, "is not in this estimate");
  assertEquals(withRoot.availableBytes, without.availableBytes);
  assertEquals(withRoot.level, without.level);

  const cleared = await hostStatus(null);
  assertEquals(cleared.detail, without.detail);
});
