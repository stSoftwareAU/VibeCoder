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
    ...(hostDiskReservations === undefined ? {} : { hostDiskReservations }),
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
    const readings = [
      reading("low", 40 * GB, EXPLAINED),
      reading("low", 40 * GB, EXPLAINED),
      reading("ok", 120 * GB, EXPLAINED),
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
