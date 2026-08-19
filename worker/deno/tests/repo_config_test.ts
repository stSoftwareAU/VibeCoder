/**
 * Tests for repo_config module (Issue #964).
 *
 * Covers per-repo configuration queries, quality instruction building,
 * reviewer flag generation, default branch fetching, and pre-setup
 * command execution.
 *
 * TDD: These tests define expected behaviour before implementation.
 */

import { assertEquals, assertThrows } from "@std/assert";
import type { RepoConfig } from "../types.ts";
import {
  buildQualityInstructions,
  buildReviewerFlags,
  buildReviewerFlagsForRepo,
  ciProviderFromPrFailureAction,
  getCiProviders,
  getCustomInstructions,
  getPrFailureActions,
  getRepoConfig,
  getRepoNice,
  parseCiProviders,
  parsePrFailureActions,
  runPreSetupCommand,
} from "../lib/repo_config.ts";
import { DEFAULT_REPO_NICE } from "../lib/config_defaults.ts";

// =============================================================================
// Test data
// =============================================================================

function createRepoConfigMap(): Record<string, RepoConfig> {
  return {
    "org/repo-a": {
      customInstructions: "Use Australian English",
      skipQualityCheck: true,
      qualityCommand: "make check",
      preSetupCommand: "npm install",
      skipReviewerRequest: true,
    },
    "org/repo-b": {
      qualityCommand: "yarn test",
    },
    "org/repo-c": {},
  };
}

// =============================================================================
// getRepoConfig tests
// =============================================================================

Deno.test("repo_config - getRepoConfig returns value for existing repo and key", () => {
  const repoConfigs = createRepoConfigMap();
  const result = getRepoConfig(repoConfigs, "org/repo-a", "customInstructions");
  assertEquals(result, "Use Australian English");
});

Deno.test("repo_config - getRepoConfig returns boolean value as string", () => {
  const repoConfigs = createRepoConfigMap();
  const result = getRepoConfig(repoConfigs, "org/repo-a", "skipQualityCheck");
  assertEquals(result, "true");
});

Deno.test("repo_config - getRepoConfig returns empty string for missing key", () => {
  const repoConfigs = createRepoConfigMap();
  const result = getRepoConfig(repoConfigs, "org/repo-c", "customInstructions");
  assertEquals(result, "");
});

Deno.test("repo_config - getRepoConfig returns empty string for missing repo", () => {
  const repoConfigs = createRepoConfigMap();
  const result = getRepoConfig(
    repoConfigs,
    "org/nonexistent",
    "customInstructions",
  );
  assertEquals(result, "");
});

Deno.test("repo_config - getRepoConfig returns empty string when repoConfigs is undefined", () => {
  const result = getRepoConfig(undefined, "org/repo-a", "customInstructions");
  assertEquals(result, "");
});

Deno.test("repo_config - getRepoConfig returns empty string when repoConfigs is empty", () => {
  const result = getRepoConfig({}, "org/repo-a", "customInstructions");
  assertEquals(result, "");
});

// =============================================================================
// getRepoNice tests (Issue #2772)
// =============================================================================

Deno.test("repo_config - getRepoNice returns configured integer nice", () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "org/repo-a": { nice: -5 },
    "org/repo-b": { nice: 10 },
  };
  assertEquals(getRepoNice(repoConfigs, "org/repo-a"), -5);
  assertEquals(getRepoNice(repoConfigs, "org/repo-b"), 10);
});

Deno.test("repo_config - getRepoNice returns zero for a configured nice of 0", () => {
  const repoConfigs: Record<string, RepoConfig> = { "org/repo-a": { nice: 0 } };
  assertEquals(getRepoNice(repoConfigs, "org/repo-a"), 0);
});

Deno.test("repo_config - getRepoNice returns default when repo has no nice field", () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "org/repo-a": { qualityCommand: "make check" },
  };
  assertEquals(getRepoNice(repoConfigs, "org/repo-a"), DEFAULT_REPO_NICE);
});

Deno.test("repo_config - getRepoNice returns default for an absent repo", () => {
  const repoConfigs: Record<string, RepoConfig> = { "org/repo-a": { nice: 3 } };
  assertEquals(getRepoNice(repoConfigs, "org/missing"), DEFAULT_REPO_NICE);
});

Deno.test("repo_config - getRepoNice returns default when repo_config map is missing", () => {
  assertEquals(getRepoNice(undefined, "org/repo-a"), DEFAULT_REPO_NICE);
  assertEquals(getRepoNice({}, "org/repo-a"), DEFAULT_REPO_NICE);
});

