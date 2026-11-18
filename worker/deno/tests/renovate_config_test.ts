/**
 * Tests for the repo-root `renovate.json` supply-chain quarantine config
 * (Issue #2124).
 *
 * The repo has third-party Deno (JSR `@std/*`) deps — and had Ruby ones, until
 * the Jekyll site's `Gemfile.lock` went with the Pages pipeline (Issues #1344,
 * #1376) — but previously shipped no auto-update tooling or quarantine gate.
 * `renovate.json` closes the gap identified by the security-scan
 * dependency-update quarantine audit (`supply-chain:quarantine-missing`):
 * every external bump must wait at least `VIBE_BUMP_QUARANTINE_HOURS`
 * (default 24h) after publish. An internal `stSoftwareAU/*` package may bypass
 * the wait with a `null` age, but only where the config manages one (Issue
 * #5120): the file carries that exemption exactly when a workflow uses a
 * stSoftwareAU action.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { extractUsesValue } from "../lib/action_pin_scanner.ts";
import {
  isScopedToFirstParty,
  parseRenovateDurationHours,
} from "../lib/renovate_release_age.ts";

interface PackageRule {
  description?: string;
  matchManagers?: string[];
  matchPackageNames?: string[];
  matchPackagePatterns?: string[];
  matchSourceUrlPrefixes?: string[];
  minimumReleaseAge?: string | null;
  enabled?: boolean;
}

interface RenovateConfig {
  $schema?: string;
  extends?: string[];
  minimumReleaseAge?: string;
  packageRules?: PackageRule[];
}

const RENOVATE_URL = new URL("../../../renovate.json", import.meta.url);

/** The workflow and composite-action trees whose `uses:` owners decide the exemption. */
const WORKFLOW_DIRS = [
  new URL("../../../.github/workflows/", import.meta.url),
  new URL("../../../.github/actions/", import.meta.url),
];

async function loadRenovateConfig(): Promise<RenovateConfig> {
  const text = await Deno.readTextFile(RENOVATE_URL);
  return JSON.parse(text) as RenovateConfig;
}

/** Every `*.yml` / `*.yaml` under `dir`, recursively; a missing directory has none. */
async function listYamlFiles(dir: URL): Promise<URL[]> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const found: URL[] = [];
  for (const entry of entries) {
    const child = new URL(
      entry.isDirectory ? `${entry.name}/` : entry.name,
      dir,
    );
    if (entry.isDirectory) {
      found.push(...await listYamlFiles(child));
    } else if (/\.ya?ml$/.test(entry.name)) {
      found.push(child);
    }
  }
  return found;
}

/**
 * Lower-cased owners of every `uses:` in the workflows and composite actions.
 * Local `./` actions and `docker://` images have no GitHub owner, so skip them.
 */
async function usesOwners(): Promise<Set<string>> {
  const owners = new Set<string>();
  for (const dir of WORKFLOW_DIRS) {
    for (const file of await listYamlFiles(dir)) {
      const lines = (await Deno.readTextFile(file)).split("\n");
      for (const line of lines) {
        const value = extractUsesValue(line);
        if (
          value === null || value.startsWith("./") ||
          value.startsWith("docker://")
        ) {
          continue;
        }
        const owner = value.split("/")[0];
        if (owner) owners.add(owner.toLowerCase());
      }
    }
  }
  return owners;
}

/**
 * True when a packageRules entry lifts the quarantine (a `null` or zero age)
 * and is scoped to first-party names by the production `isScopedToFirstParty`.
 */
function holdsFirstPartyExemption(rules: PackageRule[]): boolean {
  return rules.some((rule) => {
    const age = rule.minimumReleaseAge;
    const lifts = age === null ||
      (typeof age === "string" && parseRenovateDurationHours(age) === 0);
    return lifts && isScopedToFirstParty(rule as Record<string, unknown>);
  });
}

Deno.test("renovate.json - exists and is valid JSON", async () => {
  const config = await loadRenovateConfig();
  assertNotEquals(config, null);
  assertEquals(typeof config, "object");
});

Deno.test("renovate.json - top-level minimumReleaseAge gates every ecosystem", async () => {
  const config = await loadRenovateConfig();
  const hours = parseRenovateDurationHours(config.minimumReleaseAge ?? "");
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
  "renovate.json - carries a first-party exemption exactly when it manages a stSoftwareAU action",
  async () => {
    const config = await loadRenovateConfig();
    const managesFirstParty = (await usesOwners()).has("stsoftwareau");
    const hasExemption = holdsFirstPartyExemption(config.packageRules ?? []);
    assertEquals(
      hasExemption,
      managesFirstParty,
      managesFirstParty
        ? 'a workflow or action uses a stSoftwareAU action but renovate.json has no first-party exemption; add a packageRules entry with "minimumReleaseAge": null matched by first-party names only (Issue #5120)'
        : "renovate.json carries a first-party exemption but no workflow or action uses a stSoftwareAU action; remove the exemption rule until one is managed (Issue #5120)",
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
  "renovate.json - retains the 24h window for non-Deno ecosystems",
  async () => {
    const config = await loadRenovateConfig();

    // Top-level 24h window unchanged for the ecosystems Renovate still owns.
    const topHours = parseRenovateDurationHours(config.minimumReleaseAge ?? "");
    assertEquals(
      topHours! >= 24,
      true,
      "top-level minimumReleaseAge must remain at least 24 hours for non-Deno ecosystems",
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
