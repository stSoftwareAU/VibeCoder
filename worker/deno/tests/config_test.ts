/**
 * Tests for the configuration loader module.
 *
 * Following TDD: These tests are written first to define expected behaviour.
 */

import {
  assert,
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
  readNonNegativeNumberEnv,
  REPO_SLUG_PATTERN,
  validateConfig,
} from "../lib/config.ts";
import type { ConfigFile, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

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
  const result = getEnvOrDefault(
    "TEST_VAR_CONFIG",
    "default_value",
    envFrom({ TEST_VAR_CONFIG: "from_env" }),
  );
  assertEquals(result, "from_env");
});

Deno.test("config - getEnvOrDefault returns default when env var not set", () => {
  const result = getEnvOrDefault(
    "NONEXISTENT_VAR_12345",
    "default_value",
    emptyEnv,
  );
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

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath, {
      env: envFrom({ ALLOWED_AUTHOR: "envuser" }),
    });
    // Config file value should be used, NOT env var (Issue #266)
    assertEquals(config.allowedAuthor, "configuser");
  });
});

Deno.test("config - loadConfig uses repos from config file, not environment (Issue #266)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["config/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath, {
      env: envFrom({ REPOS: "env/repo1,env/repo2" }),
    });
    // Config file value should be used, NOT env var (Issue #266)
    assertEquals(config.repos, ["config/repo"]);
  });
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

