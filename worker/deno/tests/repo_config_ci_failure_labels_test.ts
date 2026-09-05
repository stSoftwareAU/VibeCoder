/**
 * Tests for per-repo CI-failure configuration (Issues #3581, #986).
 *
 * The failure label set must be per-repo configuration, never a hard-coded
 * `develop-build-failure` literal, and a malformed value must fail loudly.
 * A per-repo key the worker no longer honours must be refused at config
 * load rather than silently dropped.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  getCiFailureLabels,
  parseCiFailureLabels,
} from "../lib/repo_config.ts";
import { loadConfig } from "../lib/config.ts";
import type { RepoConfig } from "../types.ts";

Deno.test("parseCiFailureLabels - undefined disables the feature", () => {
  const result = parseCiFailureLabels(undefined);
  assert(result.ok);
  assertEquals(result.value, []);
});

Deno.test("parseCiFailureLabels - trims label names", () => {
  const result = parseCiFailureLabels([" develop-build-failure ", "ci-broken"]);
  assert(result.ok);
  assertEquals(result.value, ["develop-build-failure", "ci-broken"]);
});

Deno.test("parseCiFailureLabels - rejects a non-array", () => {
  const result = parseCiFailureLabels("develop-build-failure");
  assertEquals(result.ok, false);
});

Deno.test("parseCiFailureLabels - rejects a non-string entry", () => {
  const result = parseCiFailureLabels(["ok", 7]);
  assertEquals(result.ok, false);
});

Deno.test("parseCiFailureLabels - rejects a blank entry", () => {
  const result = parseCiFailureLabels(["   "]);
  assertEquals(result.ok, false);
});

Deno.test("getCiFailureLabels - reads the per-repo configuration", () => {
  const configs: Record<string, RepoConfig> = {
    "stSoftwareAU/private-repo-12": {
      ciFailureLabels: ["develop-build-failure"],
    },
    "stSoftwareAU/Other": {},
  };
  assertEquals(getCiFailureLabels(configs, "stSoftwareAU/private-repo-12"), [
    "develop-build-failure",
  ]);
  assertEquals(getCiFailureLabels(configs, "stSoftwareAU/Other"), []);
  assertEquals(getCiFailureLabels(configs, "stSoftwareAU/Unknown"), []);
  assertEquals(getCiFailureLabels(undefined, "stSoftwareAU/Other"), []);
});

Deno.test("getCiFailureLabels - throws on malformed configuration", () => {
  const configs = {
    "owner/repo": { ciFailureLabels: "develop-build-failure" },
  } as unknown as Record<string, RepoConfig>;
  assertThrows(
    () => getCiFailureLabels(configs, "owner/repo"),
    Error,
    "Invalid ciFailureLabels",
  );
});

Deno.test("loadConfig - normalises snake_case CI-failure keys", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      repo_config: {
        "owner/repo": {
          ci_failure_labels: ["develop-build-failure"],
        },
      },
    }),
  );
  try {
    const config = await loadConfig(configPath);
    assertEquals(getCiFailureLabels(config.repoConfig, "owner/repo"), [
      "develop-build-failure",
    ]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Removed per-repo keys fail loudly (Issue #986)
// ---------------------------------------------------------------------------

/** Write a `.config.json` carrying `repoConfig` and try to load it. */
async function loadWithRepoConfig(
  repoConfig: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({ repo_config: { "owner/repo": repoConfig } }),
  );
  try {
    await loadConfig(configPath);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("loadConfig - a stale prFailureActions block is refused, not dropped", async () => {
  const result = await loadWithRepoConfig({
    prFailureActions: [{ type: "fetch-jenkins-log", jobPath: "a/b" }],
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "owner/repo");
    assertStringIncludes(result.error, "prFailureActions");
    assertStringIncludes(result.error, "ciProviders");
  }
});

Deno.test("loadConfig - the snake_case spelling of a removed key is refused too", async () => {
  const result = await loadWithRepoConfig({ ci_failure_job_path: "a/job/b" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "ci_failure_job_path");
  }
});

Deno.test("loadConfig - both removed keys are reported in one message", async () => {
  const result = await loadWithRepoConfig({
    pr_failure_actions: [],
    ciFailureJobPath: "a/job/b",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "pr_failure_actions");
    assertStringIncludes(result.error, "ciFailureJobPath");
  }
});

Deno.test("loadConfig - a clean repo config still loads", async () => {
  const result = await loadWithRepoConfig({
    ci_failure_labels: ["develop-build-failure"],
    ciProviders: [{ provider: "github-actions" }],
  });
  assertEquals(result.ok, true);
});