Deno.test("repo_config - getRepoNice guards non-integer numeric values down to default", () => {
  const repoConfigs = {
    "org/repo-a": { nice: 1.5 },
  } as unknown as Record<string, RepoConfig>;
  assertEquals(getRepoNice(repoConfigs, "org/repo-a"), DEFAULT_REPO_NICE);
});

Deno.test("repo_config - getRepoNice guards non-finite values down to default", () => {
  const repoConfigs = {
    "org/inf": { nice: Infinity },
    "org/nan": { nice: NaN },
  } as unknown as Record<string, RepoConfig>;
  assertEquals(getRepoNice(repoConfigs, "org/inf"), DEFAULT_REPO_NICE);
  assertEquals(getRepoNice(repoConfigs, "org/nan"), DEFAULT_REPO_NICE);
});

Deno.test("repo_config - getRepoNice guards wrong-type JSON values down to default", () => {
  const repoConfigs = {
    "org/str": { nice: "99" },
    "org/bool": { nice: true },
    "org/null": { nice: null },
    "org/arr": { nice: [1] },
  } as unknown as Record<string, RepoConfig>;
  assertEquals(getRepoNice(repoConfigs, "org/str"), DEFAULT_REPO_NICE);
  assertEquals(getRepoNice(repoConfigs, "org/bool"), DEFAULT_REPO_NICE);
  assertEquals(getRepoNice(repoConfigs, "org/null"), DEFAULT_REPO_NICE);
  assertEquals(getRepoNice(repoConfigs, "org/arr"), DEFAULT_REPO_NICE);
});

// =============================================================================
// getCustomInstructions tests
// =============================================================================

Deno.test("repo_config - getCustomInstructions returns instructions for configured repo", () => {
  const repoConfigs = createRepoConfigMap();
  const result = getCustomInstructions(repoConfigs, "org/repo-a");
  assertEquals(result, "Use Australian English");
});

Deno.test("repo_config - getCustomInstructions returns empty string for repo without instructions", () => {
  const repoConfigs = createRepoConfigMap();
  const result = getCustomInstructions(repoConfigs, "org/repo-c");
  assertEquals(result, "");
});

Deno.test("repo_config - getCustomInstructions returns empty string for unconfigured repo", () => {
  const repoConfigs = createRepoConfigMap();
  const result = getCustomInstructions(repoConfigs, "org/unknown");
  assertEquals(result, "");
});

// =============================================================================
// buildQualityInstructions tests
// =============================================================================

Deno.test("repo_config - buildQualityInstructions returns skip message when skip_quality_check is true", () => {
  const repoConfigs = createRepoConfigMap();
  const result = buildQualityInstructions(repoConfigs, "org/repo-a");
  assertEquals(result, "Note: Quality checks are skipped for this repository.");
});

Deno.test("repo_config - buildQualityInstructions uses custom quality command", () => {
  const repoConfigs = createRepoConfigMap();
  const result = buildQualityInstructions(repoConfigs, "org/repo-b");
  assertEquals(result.includes("yarn test"), true);
  assertEquals(result.includes("< /dev/null"), true);
});

Deno.test("repo_config - buildQualityInstructions uses default quality.sh for unconfigured repo", () => {
  const repoConfigs = createRepoConfigMap();
  const result = buildQualityInstructions(repoConfigs, "org/repo-c");
  assertEquals(result.includes("./quality.sh"), true);
  assertEquals(result.includes("< /dev/null"), true);
});

Deno.test("repo_config - buildQualityInstructions uses default quality.sh when repoConfigs is undefined", () => {
  const result = buildQualityInstructions(undefined, "org/any-repo");
  assertEquals(result.includes("./quality.sh"), true);
});

// =============================================================================
// buildReviewerFlags tests
// =============================================================================

Deno.test("repo_config - buildReviewerFlags returns comma-separated list", () => {
  const result = buildReviewerFlags(["alice", "bob", "charlie"]);
  assertEquals(result, "alice,bob,charlie");
});

Deno.test("repo_config - buildReviewerFlags returns single reviewer", () => {
  const result = buildReviewerFlags(["alice"]);
  assertEquals(result, "alice");
});

Deno.test("repo_config - buildReviewerFlags returns empty string for empty array", () => {
  const result = buildReviewerFlags([]);
  assertEquals(result, "");
});

Deno.test("repo_config - buildReviewerFlags skips empty strings in array", () => {
  const result = buildReviewerFlags(["alice", "", "bob"]);
  assertEquals(result, "alice,bob");
});

