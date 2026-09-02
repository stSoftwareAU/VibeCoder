/**
 * The claiming floor is configurable, discoverable, and says where it came
 * from (Issue #732).
 *
 * The floor is the larger of a gigabyte term (20) and a percentage term
 * (10 %) of the filesystem. On the reporter's 1.875 TB filesystem the
 * percentage term is ≈ 187 GB, so 37.5 GB free was judged "low" and work was
 * refused — and the only escape was two environment variables that worked but
 * were documented nowhere, with no way to state the floor in `.config.json`
 * beside the rest of the host's configuration (report item 10 of #722).
 *
 * The default formula is unchanged. What these tests pin is the resolution
 * table: unconfigured, config-only, environment-only, and both — with
 * `.config.json` winning, the precedence Issue #289 set for every other knob.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ConfiguredDiskFloors,
  DEFAULT_LOW_FLOOR_GB,
  DEFAULT_LOW_FLOOR_PERCENT,
  describeDiskFloors,
  diskFloorOrigin,
  lowFloorBytes,
  readConfiguredDiskFloors,
  resolveDiskFloors,
} from "../lib/host_disk.ts";

const GIB = 1_073_741_824;

/** The reporter's filesystem: 1.875 TB. */
const LARGE_FS = 1.875 * 1024 * GIB;
/** A small host, where the gigabyte term is the one that binds. */
const SMALL_FS = 100 * GIB;

/** An environment reader over a plain record. */
function env(
  values: Record<string, string> = {},
): (name: string) => string | undefined {
  return (name) => values[name];
}

Deno.test("resolveDiskFloors - an unconfigured host keeps today's formula (Issue #732)", () => {
  const floors = resolveDiskFloors(env());
  assertEquals(floors.lowFloorGb, DEFAULT_LOW_FLOOR_GB);
  assertEquals(floors.lowFloorPercent, DEFAULT_LOW_FLOOR_PERCENT);
  assertEquals(floors.lowFloorGbSource, "default");
  assertEquals(floors.lowFloorPercentSource, "default");

  // Small host: the 20 GB term binds. Large host: the 10 % term does, which
  // is the reported behaviour and is deliberately unchanged.
  assertEquals(lowFloorBytes(SMALL_FS, floors), 20 * GIB);
  assertEquals(lowFloorBytes(LARGE_FS, floors), 0.1 * LARGE_FS);
  assert(
    lowFloorBytes(LARGE_FS, floors) > 180 * GIB,
    "the reported 1.875 TB floor is still ~187 GB by default",
  );
});

Deno.test("resolveDiskFloors - .config.json sets either term (Issue #732)", () => {
  const floors = resolveDiskFloors(env(), {
    hostDiskLowFloorGb: 20,
    hostDiskLowFloorPercent: 1,
  });
  assertEquals(floors.lowFloorGb, 20);
  assertEquals(floors.lowFloorPercent, 1);
  assertEquals(floors.lowFloorGbSource, "config");
  assertEquals(floors.lowFloorPercentSource, "config");

  // The reported host, configured as the reporter configured it by hand:
  // 37.5 GB free clears a 20 GB floor, so work is claimed rather than refused.
  const floor = lowFloorBytes(LARGE_FS, floors);
  assertEquals(floor, 20 * GIB);
  assert(37.5 * GIB > floor, "37.5 GB free must clear the configured floor");
});

Deno.test("resolveDiskFloors - the environment overrides still work (Issue #732)", () => {
  const floors = resolveDiskFloors(env({
    VIBE_HOST_DISK_LOW_FLOOR_GB: "20",
    VIBE_HOST_DISK_LOW_FLOOR_PERCENT: "1",
  }));
  assertEquals(floors.lowFloorGb, 20);
  assertEquals(floors.lowFloorPercent, 1);
  assertEquals(floors.lowFloorGbSource, "env");
  assertEquals(floors.lowFloorPercentSource, "env");
});

