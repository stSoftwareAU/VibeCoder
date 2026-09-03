/**
 * Tests for the repo-root `.github/dependabot.yml` supply-chain
 * quarantine (Issue #273).
 *
 * `Gemfile.lock` (Jekyll / Pages) already has advisory scanning
 * (`bundle-audit`, `dependency-review.yml`) but previously had no
 * automated 24h age embargo. The bundler ecosystem entry must honour
 * the same `cooldown.default-days: 1` as the github-actions entry.
 *
 * Australian English used throughout (behaviour, honour, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

interface DependabotCooldown {
  "default-days"?: number;
  "semver-major-days"?: number;
}

interface DependabotUpdate {
  "package-ecosystem"?: string;
  directory?: string;
  cooldown?: DependabotCooldown;
}

interface DependabotConfig {
  version?: number;
  updates?: DependabotUpdate[];
}

const DEPENDABOT_URL = new URL(
  "../../../.github/dependabot.yml",
  import.meta.url,
);

async function loadDependabotConfig(): Promise<DependabotConfig> {
  const text = await Deno.readTextFile(DEPENDABOT_URL);
  return parseYaml(text) as DependabotConfig;
}

function findUpdate(
  config: DependabotConfig,
  ecosystem: string,
): DependabotUpdate | undefined {
  return (config.updates ?? []).find(
    (u) => u["package-ecosystem"] === ecosystem,
  );
}

Deno.test("dependabot.yml - exists and is valid YAML", async () => {
  const config = await loadDependabotConfig();
  assertEquals(typeof config, "object");
  assertEquals(config.version, 2);
});

Deno.test("dependabot.yml - github-actions keeps a 24h cooldown", async () => {
  const config = await loadDependabotConfig();
  const gha = findUpdate(config, "github-actions");
  assertNotEquals(gha, undefined, "github-actions ecosystem must remain");
  assertEquals(gha!.directory, "/");
  const days = gha!.cooldown?.["default-days"];
  assertEquals(
    typeof days === "number" && days >= 1,
    true,
    `github-actions cooldown.default-days must be at least 1 (24h); got ${days}`,
  );
});

Deno.test(
  "dependabot.yml - bundler ecosystem has a 24h cooldown (Issue #273)",
  async () => {
    const config = await loadDependabotConfig();
    const bundler = findUpdate(config, "bundler");
    assertNotEquals(
      bundler,
      undefined,
      "bundler ecosystem must cover Gemfile.lock at the repo root",
    );
    assertEquals(bundler!.directory, "/");
    const days = bundler!.cooldown?.["default-days"];
    assertEquals(
      typeof days === "number" && days >= 1,
      true,
      `bundler cooldown.default-days must be at least 1 (24h); got ${days}`,
    );
  },
);
