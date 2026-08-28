/**
 * Tests for the configuration loader module.
 *
 * Following TDD: These tests are written first to define expected behaviour.
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  getEnvArrayOrDefault,
  getEnvNumberOrDefault,
  getEnvOrDefault,
  isAllowedAuthor,
  loadConfig,
  REPO_SLUG_PATTERN,
  validateConfig,
} from "../lib/config.ts";
import type { ConfigFile, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

// Test helper to create a temporary config file
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

Deno.test("config - getEnvOrDefault returns env var when set", () => {
  Deno.env.set("TEST_VAR_CONFIG", "from_env");
  try {
    const result = getEnvOrDefault("TEST_VAR_CONFIG", "default_value");
    assertEquals(result, "from_env");
  } finally {
    Deno.env.delete("TEST_VAR_CONFIG");
  }
});

Deno.test("config - getEnvOrDefault returns default when env var not set", () => {
  const result = getEnvOrDefault("NONEXISTENT_VAR_12345", "default_value");
  assertEquals(result, "default_value");
});

Deno.test("config - loadConfig loads from JSON file", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    pr_reviewers: ["reviewer"],
    repos: ["org/repo1", "org/repo2"],
    authorized_commenters: ["testuser"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.allowedAuthor, "testuser");
    assertEquals(config.prReviewer, "reviewer");
    assertEquals(config.repos, ["org/repo1", "org/repo2"]);
    // Issue #1834: issueLabels is hardwired to [top-priority] regardless
    // of whether `.config.json` is present.
    assertEquals(config.issueLabels, ["top-priority"]);
    assertEquals(config.authorisedCommenters, ["testuser"]);
    assertEquals(config.workOnLabel, "work-on");
    assertEquals(config.lowPriorityLabel, "low-priority");
  });
});

Deno.test("config - loadConfig parses idle_task_template_weights (Issue #2401)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    idle_task_template_weights: {
      "security-scan": 3,
      "supply-chain-readiness": 3,
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.idleTaskTemplateWeights, {
      "security-scan": 3,
      "supply-chain-readiness": 3,
    });
  });
});

Deno.test("config - loadConfig defaults idle_task_template_weights to empty map (Issue #2401)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.idleTaskTemplateWeights, {});
  });
});

Deno.test("config - loadConfig parses software_min_versions (Issue #2622)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    software_min_versions: { claude: "2.2.0", gh: "2.40.0" },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.softwareMinVersions, { claude: "2.2.0", gh: "2.40.0" });
  });
});

Deno.test("config - loadConfig defaults software_min_versions to claude floor (Issue #2622)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.softwareMinVersions, { claude: "2.1.170" });
  });
});

Deno.test("config - loadConfig parses best_planning_model (Issue #2654)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    best_planning_model: "fable",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.bestPlanningModel, "fable");
  });
});

Deno.test("config - loadConfig defaults best_planning_model to empty (Issue #2654)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.bestPlanningModel, "");
  });
});

Deno.test("config - loadConfig parses per-repo best_planning_model override (Issue #2654)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    best_planning_model: "fable",
    repo_config: {
      "org/repo1": { best_planning_model: "opus" } as never,
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.bestPlanningModel, "fable");
    // snake_case per-repo key is normalised to the camelCase RepoConfig field.
    assertEquals(config.repoConfig?.["org/repo1"]?.bestPlanningModel, "opus");
  });
});

Deno.test("config - loadConfig uses defaults for missing values", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.allowedAuthor, "testuser");
    // Check defaults are applied. Issue #1834: issueLabels is hardwired
    // to the top-priority constant; work-on and low-priority have
    // dedicated, author-checked collectors so they are not in this list.
    assertEquals(config.issueLabels, ["top-priority"]);
    assertEquals(config.workOnLabel, "work-on");
    assertEquals(config.failedLabel, "failed");
    assertEquals(config.failedOnceLabel, "failed-once");
    // Issue #2031: needs-clarification retired — needs-human is the handoff signal.
    assertEquals(config.needsHumanLabel, "needs-human");
    assertEquals(config.refineIssueLabel, "refine-issue");
    // Issue #1824: claudeTimeout lowered from 14400 to 3600 (1h).
    assertEquals(config.claudeTimeout, 3600);
    assertEquals(config.maxClarificationRounds, 3);
  });
});

// Issue #266: Environment variables no longer override config at runtime.
// Config is loaded from .config.json only.

Deno.test("config - loadConfig ignores env vars and uses config file values (Issue #266)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["configuser"],
    repos: ["org/repo1"],
  };

  Deno.env.set("ALLOWED_AUTHOR", "envuser");
  try {
    await withTempConfig(testConfig, async (configPath) => {
      const config = await loadConfig(configPath);
      // Config file value should be used, NOT env var (Issue #266)
      assertEquals(config.allowedAuthor, "configuser");
    });
  } finally {
    Deno.env.delete("ALLOWED_AUTHOR");
  }
});

Deno.test("config - loadConfig uses repos from config file, not environment (Issue #266)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["config/repo"],
  };

  Deno.env.set("REPOS", "env/repo1,env/repo2");
  try {
    await withTempConfig(testConfig, async (configPath) => {
      const config = await loadConfig(configPath);
      // Config file value should be used, NOT env var (Issue #266)
      assertEquals(config.repos, ["config/repo"]);
    });
  } finally {
    Deno.env.delete("REPOS");
  }
});

Deno.test("config - issueLabels stays hardwired even when no config file is present (Issue #1834)", async () => {
  // Verifies the acceptance criterion: a Vibe Coder with zero
  // configuration still discovers issues with the hardwired discovery
  // labels.
  const config = await loadConfig("/nonexistent/path/.config.json");
  assertEquals(config.issueLabels, ["top-priority"]);
  assertEquals(config.workOnLabel, "work-on");
  assertEquals(config.lowPriorityLabel, "low-priority");
});

Deno.test("config - issueLabels is unchanged regardless of file contents (Issue #1834)", async () => {
  // The three discovery labels are hardwired — a config file cannot
  // alter them. Validation rejects the obsolete keys upstream
  // (config_unknown_keys), but even an unrecognised key making it
  // through validation must not affect issueLabels.
  const testConfig = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  } as ConfigFile;

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.issueLabels, ["top-priority"]);
    assertEquals(config.workOnLabel, "work-on");
    assertEquals(config.lowPriorityLabel, "low-priority");
  });
});

Deno.test("config - validateConfig throws when allowedAuthors is empty", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: [],
    allowedAuthor: "",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  assertThrows(
    () => validateConfig(config),
    Error,
    "allowed_authors",
  );
});

Deno.test("config - validateConfig throws when repos is empty", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: [],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  assertThrows(
    () => validateConfig(config),
    Error,
    "repos",
  );
});

Deno.test("config - validateConfig throws when issueLabels is empty (Issue #1834)", () => {
  // issueLabels is hardwired in lib/config_defaults.ts — empty here
  // signals an internal bug, not user misconfiguration.
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: [],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  assertThrows(
    () => validateConfig(config),
    Error,
    "hardwired",
  );
});

Deno.test("config - validateConfig validates repo format", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["invalid-repo-format"],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  assertThrows(
    () => validateConfig(config),
    Error,
    "owner/repo",
  );
});

Deno.test("config - REPO_SLUG_PATTERN accepts valid owner/repo slugs", () => {
  for (
    const slug of [
      "owner/repo",
      "stSoftwareAU/private-repo-11",
      "org/repo1",
      "a_b/c.d",
      "user-name/repo.name-1",
    ]
  ) {
    assertEquals(REPO_SLUG_PATTERN.test(slug), true, `expected ${slug} valid`);
  }
});

Deno.test("config - REPO_SLUG_PATTERN rejects path-traversal slugs (Issue #2692)", () => {
  for (
    const slug of [
      "owner/..",
      "owner/.",
      "../x",
      "./x",
      "..",
      ".",
      "owner/...",
      ".hidden/repo",
      "owner/.git",
    ]
  ) {
    assertEquals(
      REPO_SLUG_PATTERN.test(slug),
      false,
      `expected ${slug} rejected`,
    );
  }
});

Deno.test("config - validateConfig rejects a traversal repo slug (Issue #2692)", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["owner/.."],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  assertThrows(
    () => validateConfig(config),
    Error,
    "owner/repo",
  );
});

Deno.test("config - validateConfig passes for valid config", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  // Should not throw
  validateConfig(config);
});

Deno.test("config - loadConfig throws for malformed JSON file", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, "{ not valid json }");
  try {
    await assertRejects(
      () => loadConfig(configPath),
      Error,
      "invalid JSON",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("config - loadConfig throws for config with invalid structure", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  // repos should be an array, not a string
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({ repos: "not-an-array" }),
  );
  try {
    await assertRejects(
      () => loadConfig(configPath),
      Error,
      "invalid structure",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// =============================================================================
// getEnvNumberOrDefault tests (Issue #218)
// =============================================================================

Deno.test("config - getEnvNumberOrDefault returns env var as number when set", () => {
  Deno.env.set("TEST_NUM_VAR", "42");
  try {
    const result = getEnvNumberOrDefault("TEST_NUM_VAR", 0);
    assertEquals(result, 42);
  } finally {
    Deno.env.delete("TEST_NUM_VAR");
  }
});

Deno.test("config - getEnvNumberOrDefault returns default when env var not set", () => {
  const result = getEnvNumberOrDefault("NONEXISTENT_NUM_12345", 99);
  assertEquals(result, 99);
});

Deno.test("config - getEnvNumberOrDefault returns default for non-numeric env var", () => {
  Deno.env.set("TEST_NAN_VAR", "not-a-number");
  try {
    const result = getEnvNumberOrDefault("TEST_NAN_VAR", 50);
    assertEquals(result, 50);
  } finally {
    Deno.env.delete("TEST_NAN_VAR");
  }
});

Deno.test("config - getEnvNumberOrDefault handles zero correctly", () => {
  Deno.env.set("TEST_ZERO_VAR", "0");
  try {
    const result = getEnvNumberOrDefault("TEST_ZERO_VAR", 100);
    assertEquals(result, 0);
  } finally {
    Deno.env.delete("TEST_ZERO_VAR");
  }
});

Deno.test("config - getEnvNumberOrDefault handles negative numbers", () => {
  Deno.env.set("TEST_NEG_VAR", "-5");
  try {
    const result = getEnvNumberOrDefault("TEST_NEG_VAR", 10);
    assertEquals(result, -5);
  } finally {
    Deno.env.delete("TEST_NEG_VAR");
  }
});

// =============================================================================
// getEnvArrayOrDefault tests (Issue #218)
// =============================================================================

Deno.test("config - getEnvArrayOrDefault returns env var as array when set", () => {
  Deno.env.set("TEST_ARR_VAR", "a,b,c");
  try {
    const result = getEnvArrayOrDefault("TEST_ARR_VAR", []);
    assertEquals(result, ["a", "b", "c"]);
  } finally {
    Deno.env.delete("TEST_ARR_VAR");
  }
});

Deno.test("config - getEnvArrayOrDefault returns default when env var not set", () => {
  const result = getEnvArrayOrDefault("NONEXISTENT_ARR_12345", ["x", "y"]);
  assertEquals(result, ["x", "y"]);
});

Deno.test("config - getEnvArrayOrDefault returns default for empty env var", () => {
  Deno.env.set("TEST_EMPTY_ARR", "");
  try {
    const result = getEnvArrayOrDefault("TEST_EMPTY_ARR", ["default"]);
    assertEquals(result, ["default"]);
  } finally {
    Deno.env.delete("TEST_EMPTY_ARR");
  }
});

Deno.test("config - getEnvArrayOrDefault trims whitespace from values", () => {
  Deno.env.set("TEST_SPACE_ARR", " alpha , beta , gamma ");
  try {
    const result = getEnvArrayOrDefault("TEST_SPACE_ARR", []);
    assertEquals(result, ["alpha", "beta", "gamma"]);
  } finally {
    Deno.env.delete("TEST_SPACE_ARR");
  }
});

Deno.test("config - getEnvArrayOrDefault filters out empty entries", () => {
  Deno.env.set("TEST_EMPTY_ENTRIES", "a,,b,,c");
  try {
    const result = getEnvArrayOrDefault("TEST_EMPTY_ENTRIES", []);
    assertEquals(result, ["a", "b", "c"]);
  } finally {
    Deno.env.delete("TEST_EMPTY_ENTRIES");
  }
});

Deno.test("config - getEnvArrayOrDefault handles single value", () => {
  Deno.env.set("TEST_SINGLE_ARR", "onlyone");
  try {
    const result = getEnvArrayOrDefault("TEST_SINGLE_ARR", []);
    assertEquals(result, ["onlyone"]);
  } finally {
    Deno.env.delete("TEST_SINGLE_ARR");
  }
});

// =============================================================================
// isAllowedAuthor tests (Issue #218)
// =============================================================================

Deno.test("config - isAllowedAuthor returns true for allowed user", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["alice", "bob"],
    allowedAuthor: "alice",
  }) as WorkerConfig;

  assertEquals(isAllowedAuthor(config, "alice"), true);
  assertEquals(isAllowedAuthor(config, "bob"), true);
});

Deno.test("config - isAllowedAuthor returns false for disallowed user", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["alice"],
    allowedAuthor: "alice",
  }) as WorkerConfig;

  assertEquals(isAllowedAuthor(config, "charlie"), false);
});

Deno.test("config - isAllowedAuthor is case-sensitive", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["Alice"],
    allowedAuthor: "Alice",
  }) as WorkerConfig;

  assertEquals(isAllowedAuthor(config, "alice"), false);
  assertEquals(isAllowedAuthor(config, "Alice"), true);
});

// =============================================================================
// validateConfig additional edge cases (Issue #218)
// =============================================================================

Deno.test("config - validateConfig rejects invalid username format", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["invalid user name!"],
    allowedAuthor: "invalid user name!",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  assertThrows(
    () => validateConfig(config),
    Error,
    "Invalid username format",
  );
});

Deno.test("config - validateConfig error messages reference config file, not env vars (Issue #266)", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: [],
    allowedAuthor: "",
    prReviewer: "",
    repos: [],
    issueLabels: [],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  assertThrows(
    () => validateConfig(config),
    Error,
    "setup.sh",
  );
});

Deno.test("config - validateConfig accepts bot account usernames", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["github-copilot[bot]"],
    allowedAuthor: "github-copilot[bot]",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  // Should not throw
  validateConfig(config);
});

Deno.test("config - validateConfig accepts multiple allowed authors", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["user1", "user2", "user3"],
    allowedAuthor: "user1",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  // Should not throw
  validateConfig(config);
});

// =============================================================================
// GitHub-derived allowlists — author_source + exclusion_team (Issue #252)
// =============================================================================

function captureConsoleWarn(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

Deno.test("config - validateConfig throws when allowedAuthors is empty under author_source config (Issue #252)", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: [],
    allowedAuthor: "",
    authorSource: "config",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  });

  assertThrows(
    () => validateConfig(config),
    Error,
    "allowed_authors is required",
  );
});

Deno.test("config - validateConfig allows empty allowedAuthors under author_source github (Issue #252)", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: [],
    allowedAuthor: "",
    authorSource: "github",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: [],
    workDir: "/tmp/work",
  });

  validateConfig(config);
});

Deno.test("config - validateConfig warns about ignored local allowlists under author_source github (Issue #252)", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["alice", "bob"],
    allowedAuthor: "alice",
    authorSource: "github",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["carol"],
    workDir: "/tmp/work",
  });

  const warnings = captureConsoleWarn(() => validateConfig(config));
  assertEquals(warnings.length > 0, true, "expected a deprecation warning");
  const combined = warnings.join("\n");
  assertStringIncludes(combined, "alice");
  assertStringIncludes(combined, "bob");
  assertStringIncludes(combined, "carol");
});

Deno.test("config - validateConfig throws on a malformed exclusion_team (Issue #252)", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    exclusionTeam: "vibe-workers",
    workDir: "/tmp/work",
  });

  assertThrows(
    () => validateConfig(config),
    Error,
    "exclusion_team",
  );
});

Deno.test("config - validateConfig accepts an org/slug exclusion_team (Issue #252)", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    exclusionTeam: "stSoftwareAU/vibe-workers",
    workDir: "/tmp/work",
  });

  validateConfig(config);
});

Deno.test("config - absent author_source matches today's validateConfig behaviour (Issue #252)", () => {
  const emptyAuthors: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: [],
    allowedAuthor: "",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  });

  assertThrows(
    () => validateConfig(emptyAuthors),
    Error,
    "allowed_authors is required",
  );

  const populated: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    workDir: "/tmp/work",
  });

  const warnings = captureConsoleWarn(() => validateConfig(populated));
  assertEquals(warnings, []);
});

Deno.test("config - loadConfig defaults author_source to config when absent (Issue #252)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.authorSource, "config");
    assertEquals(config.exclusionTeam, undefined);
  });
});

Deno.test("config - loadConfig loads author_source and exclusion_team (Issue #252)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: [],
    repos: ["org/repo"],
    author_source: "github",
    exclusion_team: "stSoftwareAU/vibe-workers",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath, { validate: true });
    assertEquals(config.authorSource, "github");
    assertEquals(config.exclusionTeam, "stSoftwareAU/vibe-workers");
    assertEquals(config.allowedAuthors, []);
  });
});

Deno.test("config - loadConfig throws on a malformed exclusion_team (Issue #252)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    exclusion_team: "vibe-workers",
  };

  await withTempConfig(testConfig, async (configPath) => {
    await assertRejects(
      () => loadConfig(configPath),
      Error,
      "exclusion_team",
    );
  });
});

Deno.test("config - loadConfig with author_source github warns about ignored local logins (Issue #252)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["alice"],
    authorized_commenters: ["bob"],
    repos: ["org/repo"],
    author_source: "github",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const warnings = await (async () => {
      const captured: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(" "));
      };
      try {
        await loadConfig(configPath, { validate: true });
      } finally {
        console.warn = original;
      }
      return captured;
    })();

    const combined = warnings.join("\n");
    assertStringIncludes(combined, "alice");
    assertStringIncludes(combined, "bob");
  });
});

// =============================================================================
// loadConfig allowed_authors array (Issue #218)
// =============================================================================

Deno.test("config - loadConfig loads allowed_authors array from config file", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1", "user2", "user3"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.allowedAuthors, ["user1", "user2", "user3"]);
    assertEquals(config.allowedAuthor, "user1");
  });
});

Deno.test("config - loadConfig falls back to legacy allowed_author when allowed_authors missing", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["legacy-user"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.allowedAuthors, ["legacy-user"]);
    assertEquals(config.allowedAuthor, "legacy-user");
  });
});

Deno.test("config - loadConfig uses config file allowed_authors, ignores env (Issue #266)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["config-user"],
    repos: ["org/repo"],
  };

  Deno.env.set("ALLOWED_AUTHORS", "env-user1,env-user2");
  try {
    await withTempConfig(testConfig, async (configPath) => {
      const config = await loadConfig(configPath);
      // Config file value should be used, NOT env var (Issue #266)
      assertEquals(config.allowedAuthors, ["config-user"]);
    });
  } finally {
    Deno.env.delete("ALLOWED_AUTHORS");
  }
});

Deno.test("config - loadConfig sets authorisedCommenters from allowedAuthor when not specified", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.authorisedCommenters, ["testuser"]);
  });
});

// =============================================================================
// Claude Model Configuration (Issue #260)
// =============================================================================

Deno.test("config - loadConfig loads claude_model from config file", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    claude_model: "claude-opus-4-7",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.claudeModel, "claude-opus-4-7");
  });
});

Deno.test("config - loadConfig defaults claudeModel to opus when not configured", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.claudeModel, "opus");
  });
});

Deno.test("config - loadConfig uses config file claude_model, ignores env (Issue #266)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    claude_model: "claude-sonnet-4-7",
  };

  Deno.env.set("CLAUDE_MODEL", "claude-opus-4-7");
  try {
    await withTempConfig(testConfig, async (configPath) => {
      const config = await loadConfig(configPath);
      // Config file value should be used, NOT env var (Issue #266)
      assertEquals(config.claudeModel, "claude-sonnet-4-7");
    });
  } finally {
    Deno.env.delete("CLAUDE_MODEL");
  }
});

// =============================================================================
// Operational Configuration from .config.json (Issue #277)
// =============================================================================

Deno.test("config - loadConfig uses default operational values when not in config file (Issue #277)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    // Issue #1824: claudeTimeout lowered to 3600 (1h), planningTimeout to 1800 (30 min).
    assertEquals(config.claudeTimeout, 3600);
    assertEquals(config.claudeKillAfter, 30);
    assertEquals(config.maxClarificationRounds, 3);
    assertEquals(config.sleepInterval, 30);
    assertEquals(config.creditWaitInterval, 300);
    assertEquals(config.refinementTimeout, 300);
    assertEquals(config.refinementKillAfter, 10);
    assertEquals(config.planningTimeout, 1800);
    assertEquals(config.prFeedbackTimeout, 1800);
    assertEquals(config.ciFixTimeout, 1800);
    assertEquals(config.planningKillAfter, 10);
    assertEquals(config.clarificationTimeout, 120);
    assertEquals(config.clarificationKillAfter, 10);
    assertEquals(config.maxRateLimitRetries, 2);
    assertEquals(config.maxRateLimitWait, 600);
    assertEquals(config.retryMaxDelay, 60);
    assertEquals(config.maxIssueBodyTokens, 50000);
    assertEquals(config.summariseTimeout, 120);
    assertEquals(config.summariseKillAfter, 10);
    assertEquals(config.featureCheckTimeout, 5);
  });
});

Deno.test("config - loadConfig loads claude_timeout override from config file (Issue #277)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    claude_timeout: 7200,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.claudeTimeout, 7200);
  });
});

Deno.test(
  "config - loadConfig back-compat: claude_timeout override flows into prFeedback/ciFix when those are unset (Issue #1824)",
  async () => {
    // Issue #1824 acceptance criteria: "If a .config.json has explicitly
    // overridden claudeTimeout, that override still applies (back-compat)".
    // Existing users who set claude_timeout=7200 should see PR feedback
    // and CI fix continue to use that 7200 value rather than silently
    // dropping back to the new 1800 default.
    const testConfig: ConfigFile = {
      allowed_authors: ["testuser"],
      repos: ["org/repo"],
      claude_timeout: 7200,
    };

    await withTempConfig(testConfig, async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.claudeTimeout, 7200);
      assertEquals(config.prFeedbackTimeout, 7200);
      assertEquals(config.ciFixTimeout, 7200);
    });
  },
);

Deno.test(
  "config - loadConfig honours explicit pr_feedback_timeout override (Issue #1824)",
  async () => {
    const testConfig: ConfigFile = {
      allowed_authors: ["testuser"],
      repos: ["org/repo"],
      pr_feedback_timeout: 900,
    };

    await withTempConfig(testConfig, async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.prFeedbackTimeout, 900);
      // ciFixTimeout still uses its default
      assertEquals(config.ciFixTimeout, 1800);
    });
  },
);

Deno.test(
  "config - loadConfig honours explicit ci_fix_timeout override (Issue #1824)",
  async () => {
    const testConfig: ConfigFile = {
      allowed_authors: ["testuser"],
      repos: ["org/repo"],
      ci_fix_timeout: 1200,
    };

    await withTempConfig(testConfig, async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.ciFixTimeout, 1200);
      // prFeedbackTimeout still uses its default
      assertEquals(config.prFeedbackTimeout, 1800);
    });
  },
);

Deno.test(
  "config - loadConfig: explicit pr_feedback_timeout takes precedence over claude_timeout back-compat (Issue #1824)",
  async () => {
    const testConfig: ConfigFile = {
      allowed_authors: ["testuser"],
      repos: ["org/repo"],
      claude_timeout: 7200,
      pr_feedback_timeout: 900,
    };

    await withTempConfig(testConfig, async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.prFeedbackTimeout, 900);
      // ciFixTimeout still inherits from claude_timeout (back-compat)
      assertEquals(config.ciFixTimeout, 7200);
    });
  },
);

Deno.test("config - loadConfig loads multiple operational overrides from config file (Issue #277)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    claude_timeout: 7200,
    sleep_interval: 60,
    max_clarification_rounds: 5,
    planning_timeout: 1200,
    feature_check_timeout: 10,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.claudeTimeout, 7200);
    assertEquals(config.sleepInterval, 60);
    assertEquals(config.maxClarificationRounds, 5);
    assertEquals(config.planningTimeout, 1200);
    assertEquals(config.featureCheckTimeout, 10);
    // Non-overridden values still use defaults
    assertEquals(config.refinementTimeout, 300);
    assertEquals(config.creditWaitInterval, 300);
  });
});

Deno.test("config - loadConfig loads planning_label from config file (Issue #277)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    planning_label: "custom-planning",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.planningLabel, "custom-planning");
  });
});

Deno.test("config - loadConfig defaults planning_label to 'planning' (Issue #277)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.planningLabel, "planning");
  });
});

Deno.test("config - loadConfig reads custom needs_revision_label (Issue #898)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    needs_revision_label: "custom-revision",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.needsRevisionLabel, "custom-revision");
  });
});

Deno.test("config - loadConfig defaults needs_revision_label to 'needs-revision' (Issue #898)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.needsRevisionLabel, "needs-revision");
  });
});

Deno.test("config - loadConfig reads custom needs_human_label (Issue #1469)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    needs_human_label: "custom-human",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.needsHumanLabel, "custom-human");
  });
});

Deno.test("config - loadConfig defaults needs_human_label to 'needs-human' (Issue #1469)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.needsHumanLabel, "needs-human");
  });
});

Deno.test("config - loadConfig normalises per-repo model/effort routing keys (Issue #2625)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    repo_config: {
      "org/premium-repo": {
        claude_model: "fable",
        phase_model_overrides: { issue: "fable" },
        phase_effort_overrides: { issue: "xhigh" },
      } as unknown as import("../types.ts").RepoConfig,
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    const repoConf = config.repoConfig?.["org/premium-repo"];
    assertEquals(repoConf?.claudeModel, "fable");
    assertEquals(repoConf?.phaseModelOverrides, { issue: "fable" });
    assertEquals(repoConf?.phaseEffortOverrides, { issue: "xhigh" });
  });
});

// =============================================================================
// Issue #1296: repo_config snake_case to camelCase normalisation
// =============================================================================

Deno.test("config - loadConfig normalises repo_config snake_case keys to camelCase (Issue #1296)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    repo_config: {
      "org/test-repo": {
        skip_screenshot_check: true,
        skip_quality_check: true,
        quality_command: "make test",
        custom_instructions: "Use Australian English",
      } as unknown as import("../types.ts").RepoConfig,
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    const repoConf = config.repoConfig?.["org/test-repo"];
    assertEquals(repoConf?.skipScreenshotCheck, true);
    assertEquals(repoConf?.skipQualityCheck, true);
    assertEquals(repoConf?.qualityCommand, "make test");
    assertEquals(repoConf?.customInstructions, "Use Australian English");
  });
});

Deno.test("config - loadConfig preserves repo_config camelCase keys (Issue #1296)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    repo_config: {
      "org/test-repo": {
        skipScreenshotCheck: true,
        qualityCommand: "make test",
      },
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    const repoConf = config.repoConfig?.["org/test-repo"];
    assertEquals(repoConf?.skipScreenshotCheck, true);
    assertEquals(repoConf?.qualityCommand, "make test");
  });
});

Deno.test("config - loadConfig normalises mixed snake_case and camelCase repo_config (Issue #1296)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    repo_config: {
      "org/test-repo": {
        skip_screenshot_check: true,
        qualityCommand: "make test",
        skip_auto_merge: true,
      } as unknown as import("../types.ts").RepoConfig,
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    const repoConf = config.repoConfig?.["org/test-repo"];
    assertEquals(repoConf?.skipScreenshotCheck, true);
    assertEquals(repoConf?.qualityCommand, "make test");
    assertEquals(repoConf?.skipAutoMerge, true);
  });
});

Deno.test("config - loadConfig round-trips repo_config nice through normaliseRepoConfig (Issue #2772)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    repo_config: {
      "org/sooner": { nice: -7 },
      "org/later": { nice: 12 },
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.repoConfig?.["org/sooner"]?.nice, -7);
    assertEquals(config.repoConfig?.["org/later"]?.nice, 12);
  });
});

// =============================================================================
// Issue #1334: Unknown config key detection at startup
// =============================================================================

Deno.test("config - loadConfig warns about unknown keys in config file (Issue #1334)", async () => {
  // Write a config file with an unknown camelCase key
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  const rawConfig = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    claudeTimeout: 7200, // camelCase — should warn
  };
  await Deno.writeTextFile(configPath, JSON.stringify(rawConfig));

  // Capture stderr output
  const stderrOutput: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    stderrOutput.push(args.map(String).join(" "));
  };

  try {
    const config = await loadConfig(configPath);
    // Config should still load successfully (warnings, not errors)
    assertEquals(config.allowedAuthors, ["testuser"]);
    // Should have warned about the camelCase key
    assertEquals(stderrOutput.length > 0, true, "Expected warning output");
    assertEquals(
      stderrOutput[0]!.includes("claudeTimeout"),
      true,
      "Warning should mention the unknown key",
    );
    assertEquals(
      stderrOutput[0]!.includes("claude_timeout"),
      true,
      "Warning should suggest the correct key",
    );
  } finally {
    console.error = originalError;
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("config - loadConfig does not warn for valid keys (Issue #1334)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    claude_timeout: 7200,
    shuffle_repos: false,
  };

  const stderrOutput: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    stderrOutput.push(args.map(String).join(" "));
  };

  try {
    await withTempConfig(testConfig, async (configPath) => {
      await loadConfig(configPath);
      assertEquals(
        stderrOutput.length,
        0,
        "No warnings expected for valid keys",
      );
    });
  } finally {
    console.error = originalError;
  }
});

Deno.test("config - loadConfig parses idle_task_cadence (Issue #4011)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    idle_task_cadence: {
      enabled: true,
      templates: {
        "security-scan": { weekly_model: "sonnet", monthly_model: "fable" },
      },
      weekly_days: 7,
      monthly_days: 28,
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.idleTaskCadence, {
      enabled: true,
      weeklyDays: 7,
      monthlyDays: 28,
      templates: {
        "security-scan": { weeklyModel: "sonnet", monthlyModel: "fable" },
      },
    });
  });
});

Deno.test("config - loadConfig defaults idle_task_cadence to the #4003 policy (Issue #4011)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.idleTaskCadence.enabled, true);
    assertEquals(config.idleTaskCadence.weeklyDays, 7);
    assertEquals(config.idleTaskCadence.monthlyDays, 30);
    assertEquals(Object.keys(config.idleTaskCadence.templates).sort(), [
      "github-actions-audit",
      "security-scan",
      "supply-chain-readiness",
    ]);
  });
});

Deno.test("config - loadConfig honours the idle_task_cadence kill switch (Issue #4011)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    idle_task_cadence: { enabled: false },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.idleTaskCadence.enabled, false);
  });
});

Deno.test("config - include_codebase_map defaults to true (Issue #4281)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.includeCodebaseMap, true);
  });
});

Deno.test("config - include_codebase_map can be switched off (Issue #4281)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    include_codebase_map: false,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.includeCodebaseMap, false);
  });
});

// Issue #422 flipped the shipped default from `false` to `true`, so this test
// now pins the opposite verdict for the same unconfigured input. The companion
// tunables are unchanged — only the switch moved.
Deno.test("config - progress extension is on by default (Issues #4296, #422)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.progressExtensionEnabled, true);
    assertEquals(config.progressExtensionGrantSeconds, 900);
    assertEquals(config.progressExtensionStallSeconds, 300);
  });
});

Deno.test("config - progress extension keys are read from the file (Issue #4296)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    progress_extension_enabled: true,
    progress_extension_grant_seconds: 600,
    progress_extension_stall_seconds: 120,
    // Issue #4295: the stall window may not be shorter than the check
    // interval, so a 120 s window needs the interval lowered with it.
    progress_extension_check_seconds: 60,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.progressExtensionEnabled, true);
    assertEquals(config.progressExtensionGrantSeconds, 600);
    assertEquals(config.progressExtensionStallSeconds, 120);
    assertEquals(config.progressExtensionCheckSeconds, 60);
  });
});

Deno.test("config - a non-positive progress-extension grant is rejected (Issue #4296)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    progress_extension_grant_seconds: 0,
  };

  await withTempConfig(testConfig, async (configPath) => {
    await assertRejects(
      () => loadConfig(configPath),
      Error,
      "progress_extension_grant_seconds must be positive",
    );
  });
});

Deno.test("config - a non-positive progress-extension stall window is rejected (Issue #4296)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    progress_extension_stall_seconds: -5,
  };

  await withTempConfig(testConfig, async (configPath) => {
    await assertRejects(
      () => loadConfig(configPath),
      Error,
      "progress_extension_stall_seconds must be positive",
    );
  });
});

Deno.test("config - the progress-extension check interval defaults to 300s (Issue #4295)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.progressExtensionCheckSeconds, 300);
  });
});

Deno.test("config - the progress-extension check interval is read from the file (Issue #4295)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    progress_extension_check_seconds: 60,
    progress_extension_stall_seconds: 120,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.progressExtensionCheckSeconds, 60);
  });
});

Deno.test("config - a non-positive progress-extension check interval is rejected (Issue #4295)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    progress_extension_check_seconds: 0,
  };

  await withTempConfig(testConfig, async (configPath) => {
    await assertRejects(
      () => loadConfig(configPath),
      Error,
      "progress_extension_check_seconds must be positive",
    );
  });
});

Deno.test("config - a stall window shorter than the check interval is rejected (Issue #4295)", async () => {
  // The deadline decision reads tree evidence up to one check interval old,
  // so a shorter activity window would kill a run that demonstrably
  // progressed inside that same window.
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    progress_extension_check_seconds: 300,
    progress_extension_stall_seconds: 120,
  };

  await withTempConfig(testConfig, async (configPath) => {
    await assertRejects(
      () => loadConfig(configPath),
      Error,
      "progress_extension_stall_seconds must be at least",
    );
  });
});

Deno.test("config - a stall window equal to the check interval is accepted (Issue #4295)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    progress_extension_check_seconds: 120,
    progress_extension_stall_seconds: 120,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.progressExtensionCheckSeconds, 120);
    assertEquals(config.progressExtensionStallSeconds, 120);
  });
});
