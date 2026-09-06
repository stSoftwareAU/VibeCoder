/**
 * Tests for the disk cleanup threshold bounds (Issue #1268).
 *
 * `DISK_CLEANUP_THRESHOLD` had no lower bound, so `0` read as "usage is
 * always at or above the aggressive threshold" and the work directory —
 * every cloned repository on the volume — was deleted on each start. The
 * operator-facing boundaries (the `disk-space` CLI args and the housekeeping
 * environment values) now refuse anything outside 1–100 loudly.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { diskSpaceCommand } from "../commands/disk_space.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  buildHousekeepingSteps,
  type HousekeepingOptions,
} from "../lib/run_housekeeping.ts";
import {
  DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD,
  DEFAULT_DISK_CLEANUP_THRESHOLD,
  type DiskCheckResult,
  parseCleanupThreshold,
  validateCleanupThreshold,
} from "../lib/disk_space.ts";
import { envFrom } from "./support/env_lookup.ts";

/** Work directory holding a fixture "clone" the aggressive tier would nuke. */
async function makeWorkDirWithClone(): Promise<
  { workDir: string; marker: string }
> {
  const workDir = await Deno.makeTempDir();
  const clone = `${workDir}/some-repo`;
  await Deno.mkdir(clone);
  const marker = `${clone}/README.md`;
  await Deno.writeTextFile(marker, "fixture clone");
  return { workDir, marker };
}

