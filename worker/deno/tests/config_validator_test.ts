/**
 * Tests for config_validator.ts — configuration validation module.
 *
 * Migrated from config_validator.sh BATS tests (Issue #904).
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  isRepoAllowed,
  validateConfigFull,
  validateGitHubAppConfig,
  validateGitUrl,
  validateLabelFormat,
  validateRepoFormat,
  validateRequiredFields,
  validateUsernameFormat,
  warnInsecureConfig,
} from "../lib/config_validator.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

// =============================================================================
// validateRepoFormat tests
// =============================================================================

Deno.test("config_validator - validateRepoFormat accepts valid owner/repo", () => {
  assertEquals(validateRepoFormat("owner/repo"), true);
  assertEquals(validateRepoFormat("my-org/my-repo"), true);
  assertEquals(validateRepoFormat("org_name/repo.name"), true);
  assertEquals(validateRepoFormat("a/b"), true);
  assertEquals(validateRepoFormat("stSoftwareAU/VibeCoder"), true);
});

Deno.test("config_validator - validateRepoFormat rejects invalid formats", () => {
  assertEquals(validateRepoFormat(""), false);
  assertEquals(validateRepoFormat("noslash"), false);
  assertEquals(validateRepoFormat("too/many/slashes"), false);
  assertEquals(validateRepoFormat("/leading-slash"), false);
  assertEquals(validateRepoFormat("trailing-slash/"), false);
  assertEquals(validateRepoFormat("has spaces/repo"), false);
  assertEquals(validateRepoFormat("owner/has spaces"), false);
});

// =============================================================================
// validateUsernameFormat tests
// =============================================================================

Deno.test("config_validator - validateUsernameFormat accepts valid usernames", () => {
  assertEquals(validateUsernameFormat("alice"), true);
  assertEquals(validateUsernameFormat("bob-smith"), true);
  assertEquals(validateUsernameFormat("user_123"), true);
  assertEquals(validateUsernameFormat("github-copilot[bot]"), true);
  assertEquals(validateUsernameFormat("A"), true);
});

Deno.test("config_validator - validateUsernameFormat rejects invalid usernames", () => {
  assertEquals(validateUsernameFormat(""), false);
  assertEquals(validateUsernameFormat("has spaces"), false);
  assertEquals(validateUsernameFormat("has@symbol"), false);
  assertEquals(validateUsernameFormat("user!name"), false);
  assertEquals(validateUsernameFormat("user;name"), false);
  assertEquals(validateUsernameFormat("$(whoami)"), false);
});

// =============================================================================
// validateLabelFormat tests
// =============================================================================

Deno.test("config_validator - validateLabelFormat accepts valid labels", () => {
  assertEquals(validateLabelFormat("work-on"), true);
  assertEquals(validateLabelFormat("idle-task"), true);
  assertEquals(validateLabelFormat("type:bug"), true);
  assertEquals(validateLabelFormat("area/frontend"), true);
  assertEquals(validateLabelFormat("priority.high"), true);
  assertEquals(validateLabelFormat("v1,v2"), true);
});

Deno.test("config_validator - validateLabelFormat rejects dangerous characters", () => {
  assertEquals(validateLabelFormat(""), false);
  assertEquals(validateLabelFormat("label`cmd`"), false);
  assertEquals(validateLabelFormat("label$(cmd)"), false);
  assertEquals(validateLabelFormat("label;cmd"), false);
  assertEquals(validateLabelFormat("label|pipe"), false);
  assertEquals(validateLabelFormat("label&bg"), false);
  assertEquals(validateLabelFormat("label>file"), false);
  assertEquals(validateLabelFormat("label<file"), false);
  assertEquals(validateLabelFormat("label{brace}"), false);
});

// =============================================================================
// validateRequiredFields tests
// =============================================================================

Deno.test("config_validator - validateRequiredFields reports missing authors", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: [],
    allowedAuthor: "",
    repos: ["org/repo"],
    issueLabels: ["work-on"],
  }) as WorkerConfig;

  const errors = validateRequiredFields(config);
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.includes("ALLOWED_AUTHORS"), true);
});

Deno.test("config_validator - validateRequiredFields reports missing repos", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["user"],
    repos: [],
    issueLabels: ["work-on"],
  }) as WorkerConfig;

  const errors = validateRequiredFields(config);
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.includes("REPOS"), true);
});

Deno.test("config_validator - validateRequiredFields reports missing labels", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["user"],
    repos: ["org/repo"],
    issueLabels: [],
  }) as WorkerConfig;

  const errors = validateRequiredFields(config);
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.includes("ISSUE_LABELS"), true);
});

Deno.test("config_validator - validateRequiredFields passes with all fields present", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["user"],
    repos: ["org/repo"],
    issueLabels: ["work-on"],
  }) as WorkerConfig;

  const errors = validateRequiredFields(config);
  assertEquals(errors.length, 0);
});

// =============================================================================
// warnInsecureConfig tests
// =============================================================================

Deno.test("config_validator - warnInsecureConfig warns about generic usernames", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["admin"],
    prReviewers: [],
  }) as WorkerConfig;

  const warnings = warnInsecureConfig(config);
  assertEquals(warnings.some((w) => w.includes("generic")), true);
});

Deno.test("config_validator - warnInsecureConfig warns about permissive lists", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["u1", "u2", "u3", "u4", "u5", "u6"],
    prReviewers: [],
  }) as WorkerConfig;

  const warnings = warnInsecureConfig(config);
  assertEquals(warnings.some((w) => w.includes("permissive")), true);
});

Deno.test("config_validator - warnInsecureConfig warns about missing PR reviewer", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["user"],
    prReviewer: "",
    prReviewers: [],
  }) as WorkerConfig;

  const warnings = warnInsecureConfig(config);
  assertEquals(warnings.some((w) => w.includes("PR_REVIEWER")), true);
});

// =============================================================================
// validateConfigFull tests
// =============================================================================

Deno.test("config_validator - validateConfigFull passes for valid config", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    prReviewers: ["reviewer"],
    repos: ["org/repo"],
    issueLabels: ["work-on", "low-priority"],
    authorisedCommenters: ["testuser"],
  }) as WorkerConfig;

  const result = validateConfigFull(config);
  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
});

Deno.test("config_validator - validateConfigFull rejects invalid repo format", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    repos: ["not-a-valid-repo"],
    issueLabels: ["work-on"],
  }) as WorkerConfig;

  const result = validateConfigFull(config);
  assertEquals(result.valid, false);
  assertEquals(result.errors.some((e) => e.includes("owner/repo")), true);
});

Deno.test("config_validator - validateConfigFull rejects invalid username", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["invalid user!"],
    repos: ["org/repo"],
    issueLabels: ["work-on"],
  }) as WorkerConfig;

  const result = validateConfigFull(config);
  assertEquals(result.valid, false);
  assertEquals(result.errors.some((e) => e.includes("username format")), true);
});

Deno.test("config_validator - validateConfigFull rejects invalid label", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    repos: ["org/repo"],
    issueLabels: ["label$(cmd)"],
  }) as WorkerConfig;

  const result = validateConfigFull(config);
  assertEquals(result.valid, false);
  assertEquals(result.errors.some((e) => e.includes("label format")), true);
});

Deno.test("config_validator - validateConfigFull accepts bot account usernames", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["github-copilot[bot]"],
    repos: ["org/repo"],
    issueLabels: ["work-on"],
    prReviewers: [],
  }) as WorkerConfig;

  const result = validateConfigFull(config);
  assertEquals(result.valid, true);
});

// =============================================================================
// isRepoAllowed tests
// =============================================================================

Deno.test("config_validator - isRepoAllowed returns true for allowed repo", () => {
  const repos = ["org/repo1", "org/repo2"];
  assertEquals(isRepoAllowed(repos, "org/repo1"), true);
  assertEquals(isRepoAllowed(repos, "org/repo2"), true);
});

Deno.test("config_validator - isRepoAllowed returns false for disallowed repo", () => {
  const repos = ["org/repo1"];
  assertEquals(isRepoAllowed(repos, "org/other"), false);
});

Deno.test("config_validator - isRepoAllowed returns false for empty repo", () => {
  assertEquals(isRepoAllowed(["org/repo"], ""), false);
});

Deno.test("config_validator - isRepoAllowed returns false for empty allowlist", () => {
  assertEquals(isRepoAllowed([], "org/repo"), false);
});

Deno.test("config_validator - isRepoAllowed uses exact match only", () => {
  const repos = ["org/repo"];
  assertEquals(isRepoAllowed(repos, "org/repo-extra"), false);
  assertEquals(isRepoAllowed(repos, "org/rep"), false);
  assertEquals(isRepoAllowed(repos, "ORG/REPO"), false);
});

// =============================================================================
// validateGitUrl tests
// =============================================================================

Deno.test("config_validator - validateGitUrl accepts valid HTTPS URL", () => {
  const result = validateGitUrl(
    "https://github.com/owner/repo.git",
    "owner/repo",
  );
  assertEquals(result.valid, true);
});

Deno.test("config_validator - validateGitUrl accepts HTTPS URL without .git", () => {
  const result = validateGitUrl(
    "https://github.com/owner/repo",
    "owner/repo",
  );
  assertEquals(result.valid, true);
});

Deno.test("config_validator - validateGitUrl accepts valid SSH URL", () => {
  const result = validateGitUrl(
    "git@github.com:owner/repo.git",
    "owner/repo",
  );
  assertEquals(result.valid, true);
});

Deno.test("config_validator - validateGitUrl rejects empty URL", () => {
  const result = validateGitUrl("", "owner/repo");
  assertEquals(result.valid, false);
  assertEquals(result.reason, "empty_url");
});

Deno.test("config_validator - validateGitUrl rejects newline injection", () => {
  const result = validateGitUrl(
    "https://github.com/owner/repo\n--upload-pack=evil",
    "owner/repo",
  );
  assertEquals(result.valid, false);
  assertEquals(result.reason, "newline_injection");
});

Deno.test("config_validator - validateGitUrl rejects path traversal", () => {
  const result = validateGitUrl(
    "https://github.com/owner/../evil/repo",
    "evil/repo",
  );
  assertEquals(result.valid, false);
  assertEquals(result.reason, "path_traversal");
});

Deno.test("config_validator - validateGitUrl rejects embedded credentials", () => {
  const result = validateGitUrl(
    "https://user:pass@github.com/owner/repo",
    "owner/repo",
  );
  assertEquals(result.valid, false);
  assertEquals(result.reason, "embedded_credentials");
});

Deno.test("config_validator - validateGitUrl rejects query parameters", () => {
  const result = validateGitUrl(
    "https://github.com/owner/repo?ref=evil",
    "owner/repo",
  );
  assertEquals(result.valid, false);
  assertEquals(result.reason, "query_parameters");
});

Deno.test("config_validator - validateGitUrl rejects non-GitHub hosts", () => {
  const result = validateGitUrl(
    "https://gitlab.com/owner/repo",
    "owner/repo",
  );
  assertEquals(result.valid, false);
  assertEquals(result.reason, "unrecognised_format_or_non_github_host");
});

Deno.test("config_validator - validateGitUrl rejects repo mismatch", () => {
  const result = validateGitUrl(
    "https://github.com/evil/repo.git",
    "owner/repo",
  );
  assertEquals(result.valid, false);
  assertEquals(result.reason, "repo_mismatch");
});

// =============================================================================
// validateGitHubAppConfig tests (Issue #957)
// =============================================================================

Deno.test("config_validator - validateGitHubAppConfig passes with no fields set", () => {
  const result = validateGitHubAppConfig({});
  assertEquals(result.errors.length, 0);
  assertEquals(result.warnings.length, 0);
});

Deno.test("config_validator - validateGitHubAppConfig warns on partial config (only app_id)", () => {
  const result = validateGitHubAppConfig({
    github_app_id: "12345",
  });
  assertEquals(result.errors.length, 0);
  assertEquals(result.warnings.length, 1);
  assertEquals(result.warnings[0]!.includes("partially set"), true);
  assertEquals(
    result.warnings[0]!.includes("github_app_installation_id"),
    true,
  );
  assertEquals(
    result.warnings[0]!.includes("github_app_private_key_path"),
    true,
  );
});

Deno.test("config_validator - validateGitHubAppConfig warns on partial config (two of three)", () => {
  const result = validateGitHubAppConfig({
    github_app_id: "12345",
    github_app_installation_id: "67890",
  });
  assertEquals(result.errors.length, 0);
  assertEquals(result.warnings.length, 1);
  assertEquals(
    result.warnings[0]!.includes("github_app_private_key_path"),
    true,
  );
});

Deno.test("config_validator - validateGitHubAppConfig passes with all three fields valid", () => {
  // Use a path that exists on disk to avoid the path warning
  const result = validateGitHubAppConfig({
    github_app_id: "12345",
    github_app_installation_id: "67890",
    github_app_private_key_path: "/dev/null",
  });
  assertEquals(result.errors.length, 0);
  assertEquals(result.warnings.length, 0);
});

Deno.test("config_validator - validateGitHubAppConfig errors on non-numeric app_id", () => {
  const result = validateGitHubAppConfig({
    github_app_id: "not-a-number",
    github_app_installation_id: "67890",
    github_app_private_key_path: "/dev/null",
  });
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0]!.includes("numeric"), true);
  assertEquals(result.errors[0]!.includes("github_app_id"), true);
});

Deno.test("config_validator - validateGitHubAppConfig errors on non-numeric installation_id", () => {
  const result = validateGitHubAppConfig({
    github_app_id: "12345",
    github_app_installation_id: "abc",
    github_app_private_key_path: "/dev/null",
  });
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0]!.includes("numeric"), true);
  assertEquals(result.errors[0]!.includes("github_app_installation_id"), true);
});

Deno.test("config_validator - validateGitHubAppConfig warns on missing private key file", () => {
  const result = validateGitHubAppConfig({
    github_app_id: "12345",
    github_app_installation_id: "67890",
    github_app_private_key_path: "/nonexistent/path/key.pem",
  });
  assertEquals(result.errors.length, 0);
  assertEquals(result.warnings.length, 1);
  assertEquals(result.warnings[0]!.includes("does not exist"), true);
});

Deno.test("config_validator - validateConfigFull includes GitHub App validation when rawFile provided", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    prReviewers: ["reviewer"],
    repos: ["org/repo"],
    issueLabels: ["work-on"],
    authorisedCommenters: ["testuser"],
  }) as WorkerConfig;

  const result = validateConfigFull(config, {
    github_app_id: "not-numeric",
    github_app_installation_id: "67890",
    github_app_private_key_path: "/dev/null",
  });
  assertEquals(result.valid, false);
  assertEquals(result.errors.some((e) => e.includes("github_app_id")), true);
});

// =============================================================================
// Orphan repo_config detection (Issue #4033)
// =============================================================================

Deno.test("config_validator - validateConfigFull warns on repo_config for an unmonitored repo", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    repos: ["org/repo"],
    issueLabels: ["work-on"],
    repoConfig: {
      "org/repo": {},
      "org/retired": {},
    },
  }) as WorkerConfig;

  const result = validateConfigFull(config);
  assertEquals(result.valid, true);
  assertEquals(
    result.warnings.some((w) =>
      w.includes("repo_config") && w.includes("org/retired")
    ),
    true,
  );
  // Exactly one orphan warning — the monitored repo is not reported.
  assertEquals(
    result.warnings.filter((w) => w.includes("repo_config")).length,
    1,
  );
});

Deno.test("config_validator - validateConfigFull matches repo_config keys case-insensitively", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    repos: ["ORG/Repo"],
    issueLabels: ["work-on"],
    repoConfig: { "org/repo": {} },
  }) as WorkerConfig;

  const result = validateConfigFull(config);
  assertEquals(result.warnings.some((w) => w.includes("repo_config")), false);
});

Deno.test("config_validator - validateConfigFull does not warn on repo_config when repos is empty", () => {
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    repos: [],
    issueLabels: ["work-on"],
    repoConfig: { "org/repo": {} },
  }) as WorkerConfig;

  const result = validateConfigFull(config);
  assertEquals(result.warnings.some((w) => w.includes("repo_config")), false);
});
