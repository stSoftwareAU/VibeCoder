/**
 * Tests for the repo-root `renovate.json` supply-chain quarantine config
 * (Issue #2124).
 *
 * The repo has third-party Deno (JSR `@std/*`) and Ruby (Jekyll) deps
 * but previously shipped no auto-update tooling or quarantine gate.
 * `renovate.json` closes the gap identified by the security-scan
 * dependency-update quarantine audit (`supply-chain:quarantine-missing`):
 * every external bump must wait at least `VIBE_BUMP_QUARANTINE_HOURS`
 * (default 24h) after publish, while internal `stSoftwareAU/*` packages
 * bypass the wait.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";

interface PackageRule {
  description?: string;
  matchManagers?: string[];
  matchPackageNames?: string[];
  matchPackagePatterns?: string[];
  matchSourceUrlPrefixes?: string[];
  minimumReleaseAge?: string;
  enabled?: boolean;
}

interface RenovateConfig {
  $schema?: string;
  extends?: string[];
  minimumReleaseAge?: string;
  packageRules?: PackageRule[];
}

const RENOVATE_URL = new URL("../../../renovate.json", import.meta.url);

async function loadRenovateConfig(): Promise<RenovateConfig> {
  const text = await Deno.readTextFile(RENOVATE_URL);
  return JSON.parse(text) as RenovateConfig;
}

/**
 * Parse a Renovate-style duration string ("24 hours", "7 days", "30
 * minutes", "0") into hours. Returns null for unrecognised input.
 */
function parseReleaseAgeHours(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "0" || trimmed === "") return 0;
  const match = /^(\d+(?:\.\d+)?)\s*(minute|hour|day|week)s?$/.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  switch (match[2]) {
    case "minute":
      return n / 60;
    case "hour":
      return n;
    case "day":
      return n * 24;
    case "week":
      return n * 24 * 7;
    default:
      return null;
  }
}

Deno.test("renovate.json - exists and is valid JSON", async () => {
  const config = await loadRenovateConfig();
  assertNotEquals(config, null);
  assertEquals(typeof config, "object");
});

Deno.test("renovate.json - top-level minimumReleaseAge gates every ecosystem", async () => {
  const config = await loadRenovateConfig();
  const hours = parseReleaseAgeHours(config.minimumReleaseAge);
  assertNotEquals(
    hours,
    null,
    `minimumReleaseAge "${config.minimumReleaseAge}" is not a recognised duration`,
  );
  assertEquals(
    hours! >= 24,
    true,
    `top-level minimumReleaseAge must be at least 24 hours; got ${hours}h`,
  );
});

Deno.test(
  "renovate.json - packageRules excludes stSoftwareAU/* from the quarantine",
  async () => {
    const config = await loadRenovateConfig();
    const rules = config.packageRules ?? [];
    assertNotEquals(rules.length, 0, "packageRules must not be empty");

    const matchesInternal = (rule: PackageRule): boolean => {
      const candidates: string[] = [
        ...(rule.matchPackageNames ?? []),
        ...(rule.matchPackagePatterns ?? []),
        ...(rule.matchSourceUrlPrefixes ?? []),
      ];
      return candidates.some((p) => p.toLowerCase().includes("stsoftwareau"));
    };

    const internalRule = rules.find(matchesInternal);
    assertNotEquals(
      internalRule,
      undefined,
      "expected a packageRules entry targeting stSoftwareAU/* packages",
    );
    const hours = parseReleaseAgeHours(internalRule!.minimumReleaseAge);
    assertEquals(
      hours,
      0,
      `internal stSoftwareAU/* rule must set minimumReleaseAge to 0 (bypass); got "${
        internalRule!.minimumReleaseAge
      }"`,
    );
  },
);

Deno.test(
  "renovate.json - disables the deno manager so native tooling owns Deno deps",
  async () => {
    const config = await loadRenovateConfig();
    const rules = config.packageRules ?? [];

    const denoRule = rules.find(
      (rule) => (rule.matchManagers ?? []).includes("deno"),
    );
    assertNotEquals(
      denoRule,
      undefined,
      "expected a packageRules entry targeting the deno manager so Deno deps defer to native deno.json minimumDependencyAge (Issue #2536)",
    );
    assertEquals(
      denoRule!.enabled,
      false,
      "the deno manager rule must set enabled:false so Renovate does not manage deno.json/deno.lock",
    );
  },
);

Deno.test(
  "renovate.json - retains the 24h window and internal exemption for non-Deno ecosystems",
  async () => {
    const config = await loadRenovateConfig();

    // Top-level 24h window unchanged for the ecosystems Renovate still owns.
    const topHours = parseReleaseAgeHours(config.minimumReleaseAge);
    assertEquals(
      topHours! >= 24,
      true,
      "top-level minimumReleaseAge must remain at least 24 hours for non-Deno ecosystems",
    );

    // The internal exemption rule must not be the deno-disable rule.
    const rules = config.packageRules ?? [];
    const internalRule = rules.find((rule) =>
      [
        ...(rule.matchPackageNames ?? []),
        ...(rule.matchPackagePatterns ?? []),
        ...(rule.matchSourceUrlPrefixes ?? []),
      ].some((p) => p.toLowerCase().includes("stsoftwareau"))
    );
    assertNotEquals(
      internalRule,
      undefined,
      "the stSoftwareAU/* exemption must survive the Deno change",
    );
    assertEquals(
      parseReleaseAgeHours(internalRule!.minimumReleaseAge),
      0,
      "internal stSoftwareAU/* rule must still bypass the quarantine",
    );
    assertNotEquals(
      (internalRule!.matchManagers ?? []).includes("deno"),
      true,
      "the internal exemption rule must be distinct from the deno-manager rule",
    );
  },
);

Deno.test("renovate.json - declares the official schema", async () => {
  const config = await loadRenovateConfig();
  assertEquals(
    config.$schema,
    "https://docs.renovatebot.com/renovate-schema.json",
    "renovate.json should declare the official $schema for editor validation",
  );
});
