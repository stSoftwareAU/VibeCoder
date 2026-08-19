/**
 * Tests for setup-time config preservation (Issue #4033).
 *
 * `./setup.sh` rewrites `.config.json` from the merged config, so
 * `buildOverridesOnly` must carry through every operator-set key it does not
 * explicitly handle — otherwise keys like `fleet_pr_authors` and
 * `service_accounts` are silently destroyed on the next setup run.
 *
 * Also covers `pruneOrphanRepoConfig`, which drops (and reports) `repo_config`
 * entries for repos that are not in `repos`.
 */

import { assertEquals } from "@std/assert";
import {
  buildOverridesOnly,
  pruneOrphanRepoConfig,
} from "../setup/config_setup.ts";
import type { SetupConfig } from "../setup/config_setup.ts";
import { runConfigSetup } from "../setup/config_writer.ts";

// =============================================================================
// buildOverridesOnly — unknown-key passthrough
// =============================================================================

Deno.test("buildOverridesOnly - preserves operator keys not declared on SetupConfig", () => {
  // deno-lint-ignore no-explicit-any
  const config: any = {
    allowed_authors: ["operator"],
    fleet_pr_authors: ["VibeCoderBot"],
    service_accounts: ["VibeCoderBot"],
    trusted_review_bots: ["cursor[bot]"],
    worker_name: "host-3",
    shuffle_repos: true,
    log_max_rotations: 7,
  };

  const result = buildOverridesOnly(config as SetupConfig);

  assertEquals(result.fleet_pr_authors, ["VibeCoderBot"]);
  assertEquals(result.service_accounts, ["VibeCoderBot"]);
  assertEquals(result.trusted_review_bots, ["cursor[bot]"]);
  assertEquals(result.worker_name, "host-3");
  assertEquals(result.shuffle_repos, true);
  assertEquals(result.log_max_rotations, 7);
  assertEquals(result.allowed_authors, ["operator"]);
});

Deno.test("buildOverridesOnly - passthrough still drops hardwired label keys (Issue #1834)", () => {
  // deno-lint-ignore no-explicit-any
  const config: any = {
    issue_labels: ["custom-label"],
    work_on_label: "custom-work-on",
    low_priority_label: "custom-low-priority",
    fleet_pr_authors: ["VibeCoderBot"],
  };

  const result = buildOverridesOnly(config as SetupConfig);

  assertEquals(result.issue_labels, undefined);
  assertEquals(result.work_on_label, undefined);
  assertEquals(result.low_priority_label, undefined);
  assertEquals(result.fleet_pr_authors, ["VibeCoderBot"]);
});

Deno.test("buildOverridesOnly - passthrough does not resurrect default-matching handled keys", () => {
  const config: SetupConfig = {
    failed_label: "failed", // default — must stay omitted
    claude_timeout: 3600, // default — must stay omitted
  };

  const result = buildOverridesOnly(config);

  assertEquals(result, {});
});

Deno.test("buildOverridesOnly - passthrough skips undefined values", () => {
  // deno-lint-ignore no-explicit-any
  const config: any = { worker_name: undefined, service_accounts: [] };

  const result = buildOverridesOnly(config as SetupConfig);

  assertEquals(Object.keys(result), ["service_accounts"]);
});

// =============================================================================
// pruneOrphanRepoConfig
// =============================================================================

Deno.test("pruneOrphanRepoConfig - drops repo_config entries for unmonitored repos", () => {
  const config: SetupConfig = {
    repos: ["stSoftwareAU/VibeCoder"],
    repo_config: {
      "stSoftwareAU/VibeCoder": { nice: 1 },
      "example-org/private-repo-13": { nice: 2 },
    },
  };

  const { config: pruned, removed } = pruneOrphanRepoConfig(config);

  assertEquals(removed, ["example-org/private-repo-13"]);
  assertEquals(Object.keys(pruned.repo_config ?? {}), [
    "stSoftwareAU/VibeCoder",
  ]);
  // Input is not mutated — the function is pure.
  assertEquals(Object.keys(config.repo_config ?? {}).length, 2);
});

