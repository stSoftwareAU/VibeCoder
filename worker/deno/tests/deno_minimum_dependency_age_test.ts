/**
 * Tests for the canonical native-Deno minimum-dependency-age policy
 * (Issue #2539).
 *
 * Covers the single-source-of-truth helper (`deno_minimum_dependency_age.ts`)
 * and asserts that `worker/deno/deno.json` dogfoods the canonical
 * `minimumDependencyAge` config: a 24h external floor with internal
 * `@stsoftware` Deno deps exempted (0h quarantine).
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  buildMinimumDependencyAgeConfig,
  CANONICAL_MINIMUM_DEPENDENCY_AGE,
  CANONICAL_MINIMUM_DEPENDENCY_AGE_HOURS,
  INTERNAL_SCOPE_EXCLUDES,
  isValidExcludeEntry,
  type MinimumDependencyAgeConfig,
  parseMinimumDependencyAgeHours,
} from "../lib/deno_minimum_dependency_age.ts";

interface DenoConfig {
  minimumDependencyAge?: string | number | MinimumDependencyAgeConfig;
  imports?: Record<string, string>;
}

const DENO_JSON_URL = new URL("../deno.json", import.meta.url);

async function loadDenoConfig(): Promise<DenoConfig> {
  const text = await Deno.readTextFile(DENO_JSON_URL);
  return JSON.parse(text) as DenoConfig;
}

// ---------------------------------------------------------------------------
// Helper: constants
// ---------------------------------------------------------------------------

Deno.test("canonical age maps to 24 hours", () => {
  assertEquals(CANONICAL_MINIMUM_DEPENDENCY_AGE, "P1D");
  assertEquals(
    parseMinimumDependencyAgeHours(CANONICAL_MINIMUM_DEPENDENCY_AGE),
    CANONICAL_MINIMUM_DEPENDENCY_AGE_HOURS,
  );
  assertEquals(CANONICAL_MINIMUM_DEPENDENCY_AGE_HOURS, 24);
});

Deno.test("internal-scope excludes are jsr:/npm: @stsoftware globs", () => {
  assertEquals(INTERNAL_SCOPE_EXCLUDES.includes("jsr:@stsoftware/*"), true);
  for (const entry of INTERNAL_SCOPE_EXCLUDES) {
    assertEquals(
      isValidExcludeEntry(entry),
      true,
      `exclude entry "${entry}" must satisfy deno's jsr:/npm: prefix rule`,
    );
    assertEquals(
      entry.toLowerCase().includes("stsoftware"),
      true,
      `exclude entry "${entry}" must target the internal @stsoftware scope`,
    );
  }
});

// ---------------------------------------------------------------------------
// Helper: buildMinimumDependencyAgeConfig
// ---------------------------------------------------------------------------

Deno.test("buildMinimumDependencyAgeConfig returns the canonical object", () => {
  const config = buildMinimumDependencyAgeConfig();
  assertEquals(config.age, "P1D");
  assertEquals(config.exclude, ["jsr:@stsoftware/*", "npm:@stsoftware/*"]);
});

Deno.test("buildMinimumDependencyAgeConfig exclude is a fresh array", () => {
  const a = buildMinimumDependencyAgeConfig();
  a.exclude.push("npm:evil");
  const b = buildMinimumDependencyAgeConfig();
  assertEquals(b.exclude.length, 2, "mutation must not leak into the source");
});

// ---------------------------------------------------------------------------
// Helper: isValidExcludeEntry
// ---------------------------------------------------------------------------

Deno.test("isValidExcludeEntry enforces the jsr:/npm: prefix", () => {
  assertEquals(isValidExcludeEntry("jsr:@stsoftware/foo"), true);
  assertEquals(isValidExcludeEntry("npm:@stsoftware/foo"), true);
  // Error path: missing prefix or bare prefix.
  assertEquals(isValidExcludeEntry("@stsoftware/foo"), false);
  assertEquals(isValidExcludeEntry("deno.land/x/foo"), false);
  assertEquals(isValidExcludeEntry("jsr:"), false);
  assertEquals(isValidExcludeEntry(""), false);
});

// ---------------------------------------------------------------------------
// Helper: parseMinimumDependencyAgeHours
// ---------------------------------------------------------------------------

Deno.test("parseMinimumDependencyAgeHours - ISO-8601 durations", () => {
  assertEquals(parseMinimumDependencyAgeHours("P1D"), 24);
  assertEquals(parseMinimumDependencyAgeHours("PT24H"), 24);
  assertEquals(parseMinimumDependencyAgeHours("P2D"), 48);
  assertEquals(parseMinimumDependencyAgeHours("P1W"), 168);
  assertEquals(parseMinimumDependencyAgeHours("PT30M"), 0.5);
  assertEquals(parseMinimumDependencyAgeHours("PT1H30M"), 1.5);
  assertEquals(parseMinimumDependencyAgeHours("PT3600S"), 1);
});

Deno.test("parseMinimumDependencyAgeHours - minutes (string and number)", () => {
  assertEquals(parseMinimumDependencyAgeHours("1440"), 24);
  assertEquals(parseMinimumDependencyAgeHours("120"), 2);
  assertEquals(parseMinimumDependencyAgeHours(1440), 24);
  assertEquals(parseMinimumDependencyAgeHours("0"), 0);
  assertEquals(parseMinimumDependencyAgeHours(0), 0);
});

Deno.test("parseMinimumDependencyAgeHours - unrecognised input returns null", () => {
  // Error/edge paths: RFC3339 dates, calendar durations, junk, empties.
  assertEquals(parseMinimumDependencyAgeHours("2025-09-16"), null);
  assertEquals(
    parseMinimumDependencyAgeHours("2025-09-16T12:00:00+00:00"),
    null,
  );
  assertEquals(parseMinimumDependencyAgeHours("P1Y"), null);
  assertEquals(parseMinimumDependencyAgeHours("P1M"), null);
  assertEquals(parseMinimumDependencyAgeHours("24 hours"), null);
  assertEquals(parseMinimumDependencyAgeHours("P"), null);
  assertEquals(parseMinimumDependencyAgeHours("PT"), null);
  assertEquals(parseMinimumDependencyAgeHours(""), null);
  assertEquals(parseMinimumDependencyAgeHours("  "), null);
  assertEquals(parseMinimumDependencyAgeHours(undefined), null);
  assertEquals(parseMinimumDependencyAgeHours(-5), null);
});

// ---------------------------------------------------------------------------
// worker/deno/deno.json dogfoods the canonical config
// ---------------------------------------------------------------------------

Deno.test("deno.json - minimumDependencyAge is present and an object", async () => {
  const config = await loadDenoConfig();
  assertNotEquals(
    config.minimumDependencyAge,
    undefined,
    "worker/deno/deno.json must declare minimumDependencyAge",
  );
  assertEquals(
    typeof config.minimumDependencyAge,
    "object",
    "the canonical shape is the object form { age, exclude }",
  );
});

Deno.test("deno.json - minimumDependencyAge enforces a 24h external floor", async () => {
  const config = await loadDenoConfig();
  const mda = config.minimumDependencyAge as MinimumDependencyAgeConfig;
  const hours = parseMinimumDependencyAgeHours(mda.age);
  assertNotEquals(hours, null, `age "${mda.age}" is not a recognised duration`);
  assertEquals(
    hours,
    24,
    `external floor must map to 24 hours; got ${hours}h from "${mda.age}"`,
  );
});

Deno.test("deno.json - excludes internal @stsoftware Deno deps (0h)", async () => {
  const config = await loadDenoConfig();
  const mda = config.minimumDependencyAge as MinimumDependencyAgeConfig;
  assertEquals(Array.isArray(mda.exclude), true, "exclude must be an array");
  const internal = mda.exclude.filter((e) =>
    e.toLowerCase().includes("stsoftware")
  );
  assertNotEquals(
    internal.length,
    0,
    "expected an exclude glob targeting internal @stsoftware deps",
  );
  for (const entry of mda.exclude) {
    assertEquals(
      isValidExcludeEntry(entry),
      true,
      `exclude entry "${entry}" must satisfy deno's jsr:/npm: prefix rule`,
    );
  }
});

// ---------------------------------------------------------------------------
// container/deno-seed/deno.json mirrors the quarantine (Issue #14)
// ---------------------------------------------------------------------------

const SEED_DENO_JSON_URL = new URL(
  "../../../container/deno-seed/deno.json",
  import.meta.url,
);

async function loadSeedConfig(): Promise<DenoConfig> {
  return JSON.parse(await Deno.readTextFile(SEED_DENO_JSON_URL)) as DenoConfig;
}

Deno.test("deno-seed - minimumDependencyAge enforces the same 24h floor", async () => {
  const config = await loadSeedConfig();
  assertNotEquals(
    config.minimumDependencyAge,
    undefined,
    "container/deno-seed/deno.json must declare minimumDependencyAge so a " +
      "bumped npm/JSR pin gets the worker's 24h cooling-off window (Issue #14)",
  );
  const mda = config.minimumDependencyAge as MinimumDependencyAgeConfig;
  assertEquals(
    parseMinimumDependencyAgeHours(mda.age),
    24,
    `external floor must map to 24 hours; got "${mda.age}"`,
  );
  assertEquals(Array.isArray(mda.exclude), true, "exclude must be an array");
  for (const entry of mda.exclude) {
    assertEquals(
      isValidExcludeEntry(entry),
      true,
      `exclude entry "${entry}" must satisfy deno's jsr:/npm: prefix rule`,
    );
  }
});