// =============================================================================
// buildReviewerFlagsForRepo tests
// =============================================================================

Deno.test("repo_config - buildReviewerFlagsForRepo returns empty when skip_reviewer_request is true", () => {
  const repoConfigs = createRepoConfigMap();
  const result = buildReviewerFlagsForRepo(repoConfigs, "org/repo-a", [
    "alice",
    "bob",
  ]);
  assertEquals(result, "");
});

Deno.test("repo_config - buildReviewerFlagsForRepo returns reviewers when skip not set", () => {
  const repoConfigs = createRepoConfigMap();
  const result = buildReviewerFlagsForRepo(repoConfigs, "org/repo-b", [
    "alice",
    "bob",
  ]);
  assertEquals(result, "alice,bob");
});

Deno.test("repo_config - buildReviewerFlagsForRepo returns reviewers for unconfigured repo", () => {
  const repoConfigs = createRepoConfigMap();
  const result = buildReviewerFlagsForRepo(repoConfigs, "org/unknown", [
    "alice",
  ]);
  assertEquals(result, "alice");
});

Deno.test("repo_config - buildReviewerFlagsForRepo returns reviewers when repoConfigs is undefined", () => {
  const result = buildReviewerFlagsForRepo(undefined, "org/any", ["alice"]);
  assertEquals(result, "alice");
});

// =============================================================================
// runPreSetupCommand tests
// =============================================================================

Deno.test("repo_config - runPreSetupCommand returns no_command when no command configured", async () => {
  const repoConfigs = createRepoConfigMap();
  // org/repo-c has no preSetupCommand
  const result = await runPreSetupCommand("org/repo-c", "/tmp", repoConfigs);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "no_command");
  }
});

Deno.test("repo_config - runPreSetupCommand returns no_command when repoConfigs is undefined", async () => {
  const result = await runPreSetupCommand("org/any", "/tmp", undefined);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "no_command");
  }
});

Deno.test("repo_config - runPreSetupCommand succeeds with a simple command", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repoConfigs: Record<string, RepoConfig> = {
      "org/test-repo": {
        preSetupCommand: "echo hello",
      },
    };
    const result = await runPreSetupCommand(
      "org/test-repo",
      tmpDir,
      repoConfigs,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "completed");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("repo_config - runPreSetupCommand returns error for failing command", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repoConfigs: Record<string, RepoConfig> = {
      "org/test-repo": {
        preSetupCommand: "exit 42",
      },
    };
    const result = await runPreSetupCommand(
      "org/test-repo",
      tmpDir,
      repoConfigs,
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.message.includes("exit code"), true);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("repo_config - runPreSetupCommand times out for long-running command", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repoConfigs: Record<string, RepoConfig> = {
      "org/test-repo": {
        preSetupCommand: "sleep 60",
      },
    };
    // Use a very short timeout (1 second) to trigger timeout quickly
    const result = await runPreSetupCommand(
      "org/test-repo",
      tmpDir,
      repoConfigs,
      1,
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.message.includes("timed out"), true);
      assertEquals(result.error.message.includes("1 seconds"), true);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("repo_config - runPreSetupCommand returns error for invalid repo path", async () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "org/test-repo": {
      preSetupCommand: "echo hello",
    },
  };
  const result = await runPreSetupCommand(
    "org/test-repo",
    "/nonexistent/path/that/does/not/exist",
    repoConfigs,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("failed"), true);
  }
});

Deno.test("repo_config - runPreSetupCommand passes REPO_PATH and REPO_NAME env vars", async () => {
  const tmpDir = await Deno.makeTempDir();
  const markerFile = `${tmpDir}/env_check.txt`;
  try {
    const repoConfigs: Record<string, RepoConfig> = {
      "org/test-repo": {
        preSetupCommand: `echo "$REPO_NAME|$REPO_PATH" > env_check.txt`,
      },
    };
    const result = await runPreSetupCommand(
      "org/test-repo",
      tmpDir,
      repoConfigs,
    );
    assertEquals(result.ok, true);
    const content = await Deno.readTextFile(markerFile);
    assertEquals(content.trim(), `org/test-repo|${tmpDir}`);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// parsePrFailureActions / getPrFailureActions tests (Issue #1890)
// =============================================================================

Deno.test("repo_config - parsePrFailureActions returns empty array for undefined", () => {
  const result = parsePrFailureActions(undefined);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, []);
});

Deno.test("repo_config - parsePrFailureActions returns empty array for null", () => {
  const result = parsePrFailureActions(null);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, []);
});

Deno.test("repo_config - parsePrFailureActions returns empty array for []", () => {
  const result = parsePrFailureActions([]);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, []);
});

