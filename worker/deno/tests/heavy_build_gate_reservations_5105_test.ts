/**
 * The claim deferral and the merge-gate cargo skip subtract the unconsumed
 * part of the live babysitter reservations from the free space they test
 * (Issue #5105).
 *
 * Each case pairs a reading that clears the floor plus the 25 GB cargo
 * headroom with a 16 GB reservation nothing has consumed yet, against the
 * same reading without the reservation as the control. Only the reservation
 * differs, so a gate that ignored it would give the control's answer for both.
 *
 * Every root here is a fake, and every checkout is a temp directory removed
 * afterwards.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  cargoClaimDeferral,
  enableInFlightHostDiskGate,
  type EphemeralRootDeps,
  type HeavyBuildDiskReading,
  registerHeavyBuildDiskProbe,
  shouldSkipEphemeralCargoBuild,
} from "../lib/heavy_build_gate.ts";
import {
  BABYSITTER_LAUNCH_FOOTPRINT_BYTES,
  type HostDiskReservation,
} from "../lib/host_disk_reservations.ts";

const GB = 1_073_741_824;
const NOW = Date.parse("2026-11-13T03:00:00Z");
const HOUR = 3_600_000;
/** Clears the 46 GB floor plus the 25 GB cargo headroom (71 GB) by 9 GB. */
const FREE = 80 * GB;

/** A 16 GB babysitter reservation admitted at the current reading: none consumed. */
const reservation: HostDiskReservation = {
  holder: "babysitter",
  id: "vibe-babysitter-r1",
  bytes: BABYSITTER_LAUNCH_FOOTPRINT_BYTES,
  availableAtAdmission: FREE,
  admittedAt: NOW - 60_000,
  expiresAt: NOW + HOUR,
};

/** A trim-refused ok reading with `FREE` free against a 46 GB floor. */
function reading(
  live: readonly HostDiskReservation[],
): HeavyBuildDiskReading {
  return {
    status: {
      level: "ok",
      availableBytes: FREE,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail: "80 GB free, floor 46.0 GB",
    },
    floorBytes: 46 * GB,
    trimRefused: true,
    hostDiskReservations: live,
  };
}

/** An empty fake ephemeral root: nothing to prune, nothing removed. */
function emptyRoot() {
  const removed: string[] = [];
  const deps: EphemeralRootDeps = {
    listTargetDirs: () => Promise.resolve([]),
    removeDir: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
    nowMs: () => NOW,
  };
  return { deps, removed };
}

async function armed<T>(
  r: HeavyBuildDiskReading,
  fn: () => Promise<T>,
): Promise<T> {
  enableInFlightHostDiskGate(true);
  registerHeavyBuildDiskProbe(() => Promise.resolve(r));
  try {
    return await fn();
  } finally {
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
  }
}

/** A temp cargo checkout. */
async function withCargoCheckout<T>(fn: (checkout: string) => Promise<T>) {
  const checkout = await Deno.makeTempDir({ prefix: "reservations-5105-" });
  try {
    await Deno.writeTextFile(
      `${checkout}/Cargo.toml`,
      '[package]\nname = "fixture"\n',
    );
    return await fn(checkout);
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
}

Deno.test("Issue #5105 - cargoClaimDeferral defers a cargo claim an outstanding reservation leaves short of the headroom", async () => {
  await withCargoCheckout(async (checkout) => {
    const root = emptyRoot();
    const deferral = await armed(
      reading([reservation]),
      () => cargoClaimDeferral(checkout, root.deps),
    );
    assert(deferral !== null, "80 GB less 16 GB outstanding is under 71 GB");
    assertStringIncludes(deferral, "ephemeral cargo root over budget");
    assertEquals(root.removed, [], "a claim scan never prunes");
  });
});

Deno.test("Issue #5105 - cargoClaimDeferral claims the same reading with no reservation (control)", async () => {
  await withCargoCheckout(async (checkout) => {
    assertEquals(
      await armed(
        reading([]),
        () => cargoClaimDeferral(checkout, emptyRoot().deps),
      ),
      null,
    );
  });
});

Deno.test("Issue #5105 - shouldSkipEphemeralCargoBuild skips the cargo build an outstanding reservation leaves short of the headroom", async () => {
  await withCargoCheckout(async (checkout) => {
    const root = emptyRoot();
    assertEquals(
      await armed(
        reading([reservation]),
        () => shouldSkipEphemeralCargoBuild(checkout, root.deps),
      ),
      true,
    );
    assertEquals(root.removed, []);
  });
});

Deno.test("Issue #5105 - shouldSkipEphemeralCargoBuild builds the same reading with no reservation (control)", async () => {
  await withCargoCheckout(async (checkout) => {
    assertEquals(
      await armed(
        reading([]),
        () => shouldSkipEphemeralCargoBuild(checkout, emptyRoot().deps),
      ),
      false,
    );
  });
});
