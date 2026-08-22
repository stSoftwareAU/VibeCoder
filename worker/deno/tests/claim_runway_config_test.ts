/**
 * Tests for the claim-runway floor as a `.config.json` setting (Issue #289).
 *
 * `MIN_CLAIM_RUNWAY_SECONDS` and `CLAIM_REQUIRE_FULL_EXECUTE_BUDGET` were read
 * with `Deno.env.get` inside the worker container, but `container_launch.ts`
 * forwards only the five variables it sets itself — so neither override ever
 * crossed the boundary and the floor stayed at its 300 s default while the
 * docs presented the variables as the supported interface. Live consequence:
 * `VibeCoder#207` was claimed with 904 s of runway, spent 10 minutes
 * implementing, and was killed 4.5 minutes into the quality gate; twice.
 *
 * `.config.json` is already mounted read-only into the container at
 * `CONFIG_PATH`, so the keys resolved here reach the worker. The environment
 * variables stay as a fallback for a native run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import { resolveClaimRunwayFloor } from "../lib/claim_runway.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import type { ConfigFile } from "../types.ts";

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

/** Run `fn` with the two legacy variables removed, then restore them. */
async function withoutClaimEnv(fn: () => Promise<void>): Promise<void> {
  const names = [
    "MIN_CLAIM_RUNWAY_SECONDS",
    "CLAIM_REQUIRE_FULL_EXECUTE_BUDGET",
  ];
  const saved = names.map((n) => [n, Deno.env.get(n)] as const);
  for (const n of names) Deno.env.delete(n);
  try {
    await fn();
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) Deno.env.delete(n);
      else Deno.env.set(n, v);
    }
  }
}

Deno.test("claim runway #289 - the floor is read from .config.json with the environment unset", async () => {
  await withoutClaimEnv(async () => {
    await withTempConfig(
      { ...BASE, min_claim_runway_seconds: 1800 },
      async (configPath) => {
        const config = await loadConfig(configPath);
        assertEquals(config.minClaimRunwaySeconds, 1800);
      },
    );
  });
});

Deno.test("claim runway #289 - the full-budget gate is read from .config.json with the environment unset", async () => {
  await withoutClaimEnv(async () => {
    await withTempConfig(
      { ...BASE, claim_require_full_execute_budget: true },
      async (configPath) => {
        const config = await loadConfig(configPath);
        assertEquals(config.claimRequireFullExecuteBudget, true);
      },
    );
  });
});

Deno.test("claim runway #289 - absent keys and no environment give the documented defaults", async () => {
  await withoutClaimEnv(async () => {
    await withTempConfig({ ...BASE }, async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(
        config.minClaimRunwaySeconds,
        OPERATIONAL_DEFAULTS.minClaimRunwaySeconds,
      );
      assertEquals(config.claimRequireFullExecuteBudget, false);
    });
  });
});

Deno.test("claim runway #289 - the environment still wins on a native run when no key is set", async () => {
  await withoutClaimEnv(async () => {
    Deno.env.set("MIN_CLAIM_RUNWAY_SECONDS", "900");
    Deno.env.set("CLAIM_REQUIRE_FULL_EXECUTE_BUDGET", "1");
    await withTempConfig({ ...BASE }, async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.minClaimRunwaySeconds, 900);
      assertEquals(config.claimRequireFullExecuteBudget, true);
    });
  });
});

Deno.test("claim runway #289 - a config key overrides the environment", async () => {
  await withoutClaimEnv(async () => {
    Deno.env.set("MIN_CLAIM_RUNWAY_SECONDS", "900");
    Deno.env.set("CLAIM_REQUIRE_FULL_EXECUTE_BUDGET", "1");
    await withTempConfig(
      {
        ...BASE,
        min_claim_runway_seconds: 1800,
        claim_require_full_execute_budget: false,
      },
      async (configPath) => {
        const config = await loadConfig(configPath);
        assertEquals(config.minClaimRunwaySeconds, 1800);
        assertEquals(config.claimRequireFullExecuteBudget, false);
      },
    );
  });
});

Deno.test("claim runway #289 - `0` disables the floor and is not mistaken for absent", async () => {
  await withoutClaimEnv(async () => {
    await withTempConfig(
      { ...BASE, min_claim_runway_seconds: 0 },
      async (configPath) => {
        const config = await loadConfig(configPath);
        assertEquals(config.minClaimRunwaySeconds, 0);
      },
    );
  });
});

Deno.test("claim runway #289 - a junk environment value falls back to the default rather than NaN", async () => {
  await withoutClaimEnv(async () => {
    Deno.env.set("MIN_CLAIM_RUNWAY_SECONDS", "soon");
    await withTempConfig({ ...BASE }, async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(
        config.minClaimRunwaySeconds,
        OPERATIONAL_DEFAULTS.minClaimRunwaySeconds,
      );
    });
  });
});

Deno.test("claim runway #289 - the #207 host settings refuse a late claim", async () => {
  // The GRQ-23 regime: a 3600 s cycle, an 1800 s execute budget and the gate
  // on. The 904 s of runway that #207 was claimed with is now refused, and
  // the refusal is attributed to the full-budget gate rather than the plain
  // #4304 floor.
  await withoutClaimEnv(async () => {
    await withTempConfig(
      {
        ...BASE,
        claude_timeout: 1800,
        claim_require_full_execute_budget: true,
      },
      async (configPath) => {
        const config = await loadConfig(configPath);
        const floor = resolveClaimRunwayFloor({
          minClaimRunwaySeconds: config.minClaimRunwaySeconds,
          fullExecuteBudgetSeconds: config.claimRequireFullExecuteBudget
            ? config.claudeTimeout
            : undefined,
          cycleSeconds: 3600,
        });
        assertEquals(floor.floorSeconds, 1800);
        assertEquals(floor.fullBudgetGate, true);
        assertEquals(904 >= floor.floorSeconds, false);
      },
    );
  });
});