Deno.test("config - validateConfig accepts an empty allowedAuthors (Issue #1066)", () => {
  // The derived collaborator set fills this each cycle; an empty local array
  // is the healthy state, not a configuration error.
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: [],
    allowedAuthor: "",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    serviceAccounts: ["vibe-worker"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  validateConfig(config);
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
    serviceAccounts: ["vibe-worker"],
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
  const result = getEnvNumberOrDefault(
    "TEST_NUM_VAR",
    0,
    envFrom({ TEST_NUM_VAR: "42" }),
  );
  assertEquals(result, 42);
});

Deno.test("config - getEnvNumberOrDefault returns default when env var not set", () => {
  const result = getEnvNumberOrDefault("NONEXISTENT_NUM_12345", 99, emptyEnv);
  assertEquals(result, 99);
});

Deno.test("config - getEnvNumberOrDefault returns default for non-numeric env var", () => {
  const result = getEnvNumberOrDefault(
    "TEST_NAN_VAR",
    50,
    envFrom({ TEST_NAN_VAR: "not-a-number" }),
  );
  assertEquals(result, 50);
});

Deno.test("config - getEnvNumberOrDefault handles zero correctly", () => {
  const result = getEnvNumberOrDefault(
    "TEST_ZERO_VAR",
    100,
    envFrom({ TEST_ZERO_VAR: "0" }),
  );
  assertEquals(result, 0);
});

Deno.test("config - getEnvNumberOrDefault handles negative numbers", () => {
  const result = getEnvNumberOrDefault(
    "TEST_NEG_VAR",
    10,
    envFrom({ TEST_NEG_VAR: "-5" }),
  );
  assertEquals(result, -5);
});

// =============================================================================
// getEnvArrayOrDefault tests (Issue #218)
// =============================================================================

Deno.test("config - getEnvArrayOrDefault returns env var as array when set", () => {
  const result = getEnvArrayOrDefault(
    "TEST_ARR_VAR",
    [],
    envFrom({ TEST_ARR_VAR: "a,b,c" }),
  );
  assertEquals(result, ["a", "b", "c"]);
});

Deno.test("config - getEnvArrayOrDefault returns default when env var not set", () => {
  const result = getEnvArrayOrDefault(
    "NONEXISTENT_ARR_12345",
    ["x", "y"],
    emptyEnv,
  );
  assertEquals(result, ["x", "y"]);
});

Deno.test("config - getEnvArrayOrDefault returns default for empty env var", () => {
  const result = getEnvArrayOrDefault(
    "TEST_EMPTY_ARR",
    ["default"],
    envFrom({ TEST_EMPTY_ARR: "" }),
  );
  assertEquals(result, ["default"]);
});

Deno.test("config - getEnvArrayOrDefault trims whitespace from values", () => {
  const result = getEnvArrayOrDefault(
    "TEST_SPACE_ARR",
    [],
    envFrom({ TEST_SPACE_ARR: " alpha , beta , gamma " }),
  );
  assertEquals(result, ["alpha", "beta", "gamma"]);
});

Deno.test("config - getEnvArrayOrDefault filters out empty entries", () => {
  const result = getEnvArrayOrDefault(
    "TEST_EMPTY_ENTRIES",
    [],
    envFrom({ TEST_EMPTY_ENTRIES: "a,,b,,c" }),
  );
  assertEquals(result, ["a", "b", "c"]);
});

Deno.test("config - getEnvArrayOrDefault handles single value", () => {
  const result = getEnvArrayOrDefault(
    "TEST_SINGLE_ARR",
    [],
    envFrom({ TEST_SINGLE_ARR: "onlyone" }),
  );
  assertEquals(result, ["onlyone"]);
});

// =============================================================================
// The injected environment seam itself (Issue #956)
// =============================================================================
//
// The readers above are now driven with a fixed map rather than by mutating
// `Deno.env`, which is what removes this file from `PROCESS_STATE_MUTATORS`.
// Two properties have to hold for that migration to be honest, and neither
// is asserted by the tests above:
//
//   1. Omitting the lookup still reads the real process environment, so no
//      production caller changed behaviour.
//   2. Supplying one is authoritative — a reader that quietly fell back to
//      `Deno.env.get` would pass every test above on ambient values.
//
// `PATH` is the probe: it is always set in the process environment and never
// set in the injected maps, so the two directions are distinguishable
// without writing to the process.

Deno.test("config - the env readers default to the process environment (Issue #956)", () => {
  const path = Deno.env.get("PATH");
  assert(
    path !== undefined && path !== "",
    "PATH must be set for this probe to mean anything",
  );

  assertEquals(getEnvOrDefault("PATH", "fallback"), path);
  // The array reader splits on commas, not on the path separator — a
  // colon-separated PATH arrives as one entry, and that entry is the real
  // one, which is the point being made here.
  assertEquals(getEnvArrayOrDefault("PATH", ["fallback"]), path.split(","));
  // Absent from the process environment either way — the default lookup is
  // consulted and finds nothing.
  assertEquals(
    getEnvOrDefault("VIBE_ABSENT_PROBE_956", "fallback"),
    "fallback",
  );
  assertEquals(getEnvNumberOrDefault("VIBE_ABSENT_PROBE_956", 7), 7);
  assertEquals(readNonNegativeNumberEnv("VIBE_ABSENT_PROBE_956"), undefined);
});

Deno.test("config - an injected lookup replaces the process environment (Issue #956)", () => {
  // Every reader must answer from the map alone. If any of them still
  // consulted `Deno.env`, `PATH` would come back as the real one.
  const env = envFrom({ PATH: "/injected/only", VIBE_ONLY_956: "12" });

  assertEquals(getEnvOrDefault("PATH", "fallback", env), "/injected/only");
  assertEquals(
    getEnvArrayOrDefault("PATH", ["fallback"], env),
    ["/injected/only"],
  );
  assertEquals(getEnvNumberOrDefault("VIBE_ONLY_956", 0, env), 12);
  assertEquals(readNonNegativeNumberEnv("VIBE_ONLY_956", env), 12);

  // And a name the map does not carry reads as absent even when the process
  // has it — HOME is set on every host the suite runs on.
  assertEquals(getEnvOrDefault("HOME", "fallback", env), "fallback");
});

Deno.test("config - readNonNegativeNumberEnv rejects blanks and negatives through the seam (Issue #956)", () => {
  assertEquals(readNonNegativeNumberEnv("V", envFrom({ V: "0" })), 0);
  assertEquals(readNonNegativeNumberEnv("V", envFrom({ V: "  " })), undefined);
  assertEquals(readNonNegativeNumberEnv("V", envFrom({ V: "-1" })), undefined);
  assertEquals(
    readNonNegativeNumberEnv("V", envFrom({ V: "soon" })),
    undefined,
  );
  assertEquals(readNonNegativeNumberEnv("V", emptyEnv), undefined);
});

Deno.test("config - loadConfig reads its overrides through the injected lookup (Issue #956)", async () => {
  // TRUSTED_REVIEW_BOTS, FLEET_PR_AUTHORS, MIN_CLAIM_RUNWAY_SECONDS and HOME
  // are the four variables `loadConfig` still consults. None of them is set
  // in this process, so a reader that ignored the injected lookup would
  // return the built-in defaults here instead of these values.
  await withTempConfig({
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  }, async (configPath) => {
    const config = await loadConfig(configPath, {
      env: envFrom({
        TRUSTED_REVIEW_BOTS: "seam-bot[bot]",
        FLEET_PR_AUTHORS: "sibling-a, sibling-b",
        MIN_CLAIM_RUNWAY_SECONDS: "1234",
        HOME: "/seam/home",
      }),
    });
    assertEquals(config.trustedReviewBots, ["seam-bot[bot]"]);
    assertEquals(config.fleetPrAuthors, ["sibling-a", "sibling-b"]);
    assertEquals(config.minClaimRunwaySeconds, 1234);
    assertEquals(config.workDir, "/seam/home/auto-issue-work");
  });
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

Deno.test("config - isAllowedAuthor is case-insensitive, as GitHub logins are (Issue #1066)", () => {
  // `allowedAuthors` is now the derived collaborator set, normalised to lower
  // case, while a login under test arrives in the account's own casing.
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["Alice"],
    allowedAuthor: "Alice",
  }) as WorkerConfig;

  assertEquals(isAllowedAuthor(config, "alice"), true);
  assertEquals(isAllowedAuthor(config, "Alice"), true);
  assertEquals(isAllowedAuthor(config, "mallory"), false);
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
    serviceAccounts: ["vibe-worker"],
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
    serviceAccounts: ["vibe-worker"],
    workDir: "/tmp/work",
  }) as WorkerConfig;

  // Should not throw
  validateConfig(config);
});