Deno.test("resolveDiskFloors - .config.json wins over the environment (Issue #732)", () => {
  // The precedence Issue #289 set for every other knob, applied per term:
  // the file states the percentage, the environment raises the GB term for
  // this launch alone, and each is honoured where it is the only claimant.
  const floors = resolveDiskFloors(
    env({
      VIBE_HOST_DISK_LOW_FLOOR_GB: "50",
      VIBE_HOST_DISK_LOW_FLOOR_PERCENT: "25",
    }),
    { hostDiskLowFloorPercent: 1 },
  );
  assertEquals(floors.lowFloorPercent, 1, "the file wins the term it states");
  assertEquals(floors.lowFloorPercentSource, "config");
  assertEquals(floors.lowFloorGb, 50, "the term the file omits takes the env");
  assertEquals(floors.lowFloorGbSource, "env");
});

Deno.test("resolveDiskFloors - an unusable value falls through rather than binding (Issue #732)", () => {
  const cases: Array<{ name: string; configured: ConfiguredDiskFloors }> = [
    { name: "negative", configured: { hostDiskLowFloorGb: -5 } },
    { name: "not finite", configured: { hostDiskLowFloorGb: Number.NaN } },
    { name: "over 100 percent", configured: { hostDiskLowFloorPercent: 150 } },
  ];
  for (const { name, configured } of cases) {
    const floors = resolveDiskFloors(env(), configured);
    assertEquals(floors.lowFloorGb, DEFAULT_LOW_FLOOR_GB, name);
    assertEquals(floors.lowFloorPercent, DEFAULT_LOW_FLOOR_PERCENT, name);
  }

  // Garbage in the environment is ignored the same way.
  const fromEnv = resolveDiskFloors(env({
    VIBE_HOST_DISK_LOW_FLOOR_GB: "twenty",
    VIBE_HOST_DISK_LOW_FLOOR_PERCENT: "-1",
  }));
  assertEquals(fromEnv.lowFloorGb, DEFAULT_LOW_FLOOR_GB);
  assertEquals(fromEnv.lowFloorPercent, DEFAULT_LOW_FLOOR_PERCENT);
  assertEquals(fromEnv.lowFloorGbSource, "default");
});

Deno.test("describeDiskFloors - names the floor, the winning term and its origin (Issue #732)", () => {
  const configured = resolveDiskFloors(env(), {
    hostDiskLowFloorGb: 20,
    hostDiskLowFloorPercent: 1,
  });
  const described = describeDiskFloors(configured, LARGE_FS);
  assertStringIncludes(described, "20 GB");
  assertStringIncludes(described, "config");
  assertStringIncludes(described, "the GB term");

  const unconfigured = resolveDiskFloors(env());
  const defaultDescribed = describeDiskFloors(unconfigured, LARGE_FS);
  assertStringIncludes(defaultDescribed, "the percent term");
  assertStringIncludes(defaultDescribed, "default");

  assertEquals(diskFloorOrigin(configured), "gb=config,percent=config");
  assertEquals(diskFloorOrigin(unconfigured), "gb=default,percent=default");
});

Deno.test("readConfiguredDiskFloors - reads the file, and says nothing when there is none (Issue #732)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-floor-" });
  try {
    assertEquals(await readConfiguredDiskFloors(`${dir}/.config.json`), {});

    await Deno.writeTextFile(
      `${dir}/.config.json`,
      JSON.stringify({
        repos: ["org/repo"],
        host_disk_low_floor_gb: 20,
        host_disk_low_floor_percent: 1,
      }),
    );
    assertEquals(await readConfiguredDiskFloors(`${dir}/.config.json`), {
      hostDiskLowFloorGb: 20,
      hostDiskLowFloorPercent: 1,
    });

    // A file that states neither term is not a fault; it simply states none.
    await Deno.writeTextFile(`${dir}/.config.json`, JSON.stringify({}));
    assertEquals(await readConfiguredDiskFloors(`${dir}/.config.json`), {});

    // A malformed file is a loud failure: claiming at a different floor than
    // the operator wrote is the fault this issue is about.
    await Deno.writeTextFile(`${dir}/.config.json`, "{ not json");
    let threw = false;
    try {
      await readConfiguredDiskFloors(`${dir}/.config.json`);
    } catch (error) {
      threw = true;
      assertStringIncludes((error as Error).message, "not valid JSON");
    }
    assert(threw, "a malformed configuration must not read as unconfigured");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
