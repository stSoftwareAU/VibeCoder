/**
 * The ephemeral cargo root is measured and reported (Issue #5105).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type EphemeralCargoRootUsage,
  formatEphemeralCargoRootUsage,
  measureEphemeralCargoRoot,
  measureEphemeralCargoRootBytesIfTrimRefused,
  reportWorkVolumeWithEphemeralRoot,
} from "../lib/ephemeral_root_telemetry.ts";
import {
  HOST_DISK_AVAIL_ENV,
  HOST_DISK_TOTAL_ENV,
  HostDiskMonitor,
} from "../lib/host_disk.ts";
import {
  enableInFlightHostDiskGate,
  listTargetDirsMeasuredBy,
  measureDirectoryBytesStrictly,
  parkRunningBuild,
  parseDuKilobytes,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createLogger } from "../lib/logger.ts";
import { canEnforceUnwritableDir } from "./support/environment_capability.ts";

const modesEnforced = await canEnforceUnwritableDir();

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
    const usage = await measureEphemeralCargoRoot(undefined, root);
    assertEquals(usage.error, null);
    assertEquals(usage.dirs.length, 1);
    assertEquals(usage.dirs[0]!.path.endsWith("GRQ-core-agent"), true);
    assertEquals(usage.bytes > 0, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name:
    "Issue #5105 - measure with the real listing reads unknown when du cannot read a subtree",
  ignore: !modesEnforced, // a privileged user reads every mode
  async fn() {
    const root = await Deno.makeTempDir();
    const hidden = `${root}/GRQ-core-0123abcd-agent/debug`;
    try {
      await Deno.mkdir(hidden, { recursive: true });
      await Deno.writeFile(`${hidden}/blob`, new Uint8Array(1024 * 1024));
      await Deno.chmod(hidden, 0o000);
      const usage = await measureEphemeralCargoRoot(undefined, root);
      assertEquals(usage.bytes, 0);
      assertEquals(usage.dirs, []);
      assertStringIncludes(usage.error ?? "", "du -sk");
      assertStringIncludes(usage.error ?? "", "exited 1");
      assertStringIncludes(
        formatEphemeralCargoRootUsage(usage, root),
        `ephemeral cargo root unknown — ${root} could not be measured:`,
      );
      const recorded: Array<number | null> = [];
      await reportWorkVolumeWithEphemeralRoot(undefined, {
        report: () => Promise.resolve("Work volume: 1.0 GB"),
        trimRefused: () => true,
        measure: () => measureEphemeralCargoRoot(undefined, root),
        record: (bytes) => recorded.push(bytes),
      });
      assertEquals(recorded, [null]);
    } finally {
      await Deno.chmod(hidden, 0o755).catch(() => {});
      await Deno.remove(root, { recursive: true });
    }
  },
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

Deno.test("Issue #5105 - a mid-cycle floor trip refreshes the root without waiting", async () => {
  let usedBytes = 30 * GIB;
  let rootBytes = 0;
  const measured: number[] = [];
  let t = 0;
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: (n) =>
      n === HOST_DISK_AVAIL_ENV
        ? String(60 * GIB)
        : n === HOST_DISK_TOTAL_ENV
        ? String(460 * GIB)
        : undefined,
    probe: () =>
      Promise.resolve({ availableBytes: 0, usedBytes, totalBytes: 504 * GIB }),
    now: () => t,
    measureEphemeralCargoRoot: () => {
      measured.push(t);
      return Promise.resolve(rootBytes);
    },
  });
  // Cycle start: the root has just been released, and the report records ~0.
  m.recordEphemeralCargoRootBytes(0);
  const start = await m.check();
  assertEquals(start.level, "ok");
  assertEquals(measured, [], "an ok level does not walk the root");

  // Mid-cycle: builds grow the root and the volume until the floor trips.
  rootBytes = 38.5 * GIB;
  usedBytes = 85 * GIB;
  t = 10 * 60_000;
  const low = await m.check();
  assertEquals(low.level, "low");
  assertStringIncludes(low.detail, "ephemeral cargo root refresh in progress");
  const refreshed = await m.check({ force: true });
  assertEquals(refreshed.level, "low");
  assertStringIncludes(refreshed.detail, "ephemeral cargo root 38.5 GB");
  assertEquals(measured, [t]);

  // A failed measurement drops the stale figure rather than repeating it.
  t = 20 * 60_000;
  const failing = new HostDiskMonitor({
    workDir: "/work",
    env: (n) =>
      n === HOST_DISK_AVAIL_ENV
        ? String(60 * GIB)
        : n === HOST_DISK_TOTAL_ENV
        ? String(460 * GIB)
        : undefined,
    probe: () =>
      Promise.resolve({ availableBytes: 0, usedBytes, totalBytes: 504 * GIB }),
    now: () => t,
    measureEphemeralCargoRoot: () => Promise.reject(new Error("du failed")),
  });
  failing.recordEphemeralCargoRootBytes(9 * GIB);
  await failing.check(); // baselines at the grown volume: ok
  usedBytes = 140 * GIB;
  assertEquals((await failing.check({ force: true })).level, "low");
  const lowUnknown = await failing.check({ force: true });
  assertEquals(lowUnknown.level, "low");
  assertStringIncludes(
    lowUnknown.detail,
    "ephemeral cargo root unknown on the container's own layer: du failed",
  );
  assertEquals(lowUnknown.detail.includes("9.0 GB"), false);
});

Deno.test("Issue #5105 - the monitor's refresh measures only on a trim-refused runtime", async () => {
  let calls = 0;
  const measure = () => {
    calls++;
    return Promise.resolve({ bytes: 7 * GIB, dirs: [], error: null });
  };
  assertEquals(
    await measureEphemeralCargoRootBytesIfTrimRefused({
      trimRefused: () => false,
      measure,
    }),
    null,
  );
  assertEquals(calls, 0);
  assertEquals(
    await measureEphemeralCargoRootBytesIfTrimRefused({
      trimRefused: () => true,
      measure,
    }),
    7 * GIB,
  );
  await assertRejects(
    () =>
      measureEphemeralCargoRootBytesIfTrimRefused({
        trimRefused: () => true,
        measure: () =>
          Promise.resolve({ bytes: 0, dirs: [], error: "du -sk exited 1" }),
      }),
    Error,
    "du -sk exited 1",
  );
});

Deno.test("Issue #5105 - du output with no leading size has no figure", () => {
  assertEquals(parseDuKilobytes("2048\t/var/tmp/x\n"), 2048);
  assertEquals(parseDuKilobytes(""), undefined);
  assertEquals(parseDuKilobytes("du: cannot access\n"), undefined);
  assertEquals(parseDuKilobytes("12abc /x"), undefined);
});

function lowMonitor(measure: () => Promise<number | null>, now = () => 0) {
  return new HostDiskMonitor({
    workDir: "/work",
    env: (name) =>
      name === HOST_DISK_AVAIL_ENV
        ? String(5 * GIB)
        : name === HOST_DISK_TOTAL_ENV
        ? String(460 * GIB)
        : undefined,
    probe: () =>
      Promise.resolve({
        availableBytes: 0,
        usedBytes: 0,
        totalBytes: 504 * GIB,
      }),
    now,
    measureEphemeralCargoRoot: measure,
  });
}

Deno.test("Issue #5105 - forced checks cannot bypass the root refresh interval", async () => {
  let calls = 0;
  let now = 0;
  const monitor = lowMonitor(() => Promise.resolve(++calls * GIB), () => now);
  assertEquals((await monitor.check({ force: true })).level, "low");
  assertEquals((await monitor.check({ force: true })).level, "low");
  assertEquals(calls, 1);
  now = 59_999;
  await monitor.check({ force: true });
  assertEquals(calls, 1);
  now = 60_000;
  await monitor.check({ force: true });
  assertEquals(calls, 2);
});

Deno.test("Issue #5105 - the registered build probe returns low during one slow shared scan", async () => {
  const scan = Promise.withResolvers<number>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  let now = 0;
  const monitor = lowMonitor(() => {
    calls++;
    started.resolve();
    return scan.promise;
  }, () => now);
  const tmp = await Deno.makeTempDir();
  const { cleanup } = await createProductionRunCoreDeps({
    repoDir: tmp,
    workDir: tmp,
    githubUser: "test-user",
    config: buildDefaultWorkerConfig(),
    env: () => undefined,
    logger: createLogger({ write: () => {} }),
    hostDisk: monitor,
  });
  enableInFlightHostDiskGate(true);
  const first = parkRunningBuild();
  try {
    await started.promise;
    // A task turn lets ready promises settle, without completing the scan.
    // This tests ordering, not elapsed time on a loaded host.
    const verdict = await Promise.race([
      first,
      new Promise<"blocked on scan">((resolve) =>
        setTimeout(() => resolve("blocked on scan"), 0)
      ),
    ]);
    assertStringIncludes(verdict ?? "", "host disk below its floor");
    now = 120_000; // Even a scan longer than the interval must not overlap.
    assertStringIncludes(
      await parkRunningBuild() ?? "",
      "host disk below its floor",
    );
    assertEquals(calls, 1);
    scan.resolve(38.5 * GIB);
    await scan.promise;
    const refreshed = await parkRunningBuild();
    assertStringIncludes(refreshed ?? "", "ephemeral cargo root 38.5 GB");
  } finally {
    scan.resolve(38.5 * GIB);
    await first;
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
    cleanup();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("Issue #5105 - du keeps the measured size when only descendants vanished", async () => {
  const path = "/var/tmp/vibe-cargo-target/build";
  for (
    const stderr of [
      `du: cannot access '${path}/debug/deps/temp.o': No such file or directory\n`,
      `du: ${path}/incremental/temp.o: No such file or directory\n`,
      `du: cannot access '${path}/a': No such file or directory\ndu: cannot access '${path}/b': No such file or directory\n`,
    ]
  ) {
    assertEquals(
      await measureDirectoryBytesStrictly(path, 100, () =>
        Promise.resolve({
          code: 1,
          kb: 2048,
          stderr,
        })),
      2 * 1024 * 1024,
    );
  }
});

Deno.test("Issue #5105 - strict du still rejects unreadable or unrecognised output", async () => {
  const path = "/var/tmp/vibe-cargo-target/build";
  for (
    const stderr of [
      `du: cannot read directory '${path}/private': Permission denied`,
      `du: cannot access '${path}/gone': No such file or directory\ndu: cannot read directory '${path}/private': Permission denied`,
      `du: cannot access '${path}-other/file': No such file or directory`,
      `du: cannot access '${path}/../other/file': No such file or directory`,
      "du: unknown failure",
      "",
    ]
  ) {
    await assertRejects(
      () =>
        measureDirectoryBytesStrictly(path, 100, () =>
          Promise.resolve({
            code: 1,
            kb: 2048,
            stderr,
          })),
      Error,
      "exited 1",
    );
  }
  await assertRejects(
    () =>
      measureDirectoryBytesStrictly(path, 100, () =>
        Promise.resolve({
          code: 1,
          kb: undefined,
          stderr: `du: cannot access '${path}/gone': No such file or directory`,
        })),
    Error,
    "printed no size",
  );
  await assertRejects(
    () =>
      measureDirectoryBytesStrictly(
        path,
        100,
        () => Promise.reject(new Error("du timed out")),
      ),
    Error,
    "du timed out",
  );
});

Deno.test("Issue #5105 - a released directory disappears from the measured listing", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/gone`);
    await Deno.mkdir(`${root}/remaining`);
    await Deno.writeFile(`${root}/remaining/blob`, new Uint8Array(64 * 1024));
    const usage = await measureEphemeralCargoRoot({
      listTargetDirs: listTargetDirsMeasuredBy(async (path) => {
        if (path.endsWith("/gone")) await Deno.remove(path);
        return await measureDirectoryBytesStrictly(path);
      }),
    }, root);
    assertEquals(usage.error, null);
    assertEquals(usage.dirs.map((d) => d.path), [`${root}/remaining`]);
    assertEquals(usage.bytes > 0, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
