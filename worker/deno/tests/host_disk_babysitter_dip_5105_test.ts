/**
 * A babysitter-driven host-disk dip is a wait, not a kill (Issue #5105).
 *
 * Each case pairs the explained reading with a control that differs only in the
 * probed value (no reservation, or one that cannot explain the dip).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type BabysitterDipWait,
  babysitterDipWaitWithin,
  babysitterDrivenDip,
  enableInFlightHostDiskGate,
  type EphemeralRootDeps,
  heavyBuildAdmission,
  type HeavyBuildDiskReading,
  hostDiskLaunchStopReason,
  parkInFlightBuild,
  parkRunningBuild,
  readHostDiskReservationsForProbe,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import { fakeClock } from "./support/fake_clock.ts";
import {
  type HostDiskReservation,
  writeHostDiskReservation,
} from "../lib/host_disk_reservations.ts";

const GB = 1_073_741_824;
const FLOOR = 46 * GB;
const NOW = Date.parse("2026-11-13T00:00:00Z");

function reservation(
  over: Partial<HostDiskReservation> = {},
): HostDiskReservation {
  return {
    holder: "babysitter",
    id: "repair-1",
    bytes: 16 * GB,
    availableAtAdmission: 52 * GB,
    admittedAt: NOW - 60_000,
    expiresAt: NOW + 3_600_000,
    ...over,
  };
}

function reading(
  level: "ok" | "low",
  free: number,
  hostDiskReservations?: readonly HostDiskReservation[],
  workerGrowthSinceReservationBytes: number | undefined = 0,
): HeavyBuildDiskReading {
  return {
    status: {
      level,
      availableBytes: free,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail: `host ${free} bytes free, floor ${FLOOR} — below the floor`,
    },
    floorBytes: FLOOR,
    trimRefused: true,
    ...(hostDiskReservations === undefined
      ? {}
      : { hostDiskReservations, workerGrowthSinceReservationBytes }),
  };
}

/** The reservation has vanished but the launcher's low reading predates it. */
function released(free: number): HeavyBuildDiskReading {
  return {
    ...reading("low", free, []),
    releasedHostDiskReservations: EXPLAINED,
  };
}

// 40 GB free against a 46 GB floor; the reservation consumed 12 GB of its 16 GB.
const EXPLAINED = [reservation()];
// Consumed only 1 GB: cannot account for a 6 GB shortfall.
const TOO_SMALL = [reservation({ availableAtAdmission: 41 * GB })];

async function withProbe<T>(
  r: () => HeavyBuildDiskReading,
  fn: () => Promise<T>,
): Promise<T> {
  enableInFlightHostDiskGate(true);
  registerHeavyBuildDiskProbe(() => Promise.resolve(r()));
  try {
    return await fn();
  } finally {
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
  }
}

Deno.test("Issue #5105 - parkRunningBuild does not kill a dip the reservations explain", async () => {
  assert(babysitterDrivenDip(reading("low", 40 * GB, EXPLAINED)));
  assertEquals(
    await withProbe(
      () => reading("low", 40 * GB, EXPLAINED),
      () => parkRunningBuild(),
    ),
    null,
  );
  const control = await withProbe(
    () => reading("low", 40 * GB),
    () => parkRunningBuild(),
  );
  assert(control !== null);
  assertStringIncludes(control, "Parked as infrastructure");
});

Deno.test("Issue #5105 - hostDiskLaunchStopReason continues for an explained dip", () => {
  assertEquals(
    hostDiskLaunchStopReason({
      ...reading("low", 40 * GB, EXPLAINED),
      recreateDeclined: true,
    }),
    null,
  );
  assert(hostDiskLaunchStopReason(reading("low", 40 * GB)) !== null);
});

Deno.test("Issue #5105 - a dip the reservation cannot explain still parks and stops", async () => {
  const r = reading("low", 40 * GB, TOO_SMALL);
  assertEquals(babysitterDrivenDip(r), false);
  assert(hostDiskLaunchStopReason(r) !== null);
  assert(await withProbe(() => r, () => parkRunningBuild()) !== null);
});

function fakeWait(over: Partial<BabysitterDipWait> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const wait: BabysitterDipWait = {
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    nowMs: () => clock,
    pollMs: 1_000,
    maxWaitMs: 20_000,
    ...over,
  };
  return { wait, sleeps };
}

