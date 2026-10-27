/**
 * The in-flight park credits the checkout's own cargo cache (Issue #4423).
 *
 * GRQ-AutoTrader#4488, 2026-10-27: a run on a cargo checkout was admitted,
 * built for 22 minutes, and was then refused at `completion` with "ephemeral
 * cargo root over budget (58.6 GB free, floor 46.0 GB + headroom 25.0 GB)".
 * The headroom is room for one build from scratch; the run's own build had
 * already written much of it into the checkout's target directory, and the
 * next step's build is incremental. So the bytes already in the checkout's own
 * target directories count towards the headroom, capped at the headroom, so
 * the host floor itself is never relaxed. The sync admission is unchanged.
 *
 * Every root here is a fake, so no real target directory is read or pruned,
 * and every checkout is a temp directory removed afterwards.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  enableInFlightHostDiskGate,
  type EphemeralRootDeps,
  type EphemeralTargetDir,
  heavyBuildAdmission,
  type HeavyBuildDiskReading,
  parkInFlightBuild,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import { cargoTargetDirForCheckout } from "../lib/ephemeral_build_cache.ts";

const GB = 1_073_741_824;
const NOW = Date.parse("2026-10-27T12:00:00Z");

/** A trim-refused reading with `freeGb` free against a 46 GB floor. */
function reading(freeGb: number): HeavyBuildDiskReading {
  const level = freeGb < 46 ? "low" : "ok";
  return {
    status: {
      level,
      availableBytes: freeGb * GB,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail: `${freeGb} GB free, floor 46.0 GB`,
    },
    floorBytes: 46 * GB,
    trimRefused: true,
  };
}

/** A fake ephemeral root holding `dirs`, recording every removal. */
function fakeRoot(dirs: EphemeralTargetDir[]) {
  const removed: string[] = [];
  const deps: EphemeralRootDeps = {
    listTargetDirs: () => Promise.resolve(dirs),
    removeDir: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
    nowMs: () => NOW,
  };
  return { deps, removed };
}

/** The checkout's own target directory, written to just now, of `gb` GB. */
function ownTargetDir(checkout: string, gb: number): EphemeralTargetDir {
  return {
    path: cargoTargetDirForCheckout(checkout),
    bytes: gb * GB,
    lastWriteMs: NOW,
  };
}

/** Run `fn` with the in-flight gate armed and host reading `r` registered. */
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

/** Run `fn` in a fresh temp cargo checkout, removed afterwards. */
async function withCargoCheckout<T>(fn: (dir: string) => Promise<T>) {
  const dir = await Deno.makeTempDir({ prefix: "in-flight-4423-" });
  try {
    await Deno.writeTextFile(
      `${dir}/Cargo.toml`,
      '[package]\nname = "fixture"\n',
    );
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("in-flight park - a cargo checkout whose own cache covers the shortfall is not parked (Issue #4423)", async () => {
  await withCargoCheckout((dir) =>
    armed(reading(58.6), async () => {
      // 46 + 25 − 58.6 = 12.4 GB short; the run's own 13 GB covers it.
      const root = fakeRoot([ownTargetDir(dir, 13)]);
      assertEquals(await parkInFlightBuild(dir, root.deps), null);
      assertEquals(root.removed, []);
    })
  );
});

Deno.test("in-flight park - a cargo checkout whose own cache is too small is still parked, naming the credit (Issue #4423)", async () => {
  await withCargoCheckout((dir) =>
    armed(reading(58.6), async () => {
      const root = fakeRoot([ownTargetDir(dir, 5)]);
      const parked = await parkInFlightBuild(dir, root.deps);
      if (parked === null) throw new Error("expected the checkout parked");
      assertStringIncludes(parked, "Parked as infrastructure (Issue #4360).");
      assertStringIncludes(parked, "5.0 GB already in this checkout's cache");
      assertEquals(root.removed, []);
    })
  );
});

Deno.test("in-flight park - the credit never exceeds the headroom, so the floor still holds (Issue #4423)", async () => {
  await withCargoCheckout((dir) =>
    armed(reading(46.5), async () => {
      // A 40 GB cache credits 25 GB at most: 46.5 ≥ 46 proceeds…
      const above = fakeRoot([ownTargetDir(dir, 40)]);
      assertEquals(await parkInFlightBuild(dir, above.deps), null);
    })
  );
  await withCargoCheckout((dir) =>
    armed(reading(45), async () => {
      // …and below the floor no cache helps.
      const below = fakeRoot([ownTargetDir(dir, 40)]);
      const parked = await parkInFlightBuild(dir, below.deps);
      if (parked === null) throw new Error("expected the checkout parked");
      assertStringIncludes(parked, "host disk below its floor");
    })
  );
});

Deno.test("sync admission - the checkout's own cache is not credited (Issue #4423)", async () => {
  await withCargoCheckout((dir) =>
    armed(reading(58.6), async () => {
      const root = fakeRoot([ownTargetDir(dir, 13)]);
      assertEquals(
        (await heavyBuildAdmission(dir, root.deps)).mode,
        "merge-only",
      );
    })
  );
});