Deno.test("pruneOrphanRepoConfig - keeps case-variant matches", () => {
  const config: SetupConfig = {
    repos: ["stsoftwareau/vibecoder"],
    repo_config: { "stSoftwareAU/VibeCoder": { nice: 1 } },
  };

  const { config: pruned, removed } = pruneOrphanRepoConfig(config);

  assertEquals(removed, []);
  assertEquals(Object.keys(pruned.repo_config ?? {}), [
    "stSoftwareAU/VibeCoder",
  ]);
});

Deno.test("pruneOrphanRepoConfig - no-op when repos is empty", () => {
  const config: SetupConfig = {
    repos: [],
    repo_config: { "example-org/private-repo-13": { nice: 2 } },
  };

  const { config: pruned, removed } = pruneOrphanRepoConfig(config);

  assertEquals(removed, []);
  assertEquals(Object.keys(pruned.repo_config ?? {}), ["example-org/private-repo-13"]);
});

Deno.test("pruneOrphanRepoConfig - no-op when repos is absent", () => {
  const config: SetupConfig = {
    repo_config: { "example-org/private-repo-13": { nice: 2 } },
  };

  const { config: pruned, removed } = pruneOrphanRepoConfig(config);

  assertEquals(removed, []);
  assertEquals(Object.keys(pruned.repo_config ?? {}), ["example-org/private-repo-13"]);
});

Deno.test("pruneOrphanRepoConfig - no-op when repo_config is absent", () => {
  const config: SetupConfig = { repos: ["stSoftwareAU/VibeCoder"] };

  const { config: pruned, removed } = pruneOrphanRepoConfig(config);

  assertEquals(removed, []);
  assertEquals(pruned.repo_config, undefined);
});

// =============================================================================
// runConfigSetup — end-to-end preservation and reporting
// =============================================================================

Deno.test("runConfigSetup - preserves fleet_pr_authors and service_accounts", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      allowed_authors: ["operator"],
      repos: ["stSoftwareAU/VibeCoder"],
      fleet_pr_authors: ["VibeCoderBot"],
      service_accounts: ["VibeCoderBot"],
      worker_name: "host-3",
    }),
  );

  const result = await runConfigSetup(configPath, () => undefined);
  assertEquals(result.ok, true);

  const written = JSON.parse(await Deno.readTextFile(configPath));
  assertEquals(written.fleet_pr_authors, ["VibeCoderBot"]);
  assertEquals(written.service_accounts, ["VibeCoderBot"]);
  assertEquals(written.worker_name, "host-3");

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("runConfigSetup - reports pruned orphan repo_config entries", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      allowed_authors: ["operator"],
      repos: ["stSoftwareAU/VibeCoder"],
      repo_config: {
        "stSoftwareAU/VibeCoder": { nice: 1 },
        "example-org/private-repo-13": { nice: 2 },
      },
    }),
  );

  // Issue #4030: stub the login lookup so the test never shells out to `gh`.
  const result = await runConfigSetup(configPath, () => undefined, {
    resolveWorkerLogin: () => Promise.resolve("VibeCoderBot"),
  });
  assertEquals(result.ok, true);
  assertEquals(
    (result.warnings ?? []).some((w) => w.includes("example-org/private-repo-13")),
    true,
  );

  const written = JSON.parse(await Deno.readTextFile(configPath));
  assertEquals(Object.keys(written.repo_config), ["stSoftwareAU/VibeCoder"]);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("runConfigSetup - no prune warnings when every repo_config entry is monitored", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      allowed_authors: ["operator"],
      repos: ["stSoftwareAU/VibeCoder"],
      repo_config: { "stSoftwareAU/VibeCoder": { nice: 1 } },
      service_accounts: ["VibeCoderBot"],
    }),
  );

  const result = await runConfigSetup(configPath, () => undefined, {
    resolveWorkerLogin: () => Promise.resolve("VibeCoderBot"),
  });
  assertEquals(result.ok, true);
  // No prune warnings — every repo_config entry is monitored (Issue #4033).
  assertEquals(result.warnings ?? [], []);

  await Deno.remove(tmpDir, { recursive: true });
});