Deno.test("repo_config - parsePrFailureActions parses a valid fetch-jenkins-log action", () => {
  const result = parsePrFailureActions([
    {
      type: "fetch-jenkins-log",
      jobPath: "example-org/private-repo-58/Develop",
    },
  ]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    const action = result.value[0];
    if (!action) throw new Error("expected one action");
    assertEquals(action.type, "fetch-jenkins-log");
    assertEquals(action.jobPath, "example-org/private-repo-58/Develop");
    assertEquals(action.checkNamePattern, undefined);
  }
});

Deno.test("repo_config - parsePrFailureActions preserves optional checkNamePattern", () => {
  const result = parsePrFailureActions([
    {
      type: "fetch-jenkins-log",
      jobPath: "org/job",
      checkNamePattern: "^Jenkins/.*",
    },
  ]);
  assertEquals(result.ok, true);
  if (result.ok) {
    const action = result.value[0];
    if (!action) throw new Error("expected one action");
    assertEquals(action.checkNamePattern, "^Jenkins/.*");
  }
});

Deno.test("repo_config - parsePrFailureActions rejects non-array input", () => {
  const result = parsePrFailureActions({ type: "fetch-jenkins-log" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("must be an array"), true);
  }
});

Deno.test("repo_config - parsePrFailureActions rejects unknown action type", () => {
  const result = parsePrFailureActions([
    { type: "fetch-circleci-log", jobPath: "x" },
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("fetch-circleci-log"), true);
    assertEquals(result.error.includes("not a known action"), true);
  }
});

Deno.test("repo_config - parsePrFailureActions rejects missing jobPath", () => {
  const result = parsePrFailureActions([{ type: "fetch-jenkins-log" }]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("jobPath is required"), true);
  }
});

Deno.test("repo_config - parsePrFailureActions rejects empty jobPath", () => {
  const result = parsePrFailureActions([
    { type: "fetch-jenkins-log", jobPath: "" },
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("jobPath is required"), true);
  }
});

Deno.test("repo_config - parsePrFailureActions rejects malformed regex in checkNamePattern", () => {
  const result = parsePrFailureActions([
    {
      type: "fetch-jenkins-log",
      jobPath: "org/job",
      checkNamePattern: "[unterminated",
    },
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("not a valid regex"), true);
  }
});

Deno.test("repo_config - parsePrFailureActions rejects non-object entry", () => {
  const result = parsePrFailureActions(["not-an-object"]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("must be an object"), true);
  }
});

Deno.test("repo_config - parsePrFailureActions rejects non-string type", () => {
  const result = parsePrFailureActions([{ type: 42, jobPath: "x" }]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("type must be a string"), true);
  }
});

Deno.test("repo_config - parsePrFailureActions rejects non-string checkNamePattern", () => {
  const result = parsePrFailureActions([
    { type: "fetch-jenkins-log", jobPath: "x", checkNamePattern: 7 },
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes("checkNamePattern must be a string"),
      true,
    );
  }
});

Deno.test("repo_config - getPrFailureActions returns [] when repoConfigs is undefined", () => {
  assertEquals(getPrFailureActions(undefined, "org/any"), []);
});

Deno.test("repo_config - getPrFailureActions returns [] when repo not configured", () => {
  assertEquals(getPrFailureActions({}, "org/missing"), []);
});

Deno.test("repo_config - getPrFailureActions returns [] when field absent", () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "org/r": { customInstructions: "x" },
  };
  assertEquals(getPrFailureActions(repoConfigs, "org/r"), []);
});

Deno.test("repo_config - getPrFailureActions returns parsed list", () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "org/r": {
      prFailureActions: [
        { type: "fetch-jenkins-log", jobPath: "org/job/Develop" },
      ],
    },
  };
  const actions = getPrFailureActions(repoConfigs, "org/r");
  assertEquals(actions.length, 1);
  const action = actions[0];
  if (!action) throw new Error("expected one action");
  assertEquals(action.type, "fetch-jenkins-log");
  assertEquals(action.jobPath, "org/job/Develop");
});

Deno.test("repo_config - getPrFailureActions throws on malformed config", () => {
  // Bypass the typed interface to inject a malformed value (as would
  // arrive from .config.json before validation).
  const repoConfigs = {
    "org/r": {
      prFailureActions: [{ type: "fetch-unknown" }],
    },
  } as unknown as Record<string, RepoConfig>;
  assertThrows(
    () => getPrFailureActions(repoConfigs, "org/r"),
    Error,
    "Invalid prFailureActions",
  );
});

