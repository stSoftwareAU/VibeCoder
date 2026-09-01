/**
 * Tests for the `.config.json` claiming-floor keys (Issue #732).
 *
 * The launcher reads these on the host before the worker has a config handle,
 * so a malformed value must stop the launch with the offending key named — a
 * silent fall back to the default is how a host ends up gating on a floor
 * nobody chose.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  parseConfiguredDiskFloors,
  readConfiguredDiskFloors,
} from "../lib/host_disk_floor_config.ts";

const CONFIG = "/host/.config.json";

Deno.test("parseConfiguredDiskFloors - both keys, one key, neither", () => {
  assertEquals(
    parseConfiguredDiskFloors(
      { host_disk_low_floor_gb: 20, host_disk_low_floor_percent: 1 },
      CONFIG,
    ),
    { lowFloorGb: 20, lowFloorPercent: 1 },
  );
  assertEquals(
    parseConfiguredDiskFloors({ host_disk_low_floor_percent: 0.5 }, CONFIG),
    { lowFloorPercent: 0.5 },
  );
  assertEquals(parseConfiguredDiskFloors({ repos: ["org/repo"] }, CONFIG), {});
});

Deno.test("parseConfiguredDiskFloors - a floor that is not a number fails loud", () => {
  const error = assertThrows(
    () => parseConfiguredDiskFloors({ host_disk_low_floor_gb: "20" }, CONFIG),
    Error,
  );
  assertEquals(
    error.message,
    `Cannot launch: ${CONFIG} key "host_disk_low_floor_gb" must be a ` +
      `number, got "20".`,
  );
});

Deno.test("parseConfiguredDiskFloors - a floor outside its range fails loud", () => {
  assertThrows(
    () => parseConfiguredDiskFloors({ host_disk_low_floor_gb: -1 }, CONFIG),
    Error,
    "must be 0 or more",
  );
  assertThrows(
    () =>
      parseConfiguredDiskFloors({ host_disk_low_floor_percent: 101 }, CONFIG),
    Error,
    "must be 0–100",
  );
});

Deno.test("readConfiguredDiskFloors - reads the keys off disk", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe_floor_config_" });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        repos: ["org/repo"],
        host_disk_low_floor_gb: 20,
        host_disk_low_floor_percent: 1,
      }),
    );
    assertEquals(await readConfiguredDiskFloors(path), {
      lowFloorGb: 20,
      lowFloorPercent: 1,
    });

    // An unconfigured host carries neither key.
    await Deno.writeTextFile(path, JSON.stringify({ repos: ["org/repo"] }));
    assertEquals(await readConfiguredDiskFloors(path), {});

    // Unparseable JSON is a refusal, not an empty answer.
    await Deno.writeTextFile(path, "{ not json");
    await assertRejects(
      () => readConfiguredDiskFloors(path),
      Error,
      "is not readable JSON",
    );

    // A JSON array is not a configuration.
    await Deno.writeTextFile(path, "[]");
    await assertRejects(
      () => readConfiguredDiskFloors(path),
      Error,
      "does not hold a JSON object",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
