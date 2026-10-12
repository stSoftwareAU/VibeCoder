/**
 * Config and defaults for the quota-aware polling gate (Issue #3628).
 *
 * The gate is on by default, so the floors an operator gets without writing
 * anything are the floors that defer polling — and floors that could never
 * defer (or could never be reached) are refused loudly at load time rather
 * than silently accepted.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import { detectUnknownConfigKeys } from "../lib/config_unknown_keys.ts";
import type { ConfigFile } from "../types.ts";

async function withTempConfig(
  config: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

/** The minimum a config file must carry to load at all. */
function minimalConfig(extra: ConfigFile = {}): ConfigFile {
  return {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    ...extra,
  };
}

Deno.test("quota poll config - an empty config resolves the shipped floors (Issue #3628)", async () => {
  await withTempConfig(minimalConfig(), async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(
      config.quotaPollParkFloor,
      1500,
      "a worker with no quota_poll_* keys must still park low-priority repos",
    );
    assertEquals(config.quotaPollParkNice, 99);
    assertEquals(config.quotaPollIdleFloor, 500);
  });
});

Deno.test("quota poll config - explicit floors are read and recognised (Issue #3628)", async () => {
  await withTempConfig(
    minimalConfig({
      quota_poll_park_floor: 800,
      quota_poll_park_nice: 50,
      quota_poll_idle_floor: 200,
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.quotaPollParkFloor, 800);
      assertEquals(config.quotaPollParkNice, 50);
      assertEquals(config.quotaPollIdleFloor, 200);
      assertEquals(
        detectUnknownConfigKeys({
          quota_poll_park_floor: 800,
          quota_poll_park_nice: 50,
          quota_poll_idle_floor: 200,
        }),
        [],
        "the keys must be recognised, not warned about as typos",
      );
    },
  );
});

Deno.test("quota poll config - an idle floor above the park floor is refused (Issue #3628)", async () => {
  await withTempConfig(
    minimalConfig({
      quota_poll_park_floor: 500,
      quota_poll_idle_floor: 900,
    }),
    async (configPath) => {
      const error = await assertRejects(() => loadConfig(configPath), Error);
      assert(
        error.message.includes(
          "quota_poll_idle_floor must not exceed quota_poll_park_floor",
        ),
        `the refusal must name the invariant: ${error.message}`,
      );
      assert(
        error.message.includes("Set both floors to 0"),
        `the refusal must name the way to turn the gate off: ${error.message}`,
      );
    },
  );
});

Deno.test("quota poll config - non-integer or negative floors are refused (Issue #3628)", async () => {
  for (
    const bad of [
      { quota_poll_park_floor: -1 },
      { quota_poll_park_floor: 1.5 },
      { quota_poll_park_nice: 1.5 },
      { quota_poll_idle_floor: -1 },
      { quota_poll_idle_floor: 1.5 },
    ]
  ) {
    await withTempConfig(minimalConfig(bad), async (configPath) => {
      const error = await assertRejects(() => loadConfig(configPath), Error);
      assert(
        error.message.includes("must be a whole number"),
        `the refusal must name the shape: ${error.message}`,
      );
    });
  }
});

Deno.test("quota poll config - floors of zero load and disable their tiers (Issue #3628)", async () => {
  await withTempConfig(
    minimalConfig({
      quota_poll_park_floor: 0,
      quota_poll_idle_floor: 0,
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.quotaPollParkFloor, 0);
      assertEquals(config.quotaPollIdleFloor, 0);
    },
  );
});
