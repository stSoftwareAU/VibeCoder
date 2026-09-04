/**
 * Tests for the claim-runway floor as a `.config.json` setting (Issue #289).
 *
 * `MIN_CLAIM_RUNWAY_SECONDS` was read with `Deno.env.get` inside the worker
 * container, but `container_launch.ts` forwards only the five variables it
 * sets itself — so the override never crossed the boundary and the floor
 * stayed at its 300 s default while the docs presented the variable as the
 * supported interface. Live consequence: `VibeCoder#207` was claimed with
 * 904 s of runway, spent 10 minutes implementing, and was killed 4.5 minutes
 * into the quality gate; twice.
 *
 * `.config.json` is already mounted read-only into the container at
 * `CONFIG_PATH`, so the key resolved here reaches the worker. The environment
 * variable stays as a fallback for a native run.
 *
 * Issue #425 retired the companion key `claim_require_full_execute_budget`
 * with the #47 rule it switched on, so only the floor is configurable now.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import {
  belowClaimRunwayFloor,
  resolveClaimRunwayFloor,
} from "../lib/claim_runway.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import type { ConfigFile } from "../types.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

const BASE: ConfigFile = {
  allowed_authors: ["testuser"],
  repos: ["org/repo"],
};

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

/**
 * The legacy variable, as `loadConfig` sees it (Issue #956).
 *
 * Injected rather than exported onto the process: the value under test is
 * absent from the real environment, so a `loadConfig` that ignored the
 * lookup and read `Deno.env` would return the default and fail the
 * environment-wins cases below rather than passing on an ambient value.
 */
function claimEnv(value?: string) {
  return value === undefined
    ? emptyEnv
    : envFrom({ MIN_CLAIM_RUNWAY_SECONDS: value });
}

Deno.test("claim runway #289 - the floor is read from .config.json with the environment unset", async () => {
  await withTempConfig(
    { ...BASE, min_claim_runway_seconds: 1800 },
    async (configPath) => {
      const config = await loadConfig(configPath, { env: claimEnv() });
      assertEquals(config.minClaimRunwaySeconds, 1800);
    },
  );
});

Deno.test("claim runway #289 - absent keys and no environment give the documented defaults", async () => {
  await withTempConfig({ ...BASE }, async (configPath) => {
    const config = await loadConfig(configPath, { env: claimEnv() });
    assertEquals(
      config.minClaimRunwaySeconds,
      OPERATIONAL_DEFAULTS.minClaimRunwaySeconds,
    );
  });
});

Deno.test("claim runway #289 - the environment still wins on a native run when no key is set", async () => {
  await withTempConfig({ ...BASE }, async (configPath) => {
    const config = await loadConfig(configPath, { env: claimEnv("900") });
    assertEquals(config.minClaimRunwaySeconds, 900);
  });
});

Deno.test("claim runway #289 - a config key overrides the environment", async () => {
  await withTempConfig(
    { ...BASE, min_claim_runway_seconds: 1800 },
    async (configPath) => {
      const config = await loadConfig(configPath, { env: claimEnv("900") });
      assertEquals(config.minClaimRunwaySeconds, 1800);
    },
  );
});

Deno.test("claim runway #289 - `0` disables the floor and is not mistaken for absent", async () => {
  await withTempConfig(
    { ...BASE, min_claim_runway_seconds: 0 },
    async (configPath) => {
      const config = await loadConfig(configPath, { env: claimEnv("900") });
      // A configured `0` is a value, not an absence: the environment
      // fallback must not step in behind it.
      assertEquals(config.minClaimRunwaySeconds, 0);
    },
  );
});

Deno.test("claim runway #289 - a junk environment value falls back to the default rather than NaN", async () => {
  await withTempConfig({ ...BASE }, async (configPath) => {
    const config = await loadConfig(configPath, { env: claimEnv("soon") });
    assertEquals(
      config.minClaimRunwaySeconds,
      OPERATIONAL_DEFAULTS.minClaimRunwaySeconds,
    );
  });
});

Deno.test("claim runway #425 - a configured floor refuses a claim inside it of the hard cap", async () => {
  // The configured floor is now measured against the supervisor hard cap: a
  // claim with 904 s of runway to the cap is refused under an 1800 s floor,
  // whatever the cycle deadline says.
  await withTempConfig(
    { ...BASE, claude_timeout: 1800, min_claim_runway_seconds: 1800 },
    async (configPath) => {
      const config = await loadConfig(configPath, { env: claimEnv() });
      const now = 1_000_000;
      const floor = resolveClaimRunwayFloor({
        minClaimRunwaySeconds: config.minClaimRunwaySeconds,
        hardCap: { ceilingMs: now + 904_000, windowSeconds: 10800 },
      });
      assertEquals(floor.floorSeconds, 1800);
      assertEquals(belowClaimRunwayFloor(floor, now), true);
    },
  );
});

Deno.test("claim runway #289 - a negative environment value is refused, not applied (Issue #956)", async () => {
  // `readNonNegativeNumberEnv` is the reader behind this key; a negative
  // floor would make every claim pass the runway check.
  await withTempConfig({ ...BASE }, async (configPath) => {
    const config = await loadConfig(configPath, { env: claimEnv("-1") });
    assertEquals(
      config.minClaimRunwaySeconds,
      OPERATIONAL_DEFAULTS.minClaimRunwaySeconds,
    );
  });
});