// =============================================================================
// The single trust source — collaborators minus the Vibe Coders (Issue #1066)
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

Deno.test("config - validateConfig no longer requires allowed_authors (Issue #1066)", () => {
  // Trust is derived from repository collaborators, so an empty local array
  // is the healthy state rather than a configuration error.
  validateConfig(buildDefaultWorkerConfig({
    allowedAuthors: [],
    allowedAuthor: "",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    serviceAccounts: ["vibe-worker"],
    workDir: "/tmp/work",
  }));
});

Deno.test("config - validateConfig throws when the fleet login set is empty (Issue #1066)", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    serviceAccounts: [],
    fleetPrAuthors: [],
    workDir: "/tmp/work",
  });

  assertThrows(() => validateConfig(config), Error, "fleet login set is empty");
});

Deno.test("config - validateConfig throws on a malformed exclusion_team (Issue #252)", () => {
  const config: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    serviceAccounts: ["vibe-worker"],
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
    serviceAccounts: ["vibe-worker"],
    exclusionTeam: "stSoftwareAU/vibe-workers",
    workDir: "/tmp/work",
  });

  const warnings = captureConsoleWarn(() => validateConfig(config));
  assertEquals(warnings, []);
});

Deno.test("config - loadConfig grants no trust from the local arrays (Issue #1066)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.allowedAuthors, []);
    assertEquals(config.exclusionTeam, undefined);
  });
});

Deno.test("config - loadConfig loads exclusion_team as an additional exclusion (Issue #252)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: [],
    repos: ["org/repo"],
    service_accounts: ["vibe-worker"],
    exclusion_team: "stSoftwareAU/vibe-workers",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath, { validate: true });
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

Deno.test("config - loadConfig warns that local logins no longer grant trust (Issue #1066)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["alice"],
    authorized_commenters: ["bob[bot]"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const captured: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      await loadConfig(configPath);
    } finally {
      console.warn = original;
    }

    const combined = captured.join("\n");
    assertStringIncludes(combined, "allowed_authors");
    assertStringIncludes(combined, "alice");
  });
});

// =============================================================================
// loadConfig allowed_authors array (Issue #218)
// =============================================================================

Deno.test("config - allowed_authors seeds only the default PR reviewer (Issue #1066)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["user1", "user2", "user3"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    // The array grants no trust — the derived set fills this each cycle.
    assertEquals(config.allowedAuthors, []);
    // Its first entry survives as the default reviewer/assignee only.
    assertEquals(config.allowedAuthor, "user1");
    assertEquals(config.prReviewer, "user1");
  });
});

Deno.test("config - allowed_authors still seeds the legacy allowedAuthor field", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["legacy-user"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    // Issue #1066: the array grants no trust.
    assertEquals(config.allowedAuthors, []);
    assertEquals(config.allowedAuthor, "legacy-user");
  });
});

Deno.test("config - loadConfig uses config file allowed_authors, ignores env (Issue #266)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["config-user"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath, {
      env: envFrom({ ALLOWED_AUTHORS: "env-user1,env-user2" }),
    });
    // Config file value should be used, NOT env var (Issue #266). Issue
    // #1066: neither grants trust — the reviewer seed is what survives.
    assertEquals(config.allowedAuthors, []);
    assertEquals(config.allowedAuthor, "config-user");
  });
});

Deno.test("config - loadConfig defaults authorisedCommenters to the known bots (Issue #1066)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    // Axis 2 is a *known* list. A human no longer needs to be on it: write
    // access to a monitored repo already carries input trust.
    assertEquals(config.authorisedCommenters, [
      "github-copilot[bot]",
      "github-actions[bot]",
    ]);
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

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath, {
      env: envFrom({ CLAUDE_MODEL: "claude-opus-4-7" }),
    });
    // Config file value should be used, NOT env var (Issue #266)
    assertEquals(config.claudeModel, "claude-sonnet-4-7");
  });
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
    assertEquals(config.allowedAuthor, "testuser");
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
