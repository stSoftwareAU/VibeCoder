/**
 * Config and defaults for the nice-derived poll cadence (Issue #3667).
 *
 * The cadence is on by default: an operator who writes nothing gets
 * low-priority repos polled less often. A cadence that is not a whole
 * number of cycles of at least 1 is refused loudly at load time rather
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

Deno.test("poll cadence config - an empty config resolves the shipped cadences (Issue #3667)", async () => {
  await withTempConfig(minimalConfig(), async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(
      config.pollCadenceLowCycles,
      3,
      "a worker with no poll_cadence_* keys must still slow low-priority polling",
    );
    assertEquals(config.pollCadenceParkCycles, 10);
  });
});

Deno.test("poll cadence config - explicit cadences are read and recognised (Issue #3667)", async () => {
  await withTempConfig(
    minimalConfig({ poll_cadence_low_cycles: 1, poll_cadence_park_cycles: 20 }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.pollCadenceLowCycles, 1);
      assertEquals(config.pollCadenceParkCycles, 20);
      assertEquals(
        detectUnknownConfigKeys({
          poll_cadence_low_cycles: 1,
          poll_cadence_park_cycles: 20,
        }),
        [],
        "the keys must be recognised, not warned about as typos",
      );
    },
  );
});

Deno.test("poll cadence config - zero, negative or fractional cadences are refused (Issue #3667)", async () => {
  for (
    const bad of [
      { poll_cadence_low_cycles: 0 },
      { poll_cadence_low_cycles: 2.5 },
      { poll_cadence_park_cycles: 0 },
      { poll_cadence_park_cycles: -3 },
    ]
  ) {
    await withTempConfig(minimalConfig(bad), async (configPath) => {
      const error = await assertRejects(() => loadConfig(configPath), Error);
      assert(
        error.message.includes("must be a whole number of cycles"),
        `the refusal must name the shape: ${error.message}`,
      );
      assert(
        error.message.includes("Set it to 1"),
        `the refusal must name the way to turn it off: ${error.message}`,
      );
    });
  }
});
