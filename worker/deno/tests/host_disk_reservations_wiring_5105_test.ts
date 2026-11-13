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

interface Wiring {
  checkRootFilesystem: () => Promise<{ path: string; detail: string } | null>;
  /** The babysitter's reservation file, for removing it as the repair ends. */
  reservationPath: string;
  /** Rewrites the launcher's reading, as `run.sh` does, `seconds` ahead of now. */
  writeLauncherReading(availableBytes: number, seconds: number): Promise<void>;
  monitor: HostDiskMonitor;
}

async function withWiring(
  reserve: boolean,
  fn: (
    checkRootFilesystem: Wiring["checkRootFilesystem"],
    wiring: Wiring,
  ) => Promise<void>,
  /** What the ephemeral cargo root measures: the worker's own growth. */
  ephemeral: {
    bytes: number | null;
    /** Awaited by each walk before it reports; a test holds it open. */
    walk?: () => Promise<void>;
  } = { bytes: 0 },
  /** The launcher's first reading; the host starts low unless this is set. */
  startFree: number = FREE,
  /** The monitor's quiet interval and clock, for walks the check starts. */
  timing: { sampleIntervalMs: number; clock: { ms: number } } = {
    sampleIntervalMs: 0,
    clock: { ms: 0 },
  },
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
    sampleIntervalMs: timing.sampleIntervalMs,
    ...(timing.clock.ms === 0 ? {} : { now: () => timing.clock.ms }),
    measureEphemeralCargoRoot: async () => {
      await ephemeral.walk?.();
      return ephemeral.bytes;
    },
  });
  await Deno.writeTextFile(
    refreshFile,
    JSON.stringify({
      availableBytes: startFree,
      totalBytes: TOTAL,
      measuredAt: Math.floor(Date.now() / 1000),
      workVolumeTrimRefused: true,
    }),
  );
  const writeLauncherReading = (availableBytes: number, seconds: number) =>
    Deno.writeTextFile(
      refreshFile,
      JSON.stringify({
        availableBytes,
        totalBytes: TOTAL,
        measuredAt: Math.floor(Date.now() / 1000) + seconds,
        workVolumeTrimRefused: true,
      }),
    );
  const reservationPath =
    `${home}/logs/${HOST_DISK_RESERVATIONS_DIR}/babysitter-repair-1.json`;
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
    const checkRootFilesystem = async () => {
      const check = deps.checkRootFilesystem;
      assert(check !== undefined);
      return await check();
    };
    await fn(checkRootFilesystem, {
      checkRootFilesystem,
      reservationPath,
      writeLauncherReading,
      monitor,
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

Deno.test("Issue #5105 - a released reservation keeps explaining the dip until a launcher reading measured after the release arrives", async () => {
  await withWiring(true, async (_check, wiring) => {
    assertEquals(await parkRunningBuild(), null);
    // The repair ends and the babysitter removes its file; the launcher has
    // not rewritten host-disk.json, so the worker still holds the low reading.
    await Deno.remove(wiring.reservationPath);
    assertEquals(await parkRunningBuild(), null, "build killed at release");
    assert((await wiring.checkRootFilesystem())?.path !== "host disk");
    // A fresh reading that is still low: the babysitter no longer explains it.
    await wiring.writeLauncherReading(FREE, 5);
    assertStringIncludes(
      await parkRunningBuild() ?? "",
      "host disk below its floor",
    );
    assertEquals((await wiring.checkRootFilesystem())?.path, "host disk");
  });
  await withWiring(true, async (_check, wiring) => {
    assertEquals(await parkRunningBuild(), null);
    await Deno.remove(wiring.reservationPath);
    assertEquals(await parkRunningBuild(), null);
    // A fresh reading that shows the space back: nothing to park for.
    await wiring.writeLauncherReading(120 * GIB, 5);
    assertEquals(await parkRunningBuild(), null);
  });
});

Deno.test("Issue #5105 - the worker's own measured growth stops the reservation explaining the dip", async () => {
  // Growth is measured from when the worker first saw the reservation: 20 GiB
  // of ephemeral cargo root after that exceeds the whole drop to FREE.
  const grows = { bytes: 0 as number | null };
  await withWiring(true, async (check) => {
    assertEquals(await parkRunningBuild(), null);
    grows.bytes = 20 * GIB;
    assertStringIncludes(
      await parkRunningBuild() ?? "",
      "host disk below its floor",
    );
    assertEquals((await check())?.path, "host disk");
  }, grows);
  // A cargo root whose measurement failed credits nothing, whatever it held.
  const fails = { bytes: 0 as number | null };
  await withWiring(true, async (check) => {
    assertEquals(await parkRunningBuild(), null);
    fails.bytes = null;
    assertStringIncludes(
      await parkRunningBuild() ?? "",
      "host disk below its floor",
    );
    assertEquals((await check())?.path, "host disk");
  }, fails);
});

Deno.test("Issue #5105 - a reservation first seen at ok takes its baseline from a fresh cargo root measurement", async () => {
  // The root last measured 10 GiB, then grew to 30 GiB before the babysitter's
  // reservation was first seen while the host was still ok. That growth is the
  // worker's, but it came before the reservation, so it must not be charged
  // against the dip that follows.
  const root = { bytes: 30 * GIB as number | null };
  await withWiring(
    true,
    async (_check, wiring) => {
      wiring.monitor.recordEphemeralCargoRootBytes(10 * GIB);
      assertEquals(await parkRunningBuild(), null, "ok host parks nothing");
      // The repair now pushes the host below the floor; the root is unchanged.
      await wiring.writeLauncherReading(FREE, 5);
      assertEquals(
        await parkRunningBuild(),
        null,
        "a stale baseline charged the earlier growth against the dip",
      );
      assert((await wiring.checkRootFilesystem())?.path !== "host disk");
      // Growth after the reservation was seen still stops the credit.
      root.bytes = 60 * GIB;
      assertStringIncludes(
        await parkRunningBuild() ?? "",
        "host disk below its floor",
      );
    },
    root,
    120 * GIB,
  );
  // A baseline measurement that fails leaves the growth unknown: no credit.
  const fails = { bytes: null as number | null };
  await withWiring(
    true,
    async (_check, wiring) => {
      wiring.monitor.recordEphemeralCargoRootBytes(10 * GIB);
      assertEquals(await parkRunningBuild(), null);
      await wiring.writeLauncherReading(FREE, 5);
      assertStringIncludes(
        await parkRunningBuild() ?? "",
        "host disk below its floor",
      );
    },
    fails,
    120 * GIB,
  );
});

/** Walks the test holds open one at a time, so it decides who overlaps. */
function heldWalks() {
  const open: Array<() => void> = [];
  const waiters: Array<{ n: number; wake: () => void }> = [];
  let started = 0;
  const walks = {
    hold: false,
    /** Walks started and not yet finished. */
    get open(): number {
      return open.length;
    },
    walk(): Promise<void> {
      started++;
      for (const w of waiters) if (started >= w.n) w.wake();
      if (!walks.hold) return Promise.resolve();
      return new Promise<void>((resolve) => open.push(resolve));
    },
    /** Resolves once `n` walks have started. */
    startedAtLeast(n: number): Promise<void> {
      if (started >= n) return Promise.resolve();
      return new Promise((wake) => waiters.push({ n, wake }));
    },
    /** Lets every open walk finish. */
    finish(): void {
      for (const resolve of open.splice(0)) resolve();
    },
  };
  return walks;
}

Deno.test("Issue #5105 - two probes overlapping at first sight both leave the reservation credited", async () => {
  const held = heldWalks();
  const root = { bytes: 0 as number | null, walk: () => held.walk() };
  await withWiring(
    true,
    async (_check, wiring) => {
      // Probe A starts the baseline walk; probe B arrives while it runs.
      held.hold = true;
      const enteredB = Promise.withResolvers<void>();
      const refreshNow = wiring.monitor.refreshEphemeralCargoRootNow.bind(
        wiring.monitor,
      );
      let entered = 0;
      wiring.monitor.refreshEphemeralCargoRootNow = () => {
        if (++entered === 2) enteredB.resolve();
        return refreshNow();
      };
      const a = parkRunningBuild();
      await held.startedAtLeast(1);
      const b = parkRunningBuild();
      await enteredB.promise;
      held.hold = false;
      held.finish();
      assertEquals(await a, null);
      assertEquals(await b, null);
      // The repair now takes the host below the floor; the worker grew nothing.
      await wiring.writeLauncherReading(FREE, 5);
      assertEquals(
        await parkRunningBuild(),
        null,
        "overlapping first-sight probes left the reservation uncredited",
      );
      assert((await wiring.checkRootFilesystem())?.path !== "host disk");
    },
    root,
    120 * GIB,
  );
});

Deno.test("Issue #5105 - the first probe after the release reads the growth only once the walk its check started has finished", async () => {
  const held = heldWalks();
  const root = { bytes: 0 as number | null, walk: () => held.walk() };
  const timing = {
    sampleIntervalMs: 60_000,
    clock: { ms: Date.now() },
  };
  await withWiring(
    true,
    async (_check, wiring) => {
      assertEquals(await parkRunningBuild(), null);
      // The repair ends 90 s after the last walk, past the quiet interval, so
      // this probe's low check starts a walk of its own.
      timing.clock.ms += 90_000;
      await Deno.remove(wiring.reservationPath);
      held.hold = true;
      const probe = parkRunningBuild();
      for (let turn = 0; turn < 200 && held.open === 0; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert(held.open > 0, "the probe's check started no walk");
      // A probe that waits for the walk stays pending; a few event-loop turns
      // let one that does not finish its ledger read first.
      for (let turn = 0; turn < 20; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      held.hold = false;
      held.finish();
      assertEquals(
        await probe,
        null,
        "build killed at the release, while the walk was in flight",
      );
    },
    root,
    FREE,
    timing,
  );
});

Deno.test("Issue #5105 - a probe waiting on a walk takes its status again when another check adopts a newer launcher reading", async () => {
  const held = heldWalks();
  const root = { bytes: 0 as number | null, walk: () => held.walk() };
  const timing = {
    sampleIntervalMs: 60_000,
    clock: { ms: Date.now() },
  };
  await withWiring(
    true,
    async (_check, wiring) => {
      assertEquals(await parkRunningBuild(), null);
      // The repair ends 90 s after the last walk, so the next probe's low
      // check starts a walk and then waits on it holding a stale low status.
      timing.clock.ms += 90_000;
      await Deno.remove(wiring.reservationPath);
      held.hold = true;
      const probe = parkRunningBuild();
      for (let turn = 0; turn < 200 && held.open === 0; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert(held.open > 0, "the probe's check started no walk");
      // Meanwhile another check (a second slot's poll, the claim gate)
      // adopts the launcher's fresh reading, measured after the release,
      // and so forgets the released reservation.
      await wiring.writeLauncherReading(120 * GIB, 5);
      assertEquals((await wiring.monitor.check({ force: true })).level, "ok");
      held.hold = false;
      held.finish();
      assertEquals(
        await probe,
        null,
        "build killed on a stale low status after the host recovered",
      );
    },
    root,
    FREE,
    timing,
  );
});
