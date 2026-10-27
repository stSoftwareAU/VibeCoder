/**
 * The in-flight host-disk park respects the cargo project (Issue #4413).
 *
 * A merge-only admission means the host is above its floor but short of the
 * 25 GB ephemeral cargo headroom. Only a cargo build writes to the ephemeral
 * cargo root, so a checkout with no cargo project must not be parked for that
 * headroom: it parks only below the floor. A checkout holding a cargo project
 * still parks, and the floor applies to every checkout.
 *
 * Every test injects an empty ephemeral root, so no real target directory is
 * read or pruned, and every checkout is a temp directory removed afterwards.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  enableInFlightHostDiskGate,
  type EphemeralRootDeps,
  heavyBuildAdmission,
  type HeavyBuildDiskReading,
  parkInFlightBuild,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";

const GB = 1_073_741_824;

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

/** An ephemeral cargo root with no target directories, so nothing is pruned. */
const emptyRoot: EphemeralRootDeps = {
  listTargetDirs: () => Promise.resolve([]),
  removeDir: () => Promise.resolve(),
  nowMs: () => Date.now(),
};

/** Run `fn` with the in-flight gate armed and host reading `r` registered. */
async function armed(
  r: HeavyBuildDiskReading,
  fn: () => Promise<void>,
): Promise<void> {
  enableInFlightHostDiskGate(true);
  registerHeavyBuildDiskProbe(() => Promise.resolve(r));
  try {
    await fn();
  } finally {
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
  }
}

/** Run `fn` in a fresh temp checkout holding `files`, removed afterwards. */
async function withCheckout(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "in-flight-4413-" });
  try {
    for (const [rel, text] of Object.entries(files)) {
      const path = `${dir}/${rel}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(path, text);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const CARGO_TOML = '[package]\nname = "fixture"\n';

Deno.test("in-flight park - a merge-only Deno-only checkout is not parked (Issue #4413)", async () => {
  await withCheckout(
    { "deno.json": "{}" },
    (dir) =>
      armed(reading(55.3), async () => {
        assertEquals(
          (await heavyBuildAdmission(dir, emptyRoot)).mode,
          "merge-only",
        );
        assertEquals(await parkInFlightBuild(dir, emptyRoot), null);
      }),
  );
});

Deno.test("in-flight park - a merge-only checkout with a cargo project is parked (Issue #4413)", async () => {
  await withCheckout(
    { "Cargo.toml": CARGO_TOML },
    (dir) =>
      armed(reading(55.3), async () => {
        const parked = await parkInFlightBuild(dir, emptyRoot);
        if (parked === null) {
          throw new Error("expected the cargo checkout parked");
        }
        assertStringIncludes(parked, "Parked as infrastructure (Issue #4360).");
        assertStringIncludes(
          parked,
          "ephemeral cargo root over budget (55.3 GB free, floor 46.0 GB + headroom 25.0 GB)",
        );
      }),
  );
});

Deno.test("in-flight park - a Deno-only checkout below the floor is still parked (Issue #4413)", async () => {
  await withCheckout(
    { "deno.json": "{}" },
    (dir) =>
      armed(reading(6), async () => {
        const parked = await parkInFlightBuild(dir, emptyRoot);
        if (parked === null) {
          throw new Error("expected the below-floor checkout parked");
        }
        assertStringIncludes(parked, "Parked as infrastructure (Issue #4360).");
        assertStringIncludes(parked, "46.0 GB");
      }),
  );
});

Deno.test("in-flight park - a Cargo.toml one level down counts as a cargo project (Issue #4413)", async () => {
  await withCheckout(
    { "rust/Cargo.toml": CARGO_TOML },
    (dir) =>
      armed(reading(55.3), async () => {
        const parked = await parkInFlightBuild(dir, emptyRoot);
        if (parked === null) {
          throw new Error("expected the nested cargo checkout parked");
        }
        assertStringIncludes(parked, "Parked as infrastructure (Issue #4360).");
      }),
  );
});

Deno.test("in-flight park - an empty or missing checkout with merge-only is not parked (Issue #4413)", async () => {
  await withCheckout({}, (dir) =>
    armed(reading(55.3), async () => {
      assertEquals(await parkInFlightBuild(dir, emptyRoot), null);
      assertEquals(
        await parkInFlightBuild(`${dir}/missing-checkout`, emptyRoot),
        null,
      );
    }));
});
