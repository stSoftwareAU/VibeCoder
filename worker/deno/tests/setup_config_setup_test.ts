/**
 * Tests for the TypeScript configuration setup module.
 *
 * Consolidated from setup/ts/config_setup_test.ts as part of Issue #923.
 *
 * Issue #266: Move setup to TypeScript, only store overridden values.
 *
 * Tests verify that:
 * 1. buildOverridesOnly omits default values
 * 2. writeConfigFile writes only overrides to disk
 * 3. loadExistingConfig loads and parses existing config
 * 4. parseCsv correctly splits comma-separated strings
 * 5. mergeNonInteractive applies VIBE_* env vars correctly
 * 6. runNonInteractive orchestrates the full non-interactive flow
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildOverridesOnly,
  loadExistingConfig,
  mergeNonInteractive,
  parseCsv,
  runNonInteractive,
  stripRemovedConfigKeys,
  writeConfigFile,
} from "../setup/config_setup.ts";
import type { SetupConfig } from "../setup/config_setup.ts";

// =============================================================================
// parseCsv
// =============================================================================

Deno.test("parseCsv - parses comma-separated values", () => {
  assertEquals(parseCsv("a,b,c"), ["a", "b", "c"]);
});

Deno.test("parseCsv - trims whitespace from values", () => {
  assertEquals(parseCsv(" alpha , beta , gamma "), ["alpha", "beta", "gamma"]);
});

Deno.test("parseCsv - filters out empty entries", () => {
  assertEquals(parseCsv("a,,b,,c"), ["a", "b", "c"]);
});

Deno.test("parseCsv - returns empty array for empty string", () => {
  assertEquals(parseCsv(""), []);
});

Deno.test("parseCsv - returns empty array for whitespace-only string", () => {
  assertEquals(parseCsv("   "), []);
});

Deno.test("parseCsv - handles single value", () => {
  assertEquals(parseCsv("onlyone"), ["onlyone"]);
});

// =============================================================================
// buildOverridesOnly — Core Logic
// =============================================================================

Deno.test("buildOverridesOnly - includes allowed_authors when present", () => {
  const config: SetupConfig = {
    allowed_authors: ["user1", "user2"],
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.allowed_authors, ["user1", "user2"]);
});

Deno.test("buildOverridesOnly - omits allowed_authors when empty", () => {
  const config: SetupConfig = {
    allowed_authors: [],
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.allowed_authors, undefined);
});

Deno.test("buildOverridesOnly - includes repos when present", () => {
  const config: SetupConfig = {
    repos: ["org/repo1"],
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.repos, ["org/repo1"]);
});

Deno.test("buildOverridesOnly - rejects issue_labels and work_on_label fields (Issue #1834)", () => {
  // Issue #1834: SetupConfig no longer accepts these keys; even if a
  // caller passes them in, buildOverridesOnly must not write them out.
  // deno-lint-ignore no-explicit-any
  const config: any = {
    issue_labels: ["custom-label"],
    work_on_label: "custom-work-on",
  };
  const result = buildOverridesOnly(config as SetupConfig);
  assertEquals(result.issue_labels, undefined);
  assertEquals(result.work_on_label, undefined);
});

Deno.test("buildOverridesOnly - omits failed_label when matching default", () => {
  const config: SetupConfig = {
    failed_label: "failed",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.failed_label, undefined);
});

Deno.test("buildOverridesOnly - includes failed_label when different from default", () => {
  const config: SetupConfig = {
    failed_label: "broken",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.failed_label, "broken");
});

Deno.test("buildOverridesOnly - omits all label defaults when matching", () => {
  // Issue #2031: needs_clarification_label retired from SetupConfig.
  const config: SetupConfig = {
    failed_label: "failed",
    failed_once_label: "failed-once",
    refine_issue_label: "refine-issue",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.failed_label, undefined);
  assertEquals(result.failed_once_label, undefined);
  assertEquals(result.refine_issue_label, undefined);
});

Deno.test("buildOverridesOnly - includes pr_reviewer when present", () => {
  const config: SetupConfig = {
    pr_reviewer: "reviewer-user",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.pr_reviewer, "reviewer-user");
});

Deno.test("buildOverridesOnly - includes pr_reviewers array when present", () => {
  const config: SetupConfig = {
    pr_reviewers: ["rev1", "rev2"],
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.pr_reviewers, ["rev1", "rev2"]);
});

Deno.test("buildOverridesOnly - includes authorized_commenters when present", () => {
  const config: SetupConfig = {
    authorized_commenters: ["user1", "github-copilot[bot]"],
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.authorized_commenters, ["user1", "github-copilot[bot]"]);
});

Deno.test("buildOverridesOnly - includes author_source and exclusion_team when present (Issue #252)", () => {
  const config: SetupConfig = {
    author_source: "github",
    exclusion_team: "stSoftwareAU/vibe-workers",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.author_source, "github");
  assertEquals(result.exclusion_team, "stSoftwareAU/vibe-workers");
});

Deno.test("buildOverridesOnly - omits default author_source config (Issue #252)", () => {
  const config: SetupConfig = {
    author_source: "config",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.author_source, undefined);
});

Deno.test("buildOverridesOnly - includes claude_model when present", () => {
  const config: SetupConfig = {
    claude_model: "claude-sonnet-4-7",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.claude_model, "claude-sonnet-4-7");
});

Deno.test("buildOverridesOnly - omits claude_model when empty", () => {
  const config: SetupConfig = {
    claude_model: "",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.claude_model, undefined);
});

Deno.test("buildOverridesOnly - includes repo_config when present", () => {
  const config: SetupConfig = {
    repo_config: {
      "org/repo": { skip_quality_check: true },
    },
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.repo_config, {
    "org/repo": { skip_quality_check: true },
  });
});

Deno.test("buildOverridesOnly - omits repo_config when empty", () => {
  const config: SetupConfig = {
    repo_config: {},
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.repo_config, undefined);
});

Deno.test("buildOverridesOnly - empty config produces empty result", () => {
  const config: SetupConfig = {};
  const result = buildOverridesOnly(config);
  assertEquals(result, {});
});

Deno.test("buildOverridesOnly - full config with all defaults produces only non-default values", () => {
  // Issue #2031: needs_clarification_label retired from SetupConfig.
  const config: SetupConfig = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    failed_label: "failed", // default
    failed_once_label: "failed-once", // default
    refine_issue_label: "refine-issue", // default
  };
  const result = buildOverridesOnly(config);
  assertEquals(Object.keys(result).sort(), ["allowed_authors", "repos"]);
});

// =============================================================================
// writeConfigFile and loadExistingConfig
// =============================================================================

Deno.test("writeConfigFile - writes only overridden values to disk", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    const config: SetupConfig = {
      allowed_authors: ["testuser"],
      repos: ["org/repo1"],
    };

    await writeConfigFile(configPath, config);

    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content);

    assertEquals(parsed.allowed_authors, ["testuser"]);
    assertEquals(parsed.repos, ["org/repo1"]);
    // Issue #1834: issue_labels and work_on_label are no longer valid keys.
    assertEquals(parsed.issue_labels, undefined);
    assertEquals(parsed.work_on_label, undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("writeConfigFile - writes secrets file with owner-only permissions (Issue #2805)", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    const config: SetupConfig = {
      imgbb_api_key: "secret-api-key",
      repos: ["org/repo1"],
    };

    await writeConfigFile(configPath, config);

    const mode = Deno.statSync(configPath).mode ?? 0;
    // No group/other permission bits — not readable by other local users.
    assertEquals(mode & 0o077, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("writeConfigFile - tightens permissions on a pre-existing world-readable file (Issue #2805)", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    // Simulate a file written 0o644 by an older worker.
    await Deno.writeTextFile(configPath, "{}\n");
    await Deno.chmod(configPath, 0o644);
    assertEquals(Deno.statSync(configPath).mode! & 0o077, 0o044);

    await writeConfigFile(configPath, { repos: ["org/repo1"] });

    assertEquals(Deno.statSync(configPath).mode! & 0o077, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadExistingConfig - loads existing config file", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        allowed_authors: ["user1"],
        repos: ["org/repo"],
        failed_label: "custom-failed",
      }),
    );

    const config = await loadExistingConfig(configPath);
    assertEquals(config.allowed_authors, ["user1"]);
    assertEquals(config.repos, ["org/repo"]);
    assertEquals(config.failed_label, "custom-failed");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadExistingConfig - returns empty object for missing file", async () => {
  const config = await loadExistingConfig("/nonexistent/path/.config.json");
  assertEquals(config, {});
});

Deno.test("loadExistingConfig - preserves repo_config from existing file", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        allowed_authors: ["user1"],
        repos: ["org/repo"],
        repo_config: {
          "org/repo": { pre_setup_command: "./setup.sh" },
        },
      }),
    );

    const config = await loadExistingConfig(configPath);
    assertEquals(config.repo_config, {
      "org/repo": { pre_setup_command: "./setup.sh" },
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// =============================================================================
// mergeNonInteractive
// =============================================================================

Deno.test("mergeNonInteractive - sets allowed_authors from VIBE_ALLOWED_AUTHORS", () => {
  const env = (name: string) =>
    name === "VIBE_ALLOWED_AUTHORS" ? "user1,user2" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.allowed_authors, ["user1", "user2"]);
});

Deno.test("mergeNonInteractive - sets allowed_authors from VIBE_ALLOWED_AUTHOR", () => {
  const env = (name: string) =>
    name === "VIBE_ALLOWED_AUTHOR" ? "singleuser" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.allowed_authors, ["singleuser"]);
});

Deno.test("mergeNonInteractive - VIBE_ALLOWED_AUTHORS takes priority over VIBE_ALLOWED_AUTHOR", () => {
  const env = (name: string) => {
    if (name === "VIBE_ALLOWED_AUTHORS") return "multi1,multi2";
    if (name === "VIBE_ALLOWED_AUTHOR") return "single";
    return undefined;
  };

  const result = mergeNonInteractive({}, env);
  assertEquals(result.allowed_authors, ["multi1", "multi2"]);
});

Deno.test("mergeNonInteractive - sets repos from VIBE_REPOS", () => {
  const env = (name: string) =>
    name === "VIBE_REPOS" ? "org/repo1,org/repo2" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.repos, ["org/repo1", "org/repo2"]);
});

Deno.test("mergeNonInteractive - VIBE_ADD_REPOS merges with existing repos", () => {
  const existing: SetupConfig = { repos: ["org/existing"] };
  const env = (name: string) =>
    name === "VIBE_ADD_REPOS" ? "org/new1,org/new2" : undefined;

  const result = mergeNonInteractive(existing, env);
  assertEquals(result.repos, ["org/existing", "org/new1", "org/new2"]);
});

Deno.test("mergeNonInteractive - VIBE_ADD_REPOS deduplicates repos", () => {
  const existing: SetupConfig = { repos: ["org/repo1", "org/repo2"] };
  const env = (name: string) =>
    name === "VIBE_ADD_REPOS" ? "org/repo2,org/repo3" : undefined;

  const result = mergeNonInteractive(existing, env);
  assertEquals(result.repos, ["org/repo1", "org/repo2", "org/repo3"]);
});

Deno.test("mergeNonInteractive - VIBE_ISSUE_LABELS is ignored (Issue #1834)", () => {
  // Issue #1834: VIBE_ISSUE_LABELS no longer applied — issue_labels is
  // hardwired and not configurable.
  const env = (name: string) =>
    name === "VIBE_ISSUE_LABELS" ? "custom-label,another" : undefined;

  // deno-lint-ignore no-explicit-any
  const result = mergeNonInteractive({}, env) as any;
  assertEquals(result.issue_labels, undefined);
});

Deno.test("mergeNonInteractive - sets authorized_commenters from VIBE_AUTHORIZED_COMMENTERS", () => {
  const env = (name: string) =>
    name === "VIBE_AUTHORIZED_COMMENTERS"
      ? "user1,github-copilot[bot]"
      : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.authorized_commenters, ["user1", "github-copilot[bot]"]);
});

Deno.test("mergeNonInteractive - VIBE_INCLUDE_BOT_COMMENTERS adds bot accounts", () => {
  const env = (name: string) => {
    if (name === "VIBE_ALLOWED_AUTHOR") return "testuser";
    if (name === "VIBE_INCLUDE_BOT_COMMENTERS") return "true";
    return undefined;
  };

  const result = mergeNonInteractive({}, env);
  assertEquals(result.authorized_commenters, [
    "testuser",
    "github-copilot[bot]",
    "copilot[bot]",
    "cursor-bugbot",
    "cursor[bot]",
  ]);
});

Deno.test("mergeNonInteractive - defaults authorized_commenters to first allowed author", () => {
  const env = (name: string) =>
    name === "VIBE_ALLOWED_AUTHOR" ? "mainuser" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.authorized_commenters, ["mainuser"]);
});

Deno.test("mergeNonInteractive - VIBE_WORK_ON_LABEL is ignored (Issue #1834)", () => {
  // Issue #1834: VIBE_WORK_ON_LABEL no longer applied — work_on_label
  // is hardwired and not configurable.
  const env = (name: string) =>
    name === "VIBE_WORK_ON_LABEL" ? "custom-work" : undefined;

  // deno-lint-ignore no-explicit-any
  const result = mergeNonInteractive({}, env) as any;
  assertEquals(result.work_on_label, undefined);
});

Deno.test("mergeNonInteractive - sets pr_reviewer from VIBE_PR_REVIEWER", () => {
  const env = (name: string) =>
    name === "VIBE_PR_REVIEWER" ? "rev-user" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.pr_reviewer, "rev-user");
});

Deno.test("mergeNonInteractive - preserves existing values when no env vars set", () => {
  const existing: SetupConfig = {
    allowed_authors: ["existing-user"],
    repos: ["org/existing-repo"],
    failed_label: "custom-failed",
  };
  const env = (_name: string) => undefined;

  const result = mergeNonInteractive(existing, env);
  assertEquals(result.allowed_authors, ["existing-user"]);
  assertEquals(result.repos, ["org/existing-repo"]);
  assertEquals(result.failed_label, "custom-failed");
});

Deno.test("mergeNonInteractive - preserves repo_config from existing config", () => {
  const existing: SetupConfig = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    repo_config: { "org/repo": { skip_quality_check: true } },
  };
  const env = (_name: string) => undefined;

  const result = mergeNonInteractive(existing, env);
  assertEquals(result.repo_config, {
    "org/repo": { skip_quality_check: true },
  });
});

// =============================================================================
// runNonInteractive — End-to-End
// =============================================================================

Deno.test("runNonInteractive - writes only overridden values to config file", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    const env = (name: string) => {
      if (name === "VIBE_ALLOWED_AUTHOR") return "testuser";
      if (name === "VIBE_REPOS") return "org/repo1,org/repo2";
      return undefined;
    };

    await runNonInteractive(configPath, env);

    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content);

    // Should have allowed_authors, repos, and authorized_commenters
    assertEquals(parsed.allowed_authors, ["testuser"]);
    assertEquals(parsed.repos, ["org/repo1", "org/repo2"]);
    assertEquals(parsed.authorized_commenters, ["testuser"]);

    // Should NOT have default values
    assertEquals(parsed.issue_labels, undefined);
    assertEquals(parsed.work_on_label, undefined);
    assertEquals(parsed.failed_label, undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runNonInteractive - preserves existing config and merges new values", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    // Write initial config
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        allowed_authors: ["existing-user"],
        repos: ["org/existing-repo"],
        repo_config: {
          "org/existing-repo": { pre_setup_command: "./setup.sh" },
        },
      }),
    );

    const env = (name: string) => {
      if (name === "VIBE_ADD_REPOS") return "org/new-repo";
      return undefined;
    };

    await runNonInteractive(configPath, env);

    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content);

    assertEquals(parsed.allowed_authors, ["existing-user"]);
    assertEquals(parsed.repos, ["org/existing-repo", "org/new-repo"]);
    assertEquals(parsed.repo_config, {
      "org/existing-repo": { pre_setup_command: "./setup.sh" },
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runNonInteractive - work_on_label cannot be set via env (Issue #1834)", async () => {
  // Issue #1834: VIBE_WORK_ON_LABEL is no longer honoured — the
  // work-on label is hardwired in lib/config_defaults.ts.
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    const env = (name: string) => {
      if (name === "VIBE_ALLOWED_AUTHOR") return "testuser";
      if (name === "VIBE_REPOS") return "org/repo";
      if (name === "VIBE_WORK_ON_LABEL") return "custom-work-on";
      return undefined;
    };

    await runNonInteractive(configPath, env);

    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content);

    assertEquals(parsed.work_on_label, undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// =============================================================================
// Operational Config — Issue #277
// =============================================================================

Deno.test("buildOverridesOnly - includes claude_timeout when different from default", () => {
  const config: SetupConfig = {
    claude_timeout: 7200,
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.claude_timeout, 7200);
});

Deno.test("buildOverridesOnly - omits claude_timeout when matching default (3600, Issue #1824)", () => {
  // Issue #1824: claudeTimeout default lowered from 14400 to 3600.
  const config: SetupConfig = {
    claude_timeout: 3600,
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.claude_timeout, undefined);
});

Deno.test("buildOverridesOnly - includes sleep_interval when different from default", () => {
  const config: SetupConfig = {
    sleep_interval: 60,
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.sleep_interval, 60);
});

Deno.test("buildOverridesOnly - omits sleep_interval when matching default (30)", () => {
  const config: SetupConfig = {
    sleep_interval: 30,
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.sleep_interval, undefined);
});

Deno.test("buildOverridesOnly - includes planning_label when different from default", () => {
  const config: SetupConfig = {
    planning_label: "custom-planning",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.planning_label, "custom-planning");
});

Deno.test("buildOverridesOnly - omits planning_label when matching default", () => {
  const config: SetupConfig = {
    planning_label: "planning",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.planning_label, undefined);
});

Deno.test("mergeNonInteractive - sets claude_timeout from VIBE_CLAUDE_TIMEOUT", () => {
  const env = (name: string) =>
    name === "VIBE_CLAUDE_TIMEOUT" ? "7200" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.claude_timeout, 7200);
});

Deno.test("mergeNonInteractive - sets sleep_interval from VIBE_SLEEP_INTERVAL", () => {
  const env = (name: string) =>
    name === "VIBE_SLEEP_INTERVAL" ? "60" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.sleep_interval, 60);
});

Deno.test("mergeNonInteractive - ignores non-numeric VIBE_CLAUDE_TIMEOUT", () => {
  const env = (name: string) =>
    name === "VIBE_CLAUDE_TIMEOUT" ? "not-a-number" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.claude_timeout, undefined);
});

Deno.test("mergeNonInteractive - preserves existing operational values when no env vars set", () => {
  const existing: SetupConfig = {
    claude_timeout: 7200,
    sleep_interval: 60,
  };
  const env = (_name: string) => undefined;

  const result = mergeNonInteractive(existing, env);
  assertEquals(result.claude_timeout, 7200);
  assertEquals(result.sleep_interval, 60);
});

Deno.test("runNonInteractive - stores operational override in config file (Issue #277)", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    const env = (name: string) => {
      if (name === "VIBE_ALLOWED_AUTHOR") return "testuser";
      if (name === "VIBE_REPOS") return "org/repo";
      if (name === "VIBE_CLAUDE_TIMEOUT") return "7200";
      return undefined;
    };

    await runNonInteractive(configPath, env);

    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content);

    assertEquals(parsed.claude_timeout, 7200);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runNonInteractive - does NOT store default operational value (Issue #277)", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    const env = (name: string) => {
      if (name === "VIBE_ALLOWED_AUTHOR") return "testuser";
      if (name === "VIBE_REPOS") return "org/repo";
      if (name === "VIBE_CLAUDE_TIMEOUT") return "3600"; // matches default (Issue #1824)
      return undefined;
    };

    await runNonInteractive(configPath, env);

    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content);

    assertEquals(parsed.claude_timeout, undefined); // not stored
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// =============================================================================
// Optional Feature Configuration — Issue #535
// =============================================================================

Deno.test("mergeNonInteractive - sets imgbb_api_key from VIBE_IMGBB_API_KEY", () => {
  const env = (name: string) =>
    name === "VIBE_IMGBB_API_KEY" ? "test-api-key-123" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.imgbb_api_key, "test-api-key-123");
});

Deno.test("mergeNonInteractive - does not set imgbb_api_key when env var is empty", () => {
  const env = (name: string) => name === "VIBE_IMGBB_API_KEY" ? "" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.imgbb_api_key, undefined);
});

Deno.test("mergeNonInteractive - sets update_gh_user_status from VIBE_UPDATE_GH_USER_STATUS", () => {
  const env = (name: string) =>
    name === "VIBE_UPDATE_GH_USER_STATUS" ? "false" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.update_gh_user_status, false);
});

Deno.test("mergeNonInteractive - sets update_gh_user_status to true", () => {
  const env = (name: string) =>
    name === "VIBE_UPDATE_GH_USER_STATUS" ? "true" : undefined;

  const result = mergeNonInteractive({}, env);
  assertEquals(result.update_gh_user_status, true);
});

Deno.test("mergeNonInteractive - preserves existing imgbb_api_key when no env var set", () => {
  const existing: SetupConfig = {
    imgbb_api_key: "existing-key",
  };
  const env = (_name: string) => undefined;

  const result = mergeNonInteractive(existing, env);
  assertEquals(result.imgbb_api_key, "existing-key");
});

Deno.test("mergeNonInteractive - preserves existing update_gh_user_status when no env var set", () => {
  const existing: SetupConfig = {
    update_gh_user_status: false,
  };
  const env = (_name: string) => undefined;

  const result = mergeNonInteractive(existing, env);
  assertEquals(result.update_gh_user_status, false);
});

Deno.test("buildOverridesOnly - includes imgbb_api_key when present", () => {
  const config: SetupConfig = {
    imgbb_api_key: "my-api-key",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.imgbb_api_key, "my-api-key");
});

Deno.test("buildOverridesOnly - omits imgbb_api_key when empty", () => {
  const config: SetupConfig = {
    imgbb_api_key: "",
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.imgbb_api_key, undefined);
});

Deno.test("buildOverridesOnly - includes update_gh_user_status when false (overrides default true)", () => {
  const config: SetupConfig = {
    update_gh_user_status: false,
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.update_gh_user_status, false);
});

Deno.test("buildOverridesOnly - omits update_gh_user_status when true (matches default)", () => {
  const config: SetupConfig = {
    update_gh_user_status: true,
  };
  const result = buildOverridesOnly(config);
  assertEquals(result.update_gh_user_status, undefined);
});

Deno.test("runNonInteractive - stores imgbb_api_key in config file (Issue #535)", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    const env = (name: string) => {
      if (name === "VIBE_ALLOWED_AUTHOR") return "testuser";
      if (name === "VIBE_IMGBB_API_KEY") return "test-key-535";
      return undefined;
    };

    await runNonInteractive(configPath, env);

    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content);

    assertEquals(parsed.imgbb_api_key, "test-key-535");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runNonInteractive - stores update_gh_user_status=false in config file (Issue #535)", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    const env = (name: string) => {
      if (name === "VIBE_ALLOWED_AUTHOR") return "testuser";
      if (name === "VIBE_UPDATE_GH_USER_STATUS") return "false";
      return undefined;
    };

    await runNonInteractive(configPath, env);

    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content);

    assertEquals(parsed.update_gh_user_status, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runNonInteractive - idempotent with feature config (Issue #535)", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    const env = (name: string) => {
      if (name === "VIBE_ALLOWED_AUTHOR") return "testuser";
      if (name === "VIBE_IMGBB_API_KEY") return "test-key";
      if (name === "VIBE_UPDATE_GH_USER_STATUS") return "false";
      return undefined;
    };

    // Run twice — should produce identical output
    await runNonInteractive(configPath, env);
    const first = await Deno.readTextFile(configPath);

    await runNonInteractive(configPath, env);
    const second = await Deno.readTextFile(configPath);

    assertEquals(first, second);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Removed config keys (Issue #805)
// ---------------------------------------------------------------------------

Deno.test("stripRemovedConfigKeys - drops a stale fleet_health key and says so", () => {
  const { config, warnings } = stripRemovedConfigKeys(
    {
      repos: ["org/repo"],
      fleet_health_repo: "git@github.com:org/health.git",
    } as SetupConfig & Record<string, unknown>,
  );

  assertEquals(
    (config as Record<string, unknown>).fleet_health_repo,
    undefined,
  );
  assertEquals(config.repos, ["org/repo"]);
  assertEquals(warnings.length, 1);
  assert(warnings[0]!.includes("fleet_health_repo"), warnings[0]);
  assert(warnings[0]!.includes("callbacks"), warnings[0]);
});

Deno.test("stripRemovedConfigKeys - a config without a removed key is untouched and silent", () => {
  const { config, warnings } = stripRemovedConfigKeys({ repos: ["org/repo"] });
  assertEquals(config, { repos: ["org/repo"] });
  assertEquals(warnings, []);
});

Deno.test("buildOverridesOnly - never writes a removed key back (Issue #805)", () => {
  const result = buildOverridesOnly(
    {
      repos: ["org/repo"],
      fleet_health_dir: "/srv/health",
      fleet_health_repo: "git@github.com:org/health.git",
    } as SetupConfig & Record<string, unknown>,
  );
  assertEquals(result.fleet_health_dir, undefined);
  assertEquals(result.fleet_health_repo, undefined);
});
