/**
 * Tests for the bounded adaptive-floor deferral (Issue #375).
 *
 * Each test drives the real functions against a temporary work directory and
 * asserts on the returned counts and the persisted state.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ADAPTIVE_FLOOR_ENTRY_TTL_SECONDS,
  ADAPTIVE_FLOOR_STARVATION_LIMIT,
  adaptiveFloorStatePath,
  clearAdaptiveFloorDeferral,
  formatAdaptiveFloorStarvation,
  loadAdaptiveFloorDeferrals,
  recordAdaptiveFloorDeferral,
  saveAdaptiveFloorDeferrals,
} from "../lib/adaptive_floor_starvation.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "adaptive-floor-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("adaptive floor #375 - consecutive cycles increment the streak", async () => {
  await withTempDir(async (dir) => {
    const statePath = adaptiveFloorStatePath(dir);
    const key = "o/r#355";
    assertEquals(
      await recordAdaptiveFloorDeferral({ statePath, key, cycleId: "c1" }),
      1,
    );
    assertEquals(
      await recordAdaptiveFloorDeferral({ statePath, key, cycleId: "c2" }),
      2,
    );
    assertEquals(
      await recordAdaptiveFloorDeferral({ statePath, key, cycleId: "c3" }),
      3,
    );
  });
});

Deno.test("adaptive floor #375 - repeat scans within one cycle do not increment", async () => {
  await withTempDir(async (dir) => {
    const statePath = adaptiveFloorStatePath(dir);
    const key = "o/r#355";
    assertEquals(
      await recordAdaptiveFloorDeferral({ statePath, key, cycleId: "c1" }),
      1,
    );
    // A slot re-scans every 30s; the cycle id is unchanged.
    for (let i = 0; i < 5; i++) {
      assertEquals(
        await recordAdaptiveFloorDeferral({ statePath, key, cycleId: "c1" }),
        1,
      );
    }
    assertEquals(
      await recordAdaptiveFloorDeferral({ statePath, key, cycleId: "c2" }),
      2,
    );
  });
});

Deno.test("adaptive floor #375 - streaks are tracked per issue", async () => {
  await withTempDir(async (dir) => {
    const statePath = adaptiveFloorStatePath(dir);
    await recordAdaptiveFloorDeferral({
      statePath,
      key: "o/r#355",
      cycleId: "c1",
    });
    await recordAdaptiveFloorDeferral({
      statePath,
      key: "o/r#355",
      cycleId: "c2",
    });
    assertEquals(
      await recordAdaptiveFloorDeferral({
        statePath,
        key: "o/other#9",
        cycleId: "c2",
      }),
      1,
    );
    const state = await loadAdaptiveFloorDeferrals(statePath);
    assertEquals(state["o/r#355"]?.count, 2);
    assertEquals(state["o/other#9"]?.count, 1);
  });
});

Deno.test("adaptive floor #375 - clearing resets the streak", async () => {
  await withTempDir(async (dir) => {
    const statePath = adaptiveFloorStatePath(dir);
    const key = "o/r#355";
    await recordAdaptiveFloorDeferral({ statePath, key, cycleId: "c1" });
    await recordAdaptiveFloorDeferral({ statePath, key, cycleId: "c2" });
    await clearAdaptiveFloorDeferral(statePath, key);
    assertEquals(Object.keys(await loadAdaptiveFloorDeferrals(statePath)), []);
    assertEquals(
      await recordAdaptiveFloorDeferral({ statePath, key, cycleId: "c3" }),
      1,
    );
  });
});

Deno.test("adaptive floor #375 - clearing an untracked issue is a no-op", async () => {
  await withTempDir(async (dir) => {
    const statePath = adaptiveFloorStatePath(dir);
    await clearAdaptiveFloorDeferral(statePath, "o/r#1");
    assertEquals(await loadAdaptiveFloorDeferrals(statePath), {});
  });
});

Deno.test("adaptive floor #375 - a missing state file reads as empty", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await loadAdaptiveFloorDeferrals(`${dir}/nope.json`),
      {},
    );
  });
});

Deno.test("adaptive floor #375 - a corrupt state file restarts the streak", async () => {
  await withTempDir(async (dir) => {
    const statePath = adaptiveFloorStatePath(dir);
    await Deno.writeTextFile(statePath, "{not json");
    assertEquals(await loadAdaptiveFloorDeferrals(statePath), {});
    assertEquals(
      await recordAdaptiveFloorDeferral({
        statePath,
        key: "o/r#1",
        cycleId: "c1",
      }),
      1,
    );
  });
});

Deno.test("adaptive floor #375 - malformed and expired entries are dropped on load", async () => {
  await withTempDir(async (dir) => {
    const statePath = adaptiveFloorStatePath(dir);
    const now = 1_800_000_000;
    await Deno.writeTextFile(
      statePath,
      JSON.stringify({
        "o/r#1": { count: "two", lastCycleId: "c1", updatedAt: now },
        "o/r#2": null,
        "o/r#3": {
          count: 2,
          lastCycleId: "c1",
          updatedAt: now - ADAPTIVE_FLOOR_ENTRY_TTL_SECONDS - 1,
        },
        "o/r#4": { count: 2, lastCycleId: "c1", updatedAt: now - 60 },
      }),
    );
    const state = await loadAdaptiveFloorDeferrals(statePath, now);
    assertEquals(Object.keys(state), ["o/r#4"]);
    assertEquals(state["o/r#4"]?.count, 2);
  });
});

Deno.test("adaptive floor #375 - a failed persist is reported, never silent", async () => {
  await withTempDir(async (dir) => {
    const warnings: string[] = [];
    // A directory in place of the state file makes the atomic rename fail.
    const statePath = `${dir}/state-dir`;
    await Deno.mkdir(statePath);
    const ok = await saveAdaptiveFloorDeferrals(
      statePath,
      { "o/r#1": { count: 1, lastCycleId: "c1", updatedAt: 1 } },
      (m) => warnings.push(m),
    );
    assertEquals(ok, false);
    assert(
      warnings.some((m) => m.includes("could not persist")),
      `expected a persist failure warning, got: ${warnings.join(" | ")}`,
    );
  });
});

Deno.test("adaptive floor #375 - the starvation line names the issue, the limit and the shortfall", () => {
  const line = formatAdaptiveFloorStarvation({
    key: "stSoftwareAU/VibeCoder#355",
    consecutiveCycles: ADAPTIVE_FLOOR_STARVATION_LIMIT,
    limit: ADAPTIVE_FLOOR_STARVATION_LIMIT,
    remainingRunwaySeconds: 2360,
    requiredRunwaySeconds: 2700,
  });
  assertStringIncludes(line, "ALERT starvation");
  assertStringIncludes(line, "issue=stSoftwareAU/VibeCoder#355");
  assertStringIncludes(line, "deferred_cycles=3");
  assertStringIncludes(line, "runway=2360s");
  assertStringIncludes(line, "required=2700s");
});
