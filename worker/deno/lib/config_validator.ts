/**
 * Configuration validation for the Vibe Coder worker.
 *
 * Migrated from worker/shared/config_validator.sh (Issue #904).
 * Validates configuration values, repository formats, usernames, labels,
 * and provides security warnings for potentially insecure configurations.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import type { ConfigFile, WorkerConfig } from "../types.ts";

/**
 * Validation result with structured errors and warnings.
 */
export interface ConfigValidationResult {
  /** Whether validation passed (no errors) */
  valid: boolean;
  /** Validation errors (blocking) */
  errors: string[];
  /** Security warnings (non-blocking) */
  warnings: string[];
}

/**
 * Git URL validation result.
 */
export interface GitUrlValidationResult {
  valid: boolean;
  reason?: string;
}

// =============================================================================
// Format Validation Functions
// =============================================================================

/**
 * Validate repository name format.
 *
 * Repository names must match the pattern: owner/repo
 * where owner and repo can contain alphanumeric characters, hyphens,
 * underscores, and dots.
 *
 * @param repo - Repository name to validate (e.g., "owner/repo")
 * @returns true if valid
 */
export function validateRepoFormat(repo: string): boolean {
  if (!repo) return false;
  return /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repo);
}

/**
 * Validate GitHub username format.
 *
 * GitHub usernames can contain alphanumeric characters, hyphens,
 * and underscores. Bot accounts may have [bot] suffix.
 *
 * @param username - Username to validate
 * @returns true if valid
 */
export function validateUsernameFormat(username: string): boolean {
  if (!username) return false;
  return /^[a-zA-Z0-9_-]+(\[bot\])?$/.test(username);
}

/**
 * Validate GitHub label format.
 *
 * Labels can contain alphanumeric characters, spaces, hyphens, underscores,
 * colons, forward slashes, dots, and commas. Rejects characters that could
 * be used for shell injection.
 *
 * @param label - Label name to validate
 * @returns true if valid
 */