/** The thresholds the check actually ran with, as reported by the command. */
function appliedThresholds(
  data: unknown,
): { t: number | undefined; gentle: number | undefined } {
  const result = data as Partial<DiskCheckResult> | undefined;
  return { t: result?.threshold, gentle: result?.gentleThreshold };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function housekeepingOptions(): HousekeepingOptions {
  return {
    workDir: "/tmp/work",
    logDir: "/tmp/logs",
    tmpDir: "/tmp",
    defaultBranch: "Develop",
    githubUser: "vibe-bot",
  };
}

function diskSpaceArg(
  env: Record<string, string>,
  key: string,
  warn: (message: string) => void = () => {},
): unknown {
  const steps = buildHousekeepingSteps(
    housekeepingOptions(),
    envFrom(env),
    warn,
  );
  return steps.find((s) => s.id === "disk-space")?.args[key];
}

// ---------------------------------------------------------------------------
// CLI boundary: out-of-range thresholds are refused, work directory preserved
// ---------------------------------------------------------------------------

Deno.test("disk-space command - refuses threshold 0 and preserves the work directory", async () => {
  const { workDir, marker } = await makeWorkDirWithClone();
  try {
    const result = await diskSpaceCommand.execute(
      { "work-dir": workDir, threshold: 0 },
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "must be 1–100");
    assertEquals(await exists(marker), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("disk-space command - refuses out-of-range and unparseable thresholds", async () => {
  const config = buildDefaultWorkerConfig();
  const workDir = await Deno.makeTempDir();
  try {
    for (
      const args of [
        { threshold: -1 },
        { threshold: 101 },
        { threshold: "0abc" },
        { threshold: 50.5 },
        { "gentle-threshold": 0 },
        { "gentle-threshold": 101 },
      ]
    ) {
      const result = await diskSpaceCommand.execute(
        { "work-dir": workDir, ...args },
        config,
      );
      assertEquals(
        result.success,
        false,
        `expected refusal for ${JSON.stringify(args)}`,
      );
      assertStringIncludes(result.message, "must be 1–100");
    }
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("disk-space command - applies in-range thresholds, including string form", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    // 100 is in range and at or above any healthy usage, so the accepted
    // path asserts the applied values without triggering a real cleanup.
    const numeric = await diskSpaceCommand.execute(
      { "work-dir": workDir, threshold: 100, "gentle-threshold": 100 },
      buildDefaultWorkerConfig(),
    );
    assertEquals(numeric.success, true);
    assertEquals(appliedThresholds(numeric.data), { t: 100, gentle: 100 });

    // The string form must reach the check as the number written, not as a
    // silent fallback to the 90/80 defaults.
    const stringForm = await diskSpaceCommand.execute(
      { "work-dir": workDir, threshold: "100", "gentle-threshold": "100" },
      buildDefaultWorkerConfig(),
    );
    assertEquals(stringForm.success, true);
    assertEquals(appliedThresholds(stringForm.data), { t: 100, gentle: 100 });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Environment boundary: buildHousekeepingSteps applies the same bound
// ---------------------------------------------------------------------------

Deno.test("buildHousekeepingSteps - refuses an out-of-range DISK_CLEANUP_THRESHOLD and warns", () => {
  const warnings: string[] = [];
  const value = diskSpaceArg(
    { DISK_CLEANUP_THRESHOLD: "0" },
    "threshold",
    (m) => warnings.push(m),
  );

  assertEquals(value, DEFAULT_DISK_CLEANUP_THRESHOLD);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "DISK_CLEANUP_THRESHOLD");
  assertStringIncludes(warnings[0] ?? "", "must be 1–100");
});

Deno.test("buildHousekeepingSteps - refuses an out-of-range DISK_CLEANUP_GENTLE_THRESHOLD", () => {
  const warnings: string[] = [];
  const value = diskSpaceArg(
    { DISK_CLEANUP_GENTLE_THRESHOLD: "-5" },
    "gentle-threshold",
    (m) => warnings.push(m),
  );

  assertEquals(value, DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "DISK_CLEANUP_GENTLE_THRESHOLD");
});

Deno.test("buildHousekeepingSteps - refuses a prefix-numeric environment threshold", () => {
  const warnings: string[] = [];
  // `parseInt` reads "9x" as 9 — a threshold the operator never wrote.
  const value = diskSpaceArg(
    { DISK_CLEANUP_THRESHOLD: "9x" },
    "threshold",
    (m) => warnings.push(m),
  );

  assertEquals(value, DEFAULT_DISK_CLEANUP_THRESHOLD);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "9x");
});

Deno.test("buildHousekeepingSteps - passes in-range environment thresholds through", () => {
  const warnings: string[] = [];
  const env = {
    DISK_CLEANUP_THRESHOLD: "95",
    DISK_CLEANUP_GENTLE_THRESHOLD: "70",
  };
  assertEquals(
    diskSpaceArg(env, "threshold", (m) => warnings.push(m)),
    95,
  );
  assertEquals(
    diskSpaceArg(env, "gentle-threshold", (m) => warnings.push(m)),
    70,
  );
  assertEquals(warnings, []);
});

// ---------------------------------------------------------------------------
// The shared bound itself
// ---------------------------------------------------------------------------

Deno.test("parseCleanupThreshold - falls back only when the value is absent", () => {
  assertEquals(parseCleanupThreshold(undefined, 90), 90);
  assertEquals(parseCleanupThreshold("", 90), 90);
  assertEquals(parseCleanupThreshold("85", 90), 85);
  assertEquals(parseCleanupThreshold(" 85 ", 90), 85);
  assertEquals(parseCleanupThreshold(85, 90), 85);
  // Present but unreadable: NaN, never the fallback and never a truncation.
  assertEquals(Number.isNaN(parseCleanupThreshold("0abc", 90)), true);
  assertEquals(Number.isNaN(parseCleanupThreshold("9x", 90)), true);
  assertEquals(Number.isNaN(parseCleanupThreshold({}, 90)), true);
});

Deno.test("validateCleanupThreshold - accepts 1..100 and refuses everything else", () => {
  assertEquals(validateCleanupThreshold("--threshold", 1), null);
  assertEquals(validateCleanupThreshold("--threshold", 90), null);
  assertEquals(validateCleanupThreshold("--threshold", 100), null);

  for (const bad of [0, -1, 101, 1.5, NaN, Infinity]) {
    const message = validateCleanupThreshold("--threshold", bad);
    assertEquals(
      typeof message,
      "string",
      `expected a refusal message for ${bad}`,
    );
    assertStringIncludes(message ?? "", "must be 1–100");
  }
});
