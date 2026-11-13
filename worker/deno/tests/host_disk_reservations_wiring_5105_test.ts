/**
 * The production wiring reads the babysitter's reservation ledger from the
 * worker's log directory (Issue #5105): `${HOME}/logs/host-disk-reservations`.
 *
 * Each case pairs a reading with a live reservation file against the same
 * reading without one, through `createProductionRunCoreDeps`.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  HOST_DISK_AVAIL_ENV,
  HOST_DISK_TOTAL_ENV,
  HostDiskMonitor,
} from "../lib/host_disk.ts";
import {
  enableInFlightHostDiskGate,
  parkRunningBuild,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import {
  HOST_DISK_RESERVATIONS_DIR,
  writeHostDiskReservation,
} from "../lib/host_disk_reservations.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createLogger } from "../lib/logger.ts";

const GIB = 1024 ** 3;
const TOTAL = 460 * GIB;
const FREE = 40 * GIB;

async function withWiring(
  reserve: boolean,
  fn: (
    checkRootFilesystem: () => Promise<{ path: string; detail: string } | null>,
  ) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  const work = await Deno.makeTempDir();
  const refreshFile = `${home}/host-disk-refresh.json`;
  const monitor = new HostDiskMonitor({
    workDir: "/work",
    env: (name) =>
      name === HOST_DISK_AVAIL_ENV
        ? String(FREE)
        : name === HOST_DISK_TOTAL_ENV
        ? String(TOTAL)
        : undefined,
    // A separate work volume (different total): the launch-baseline path,
    // where the worker's own growth is measured.
    probe: () =>
      Promise.resolve({
        availableBytes: 0,
        usedBytes: 0,
        totalBytes: 504 * GIB,
      }),
    refreshFile,
    measureEphemeralCargoRoot: () => Promise.resolve(0),
  });
  await Deno.writeTextFile(
    refreshFile,
    JSON.stringify({
      availableBytes: FREE,
      totalBytes: TOTAL,
      measuredAt: Math.floor(Date.now() / 1000),
      workVolumeTrimRefused: true,
    }),
  );
  const floor = monitor.floorBytesFor(TOTAL);
  // The test needs a reading below the floor but above its hard minimum.
  assert(floor > FREE && floor / 2 <= FREE, `floor ${floor}`);
  if (reserve) {
    await writeHostDiskReservation(
      `${home}/logs/${HOST_DISK_RESERVATIONS_DIR}`,
      {
        holder: "babysitter",
        id: "babysitter-repair-1",
        bytes: floor,
        // The whole drop to FREE is the babysitter's: the worker grew nothing.
        availableAtAdmission: floor + GIB,
        admittedAt: Date.now() - 60_000,
        expiresAt: Date.now() + 3_600_000,
      },
    );
  }
  const { deps, cleanup } = await createProductionRunCoreDeps({
    repoDir: work,
    workDir: work,
    githubUser: "test-user",
    config: buildDefaultWorkerConfig(),
    env: (name) => (name === "HOME" ? home : undefined),
    logger: createLogger({ write: () => {} }),
    hostDisk: monitor,
  });
  enableInFlightHostDiskGate(true);
  try {
    await fn(async () => {
      const check = deps.checkRootFilesystem;
      assert(check !== undefined);
      return await check();
    });
  } finally {
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
    cleanup();
    await Deno.remove(home, { recursive: true });
    await Deno.remove(work, { recursive: true });
  }
}

Deno.test("Issue #5105 - production parkRunningBuild reads the reservation in ${HOME}/logs", async () => {
  await withWiring(true, async () => {
    assertEquals(await parkRunningBuild(), null);
  });
  await withWiring(false, async () => {
    assertStringIncludes(
      await parkRunningBuild() ?? "",
      "host disk below its floor",
    );
  });
});

Deno.test("Issue #5105 - production checkRootFilesystem reads the reservation in ${HOME}/logs", async () => {
  await withWiring(true, async (check) => {
    const fault = await check();
    assert(fault?.path !== "host disk", JSON.stringify(fault));
  });
  await withWiring(false, async (check) => {
    assertEquals((await check())?.path, "host disk");
  });
});