export function validateLabelFormat(label: string): boolean {
  if (!label) return false;

  // Reject dangerous shell metacharacters
  if (/[`$;|&><(){}]/.test(label)) return false;

  // Allow: alphanumeric, spaces, hyphens, underscores, colons, slashes, dots, commas
  return /^[a-zA-Z0-9 _:/.,-]+$/.test(label);
}

// =============================================================================
// Configuration Validation
// =============================================================================

/** Generic usernames that should raise a security warning. */
const GENERIC_NAMES = [
  "admin",
  "test",
  "user",
  "root",
  "guest",
  "default",
  "owner",
  "developer",
  "dev",
];

/**
 * Soft cap above which `trusted_review_bots` is considered unusually large
 * and worth a warning (Issue #1856).
 */
const TRUSTED_REVIEW_BOTS_WARN_THRESHOLD = 20;

/**
 * Allowlist of known bot-shaped names that do NOT carry the `[bot]`
 * suffix. Entries here are accepted in `trusted_review_bots` without
 * warning even though they don't look like a GitHub App bot account
 * (Issue #1856).
 */
const KNOWN_NON_SUFFIX_BOTS: ReadonlySet<string> = new Set([
  "dependabot",
  "renovate",
  "github-actions",
]);

/**
 * Warn about a `trusted_review_bots` configuration that is suspiciously
 * large or contains entries that don't look like bot accounts.
 *
 * Returns a list of human-readable warning strings (Issue #1856).
 */
export function warnTrustedReviewBots(bots: string[]): string[] {
  const warnings: string[] = [];

  if (bots.length > TRUSTED_REVIEW_BOTS_WARN_THRESHOLD) {
    warnings.push(
      `TRUSTED_REVIEW_BOTS has ${bots.length} entries — this is unusually large. ` +
        "Consider limiting to a small set of curated automated review tools",
    );
  }

  for (const bot of bots) {
    if (!bot) continue;
    const looksLikeBot = bot.endsWith("[bot]") ||
      KNOWN_NON_SUFFIX_BOTS.has(bot.toLowerCase());
    if (!looksLikeBot) {
      warnings.push(
        `TRUSTED_REVIEW_BOTS entry '${bot}' does not look like a bot account ` +
          "(no '[bot]' suffix and not in the known-bot allowlist). " +
          "Auto-trusting a human account bypasses the thumbs-up gate — " +
          "use authorized_commenters for human reviewers instead",
      );
    }
  }

  return warnings;
}

/**
 * Validate required fields in the configuration.
 *
 * @param config - Worker configuration
 * @returns Array of error messages (empty if valid)
 */
export function validateRequiredFields(config: WorkerConfig): string[] {
  const errors: string[] = [];

  if (config.allowedAuthors.length === 0 && !config.allowedAuthor) {
    errors.push(
      "ALLOWED_AUTHORS is not set or contains no authors. " +
        "Configure 'allowed_authors' array or 'allowed_author' string in .config.json",
    );
  }

  if (config.repos.length === 0) {
    errors.push("REPOS is not set or contains no repositories");
  }

  if (config.issueLabels.length === 0) {
    errors.push("ISSUE_LABELS is not set or contains no labels");
  }

  return errors;
}

/**
 * Generate security warnings for potentially insecure configurations.
 *
 * Checks for:
 * - Generic/common names in allowed authors
 * - Very permissive lists (more than 5 users)
 * - Missing PR reviewer
 *
 * @param config - Worker configuration
 * @returns Array of warning messages
 */
export function warnInsecureConfig(config: WorkerConfig): string[] {
  const warnings: string[] = [];

  // Check for generic usernames in allowed authors
  for (const author of config.allowedAuthors) {
    if (GENERIC_NAMES.includes(author.toLowerCase())) {
      warnings.push(
        `ALLOWED_AUTHORS contains '${author}' which is a generic/common name. ` +
          "Consider using actual GitHub usernames for better security",
      );
    }
  }

  // Check for very permissive allowed authors list
  if (config.allowedAuthors.length > 5) {
    warnings.push(
      `ALLOWED_AUTHORS has ${config.allowedAuthors.length} users — this is quite permissive. ` +
        "Consider limiting allowed authors to trusted users only",
    );
  }

  // Check for very permissive commenters list
  if (config.authorisedCommenters.length > 5) {
    warnings.push(
      `AUTHORIZED_COMMENTERS has ${config.authorisedCommenters.length} users — this is quite permissive. ` +
        "Consider limiting authorised commenters to trusted users only",
    );
  }

  // Check for very permissive PR reviewers list
  if (config.prReviewers.length > 5) {
    warnings.push(
      `PR_REVIEWERS has ${config.prReviewers.length} users — this is quite permissive. ` +
        "Consider limiting PR reviewers to trusted users only",
    );
  }

  // Trusted review bots — warn if list is unusually large or contains
  // entries that are not bot-shaped and not in a known-bot allowlist
  // (Issue #1856).
  warnings.push(...warnTrustedReviewBots(config.trustedReviewBots));

  // Warn if PR reviewer is not set
  if (!config.prReviewer && config.prReviewers.length === 0) {
    warnings.push(
      "PR_REVIEWER/PR_REVIEWERS is not set — PRs will not have an automatic reviewer assigned",
    );
  }

  return warnings;
}

// =============================================================================
// GitHub App Configuration Validation (Issue #957)
// =============================================================================

/**
 * Validate GitHub App configuration fields from the raw config file.
 *
 * Rules:
 * - If any GitHub App field is set, all three must be set (partial = warning)
 * - App ID and Installation ID must be numeric strings
 * - Private key path existence is checked (warning, not error)
 *
 * @param rawFile - Raw config file contents
 * @returns Object with errors and warnings arrays
 */
export function validateGitHubAppConfig(
  rawFile: ConfigFile,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const appId = rawFile.github_app_id;
  const installationId = rawFile.github_app_installation_id;
  const privateKeyPath = rawFile.github_app_private_key_path;

  const fields = [appId, installationId, privateKeyPath];
  const setCount = fields.filter((f) => f !== undefined && f !== "").length;

  // No fields set — nothing to validate
  if (setCount === 0) {
    return { errors, warnings };
  }

  // Partial configuration — warn
  if (setCount > 0 && setCount < 3) {
    const missing: string[] = [];
    if (!appId) missing.push("github_app_id");
    if (!installationId) missing.push("github_app_installation_id");
    if (!privateKeyPath) missing.push("github_app_private_key_path");
    warnings.push(
      `GitHub App configuration is partially set — missing: ${
        missing.join(", ")
      }. ` +
        "All three fields (github_app_id, github_app_installation_id, github_app_private_key_path) " +
        "must be set for GitHub App authentication to work",
    );
    return { errors, warnings };
  }

  // All three set — validate formats
  if (appId && !/^\d+$/.test(appId)) {
    errors.push(
      `github_app_id must be a numeric string, got '${appId}'`,
    );
  }

  if (installationId && !/^\d+$/.test(installationId)) {
    errors.push(
      `github_app_installation_id must be a numeric string, got '${installationId}'`,
    );
  }

  // Check private key path exists (warning, not error — path may be created later)
  if (privateKeyPath) {
    const expandedPath = privateKeyPath.replace(
      /^~/,
      Deno.env.get("HOME") ?? "",
    );
    try {
      Deno.statSync(expandedPath);
    } catch {
      warnings.push(
        `GitHub App private key path does not exist: '${expandedPath}'. ` +
          "Ensure the file is created before the worker starts",
      );
    }
  }

  return { errors, warnings };
}

/**
 * Warn about `repo_config` entries for repos that are not monitored
 * (Issue #4033).
 *
 * Such an entry is dead config — nothing reads it — and it silently misleads
 * anyone auditing which repos are configured. Matching is case-insensitive,
 * and no warning is raised when `repos` is empty (an unconfigured host).
 *
 * @param config - Worker configuration
 * @returns Non-blocking warnings, one per orphan entry
 */
function warnOrphanRepoConfig(config: WorkerConfig): string[] {
  const repoConfig = config.repoConfig;
  if (!repoConfig || config.repos.length === 0) return [];

  const monitored = new Set(config.repos.map((r) => r.toLowerCase()));
  return Object.keys(repoConfig)
    .filter((repo) => !monitored.has(repo.toLowerCase()))
    .map((repo) =>
      `repo_config contains an entry for '${repo}', which is not in repos. ` +
      "It is dead config and is never read — remove it or add the repo to repos"
    );
}

/**
 * Full configuration validation.
 *
 * Validates all configuration settings and returns structured results
 * including errors (blocking) and warnings (non-blocking).
 *
 * @param config - Worker configuration
 * @returns Validation result with errors and warnings
 */
export function validateConfigFull(
  config: WorkerConfig,
  rawFile?: ConfigFile,
): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Step 1: Validate required fields
  errors.push(...validateRequiredFields(config));

  // Step 1b: maxConcurrentIssues range (Issue #4174). Read the raw file value
  // so non-integers and strings are rejected before coercion; absent means
  // the default (1) applies and is fine.
  if (rawFile && rawFile.max_concurrent_issues !== undefined) {
    const v = rawFile.max_concurrent_issues as unknown;
    if (
      typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 8
    ) {
      errors.push(
        `Invalid max_concurrent_issues: ${JSON.stringify(v)}. ` +
          "It must be an integer between 1 and 8.",
      );
    }
  }

  // Step 2: Validate username formats for allowed authors
  for (const author of config.allowedAuthors) {
    if (!author) continue;
    if (!validateUsernameFormat(author)) {
      errors.push(
        `Invalid username format in ALLOWED_AUTHORS: '${author}'. ` +
          "Usernames must be alphanumeric with hyphens/underscores only",
      );
    }
  }

  // Step 3: Validate repository formats
  for (const repo of config.repos) {
    if (!validateRepoFormat(repo)) {
      errors.push(
        `Invalid repository format: '${repo}'. ` +
          "Repository names must be in 'owner/repo' format",
      );
    }
  }

  // Step 4: Validate label formats
  for (const label of config.issueLabels) {
    if (!validateLabelFormat(label)) {
      errors.push(
        `Invalid label format: '${label}'. ` +
          "Labels must not contain shell metacharacters",
      );
    }
  }

  // Step 5: Validate authorised commenters formats
  for (const commenter of config.authorisedCommenters) {
    if (!commenter) continue;
    if (!validateUsernameFormat(commenter)) {
      errors.push(
        `Invalid username format in AUTHORIZED_COMMENTERS: '${commenter}'`,
      );
    }
  }

  // Step 6: Validate PR reviewers formats
  for (const reviewer of config.prReviewers) {
    if (!reviewer) continue;
    if (!validateUsernameFormat(reviewer)) {
      errors.push(
        `Invalid username format in PR_REVIEWERS: '${reviewer}'. ` +
          "Usernames must be alphanumeric with hyphens/underscores only",
      );
    }
  }

  // Step 7: Security warnings (non-blocking)
  warnings.push(...warnInsecureConfig(config));

  // Step 8: orphan repo_config detection (Issue #4033) — dead per-repo config
  // is never read and misleads a config audit. Non-blocking.
  warnings.push(...warnOrphanRepoConfig(config));

  // Step 9: GitHub App configuration validation (Issue #957)
  if (rawFile) {
    const appValidation = validateGitHubAppConfig(rawFile);
    errors.push(...appValidation.errors);
    warnings.push(...appValidation.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// =============================================================================
// Repository Allowlist Validation
// =============================================================================

/**
 * Check if a repository is in the configured REPOS allowlist.
 *
 * Provides defence in depth by ensuring the worker only processes
 * repositories that have been explicitly configured.
 *
 * @param repos - Configured repository allowlist
 * @param repo - Repository name to check (e.g., "owner/repo")
 * @returns true if the repository is in the allowlist
 */
export function isRepoAllowed(repos: string[], repo: string): boolean {
  if (!repo) return false;
  if (repos.length === 0) return false;
  return repos.includes(repo);
}

// =============================================================================
// Git URL Validation
// =============================================================================

/**
 * Validate a git URL to ensure it matches the expected repository.
 *
 * Prevents:
 * - Path traversal attacks (../)
 * - URL manipulation to clone from unexpected hosts
 * - Credential injection in URLs
 * - Newline injection
 * - Query parameter injection
 *
 * Supported URL formats:
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - git@github.com:owner/repo.git
 *
 * @param url - The git URL to validate
 * @param expectedRepo - The expected repository in "owner/repo" format
 * @returns Validation result with reason if invalid
 */
export function validateGitUrl(
  url: string,
  expectedRepo: string,
): GitUrlValidationResult {
  // Reject empty URL
  if (!url) {
    return { valid: false, reason: "empty_url" };
  }

  // Reject URLs with newlines (injection attempt)
  if (url.includes("\n") || url.includes("\r")) {
    return { valid: false, reason: "newline_injection" };
  }

  // Reject URLs with path traversal sequences
  if (url.includes("..")) {
    return { valid: false, reason: "path_traversal" };
  }

  // Reject URLs with embedded credentials (user:pass@)
  if (/:\/\/[^/]*:[^/]*@/.test(url)) {
    return { valid: false, reason: "embedded_credentials" };
  }

  // Reject URLs with query parameters
  if (url.includes("?")) {
    return { valid: false, reason: "query_parameters" };
  }

  // Extract owner/repo from URL
  let extractedOwner = "";
  let extractedRepoName = "";

  // Handle HTTPS URLs: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = url.match(
    /^https:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/,
  );
  if (httpsMatch) {
    extractedOwner = httpsMatch[1]!;
    extractedRepoName = httpsMatch[2]!;
  } else {
    // Handle SSH URLs: git@github.com:owner/repo.git
    const sshMatch = url.match(
      /^git@github\.com:([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/,
    );
    if (sshMatch) {
      extractedOwner = sshMatch[1]!;
      extractedRepoName = sshMatch[2]!;
    } else {
      return {
        valid: false,
        reason: "unrecognised_format_or_non_github_host",
      };
    }
  }

  // Strip .git suffix if present
  if (extractedRepoName.endsWith(".git")) {
    extractedRepoName = extractedRepoName.slice(0, -4);
  }

  const extractedRepo = `${extractedOwner}/${extractedRepoName}`;

  // Validate extracted repo matches expected repo
  if (extractedRepo !== expectedRepo) {
    return { valid: false, reason: "repo_mismatch" };
  }

  return { valid: true };
}