Deno.test("Issue #5105 - parkInFlightBuild waits out an explained dip that recovers", async () => {
  const checkout = await Deno.makeTempDir({ prefix: "babysitter-dip-5105-" });
  try {
    // The repair ends mid-wait: the file goes (held as released) while the
    // launcher's low reading is unchanged, then the fresh reading arrives
    // with no reservation at all, as production delivers them.
    const readings = [
      reading("low", 40 * GB, EXPLAINED),
      released(40 * GB),
      reading("ok", 120 * GB, []),
    ];
    let i = 0;
    const { wait, sleeps } = fakeWait();
    const result = await withProbe(
      () => {
        const r = readings.at(Math.min(i++, readings.length - 1));
        if (r === undefined) throw new Error("no reading");
        return r;
      },
      () => parkInFlightBuild(checkout, undefined, wait),
    );
    assertEquals(result, null);
    assertEquals(sleeps, [1_000, 1_000]);
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});

Deno.test("Issue #5105 - parkInFlightBuild parks once the wait bound passes", async () => {
  const checkout = await Deno.makeTempDir({ prefix: "babysitter-dip-5105-" });
  try {
    const { wait, sleeps } = fakeWait({ maxWaitMs: 3_000 });
    const result = await withProbe(
      () => reading("low", 40 * GB, EXPLAINED),
      () => parkInFlightBuild(checkout, undefined, wait),
    );
    assert(result !== null);
    assertStringIncludes(result, "Parked as infrastructure");
    assertEquals(sleeps.length, 3);
    // Control: the same low reading without reservations parks without waiting.
    const control = fakeWait();
    const parked = await withProbe(
      () => reading("low", 40 * GB),
      () => parkInFlightBuild(checkout, undefined, control.wait),
    );
    assert(parked !== null);
    assertEquals(control.sleeps.length, 0);
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});

Deno.test("Issue #5105 - cargo admission subtracts unconsumed reservations", async () => {
  const checkout = await Deno.makeTempDir({ prefix: "babysitter-dip-5105-" });
  await Deno.writeTextFile(
    `${checkout}/Cargo.toml`,
    '[package]\nname = "fixture"\n',
  );
  const deps: EphemeralRootDeps = {
    listTargetDirs: () => Promise.resolve([]),
    removeDir: () => Promise.resolve(),
    nowMs: () => NOW,
  };
  try {
    // 80 GB free clears floor 46 + headroom 25 = 71 GB.
    const free = 80 * GB;
    const admit = (r: HeavyBuildDiskReading) => {
      registerHeavyBuildDiskProbe(() => Promise.resolve(r));
      return heavyBuildAdmission(checkout, deps);
    };
    try {
      assertEquals((await admit(reading("ok", free))).mode, "build");
      // Nothing consumed yet: all 16 GB outstanding leaves 64 GB < 71 GB.
      const held = await admit(
        reading("ok", free, [reservation({ availableAtAdmission: free })]),
      );
      assertEquals(held.mode, "merge-only");
    } finally {
      registerHeavyBuildDiskProbe(undefined);
    }
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});

Deno.test("Issue #5105 - the probe helper reads live reservations and survives an unreadable directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "babysitter-dip-5105-" });
  try {
    const warnings: string[] = [];
    const written = reservation({
      admittedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 3_600_000,
    });
    await writeHostDiskReservation(`${dir}/ledger`, written);
    const live = await readHostDiskReservationsForProbe(
      `${dir}/ledger`,
      Date.now(),
      (m) => warnings.push(m),
    );
    assertEquals(live, [written]);
    assertEquals(warnings, []);

    const notADir = `${dir}/plain-file`;
    await Deno.writeTextFile(notADir, "x");
    const none = await readHostDiskReservationsForProbe(
      notADir,
      Date.now(),
      (m) => warnings.push(m),
    );
    assertEquals(none, []);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0] ?? "", notADir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Finding 1 of the pre-PR verifier: the worker's own growth is not the
// babysitter's, and below the hard minimum nothing is credited.
Deno.test("Issue #5105 - a dip the worker's own growth caused still parks and still ends the launch", async () => {
  // Same 40 GB reading and reservation as EXPLAINED, but the worker grew 12 GB
  // of the 12 GB drop itself: nothing is left to credit the babysitter with.
  const own = reading("low", 40 * GB, EXPLAINED, 12 * GB);
  assertEquals(babysitterDrivenDip(own), false);
  const parked = await withProbe(() => own, () => parkRunningBuild());
  assert(parked !== null);
  assertStringIncludes(parked, "Parked as infrastructure");
  assert(hostDiskLaunchStopReason(own) !== null);
  // Unknown worker growth credits nothing either.
  const unknown = reading("low", 40 * GB, EXPLAINED);
  delete unknown.workerGrowthSinceReservationBytes;
  assertEquals(babysitterDrivenDip(unknown), false);
  // Control: zero worker growth is the explained dip.
  assert(babysitterDrivenDip(reading("low", 40 * GB, EXPLAINED, 0)));
});

Deno.test("Issue #5105 - a reservation larger than the floor never credits a host near zero", async () => {
  // A 41 GB cargo reservation admitted at 50 GB free; the host is now at 1 GB
  // and the worker grew nothing. The credit would cover the floor, but 1 GB
  // is below the hard minimum, so the build parks and the launch ends.
  const big = [
    reservation({ bytes: 41 * GB, availableAtAdmission: 50 * GB }),
  ];
  const nearZero = reading("low", 1 * GB, big, 0);
  assertEquals(babysitterDrivenDip(nearZero), false);
  const parked = await withProbe(() => nearZero, () => parkRunningBuild());
  assert(parked !== null);
  assert(hostDiskLaunchStopReason(nearZero) !== null);
  // Control: at 30 GB free (above half the 46 GB floor) the same reservation
  // explains the 20 GB drop.
  assert(babysitterDrivenDip(reading("low", 30 * GB, big, 0)));
});

Deno.test("Issue #5105 - parkInFlightBuild does not wait by default", async () => {
  const checkout = await Deno.makeTempDir();
  try {
    let sleeps = 0;
    const parked = await withProbe(
      () => reading("low", 40 * GB, EXPLAINED),
      async () => {
        const original = globalThis.setTimeout;
        globalThis.setTimeout = ((fn: () => void, _ms?: number) => {
          sleeps++;
          return original(fn, 0);
        }) as typeof setTimeout;
        try {
          return await parkInFlightBuild(checkout);
        } finally {
          globalThis.setTimeout = original;
        }
      },
    );
    assertEquals(sleeps, 0);
    assert(parked !== null);
    assertStringIncludes(parked, "Parked as infrastructure");
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});

Deno.test("Issue #5105 - a released reservation is a wait, not a kill, until the fresh reading arrives", async () => {
  const gone = released(40 * GB);
  assert(babysitterDrivenDip(gone));
  assertEquals(await withProbe(() => gone, () => parkRunningBuild()), null);
  assertEquals(
    hostDiskLaunchStopReason({ ...gone, recreateDeclined: true }),
    null,
  );
  // Control: the same low reading with the release forgotten is unexplained.
  const forgotten = reading("low", 40 * GB, []);
  assertEquals(babysitterDrivenDip(forgotten), false);
  assert(await withProbe(() => forgotten, () => parkRunningBuild()) !== null);
  assert(hostDiskLaunchStopReason(forgotten) !== null);
  // A released reservation is nothing more outstanding: it never charges cargo
  // admission, which a live one that consumed nothing yet does.
  const checkout = await Deno.makeTempDir({ prefix: "babysitter-dip-5105-" });
  await Deno.writeTextFile(
    `${checkout}/Cargo.toml`,
    '[package]\nname = "fixture"\n',
  );
  const deps: EphemeralRootDeps = {
    listTargetDirs: () => Promise.resolve([]),
    removeDir: () => Promise.resolve(),
    nowMs: () => NOW,
  };
  try {
    const free = 80 * GB;
    const admit = (extra: Partial<HeavyBuildDiskReading>) => {
      registerHeavyBuildDiskProbe(() =>
        Promise.resolve({ ...reading("ok", free, []), ...extra })
      );
      return heavyBuildAdmission(checkout, deps);
    };
    try {
      const ghost = [reservation({ availableAtAdmission: free })];
      assertEquals(
        (await admit({ releasedHostDiskReservations: ghost })).mode,
        "build",
      );
      assertEquals(
        (await admit({ hostDiskReservations: ghost })).mode,
        "merge-only",
      );
    } finally {
      registerHeavyBuildDiskProbe(undefined);
    }
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});

Deno.test("Issue #5105 - parkInFlightBuild keeps waiting through the release and parks if no fresh reading comes", async () => {
  const checkout = await Deno.makeTempDir({ prefix: "babysitter-dip-5105-" });
  try {
    const { wait, sleeps } = fakeWait({ maxWaitMs: 3_000 });
    const result = await withProbe(
      () => released(40 * GB),
      () => parkInFlightBuild(checkout, undefined, wait),
    );
    assertEquals(sleeps.length, 3);
    assertStringIncludes(result ?? "", "Parked as infrastructure");
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});

Deno.test("Issue #5105 - babysitterDipWaitWithin clamps to the remaining budget", () => {
  const clock = fakeClock();
  const twentyMinutes = 20 * 60_000;
  assertEquals(
    babysitterDipWaitWithin(60 * 60_000, clock).maxWaitMs,
    twentyMinutes,
  );
  assertEquals(babysitterDipWaitWithin(90_000, clock).maxWaitMs, 90_000);
  assertEquals(babysitterDipWaitWithin(0, clock).maxWaitMs, 0);
  assertEquals(babysitterDipWaitWithin(-5_000, clock).maxWaitMs, 0);
});

Deno.test("Issue #5105 - babysitterDipWaitWithin sleeps and reads time through the clock it is given", async () => {
  const clock = fakeClock();
  const wait = babysitterDipWaitWithin(10 * 60_000, clock);
  const before = wait.nowMs();
  const slept = wait.sleep(wait.pollMs);
  await clock.advance(wait.pollMs);
  await slept;
  assertEquals(wait.nowMs() - before, wait.pollMs);
});