// =============================================================================
// parseCiProviders / getCiProviders tests (Issue #3579)
// =============================================================================

Deno.test("repo_config - parseCiProviders returns empty array for undefined", () => {
  const result = parseCiProviders(undefined);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, []);
});

Deno.test("repo_config - parseCiProviders parses a jenkins entry", () => {
  const result = parseCiProviders([
    {
      provider: "jenkins",
      jobPath: "org/job/Develop",
      checkNamePattern: "ST-pipeline",
    },
  ]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, [
      {
        provider: "jenkins",
        checkNamePattern: "ST-pipeline",
        jobPath: "org/job/Develop",
      },
    ]);
  }
});

Deno.test("repo_config - parseCiProviders accepts a provider with no options", () => {
  const result = parseCiProviders([{ provider: "github-actions" }]);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, [{ provider: "github-actions" }]);
});

Deno.test("repo_config - parseCiProviders rejects non-array input", () => {
  const result = parseCiProviders({ provider: "jenkins" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error, "ciProviders must be an array");
});

Deno.test("repo_config - parseCiProviders rejects a non-object entry", () => {
  const result = parseCiProviders(["jenkins"]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes("ciProviders[0] must be an object"),
      true,
    );
  }
});

Deno.test("repo_config - parseCiProviders rejects a missing provider field", () => {
  const result = parseCiProviders([{ jobPath: "x" }]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes(
        "ciProviders[0].provider must be a non-empty string",
      ),
      true,
    );
  }
});

Deno.test("repo_config - parseCiProviders rejects a non-string jobPath", () => {
  const result = parseCiProviders([{ provider: "jenkins", jobPath: 7 }]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes("ciProviders[0].jobPath must be a string"),
      true,
    );
  }
});

Deno.test("repo_config - parseCiProviders requires jobPath for jenkins", () => {
  const result = parseCiProviders([{ provider: "jenkins" }]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes("ciProviders[0].jobPath is required"),
      true,
    );
  }
});

Deno.test("repo_config - parseCiProviders rejects a malformed checkNamePattern", () => {
  const result = parseCiProviders([
    { provider: "github-actions", checkNamePattern: "([" },
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes("ciProviders[0].invalid checkNamePattern"),
      true,
    );
  }
});

Deno.test("repo_config - parseCiProviders rejects an unsafe checkNamePattern", () => {
  const result = parseCiProviders([
    { provider: "github-actions", checkNamePattern: "(a+)+" },
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("nested quantifiers"), true);
  }
});

Deno.test("repo_config - ciProviderFromPrFailureAction converts a legacy action", () => {
  assertEquals(
    ciProviderFromPrFailureAction({
      type: "fetch-jenkins-log",
      jobPath: "org/job/Develop",
      checkNamePattern: "Jenkins",
    }),
    {
      provider: "jenkins",
      jobPath: "org/job/Develop",
      checkNamePattern: "Jenkins",
    },
  );
});

Deno.test("repo_config - getCiProviders includes converted legacy prFailureActions", () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "org/r": {
      prFailureActions: [
        { type: "fetch-jenkins-log", jobPath: "org/job/Develop" },
      ],
    },
  };
  assertEquals(getCiProviders(repoConfigs, "org/r"), [
    { provider: "jenkins", jobPath: "org/job/Develop" },
  ]);
});

Deno.test("repo_config - getCiProviders lists ciProviders ahead of legacy entries", () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "org/r": {
      ciProviders: [{ provider: "github-actions" }],
      prFailureActions: [
        { type: "fetch-jenkins-log", jobPath: "org/job/Develop" },
      ],
    },
  };
  assertEquals(getCiProviders(repoConfigs, "org/r"), [
    { provider: "github-actions" },
    { provider: "jenkins", jobPath: "org/job/Develop" },
  ]);
});

Deno.test("repo_config - getCiProviders returns [] when nothing is configured", () => {
  assertEquals(getCiProviders(undefined, "org/any"), []);
  assertEquals(getCiProviders({}, "org/missing"), []);
  assertEquals(
    getCiProviders({ "org/r": { customInstructions: "x" } }, "org/r"),
    [],
  );
});

Deno.test("repo_config - getCiProviders throws on malformed config", () => {
  const repoConfigs = {
    "org/r": { ciProviders: [{ provider: "jenkins" }] },
  } as unknown as Record<string, RepoConfig>;
  assertThrows(
    () => getCiProviders(repoConfigs, "org/r"),
    Error,
    "Invalid ciProviders",
  );
});
