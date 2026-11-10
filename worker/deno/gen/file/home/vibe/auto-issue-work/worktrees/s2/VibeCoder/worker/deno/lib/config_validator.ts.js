/**
 * Configuration validation for the Vibe Coder worker.
 *
 * Migrated from worker/shared/config_validator.sh (Issue #904).
 * Validates configuration values, repository formats, usernames, labels,
 * and provides security warnings for potentially insecure configurations.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */ import { EXCLUSION_TEAM_PATTERN } from "./validation.ts";
import { FLEET_LOGIN_CONFIG_KEYS, isBotLogin, resolveVibeCoderLogins } from "./trust_exclusions.ts";
import { COPILOT_CODE_REVIEW_MODES, DEFAULT_COPILOT_CODE_REVIEW, PINNED_TOOLS, UPDATE_MODES } from "./config_defaults.ts";
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
 */ export function validateRepoFormat(repo) {
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
 */ export function validateUsernameFormat(username) {
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
 */ export function validateLabelFormat(label) {
  if (!label) return false;
  // Reject dangerous shell metacharacters
  if (/[`$;|&><(){}]/.test(label)) return false;
  // Allow: alphanumeric, spaces, hyphens, underscores, colons, slashes, dots, commas
  return /^[a-zA-Z0-9 _:/.,-]+$/.test(label);
}
// =============================================================================
// Configuration Validation
// =============================================================================
/** Generic usernames that should raise a security warning. */ const GENERIC_NAMES = [
  "admin",
  "test",
  "user",
  "root",
  "guest",
  "default",
  "owner",
  "developer",
  "dev"
];
/**
 * Soft cap above which `trusted_review_bots` is considered unusually large
 * and worth a warning (Issue #1856).
 */ const TRUSTED_REVIEW_BOTS_WARN_THRESHOLD = 20;
/**
 * Warn about a `trusted_review_bots` configuration that is suspiciously
 * large or contains entries that don't look like bot accounts.
 *
 * Returns a list of human-readable warning strings (Issue #1856).
 */ export function warnTrustedReviewBots(bots) {
  const warnings = [];
  if (bots.length > TRUSTED_REVIEW_BOTS_WARN_THRESHOLD) {
    warnings.push(`TRUSTED_REVIEW_BOTS has ${bots.length} entries — this is unusually large. ` + "Consider limiting to a small set of curated automated review tools");
  }
  for (const bot of bots){
    if (!bot) continue;
    if (!isBotLogin(bot)) {
      warnings.push(`TRUSTED_REVIEW_BOTS entry '${bot}' does not look like a bot account ` + "(no '[bot]' suffix and not in the known-bot allowlist). " + "Auto-trusting a human account bypasses the thumbs-up gate — " + "a human reviewer is trusted through repository write access instead");
    }
  }
  return warnings;
}
/**
 * Validate required fields in the configuration.
 *
 * @param config - Worker configuration
 * @returns Array of error messages (empty if valid)
 */ export function validateRequiredFields(config) {
  const errors = [];
  // Issue #1066: `allowed_authors` is no longer required — who may direct
  // work is derived from repository collaborators. What must be present is
  // the fleet's own login set, because that is what is subtracted from the
  // collaborator set; without it the Vibe Coders, which hold write access to
  // push branches, would be trusted to schedule their own work.
  if (resolveVibeCoderLogins({
    serviceAccounts: config.serviceAccounts ?? [],
    fleetPrAuthors: config.fleetPrAuthors ?? []
  }).size === 0) {
    errors.push(`The fleet login set is empty — set ${FLEET_LOGIN_CONFIG_KEYS.join(" and/or ")} in .config.json, or the Vibe Coder accounts would be trusted to ` + "raise and schedule their own work");
  }
  // Issue #252: `exclusion_team` is an optional *additional* exclusion for
  // org-team-based setups. Validated on the loaded WorkerConfig here (not
  // only the raw JSON key in config.ts) so unused_config_fields_test sees a
  // real consumer outside config plumbing.
  if (config.exclusionTeam !== undefined && !EXCLUSION_TEAM_PATTERN.test(config.exclusionTeam)) {
    errors.push(`Invalid exclusion_team '${config.exclusionTeam}'. ` + "Expected org/slug (e.g. stSoftwareAU/vibe-workers).");
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
 */ export function warnInsecureConfig(config) {
  const warnings = [];
  // Issue #1066: `allowedAuthors` is the *derived* set (repository
  // collaborators minus the Vibe Coders and bots), so a generic name or a
  // long list there is a fact about who holds write access, not a
  // configuration mistake anyone can fix by editing this file. Only the
  // hand-maintained known-input allowlist is still worth warning about.
  for (const commenter of config.authorisedCommenters){
    if (GENERIC_NAMES.includes(commenter.toLowerCase())) {
      warnings.push(`AUTHORIZED_COMMENTERS contains '${commenter}' which is a generic/common name. ` + "Consider using actual GitHub usernames for better security");
    }
  }
  if (config.authorisedCommenters.length > 5) {
    warnings.push(`AUTHORIZED_COMMENTERS has ${config.authorisedCommenters.length} users — this is quite permissive. ` + "Consider limiting authorised commenters to trusted users only");
  }
  // Check for very permissive PR reviewers list
  if (config.prReviewers.length > 5) {
    warnings.push(`PR_REVIEWERS has ${config.prReviewers.length} users — this is quite permissive. ` + "Consider limiting PR reviewers to trusted users only");
  }
  // Trusted review bots — warn if list is unusually large or contains
  // entries that are not bot-shaped and not in a known-bot allowlist
  // (Issue #1856).
  warnings.push(...warnTrustedReviewBots(config.trustedReviewBots));
  // Warn if PR reviewer is not set
  if (!config.prReviewer && config.prReviewers.length === 0) {
    warnings.push("PR_REVIEWER/PR_REVIEWERS is not set — PRs will not have an automatic reviewer assigned");
  }
  return warnings;
}
// =============================================================================
// Update Mode Validation (Issue #622, part of #583)
// =============================================================================
/**
 * Shape a pinned ref or tool version must take (Issue #622).
 *
 * Both are later handed to `git` and to tool installers, so the allowlist is
 * deliberately narrow: start with a letter or digit, then letters, digits and
 * `. _ + - / @`. That covers every commit SHA, tag (`v1.2.3`,
 * `release/2026-01`) and version string (`2.0.76`, `1.0.0-beta.1`) while
 * rejecting whitespace and every shell metacharacter.
 */ const PIN_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+@/-]*$/;
/**
 * Validate the update-mode settings, failing loud on a bad hand-edit
 * (Issue #622, part of #583).
 *
 * The pinned ref and tool versions are meant to be hand-editable without
 * re-running setup, so a typo has to be caught at config-load time rather
 * than silently checking out the wrong thing.
 *
 * In `dynamic` mode the pin fields are ignored entirely — a host that flips
 * back to dynamic keeps its stale pins without being refused.
 *
 * @param settings - Resolved update-mode settings
 * @returns Error messages naming the offending field (empty when valid)
 */ export function validateUpdateModeSettings(settings) {
  const mode = settings.updateMode;
  if (mode !== undefined && !UPDATE_MODES.includes(mode)) {
    return [
      `Invalid update_mode ${JSON.stringify(mode)}. ` + `Accepted values: ${UPDATE_MODES.join(", ")}.`
    ];
  }
  // Dynamic hosts ignore the pins, so a stale one is never an error.
  if (mode !== "frozen") return [];
  const errors = [];
  const ref = settings.pinnedRef;
  if (ref === undefined || ref.trim() === "") {
    errors.push('update_mode "frozen" requires pinned_ref — the commit SHA or tag the ' + "worker checkout is held at.");
  } else {
    errors.push(...pinValueErrors("pinned_ref", ref));
  }
  const versions = settings.pinnedToolVersions ?? {};
  for (const tool of PINNED_TOOLS){
    const version = versions[tool];
    if (version === undefined || version.trim() === "") {
      errors.push(`update_mode "frozen" requires pinned_tool_versions.${tool} — the ` + `exact ${tool} version a frozen host installs.`);
      continue;
    }
    errors.push(...pinValueErrors(`pinned_tool_versions.${tool}`, version));
  }
  return errors;
}
/**
 * Parse `copilot_code_review` (Issue #2701), failing loud on anything but
 * the three accepted values.
 *
 * Only an absent key means {@link DEFAULT_COPILOT_CODE_REVIEW}: a typo read
 * as `leave` would keep billing a host that asked for `off`, with nothing to
 * say the setting was never understood.
 *
 * @param raw - The value as it appeared in `.config.json`, or `undefined`
 * @returns The mode, or an error naming the field and the accepted values
 */ export function parseCopilotCodeReview(raw) {
  if (raw === undefined) {
    return {
      ok: true,
      value: DEFAULT_COPILOT_CODE_REVIEW
    };
  }
  if (typeof raw === "string" && COPILOT_CODE_REVIEW_MODES.includes(raw)) {
    return {
      ok: true,
      value: raw
    };
  }
  return {
    ok: false,
    error: `Invalid copilot_code_review ${JSON.stringify(raw)}. ` + `Accepted values: ${COPILOT_CODE_REVIEW_MODES.join(", ")}.`
  };
}
/**
 * Reject a pin value that could not be safely handed to git or an installer.
 *
 * Exported because the host-side checkout update reads `pinned_ref` from
 * `.config.json` itself, before the configuration load runs (Issue #624), and
 * must apply the same allowlist rather than a second copy of it.
 */ export function pinValueErrors(field, value) {
  if (PIN_VALUE_PATTERN.test(value)) return [];
  return [
    `Invalid ${field} ${JSON.stringify(value)}. It is passed to git and to ` + "tool installers, so it must start with a letter or digit and contain " + "only letters, digits and . _ + - / @ — no whitespace or shell " + "metacharacters."
  ];
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
 */ export function validateGitHubAppConfig(rawFile) {
  const errors = [];
  const warnings = [];
  const appId = rawFile.github_app_id;
  const installationId = rawFile.github_app_installation_id;
  const privateKeyPath = rawFile.github_app_private_key_path;
  const fields = [
    appId,
    installationId,
    privateKeyPath
  ];
  const setCount = fields.filter((f)=>f !== undefined && f !== "").length;
  // No fields set — nothing to validate
  if (setCount === 0) {
    return {
      errors,
      warnings
    };
  }
  // Partial configuration — warn
  if (setCount > 0 && setCount < 3) {
    const missing = [];
    if (!appId) missing.push("github_app_id");
    if (!installationId) missing.push("github_app_installation_id");
    if (!privateKeyPath) missing.push("github_app_private_key_path");
    warnings.push(`GitHub App configuration is partially set — missing: ${missing.join(", ")}. ` + "All three fields (github_app_id, github_app_installation_id, github_app_private_key_path) " + "must be set for GitHub App authentication to work");
    return {
      errors,
      warnings
    };
  }
  // All three set — validate formats
  if (appId && !/^\d+$/.test(appId)) {
    errors.push(`github_app_id must be a numeric string, got '${appId}'`);
  }
  if (installationId && !/^\d+$/.test(installationId)) {
    errors.push(`github_app_installation_id must be a numeric string, got '${installationId}'`);
  }
  // Check private key path exists (warning, not error — path may be created later)
  if (privateKeyPath) {
    const expandedPath = privateKeyPath.replace(/^~/, Deno.env.get("HOME") ?? "");
    try {
      Deno.statSync(expandedPath);
    } catch  {
      warnings.push(`GitHub App private key path does not exist: '${expandedPath}'. ` + "Ensure the file is created before the worker starts");
    }
  }
  return {
    errors,
    warnings
  };
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
 */ function warnOrphanRepoConfig(config) {
  const repoConfig = config.repoConfig;
  if (!repoConfig || config.repos.length === 0) return [];
  const monitored = new Set(config.repos.map((r)=>r.toLowerCase()));
  return Object.keys(repoConfig).filter((repo)=>!monitored.has(repo.toLowerCase())).map((repo)=>`repo_config contains an entry for '${repo}', which is not in repos. ` + "It is dead config and is never read — remove it or add the repo to repos");
}
/**
 * Full configuration validation.
 *
 * Validates all configuration settings and returns structured results
 * including errors (blocking) and warnings (non-blocking).
 *
 * @param config - Worker configuration
 * @returns Validation result with errors and warnings
 */ export function validateConfigFull(config, rawFile) {
  const errors = [];
  const warnings = [];
  // Step 1: Validate required fields
  errors.push(...validateRequiredFields(config));
  // Step 1b: maxConcurrentIssues range (Issue #4174). Read the raw file value
  // so non-integers and strings are rejected before coercion; absent means
  // the default (1) applies and is fine.
  if (rawFile && rawFile.max_concurrent_issues !== undefined) {
    const v = rawFile.max_concurrent_issues;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 8) {
      errors.push(`Invalid max_concurrent_issues: ${JSON.stringify(v)}. ` + "It must be an integer between 1 and 8.");
    }
  }
  // Step 1c: update mode and its pins (Issue #622). Validated from the
  // resolved config so a caller that assembled one itself is covered too.
  errors.push(...validateUpdateModeSettings({
    updateMode: config.updateMode,
    pinnedRef: config.pinnedRef,
    pinnedToolVersions: config.pinnedToolVersions
  }));
  // Step 2: Validate username formats for allowed authors
  for (const author of config.allowedAuthors){
    if (!author) continue;
    if (!validateUsernameFormat(author)) {
      errors.push(`Invalid username format in ALLOWED_AUTHORS: '${author}'. ` + "Usernames must be alphanumeric with hyphens/underscores only");
    }
  }
  // Step 3: Validate repository formats
  for (const repo of config.repos){
    if (!validateRepoFormat(repo)) {
      errors.push(`Invalid repository format: '${repo}'. ` + "Repository names must be in 'owner/repo' format");
    }
  }
  // Step 4: Validate label formats
  for (const label of config.issueLabels){
    if (!validateLabelFormat(label)) {
      errors.push(`Invalid label format: '${label}'. ` + "Labels must not contain shell metacharacters");
    }
  }
  // Step 5: Validate authorised commenters formats
  for (const commenter of config.authorisedCommenters){
    if (!commenter) continue;
    if (!validateUsernameFormat(commenter)) {
      errors.push(`Invalid username format in AUTHORIZED_COMMENTERS: '${commenter}'`);
    }
  }
  // Step 6: Validate PR reviewers formats
  for (const reviewer of config.prReviewers){
    if (!reviewer) continue;
    if (!validateUsernameFormat(reviewer)) {
      errors.push(`Invalid username format in PR_REVIEWERS: '${reviewer}'. ` + "Usernames must be alphanumeric with hyphens/underscores only");
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
    warnings
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
 */ export function isRepoAllowed(repos, repo) {
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
 */ export function validateGitUrl(url, expectedRepo) {
  // Reject empty URL
  if (!url) {
    return {
      valid: false,
      reason: "empty_url"
    };
  }
  // Reject URLs with newlines (injection attempt)
  if (url.includes("\n") || url.includes("\r")) {
    return {
      valid: false,
      reason: "newline_injection"
    };
  }
  // Reject URLs with path traversal sequences
  if (url.includes("..")) {
    return {
      valid: false,
      reason: "path_traversal"
    };
  }
  // Reject URLs with embedded credentials (user:pass@)
  if (/:\/\/[^/]*:[^/]*@/.test(url)) {
    return {
      valid: false,
      reason: "embedded_credentials"
    };
  }
  // Reject URLs with query parameters
  if (url.includes("?")) {
    return {
      valid: false,
      reason: "query_parameters"
    };
  }
  // Extract owner/repo from URL
  let extractedOwner = "";
  let extractedRepoName = "";
  // Handle HTTPS URLs: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = url.match(/^https:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (httpsMatch) {
    extractedOwner = httpsMatch[1];
    extractedRepoName = httpsMatch[2];
  } else {
    // Handle SSH URLs: git@github.com:owner/repo.git
    const sshMatch = url.match(/^git@github\.com:([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (sshMatch) {
      extractedOwner = sshMatch[1];
      extractedRepoName = sshMatch[2];
    } else {
      return {
        valid: false,
        reason: "unrecognised_format_or_non_github_host"
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
    return {
      valid: false,
      reason: "repo_mismatch"
    };
  }
  return {
    valid: true
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb25maWdfdmFsaWRhdG9yLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ29uZmlndXJhdGlvbiB2YWxpZGF0aW9uIGZvciB0aGUgVmliZSBDb2RlciB3b3JrZXIuXG4gKlxuICogTWlncmF0ZWQgZnJvbSB3b3JrZXIvc2hhcmVkL2NvbmZpZ192YWxpZGF0b3Iuc2ggKElzc3VlICM5MDQpLlxuICogVmFsaWRhdGVzIGNvbmZpZ3VyYXRpb24gdmFsdWVzLCByZXBvc2l0b3J5IGZvcm1hdHMsIHVzZXJuYW1lcywgbGFiZWxzLFxuICogYW5kIHByb3ZpZGVzIHNlY3VyaXR5IHdhcm5pbmdzIGZvciBwb3RlbnRpYWxseSBpbnNlY3VyZSBjb25maWd1cmF0aW9ucy5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUge1xuICBDb25maWdGaWxlLFxuICBDb3BpbG90Q29kZVJldmlld01vZGUsXG4gIFBpbm5lZFRvb2xWZXJzaW9ucyxcbiAgUmVzdWx0LFxuICBXb3JrZXJDb25maWcsXG59IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgRVhDTFVTSU9OX1RFQU1fUEFUVEVSTiB9IGZyb20gXCIuL3ZhbGlkYXRpb24udHNcIjtcbmltcG9ydCB7XG4gIEZMRUVUX0xPR0lOX0NPTkZJR19LRVlTLFxuICBpc0JvdExvZ2luLFxuICByZXNvbHZlVmliZUNvZGVyTG9naW5zLFxufSBmcm9tIFwiLi90cnVzdF9leGNsdXNpb25zLnRzXCI7XG5pbXBvcnQge1xuICBDT1BJTE9UX0NPREVfUkVWSUVXX01PREVTLFxuICBERUZBVUxUX0NPUElMT1RfQ09ERV9SRVZJRVcsXG4gIFBJTk5FRF9UT09MUyxcbiAgVVBEQVRFX01PREVTLFxufSBmcm9tIFwiLi9jb25maWdfZGVmYXVsdHMudHNcIjtcblxuLyoqXG4gKiBWYWxpZGF0aW9uIHJlc3VsdCB3aXRoIHN0cnVjdHVyZWQgZXJyb3JzIGFuZCB3YXJuaW5ncy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb25maWdWYWxpZGF0aW9uUmVzdWx0IHtcbiAgLyoqIFdoZXRoZXIgdmFsaWRhdGlvbiBwYXNzZWQgKG5vIGVycm9ycykgKi9cbiAgdmFsaWQ6IGJvb2xlYW47XG4gIC8qKiBWYWxpZGF0aW9uIGVycm9ycyAoYmxvY2tpbmcpICovXG4gIGVycm9yczogc3RyaW5nW107XG4gIC8qKiBTZWN1cml0eSB3YXJuaW5ncyAobm9uLWJsb2NraW5nKSAqL1xuICB3YXJuaW5nczogc3RyaW5nW107XG59XG5cbi8qKlxuICogR2l0IFVSTCB2YWxpZGF0aW9uIHJlc3VsdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaXRVcmxWYWxpZGF0aW9uUmVzdWx0IHtcbiAgdmFsaWQ6IGJvb2xlYW47XG4gIHJlYXNvbj86IHN0cmluZztcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEZvcm1hdCBWYWxpZGF0aW9uIEZ1bmN0aW9uc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBWYWxpZGF0ZSByZXBvc2l0b3J5IG5hbWUgZm9ybWF0LlxuICpcbiAqIFJlcG9zaXRvcnkgbmFtZXMgbXVzdCBtYXRjaCB0aGUgcGF0dGVybjogb3duZXIvcmVwb1xuICogd2hlcmUgb3duZXIgYW5kIHJlcG8gY2FuIGNvbnRhaW4gYWxwaGFudW1lcmljIGNoYXJhY3RlcnMsIGh5cGhlbnMsXG4gKiB1bmRlcnNjb3JlcywgYW5kIGRvdHMuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IG5hbWUgdG8gdmFsaWRhdGUgKGUuZy4sIFwib3duZXIvcmVwb1wiKVxuICogQHJldHVybnMgdHJ1ZSBpZiB2YWxpZFxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVSZXBvRm9ybWF0KHJlcG86IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIXJlcG8pIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIC9eW2EtekEtWjAtOV8tXStcXC9bYS16QS1aMC05Xy4tXSskLy50ZXN0KHJlcG8pO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIEdpdEh1YiB1c2VybmFtZSBmb3JtYXQuXG4gKlxuICogR2l0SHViIHVzZXJuYW1lcyBjYW4gY29udGFpbiBhbHBoYW51bWVyaWMgY2hhcmFjdGVycywgaHlwaGVucyxcbiAqIGFuZCB1bmRlcnNjb3Jlcy4gQm90IGFjY291bnRzIG1heSBoYXZlIFtib3RdIHN1ZmZpeC5cbiAqXG4gKiBAcGFyYW0gdXNlcm5hbWUgLSBVc2VybmFtZSB0byB2YWxpZGF0ZVxuICogQHJldHVybnMgdHJ1ZSBpZiB2YWxpZFxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVVc2VybmFtZUZvcm1hdCh1c2VybmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghdXNlcm5hbWUpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIC9eW2EtekEtWjAtOV8tXSsoXFxbYm90XFxdKT8kLy50ZXN0KHVzZXJuYW1lKTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBHaXRIdWIgbGFiZWwgZm9ybWF0LlxuICpcbiAqIExhYmVscyBjYW4gY29udGFpbiBhbHBoYW51bWVyaWMgY2hhcmFjdGVycywgc3BhY2VzLCBoeXBoZW5zLCB1bmRlcnNjb3JlcyxcbiAqIGNvbG9ucywgZm9yd2FyZCBzbGFzaGVzLCBkb3RzLCBhbmQgY29tbWFzLiBSZWplY3RzIGNoYXJhY3RlcnMgdGhhdCBjb3VsZFxuICogYmUgdXNlZCBmb3Igc2hlbGwgaW5qZWN0aW9uLlxuICpcbiAqIEBwYXJhbSBsYWJlbCAtIExhYmVsIG5hbWUgdG8gdmFsaWRhdGVcbiAqIEByZXR1cm5zIHRydWUgaWYgdmFsaWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlTGFiZWxGb3JtYXQobGFiZWw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIWxhYmVsKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gUmVqZWN0IGRhbmdlcm91cyBzaGVsbCBtZXRhY2hhcmFjdGVyc1xuICBpZiAoL1tgJDt8Jj48KCl7fV0vLnRlc3QobGFiZWwpKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gQWxsb3c6IGFscGhhbnVtZXJpYywgc3BhY2VzLCBoeXBoZW5zLCB1bmRlcnNjb3JlcywgY29sb25zLCBzbGFzaGVzLCBkb3RzLCBjb21tYXNcbiAgcmV0dXJuIC9eW2EtekEtWjAtOSBfOi8uLC1dKyQvLnRlc3QobGFiZWwpO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQ29uZmlndXJhdGlvbiBWYWxpZGF0aW9uXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKiogR2VuZXJpYyB1c2VybmFtZXMgdGhhdCBzaG91bGQgcmFpc2UgYSBzZWN1cml0eSB3YXJuaW5nLiAqL1xuY29uc3QgR0VORVJJQ19OQU1FUyA9IFtcbiAgXCJhZG1pblwiLFxuICBcInRlc3RcIixcbiAgXCJ1c2VyXCIsXG4gIFwicm9vdFwiLFxuICBcImd1ZXN0XCIsXG4gIFwiZGVmYXVsdFwiLFxuICBcIm93bmVyXCIsXG4gIFwiZGV2ZWxvcGVyXCIsXG4gIFwiZGV2XCIsXG5dO1xuXG4vKipcbiAqIFNvZnQgY2FwIGFib3ZlIHdoaWNoIGB0cnVzdGVkX3Jldmlld19ib3RzYCBpcyBjb25zaWRlcmVkIHVudXN1YWxseSBsYXJnZVxuICogYW5kIHdvcnRoIGEgd2FybmluZyAoSXNzdWUgIzE4NTYpLlxuICovXG5jb25zdCBUUlVTVEVEX1JFVklFV19CT1RTX1dBUk5fVEhSRVNIT0xEID0gMjA7XG5cbi8qKlxuICogV2FybiBhYm91dCBhIGB0cnVzdGVkX3Jldmlld19ib3RzYCBjb25maWd1cmF0aW9uIHRoYXQgaXMgc3VzcGljaW91c2x5XG4gKiBsYXJnZSBvciBjb250YWlucyBlbnRyaWVzIHRoYXQgZG9uJ3QgbG9vayBsaWtlIGJvdCBhY2NvdW50cy5cbiAqXG4gKiBSZXR1cm5zIGEgbGlzdCBvZiBodW1hbi1yZWFkYWJsZSB3YXJuaW5nIHN0cmluZ3MgKElzc3VlICMxODU2KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhcm5UcnVzdGVkUmV2aWV3Qm90cyhib3RzOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gW107XG5cbiAgaWYgKGJvdHMubGVuZ3RoID4gVFJVU1RFRF9SRVZJRVdfQk9UU19XQVJOX1RIUkVTSE9MRCkge1xuICAgIHdhcm5pbmdzLnB1c2goXG4gICAgICBgVFJVU1RFRF9SRVZJRVdfQk9UUyBoYXMgJHtib3RzLmxlbmd0aH0gZW50cmllcyDigJQgdGhpcyBpcyB1bnVzdWFsbHkgbGFyZ2UuIGAgK1xuICAgICAgICBcIkNvbnNpZGVyIGxpbWl0aW5nIHRvIGEgc21hbGwgc2V0IG9mIGN1cmF0ZWQgYXV0b21hdGVkIHJldmlldyB0b29sc1wiLFxuICAgICk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGJvdCBvZiBib3RzKSB7XG4gICAgaWYgKCFib3QpIGNvbnRpbnVlO1xuICAgIGlmICghaXNCb3RMb2dpbihib3QpKSB7XG4gICAgICB3YXJuaW5ncy5wdXNoKFxuICAgICAgICBgVFJVU1RFRF9SRVZJRVdfQk9UUyBlbnRyeSAnJHtib3R9JyBkb2VzIG5vdCBsb29rIGxpa2UgYSBib3QgYWNjb3VudCBgICtcbiAgICAgICAgICBcIihubyAnW2JvdF0nIHN1ZmZpeCBhbmQgbm90IGluIHRoZSBrbm93bi1ib3QgYWxsb3dsaXN0KS4gXCIgK1xuICAgICAgICAgIFwiQXV0by10cnVzdGluZyBhIGh1bWFuIGFjY291bnQgYnlwYXNzZXMgdGhlIHRodW1icy11cCBnYXRlIOKAlCBcIiArXG4gICAgICAgICAgXCJhIGh1bWFuIHJldmlld2VyIGlzIHRydXN0ZWQgdGhyb3VnaCByZXBvc2l0b3J5IHdyaXRlIGFjY2VzcyBpbnN0ZWFkXCIsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB3YXJuaW5ncztcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSByZXF1aXJlZCBmaWVsZHMgaW4gdGhlIGNvbmZpZ3VyYXRpb24uXG4gKlxuICogQHBhcmFtIGNvbmZpZyAtIFdvcmtlciBjb25maWd1cmF0aW9uXG4gKiBAcmV0dXJucyBBcnJheSBvZiBlcnJvciBtZXNzYWdlcyAoZW1wdHkgaWYgdmFsaWQpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVJlcXVpcmVkRmllbGRzKGNvbmZpZzogV29ya2VyQ29uZmlnKTogc3RyaW5nW10ge1xuICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gSXNzdWUgIzEwNjY6IGBhbGxvd2VkX2F1dGhvcnNgIGlzIG5vIGxvbmdlciByZXF1aXJlZCDigJQgd2hvIG1heSBkaXJlY3RcbiAgLy8gd29yayBpcyBkZXJpdmVkIGZyb20gcmVwb3NpdG9yeSBjb2xsYWJvcmF0b3JzLiBXaGF0IG11c3QgYmUgcHJlc2VudCBpc1xuICAvLyB0aGUgZmxlZXQncyBvd24gbG9naW4gc2V0LCBiZWNhdXNlIHRoYXQgaXMgd2hhdCBpcyBzdWJ0cmFjdGVkIGZyb20gdGhlXG4gIC8vIGNvbGxhYm9yYXRvciBzZXQ7IHdpdGhvdXQgaXQgdGhlIFZpYmUgQ29kZXJzLCB3aGljaCBob2xkIHdyaXRlIGFjY2VzcyB0b1xuICAvLyBwdXNoIGJyYW5jaGVzLCB3b3VsZCBiZSB0cnVzdGVkIHRvIHNjaGVkdWxlIHRoZWlyIG93biB3b3JrLlxuICBpZiAoXG4gICAgcmVzb2x2ZVZpYmVDb2RlckxvZ2lucyh7XG4gICAgICBzZXJ2aWNlQWNjb3VudHM6IGNvbmZpZy5zZXJ2aWNlQWNjb3VudHMgPz8gW10sXG4gICAgICBmbGVldFByQXV0aG9yczogY29uZmlnLmZsZWV0UHJBdXRob3JzID8/IFtdLFxuICAgIH0pLnNpemUgPT09IDBcbiAgKSB7XG4gICAgZXJyb3JzLnB1c2goXG4gICAgICBgVGhlIGZsZWV0IGxvZ2luIHNldCBpcyBlbXB0eSDigJQgc2V0ICR7XG4gICAgICAgIEZMRUVUX0xPR0lOX0NPTkZJR19LRVlTLmpvaW4oXCIgYW5kL29yIFwiKVxuICAgICAgfSBpbiAuY29uZmlnLmpzb24sIG9yIHRoZSBWaWJlIENvZGVyIGFjY291bnRzIHdvdWxkIGJlIHRydXN0ZWQgdG8gYCArXG4gICAgICAgIFwicmFpc2UgYW5kIHNjaGVkdWxlIHRoZWlyIG93biB3b3JrXCIsXG4gICAgKTtcbiAgfVxuXG4gIC8vIElzc3VlICMyNTI6IGBleGNsdXNpb25fdGVhbWAgaXMgYW4gb3B0aW9uYWwgKmFkZGl0aW9uYWwqIGV4Y2x1c2lvbiBmb3JcbiAgLy8gb3JnLXRlYW0tYmFzZWQgc2V0dXBzLiBWYWxpZGF0ZWQgb24gdGhlIGxvYWRlZCBXb3JrZXJDb25maWcgaGVyZSAobm90XG4gIC8vIG9ubHkgdGhlIHJhdyBKU09OIGtleSBpbiBjb25maWcudHMpIHNvIHVudXNlZF9jb25maWdfZmllbGRzX3Rlc3Qgc2VlcyBhXG4gIC8vIHJlYWwgY29uc3VtZXIgb3V0c2lkZSBjb25maWcgcGx1bWJpbmcuXG4gIGlmIChcbiAgICBjb25maWcuZXhjbHVzaW9uVGVhbSAhPT0gdW5kZWZpbmVkICYmXG4gICAgIUVYQ0xVU0lPTl9URUFNX1BBVFRFUk4udGVzdChjb25maWcuZXhjbHVzaW9uVGVhbSlcbiAgKSB7XG4gICAgZXJyb3JzLnB1c2goXG4gICAgICBgSW52YWxpZCBleGNsdXNpb25fdGVhbSAnJHtjb25maWcuZXhjbHVzaW9uVGVhbX0nLiBgICtcbiAgICAgICAgXCJFeHBlY3RlZCBvcmcvc2x1ZyAoZS5nLiBzdFNvZnR3YXJlQVUvdmliZS13b3JrZXJzKS5cIixcbiAgICApO1xuICB9XG5cbiAgaWYgKGNvbmZpZy5yZXBvcy5sZW5ndGggPT09IDApIHtcbiAgICBlcnJvcnMucHVzaChcIlJFUE9TIGlzIG5vdCBzZXQgb3IgY29udGFpbnMgbm8gcmVwb3NpdG9yaWVzXCIpO1xuICB9XG5cbiAgaWYgKGNvbmZpZy5pc3N1ZUxhYmVscy5sZW5ndGggPT09IDApIHtcbiAgICBlcnJvcnMucHVzaChcIklTU1VFX0xBQkVMUyBpcyBub3Qgc2V0IG9yIGNvbnRhaW5zIG5vIGxhYmVsc1wiKTtcbiAgfVxuXG4gIHJldHVybiBlcnJvcnM7XG59XG5cbi8qKlxuICogR2VuZXJhdGUgc2VjdXJpdHkgd2FybmluZ3MgZm9yIHBvdGVudGlhbGx5IGluc2VjdXJlIGNvbmZpZ3VyYXRpb25zLlxuICpcbiAqIENoZWNrcyBmb3I6XG4gKiAtIEdlbmVyaWMvY29tbW9uIG5hbWVzIGluIGFsbG93ZWQgYXV0aG9yc1xuICogLSBWZXJ5IHBlcm1pc3NpdmUgbGlzdHMgKG1vcmUgdGhhbiA1IHVzZXJzKVxuICogLSBNaXNzaW5nIFBSIHJldmlld2VyXG4gKlxuICogQHBhcmFtIGNvbmZpZyAtIFdvcmtlciBjb25maWd1cmF0aW9uXG4gKiBAcmV0dXJucyBBcnJheSBvZiB3YXJuaW5nIG1lc3NhZ2VzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3YXJuSW5zZWN1cmVDb25maWcoY29uZmlnOiBXb3JrZXJDb25maWcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIElzc3VlICMxMDY2OiBgYWxsb3dlZEF1dGhvcnNgIGlzIHRoZSAqZGVyaXZlZCogc2V0IChyZXBvc2l0b3J5XG4gIC8vIGNvbGxhYm9yYXRvcnMgbWludXMgdGhlIFZpYmUgQ29kZXJzIGFuZCBib3RzKSwgc28gYSBnZW5lcmljIG5hbWUgb3IgYVxuICAvLyBsb25nIGxpc3QgdGhlcmUgaXMgYSBmYWN0IGFib3V0IHdobyBob2xkcyB3cml0ZSBhY2Nlc3MsIG5vdCBhXG4gIC8vIGNvbmZpZ3VyYXRpb24gbWlzdGFrZSBhbnlvbmUgY2FuIGZpeCBieSBlZGl0aW5nIHRoaXMgZmlsZS4gT25seSB0aGVcbiAgLy8gaGFuZC1tYWludGFpbmVkIGtub3duLWlucHV0IGFsbG93bGlzdCBpcyBzdGlsbCB3b3J0aCB3YXJuaW5nIGFib3V0LlxuICBmb3IgKGNvbnN0IGNvbW1lbnRlciBvZiBjb25maWcuYXV0aG9yaXNlZENvbW1lbnRlcnMpIHtcbiAgICBpZiAoR0VORVJJQ19OQU1FUy5pbmNsdWRlcyhjb21tZW50ZXIudG9Mb3dlckNhc2UoKSkpIHtcbiAgICAgIHdhcm5pbmdzLnB1c2goXG4gICAgICAgIGBBVVRIT1JJWkVEX0NPTU1FTlRFUlMgY29udGFpbnMgJyR7Y29tbWVudGVyfScgd2hpY2ggaXMgYSBnZW5lcmljL2NvbW1vbiBuYW1lLiBgICtcbiAgICAgICAgICBcIkNvbnNpZGVyIHVzaW5nIGFjdHVhbCBHaXRIdWIgdXNlcm5hbWVzIGZvciBiZXR0ZXIgc2VjdXJpdHlcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgaWYgKGNvbmZpZy5hdXRob3Jpc2VkQ29tbWVudGVycy5sZW5ndGggPiA1KSB7XG4gICAgd2FybmluZ3MucHVzaChcbiAgICAgIGBBVVRIT1JJWkVEX0NPTU1FTlRFUlMgaGFzICR7Y29uZmlnLmF1dGhvcmlzZWRDb21tZW50ZXJzLmxlbmd0aH0gdXNlcnMg4oCUIHRoaXMgaXMgcXVpdGUgcGVybWlzc2l2ZS4gYCArXG4gICAgICAgIFwiQ29uc2lkZXIgbGltaXRpbmcgYXV0aG9yaXNlZCBjb21tZW50ZXJzIHRvIHRydXN0ZWQgdXNlcnMgb25seVwiLFxuICAgICk7XG4gIH1cblxuICAvLyBDaGVjayBmb3IgdmVyeSBwZXJtaXNzaXZlIFBSIHJldmlld2VycyBsaXN0XG4gIGlmIChjb25maWcucHJSZXZpZXdlcnMubGVuZ3RoID4gNSkge1xuICAgIHdhcm5pbmdzLnB1c2goXG4gICAgICBgUFJfUkVWSUVXRVJTIGhhcyAke2NvbmZpZy5wclJldmlld2Vycy5sZW5ndGh9IHVzZXJzIOKAlCB0aGlzIGlzIHF1aXRlIHBlcm1pc3NpdmUuIGAgK1xuICAgICAgICBcIkNvbnNpZGVyIGxpbWl0aW5nIFBSIHJldmlld2VycyB0byB0cnVzdGVkIHVzZXJzIG9ubHlcIixcbiAgICApO1xuICB9XG5cbiAgLy8gVHJ1c3RlZCByZXZpZXcgYm90cyDigJQgd2FybiBpZiBsaXN0IGlzIHVudXN1YWxseSBsYXJnZSBvciBjb250YWluc1xuICAvLyBlbnRyaWVzIHRoYXQgYXJlIG5vdCBib3Qtc2hhcGVkIGFuZCBub3QgaW4gYSBrbm93bi1ib3QgYWxsb3dsaXN0XG4gIC8vIChJc3N1ZSAjMTg1NikuXG4gIHdhcm5pbmdzLnB1c2goLi4ud2FyblRydXN0ZWRSZXZpZXdCb3RzKGNvbmZpZy50cnVzdGVkUmV2aWV3Qm90cykpO1xuXG4gIC8vIFdhcm4gaWYgUFIgcmV2aWV3ZXIgaXMgbm90IHNldFxuICBpZiAoIWNvbmZpZy5wclJldmlld2VyICYmIGNvbmZpZy5wclJldmlld2Vycy5sZW5ndGggPT09IDApIHtcbiAgICB3YXJuaW5ncy5wdXNoKFxuICAgICAgXCJQUl9SRVZJRVdFUi9QUl9SRVZJRVdFUlMgaXMgbm90IHNldCDigJQgUFJzIHdpbGwgbm90IGhhdmUgYW4gYXV0b21hdGljIHJldmlld2VyIGFzc2lnbmVkXCIsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiB3YXJuaW5ncztcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFVwZGF0ZSBNb2RlIFZhbGlkYXRpb24gKElzc3VlICM2MjIsIHBhcnQgb2YgIzU4Mylcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogU2hhcGUgYSBwaW5uZWQgcmVmIG9yIHRvb2wgdmVyc2lvbiBtdXN0IHRha2UgKElzc3VlICM2MjIpLlxuICpcbiAqIEJvdGggYXJlIGxhdGVyIGhhbmRlZCB0byBgZ2l0YCBhbmQgdG8gdG9vbCBpbnN0YWxsZXJzLCBzbyB0aGUgYWxsb3dsaXN0IGlzXG4gKiBkZWxpYmVyYXRlbHkgbmFycm93OiBzdGFydCB3aXRoIGEgbGV0dGVyIG9yIGRpZ2l0LCB0aGVuIGxldHRlcnMsIGRpZ2l0cyBhbmRcbiAqIGAuIF8gKyAtIC8gQGAuIFRoYXQgY292ZXJzIGV2ZXJ5IGNvbW1pdCBTSEEsIHRhZyAoYHYxLjIuM2AsXG4gKiBgcmVsZWFzZS8yMDI2LTAxYCkgYW5kIHZlcnNpb24gc3RyaW5nIChgMi4wLjc2YCwgYDEuMC4wLWJldGEuMWApIHdoaWxlXG4gKiByZWplY3Rpbmcgd2hpdGVzcGFjZSBhbmQgZXZlcnkgc2hlbGwgbWV0YWNoYXJhY3Rlci5cbiAqL1xuY29uc3QgUElOX1ZBTFVFX1BBVFRFUk4gPSAvXltBLVphLXowLTldW0EtWmEtejAtOS5fK0AvLV0qJC87XG5cbi8qKlxuICogUmVzb2x2ZWQgdXBkYXRlLW1vZGUgc2V0dGluZ3MgdG8gdmFsaWRhdGUgKElzc3VlICM2MjIpLlxuICpcbiAqIGB1cGRhdGVNb2RlYCBpcyBkZWxpYmVyYXRlbHkgYSBwbGFpbiBgc3RyaW5nYCBzbyBhIGhhbmQtZWRpdGVkXG4gKiBgLmNvbmZpZy5qc29uYCBjYXJyeWluZyBhIGJvZ3VzIG1vZGUgaXMgdmFsaWRhdGVkLCBub3QgdHlwZS1hc3NlcnRlZCBhd2F5LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFVwZGF0ZU1vZGVTZXR0aW5ncyB7XG4gIC8qKiBSZXNvbHZlZCBgdXBkYXRlX21vZGVgOyBhYnNlbnQgbWVhbnMgdGhlIGBkeW5hbWljYCBkZWZhdWx0LiAqL1xuICB1cGRhdGVNb2RlPzogc3RyaW5nO1xuICAvKiogUmVzb2x2ZWQgYHBpbm5lZF9yZWZgLCB3aGVuIHRoZSBvcGVyYXRvciBzZXQgb25lLiAqL1xuICBwaW5uZWRSZWY/OiBzdHJpbmc7XG4gIC8qKiBSZXNvbHZlZCBgcGlubmVkX3Rvb2xfdmVyc2lvbnNgLCB3aGVuIHRoZSBvcGVyYXRvciBzZXQgb25lLiAqL1xuICBwaW5uZWRUb29sVmVyc2lvbnM/OiBQaW5uZWRUb29sVmVyc2lvbnM7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdGhlIHVwZGF0ZS1tb2RlIHNldHRpbmdzLCBmYWlsaW5nIGxvdWQgb24gYSBiYWQgaGFuZC1lZGl0XG4gKiAoSXNzdWUgIzYyMiwgcGFydCBvZiAjNTgzKS5cbiAqXG4gKiBUaGUgcGlubmVkIHJlZiBhbmQgdG9vbCB2ZXJzaW9ucyBhcmUgbWVhbnQgdG8gYmUgaGFuZC1lZGl0YWJsZSB3aXRob3V0XG4gKiByZS1ydW5uaW5nIHNldHVwLCBzbyBhIHR5cG8gaGFzIHRvIGJlIGNhdWdodCBhdCBjb25maWctbG9hZCB0aW1lIHJhdGhlclxuICogdGhhbiBzaWxlbnRseSBjaGVja2luZyBvdXQgdGhlIHdyb25nIHRoaW5nLlxuICpcbiAqIEluIGBkeW5hbWljYCBtb2RlIHRoZSBwaW4gZmllbGRzIGFyZSBpZ25vcmVkIGVudGlyZWx5IOKAlCBhIGhvc3QgdGhhdCBmbGlwc1xuICogYmFjayB0byBkeW5hbWljIGtlZXBzIGl0cyBzdGFsZSBwaW5zIHdpdGhvdXQgYmVpbmcgcmVmdXNlZC5cbiAqXG4gKiBAcGFyYW0gc2V0dGluZ3MgLSBSZXNvbHZlZCB1cGRhdGUtbW9kZSBzZXR0aW5nc1xuICogQHJldHVybnMgRXJyb3IgbWVzc2FnZXMgbmFtaW5nIHRoZSBvZmZlbmRpbmcgZmllbGQgKGVtcHR5IHdoZW4gdmFsaWQpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVVwZGF0ZU1vZGVTZXR0aW5ncyhcbiAgc2V0dGluZ3M6IFVwZGF0ZU1vZGVTZXR0aW5ncyxcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgbW9kZSA9IHNldHRpbmdzLnVwZGF0ZU1vZGU7XG4gIGlmIChcbiAgICBtb2RlICE9PSB1bmRlZmluZWQgJiZcbiAgICAhKFVQREFURV9NT0RFUyBhcyByZWFkb25seSBzdHJpbmdbXSkuaW5jbHVkZXMobW9kZSlcbiAgKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIGBJbnZhbGlkIHVwZGF0ZV9tb2RlICR7SlNPTi5zdHJpbmdpZnkobW9kZSl9LiBgICtcbiAgICAgIGBBY2NlcHRlZCB2YWx1ZXM6ICR7VVBEQVRFX01PREVTLmpvaW4oXCIsIFwiKX0uYCxcbiAgICBdO1xuICB9XG5cbiAgLy8gRHluYW1pYyBob3N0cyBpZ25vcmUgdGhlIHBpbnMsIHNvIGEgc3RhbGUgb25lIGlzIG5ldmVyIGFuIGVycm9yLlxuICBpZiAobW9kZSAhPT0gXCJmcm96ZW5cIikgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcblxuICBjb25zdCByZWYgPSBzZXR0aW5ncy5waW5uZWRSZWY7XG4gIGlmIChyZWYgPT09IHVuZGVmaW5lZCB8fCByZWYudHJpbSgpID09PSBcIlwiKSB7XG4gICAgZXJyb3JzLnB1c2goXG4gICAgICAndXBkYXRlX21vZGUgXCJmcm96ZW5cIiByZXF1aXJlcyBwaW5uZWRfcmVmIOKAlCB0aGUgY29tbWl0IFNIQSBvciB0YWcgdGhlICcgK1xuICAgICAgICBcIndvcmtlciBjaGVja291dCBpcyBoZWxkIGF0LlwiLFxuICAgICk7XG4gIH0gZWxzZSB7XG4gICAgZXJyb3JzLnB1c2goLi4ucGluVmFsdWVFcnJvcnMoXCJwaW5uZWRfcmVmXCIsIHJlZikpO1xuICB9XG5cbiAgY29uc3QgdmVyc2lvbnMgPSBzZXR0aW5ncy5waW5uZWRUb29sVmVyc2lvbnMgPz8ge307XG4gIGZvciAoY29uc3QgdG9vbCBvZiBQSU5ORURfVE9PTFMpIHtcbiAgICBjb25zdCB2ZXJzaW9uID0gdmVyc2lvbnNbdG9vbF07XG4gICAgaWYgKHZlcnNpb24gPT09IHVuZGVmaW5lZCB8fCB2ZXJzaW9uLnRyaW0oKSA9PT0gXCJcIikge1xuICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgIGB1cGRhdGVfbW9kZSBcImZyb3plblwiIHJlcXVpcmVzIHBpbm5lZF90b29sX3ZlcnNpb25zLiR7dG9vbH0g4oCUIHRoZSBgICtcbiAgICAgICAgICBgZXhhY3QgJHt0b29sfSB2ZXJzaW9uIGEgZnJvemVuIGhvc3QgaW5zdGFsbHMuYCxcbiAgICAgICk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZXJyb3JzLnB1c2goLi4ucGluVmFsdWVFcnJvcnMoYHBpbm5lZF90b29sX3ZlcnNpb25zLiR7dG9vbH1gLCB2ZXJzaW9uKSk7XG4gIH1cblxuICByZXR1cm4gZXJyb3JzO1xufVxuXG4vKipcbiAqIFBhcnNlIGBjb3BpbG90X2NvZGVfcmV2aWV3YCAoSXNzdWUgIzI3MDEpLCBmYWlsaW5nIGxvdWQgb24gYW55dGhpbmcgYnV0XG4gKiB0aGUgdGhyZWUgYWNjZXB0ZWQgdmFsdWVzLlxuICpcbiAqIE9ubHkgYW4gYWJzZW50IGtleSBtZWFucyB7QGxpbmsgREVGQVVMVF9DT1BJTE9UX0NPREVfUkVWSUVXfTogYSB0eXBvIHJlYWRcbiAqIGFzIGBsZWF2ZWAgd291bGQga2VlcCBiaWxsaW5nIGEgaG9zdCB0aGF0IGFza2VkIGZvciBgb2ZmYCwgd2l0aCBub3RoaW5nIHRvXG4gKiBzYXkgdGhlIHNldHRpbmcgd2FzIG5ldmVyIHVuZGVyc3Rvb2QuXG4gKlxuICogQHBhcmFtIHJhdyAtIFRoZSB2YWx1ZSBhcyBpdCBhcHBlYXJlZCBpbiBgLmNvbmZpZy5qc29uYCwgb3IgYHVuZGVmaW5lZGBcbiAqIEByZXR1cm5zIFRoZSBtb2RlLCBvciBhbiBlcnJvciBuYW1pbmcgdGhlIGZpZWxkIGFuZCB0aGUgYWNjZXB0ZWQgdmFsdWVzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNvcGlsb3RDb2RlUmV2aWV3KFxuICByYXc6IHVua25vd24sXG4pOiBSZXN1bHQ8Q29waWxvdENvZGVSZXZpZXdNb2RlLCBzdHJpbmc+IHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBERUZBVUxUX0NPUElMT1RfQ09ERV9SRVZJRVcgfTtcbiAgfVxuICBpZiAoXG4gICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIChDT1BJTE9UX0NPREVfUkVWSUVXX01PREVTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyhyYXcpXG4gICkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcmF3IGFzIENvcGlsb3RDb2RlUmV2aWV3TW9kZSB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBgSW52YWxpZCBjb3BpbG90X2NvZGVfcmV2aWV3ICR7SlNPTi5zdHJpbmdpZnkocmF3KX0uIGAgK1xuICAgICAgYEFjY2VwdGVkIHZhbHVlczogJHtDT1BJTE9UX0NPREVfUkVWSUVXX01PREVTLmpvaW4oXCIsIFwiKX0uYCxcbiAgfTtcbn1cblxuLyoqXG4gKiBSZWplY3QgYSBwaW4gdmFsdWUgdGhhdCBjb3VsZCBub3QgYmUgc2FmZWx5IGhhbmRlZCB0byBnaXQgb3IgYW4gaW5zdGFsbGVyLlxuICpcbiAqIEV4cG9ydGVkIGJlY2F1c2UgdGhlIGhvc3Qtc2lkZSBjaGVja291dCB1cGRhdGUgcmVhZHMgYHBpbm5lZF9yZWZgIGZyb21cbiAqIGAuY29uZmlnLmpzb25gIGl0c2VsZiwgYmVmb3JlIHRoZSBjb25maWd1cmF0aW9uIGxvYWQgcnVucyAoSXNzdWUgIzYyNCksIGFuZFxuICogbXVzdCBhcHBseSB0aGUgc2FtZSBhbGxvd2xpc3QgcmF0aGVyIHRoYW4gYSBzZWNvbmQgY29weSBvZiBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBpblZhbHVlRXJyb3JzKGZpZWxkOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGlmIChQSU5fVkFMVUVfUEFUVEVSTi50ZXN0KHZhbHVlKSkgcmV0dXJuIFtdO1xuICByZXR1cm4gW1xuICAgIGBJbnZhbGlkICR7ZmllbGR9ICR7SlNPTi5zdHJpbmdpZnkodmFsdWUpfS4gSXQgaXMgcGFzc2VkIHRvIGdpdCBhbmQgdG8gYCArXG4gICAgXCJ0b29sIGluc3RhbGxlcnMsIHNvIGl0IG11c3Qgc3RhcnQgd2l0aCBhIGxldHRlciBvciBkaWdpdCBhbmQgY29udGFpbiBcIiArXG4gICAgXCJvbmx5IGxldHRlcnMsIGRpZ2l0cyBhbmQgLiBfICsgLSAvIEAg4oCUIG5vIHdoaXRlc3BhY2Ugb3Igc2hlbGwgXCIgK1xuICAgIFwibWV0YWNoYXJhY3RlcnMuXCIsXG4gIF07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBHaXRIdWIgQXBwIENvbmZpZ3VyYXRpb24gVmFsaWRhdGlvbiAoSXNzdWUgIzk1Nylcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogVmFsaWRhdGUgR2l0SHViIEFwcCBjb25maWd1cmF0aW9uIGZpZWxkcyBmcm9tIHRoZSByYXcgY29uZmlnIGZpbGUuXG4gKlxuICogUnVsZXM6XG4gKiAtIElmIGFueSBHaXRIdWIgQXBwIGZpZWxkIGlzIHNldCwgYWxsIHRocmVlIG11c3QgYmUgc2V0IChwYXJ0aWFsID0gd2FybmluZylcbiAqIC0gQXBwIElEIGFuZCBJbnN0YWxsYXRpb24gSUQgbXVzdCBiZSBudW1lcmljIHN0cmluZ3NcbiAqIC0gUHJpdmF0ZSBrZXkgcGF0aCBleGlzdGVuY2UgaXMgY2hlY2tlZCAod2FybmluZywgbm90IGVycm9yKVxuICpcbiAqIEBwYXJhbSByYXdGaWxlIC0gUmF3IGNvbmZpZyBmaWxlIGNvbnRlbnRzXG4gKiBAcmV0dXJucyBPYmplY3Qgd2l0aCBlcnJvcnMgYW5kIHdhcm5pbmdzIGFycmF5c1xuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVHaXRIdWJBcHBDb25maWcoXG4gIHJhd0ZpbGU6IENvbmZpZ0ZpbGUsXG4pOiB7IGVycm9yczogc3RyaW5nW107IHdhcm5pbmdzOiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblxuICBjb25zdCBhcHBJZCA9IHJhd0ZpbGUuZ2l0aHViX2FwcF9pZDtcbiAgY29uc3QgaW5zdGFsbGF0aW9uSWQgPSByYXdGaWxlLmdpdGh1Yl9hcHBfaW5zdGFsbGF0aW9uX2lkO1xuICBjb25zdCBwcml2YXRlS2V5UGF0aCA9IHJhd0ZpbGUuZ2l0aHViX2FwcF9wcml2YXRlX2tleV9wYXRoO1xuXG4gIGNvbnN0IGZpZWxkcyA9IFthcHBJZCwgaW5zdGFsbGF0aW9uSWQsIHByaXZhdGVLZXlQYXRoXTtcbiAgY29uc3Qgc2V0Q291bnQgPSBmaWVsZHMuZmlsdGVyKChmKSA9PiBmICE9PSB1bmRlZmluZWQgJiYgZiAhPT0gXCJcIikubGVuZ3RoO1xuXG4gIC8vIE5vIGZpZWxkcyBzZXQg4oCUIG5vdGhpbmcgdG8gdmFsaWRhdGVcbiAgaWYgKHNldENvdW50ID09PSAwKSB7XG4gICAgcmV0dXJuIHsgZXJyb3JzLCB3YXJuaW5ncyB9O1xuICB9XG5cbiAgLy8gUGFydGlhbCBjb25maWd1cmF0aW9uIOKAlCB3YXJuXG4gIGlmIChzZXRDb3VudCA+IDAgJiYgc2V0Q291bnQgPCAzKSB7XG4gICAgY29uc3QgbWlzc2luZzogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoIWFwcElkKSBtaXNzaW5nLnB1c2goXCJnaXRodWJfYXBwX2lkXCIpO1xuICAgIGlmICghaW5zdGFsbGF0aW9uSWQpIG1pc3NpbmcucHVzaChcImdpdGh1Yl9hcHBfaW5zdGFsbGF0aW9uX2lkXCIpO1xuICAgIGlmICghcHJpdmF0ZUtleVBhdGgpIG1pc3NpbmcucHVzaChcImdpdGh1Yl9hcHBfcHJpdmF0ZV9rZXlfcGF0aFwiKTtcbiAgICB3YXJuaW5ncy5wdXNoKFxuICAgICAgYEdpdEh1YiBBcHAgY29uZmlndXJhdGlvbiBpcyBwYXJ0aWFsbHkgc2V0IOKAlCBtaXNzaW5nOiAke1xuICAgICAgICBtaXNzaW5nLmpvaW4oXCIsIFwiKVxuICAgICAgfS4gYCArXG4gICAgICAgIFwiQWxsIHRocmVlIGZpZWxkcyAoZ2l0aHViX2FwcF9pZCwgZ2l0aHViX2FwcF9pbnN0YWxsYXRpb25faWQsIGdpdGh1Yl9hcHBfcHJpdmF0ZV9rZXlfcGF0aCkgXCIgK1xuICAgICAgICBcIm11c3QgYmUgc2V0IGZvciBHaXRIdWIgQXBwIGF1dGhlbnRpY2F0aW9uIHRvIHdvcmtcIixcbiAgICApO1xuICAgIHJldHVybiB7IGVycm9ycywgd2FybmluZ3MgfTtcbiAgfVxuXG4gIC8vIEFsbCB0aHJlZSBzZXQg4oCUIHZhbGlkYXRlIGZvcm1hdHNcbiAgaWYgKGFwcElkICYmICEvXlxcZCskLy50ZXN0KGFwcElkKSkge1xuICAgIGVycm9ycy5wdXNoKFxuICAgICAgYGdpdGh1Yl9hcHBfaWQgbXVzdCBiZSBhIG51bWVyaWMgc3RyaW5nLCBnb3QgJyR7YXBwSWR9J2AsXG4gICAgKTtcbiAgfVxuXG4gIGlmIChpbnN0YWxsYXRpb25JZCAmJiAhL15cXGQrJC8udGVzdChpbnN0YWxsYXRpb25JZCkpIHtcbiAgICBlcnJvcnMucHVzaChcbiAgICAgIGBnaXRodWJfYXBwX2luc3RhbGxhdGlvbl9pZCBtdXN0IGJlIGEgbnVtZXJpYyBzdHJpbmcsIGdvdCAnJHtpbnN0YWxsYXRpb25JZH0nYCxcbiAgICApO1xuICB9XG5cbiAgLy8gQ2hlY2sgcHJpdmF0ZSBrZXkgcGF0aCBleGlzdHMgKHdhcm5pbmcsIG5vdCBlcnJvciDigJQgcGF0aCBtYXkgYmUgY3JlYXRlZCBsYXRlcilcbiAgaWYgKHByaXZhdGVLZXlQYXRoKSB7XG4gICAgY29uc3QgZXhwYW5kZWRQYXRoID0gcHJpdmF0ZUtleVBhdGgucmVwbGFjZShcbiAgICAgIC9efi8sXG4gICAgICBEZW5vLmVudi5nZXQoXCJIT01FXCIpID8/IFwiXCIsXG4gICAgKTtcbiAgICB0cnkge1xuICAgICAgRGVuby5zdGF0U3luYyhleHBhbmRlZFBhdGgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgd2FybmluZ3MucHVzaChcbiAgICAgICAgYEdpdEh1YiBBcHAgcHJpdmF0ZSBrZXkgcGF0aCBkb2VzIG5vdCBleGlzdDogJyR7ZXhwYW5kZWRQYXRofScuIGAgK1xuICAgICAgICAgIFwiRW5zdXJlIHRoZSBmaWxlIGlzIGNyZWF0ZWQgYmVmb3JlIHRoZSB3b3JrZXIgc3RhcnRzXCIsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IGVycm9ycywgd2FybmluZ3MgfTtcbn1cblxuLyoqXG4gKiBXYXJuIGFib3V0IGByZXBvX2NvbmZpZ2AgZW50cmllcyBmb3IgcmVwb3MgdGhhdCBhcmUgbm90IG1vbml0b3JlZFxuICogKElzc3VlICM0MDMzKS5cbiAqXG4gKiBTdWNoIGFuIGVudHJ5IGlzIGRlYWQgY29uZmlnIOKAlCBub3RoaW5nIHJlYWRzIGl0IOKAlCBhbmQgaXQgc2lsZW50bHkgbWlzbGVhZHNcbiAqIGFueW9uZSBhdWRpdGluZyB3aGljaCByZXBvcyBhcmUgY29uZmlndXJlZC4gTWF0Y2hpbmcgaXMgY2FzZS1pbnNlbnNpdGl2ZSxcbiAqIGFuZCBubyB3YXJuaW5nIGlzIHJhaXNlZCB3aGVuIGByZXBvc2AgaXMgZW1wdHkgKGFuIHVuY29uZmlndXJlZCBob3N0KS5cbiAqXG4gKiBAcGFyYW0gY29uZmlnIC0gV29ya2VyIGNvbmZpZ3VyYXRpb25cbiAqIEByZXR1cm5zIE5vbi1ibG9ja2luZyB3YXJuaW5ncywgb25lIHBlciBvcnBoYW4gZW50cnlcbiAqL1xuZnVuY3Rpb24gd2Fybk9ycGhhblJlcG9Db25maWcoY29uZmlnOiBXb3JrZXJDb25maWcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHJlcG9Db25maWcgPSBjb25maWcucmVwb0NvbmZpZztcbiAgaWYgKCFyZXBvQ29uZmlnIHx8IGNvbmZpZy5yZXBvcy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcblxuICBjb25zdCBtb25pdG9yZWQgPSBuZXcgU2V0KGNvbmZpZy5yZXBvcy5tYXAoKHIpID0+IHIudG9Mb3dlckNhc2UoKSkpO1xuICByZXR1cm4gT2JqZWN0LmtleXMocmVwb0NvbmZpZylcbiAgICAuZmlsdGVyKChyZXBvKSA9PiAhbW9uaXRvcmVkLmhhcyhyZXBvLnRvTG93ZXJDYXNlKCkpKVxuICAgIC5tYXAoKHJlcG8pID0+XG4gICAgICBgcmVwb19jb25maWcgY29udGFpbnMgYW4gZW50cnkgZm9yICcke3JlcG99Jywgd2hpY2ggaXMgbm90IGluIHJlcG9zLiBgICtcbiAgICAgIFwiSXQgaXMgZGVhZCBjb25maWcgYW5kIGlzIG5ldmVyIHJlYWQg4oCUIHJlbW92ZSBpdCBvciBhZGQgdGhlIHJlcG8gdG8gcmVwb3NcIlxuICAgICk7XG59XG5cbi8qKlxuICogRnVsbCBjb25maWd1cmF0aW9uIHZhbGlkYXRpb24uXG4gKlxuICogVmFsaWRhdGVzIGFsbCBjb25maWd1cmF0aW9uIHNldHRpbmdzIGFuZCByZXR1cm5zIHN0cnVjdHVyZWQgcmVzdWx0c1xuICogaW5jbHVkaW5nIGVycm9ycyAoYmxvY2tpbmcpIGFuZCB3YXJuaW5ncyAobm9uLWJsb2NraW5nKS5cbiAqXG4gKiBAcGFyYW0gY29uZmlnIC0gV29ya2VyIGNvbmZpZ3VyYXRpb25cbiAqIEByZXR1cm5zIFZhbGlkYXRpb24gcmVzdWx0IHdpdGggZXJyb3JzIGFuZCB3YXJuaW5nc1xuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVDb25maWdGdWxsKFxuICBjb25maWc6IFdvcmtlckNvbmZpZyxcbiAgcmF3RmlsZT86IENvbmZpZ0ZpbGUsXG4pOiBDb25maWdWYWxpZGF0aW9uUmVzdWx0IHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBTdGVwIDE6IFZhbGlkYXRlIHJlcXVpcmVkIGZpZWxkc1xuICBlcnJvcnMucHVzaCguLi52YWxpZGF0ZVJlcXVpcmVkRmllbGRzKGNvbmZpZykpO1xuXG4gIC8vIFN0ZXAgMWI6IG1heENvbmN1cnJlbnRJc3N1ZXMgcmFuZ2UgKElzc3VlICM0MTc0KS4gUmVhZCB0aGUgcmF3IGZpbGUgdmFsdWVcbiAgLy8gc28gbm9uLWludGVnZXJzIGFuZCBzdHJpbmdzIGFyZSByZWplY3RlZCBiZWZvcmUgY29lcmNpb247IGFic2VudCBtZWFuc1xuICAvLyB0aGUgZGVmYXVsdCAoMSkgYXBwbGllcyBhbmQgaXMgZmluZS5cbiAgaWYgKHJhd0ZpbGUgJiYgcmF3RmlsZS5tYXhfY29uY3VycmVudF9pc3N1ZXMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHYgPSByYXdGaWxlLm1heF9jb25jdXJyZW50X2lzc3VlcyBhcyB1bmtub3duO1xuICAgIGlmIChcbiAgICAgIHR5cGVvZiB2ICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYpIHx8IHYgPCAxIHx8IHYgPiA4XG4gICAgKSB7XG4gICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgYEludmFsaWQgbWF4X2NvbmN1cnJlbnRfaXNzdWVzOiAke0pTT04uc3RyaW5naWZ5KHYpfS4gYCArXG4gICAgICAgICAgXCJJdCBtdXN0IGJlIGFuIGludGVnZXIgYmV0d2VlbiAxIGFuZCA4LlwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBTdGVwIDFjOiB1cGRhdGUgbW9kZSBhbmQgaXRzIHBpbnMgKElzc3VlICM2MjIpLiBWYWxpZGF0ZWQgZnJvbSB0aGVcbiAgLy8gcmVzb2x2ZWQgY29uZmlnIHNvIGEgY2FsbGVyIHRoYXQgYXNzZW1ibGVkIG9uZSBpdHNlbGYgaXMgY292ZXJlZCB0b28uXG4gIGVycm9ycy5wdXNoKC4uLnZhbGlkYXRlVXBkYXRlTW9kZVNldHRpbmdzKHtcbiAgICB1cGRhdGVNb2RlOiBjb25maWcudXBkYXRlTW9kZSxcbiAgICBwaW5uZWRSZWY6IGNvbmZpZy5waW5uZWRSZWYsXG4gICAgcGlubmVkVG9vbFZlcnNpb25zOiBjb25maWcucGlubmVkVG9vbFZlcnNpb25zLFxuICB9KSk7XG5cbiAgLy8gU3RlcCAyOiBWYWxpZGF0ZSB1c2VybmFtZSBmb3JtYXRzIGZvciBhbGxvd2VkIGF1dGhvcnNcbiAgZm9yIChjb25zdCBhdXRob3Igb2YgY29uZmlnLmFsbG93ZWRBdXRob3JzKSB7XG4gICAgaWYgKCFhdXRob3IpIGNvbnRpbnVlO1xuICAgIGlmICghdmFsaWRhdGVVc2VybmFtZUZvcm1hdChhdXRob3IpKSB7XG4gICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgYEludmFsaWQgdXNlcm5hbWUgZm9ybWF0IGluIEFMTE9XRURfQVVUSE9SUzogJyR7YXV0aG9yfScuIGAgK1xuICAgICAgICAgIFwiVXNlcm5hbWVzIG11c3QgYmUgYWxwaGFudW1lcmljIHdpdGggaHlwaGVucy91bmRlcnNjb3JlcyBvbmx5XCIsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFN0ZXAgMzogVmFsaWRhdGUgcmVwb3NpdG9yeSBmb3JtYXRzXG4gIGZvciAoY29uc3QgcmVwbyBvZiBjb25maWcucmVwb3MpIHtcbiAgICBpZiAoIXZhbGlkYXRlUmVwb0Zvcm1hdChyZXBvKSkge1xuICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgIGBJbnZhbGlkIHJlcG9zaXRvcnkgZm9ybWF0OiAnJHtyZXBvfScuIGAgK1xuICAgICAgICAgIFwiUmVwb3NpdG9yeSBuYW1lcyBtdXN0IGJlIGluICdvd25lci9yZXBvJyBmb3JtYXRcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gU3RlcCA0OiBWYWxpZGF0ZSBsYWJlbCBmb3JtYXRzXG4gIGZvciAoY29uc3QgbGFiZWwgb2YgY29uZmlnLmlzc3VlTGFiZWxzKSB7XG4gICAgaWYgKCF2YWxpZGF0ZUxhYmVsRm9ybWF0KGxhYmVsKSkge1xuICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgIGBJbnZhbGlkIGxhYmVsIGZvcm1hdDogJyR7bGFiZWx9Jy4gYCArXG4gICAgICAgICAgXCJMYWJlbHMgbXVzdCBub3QgY29udGFpbiBzaGVsbCBtZXRhY2hhcmFjdGVyc1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBTdGVwIDU6IFZhbGlkYXRlIGF1dGhvcmlzZWQgY29tbWVudGVycyBmb3JtYXRzXG4gIGZvciAoY29uc3QgY29tbWVudGVyIG9mIGNvbmZpZy5hdXRob3Jpc2VkQ29tbWVudGVycykge1xuICAgIGlmICghY29tbWVudGVyKSBjb250aW51ZTtcbiAgICBpZiAoIXZhbGlkYXRlVXNlcm5hbWVGb3JtYXQoY29tbWVudGVyKSkge1xuICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgIGBJbnZhbGlkIHVzZXJuYW1lIGZvcm1hdCBpbiBBVVRIT1JJWkVEX0NPTU1FTlRFUlM6ICcke2NvbW1lbnRlcn0nYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gU3RlcCA2OiBWYWxpZGF0ZSBQUiByZXZpZXdlcnMgZm9ybWF0c1xuICBmb3IgKGNvbnN0IHJldmlld2VyIG9mIGNvbmZpZy5wclJldmlld2Vycykge1xuICAgIGlmICghcmV2aWV3ZXIpIGNvbnRpbnVlO1xuICAgIGlmICghdmFsaWRhdGVVc2VybmFtZUZvcm1hdChyZXZpZXdlcikpIHtcbiAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICBgSW52YWxpZCB1c2VybmFtZSBmb3JtYXQgaW4gUFJfUkVWSUVXRVJTOiAnJHtyZXZpZXdlcn0nLiBgICtcbiAgICAgICAgICBcIlVzZXJuYW1lcyBtdXN0IGJlIGFscGhhbnVtZXJpYyB3aXRoIGh5cGhlbnMvdW5kZXJzY29yZXMgb25seVwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBTdGVwIDc6IFNlY3VyaXR5IHdhcm5pbmdzIChub24tYmxvY2tpbmcpXG4gIHdhcm5pbmdzLnB1c2goLi4ud2Fybkluc2VjdXJlQ29uZmlnKGNvbmZpZykpO1xuXG4gIC8vIFN0ZXAgODogb3JwaGFuIHJlcG9fY29uZmlnIGRldGVjdGlvbiAoSXNzdWUgIzQwMzMpIOKAlCBkZWFkIHBlci1yZXBvIGNvbmZpZ1xuICAvLyBpcyBuZXZlciByZWFkIGFuZCBtaXNsZWFkcyBhIGNvbmZpZyBhdWRpdC4gTm9uLWJsb2NraW5nLlxuICB3YXJuaW5ncy5wdXNoKC4uLndhcm5PcnBoYW5SZXBvQ29uZmlnKGNvbmZpZykpO1xuXG4gIC8vIFN0ZXAgOTogR2l0SHViIEFwcCBjb25maWd1cmF0aW9uIHZhbGlkYXRpb24gKElzc3VlICM5NTcpXG4gIGlmIChyYXdGaWxlKSB7XG4gICAgY29uc3QgYXBwVmFsaWRhdGlvbiA9IHZhbGlkYXRlR2l0SHViQXBwQ29uZmlnKHJhd0ZpbGUpO1xuICAgIGVycm9ycy5wdXNoKC4uLmFwcFZhbGlkYXRpb24uZXJyb3JzKTtcbiAgICB3YXJuaW5ncy5wdXNoKC4uLmFwcFZhbGlkYXRpb24ud2FybmluZ3MpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICB2YWxpZDogZXJyb3JzLmxlbmd0aCA9PT0gMCxcbiAgICBlcnJvcnMsXG4gICAgd2FybmluZ3MsXG4gIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBSZXBvc2l0b3J5IEFsbG93bGlzdCBWYWxpZGF0aW9uXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIENoZWNrIGlmIGEgcmVwb3NpdG9yeSBpcyBpbiB0aGUgY29uZmlndXJlZCBSRVBPUyBhbGxvd2xpc3QuXG4gKlxuICogUHJvdmlkZXMgZGVmZW5jZSBpbiBkZXB0aCBieSBlbnN1cmluZyB0aGUgd29ya2VyIG9ubHkgcHJvY2Vzc2VzXG4gKiByZXBvc2l0b3JpZXMgdGhhdCBoYXZlIGJlZW4gZXhwbGljaXRseSBjb25maWd1cmVkLlxuICpcbiAqIEBwYXJhbSByZXBvcyAtIENvbmZpZ3VyZWQgcmVwb3NpdG9yeSBhbGxvd2xpc3RcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBuYW1lIHRvIGNoZWNrIChlLmcuLCBcIm93bmVyL3JlcG9cIilcbiAqIEByZXR1cm5zIHRydWUgaWYgdGhlIHJlcG9zaXRvcnkgaXMgaW4gdGhlIGFsbG93bGlzdFxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNSZXBvQWxsb3dlZChyZXBvczogc3RyaW5nW10sIHJlcG86IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIXJlcG8pIHJldHVybiBmYWxzZTtcbiAgaWYgKHJlcG9zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gcmVwb3MuaW5jbHVkZXMocmVwbyk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBHaXQgVVJMIFZhbGlkYXRpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogVmFsaWRhdGUgYSBnaXQgVVJMIHRvIGVuc3VyZSBpdCBtYXRjaGVzIHRoZSBleHBlY3RlZCByZXBvc2l0b3J5LlxuICpcbiAqIFByZXZlbnRzOlxuICogLSBQYXRoIHRyYXZlcnNhbCBhdHRhY2tzICguLi8pXG4gKiAtIFVSTCBtYW5pcHVsYXRpb24gdG8gY2xvbmUgZnJvbSB1bmV4cGVjdGVkIGhvc3RzXG4gKiAtIENyZWRlbnRpYWwgaW5qZWN0aW9uIGluIFVSTHNcbiAqIC0gTmV3bGluZSBpbmplY3Rpb25cbiAqIC0gUXVlcnkgcGFyYW1ldGVyIGluamVjdGlvblxuICpcbiAqIFN1cHBvcnRlZCBVUkwgZm9ybWF0czpcbiAqICAgLSBodHRwczovL2dpdGh1Yi5jb20vb3duZXIvcmVwby5naXRcbiAqICAgLSBodHRwczovL2dpdGh1Yi5jb20vb3duZXIvcmVwb1xuICogICAtIGdpdEBnaXRodWIuY29tOm93bmVyL3JlcG8uZ2l0XG4gKlxuICogQHBhcmFtIHVybCAtIFRoZSBnaXQgVVJMIHRvIHZhbGlkYXRlXG4gKiBAcGFyYW0gZXhwZWN0ZWRSZXBvIC0gVGhlIGV4cGVjdGVkIHJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcmV0dXJucyBWYWxpZGF0aW9uIHJlc3VsdCB3aXRoIHJlYXNvbiBpZiBpbnZhbGlkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUdpdFVybChcbiAgdXJsOiBzdHJpbmcsXG4gIGV4cGVjdGVkUmVwbzogc3RyaW5nLFxuKTogR2l0VXJsVmFsaWRhdGlvblJlc3VsdCB7XG4gIC8vIFJlamVjdCBlbXB0eSBVUkxcbiAgaWYgKCF1cmwpIHtcbiAgICByZXR1cm4geyB2YWxpZDogZmFsc2UsIHJlYXNvbjogXCJlbXB0eV91cmxcIiB9O1xuICB9XG5cbiAgLy8gUmVqZWN0IFVSTHMgd2l0aCBuZXdsaW5lcyAoaW5qZWN0aW9uIGF0dGVtcHQpXG4gIGlmICh1cmwuaW5jbHVkZXMoXCJcXG5cIikgfHwgdXJsLmluY2x1ZGVzKFwiXFxyXCIpKSB7XG4gICAgcmV0dXJuIHsgdmFsaWQ6IGZhbHNlLCByZWFzb246IFwibmV3bGluZV9pbmplY3Rpb25cIiB9O1xuICB9XG5cbiAgLy8gUmVqZWN0IFVSTHMgd2l0aCBwYXRoIHRyYXZlcnNhbCBzZXF1ZW5jZXNcbiAgaWYgKHVybC5pbmNsdWRlcyhcIi4uXCIpKSB7XG4gICAgcmV0dXJuIHsgdmFsaWQ6IGZhbHNlLCByZWFzb246IFwicGF0aF90cmF2ZXJzYWxcIiB9O1xuICB9XG5cbiAgLy8gUmVqZWN0IFVSTHMgd2l0aCBlbWJlZGRlZCBjcmVkZW50aWFscyAodXNlcjpwYXNzQClcbiAgaWYgKC86XFwvXFwvW14vXSo6W14vXSpALy50ZXN0KHVybCkpIHtcbiAgICByZXR1cm4geyB2YWxpZDogZmFsc2UsIHJlYXNvbjogXCJlbWJlZGRlZF9jcmVkZW50aWFsc1wiIH07XG4gIH1cblxuICAvLyBSZWplY3QgVVJMcyB3aXRoIHF1ZXJ5IHBhcmFtZXRlcnNcbiAgaWYgKHVybC5pbmNsdWRlcyhcIj9cIikpIHtcbiAgICByZXR1cm4geyB2YWxpZDogZmFsc2UsIHJlYXNvbjogXCJxdWVyeV9wYXJhbWV0ZXJzXCIgfTtcbiAgfVxuXG4gIC8vIEV4dHJhY3Qgb3duZXIvcmVwbyBmcm9tIFVSTFxuICBsZXQgZXh0cmFjdGVkT3duZXIgPSBcIlwiO1xuICBsZXQgZXh0cmFjdGVkUmVwb05hbWUgPSBcIlwiO1xuXG4gIC8vIEhhbmRsZSBIVFRQUyBVUkxzOiBodHRwczovL2dpdGh1Yi5jb20vb3duZXIvcmVwby5naXQgb3IgaHR0cHM6Ly9naXRodWIuY29tL293bmVyL3JlcG9cbiAgY29uc3QgaHR0cHNNYXRjaCA9IHVybC5tYXRjaChcbiAgICAvXmh0dHBzOlxcL1xcL2dpdGh1YlxcLmNvbVxcLyhbYS16QS1aMC05Xy1dKylcXC8oW2EtekEtWjAtOV8uLV0rKSQvLFxuICApO1xuICBpZiAoaHR0cHNNYXRjaCkge1xuICAgIGV4dHJhY3RlZE93bmVyID0gaHR0cHNNYXRjaFsxXSE7XG4gICAgZXh0cmFjdGVkUmVwb05hbWUgPSBodHRwc01hdGNoWzJdITtcbiAgfSBlbHNlIHtcbiAgICAvLyBIYW5kbGUgU1NIIFVSTHM6IGdpdEBnaXRodWIuY29tOm93bmVyL3JlcG8uZ2l0XG4gICAgY29uc3Qgc3NoTWF0Y2ggPSB1cmwubWF0Y2goXG4gICAgICAvXmdpdEBnaXRodWJcXC5jb206KFthLXpBLVowLTlfLV0rKVxcLyhbYS16QS1aMC05Xy4tXSspJC8sXG4gICAgKTtcbiAgICBpZiAoc3NoTWF0Y2gpIHtcbiAgICAgIGV4dHJhY3RlZE93bmVyID0gc3NoTWF0Y2hbMV0hO1xuICAgICAgZXh0cmFjdGVkUmVwb05hbWUgPSBzc2hNYXRjaFsyXSE7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHZhbGlkOiBmYWxzZSxcbiAgICAgICAgcmVhc29uOiBcInVucmVjb2duaXNlZF9mb3JtYXRfb3Jfbm9uX2dpdGh1Yl9ob3N0XCIsXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIFN0cmlwIC5naXQgc3VmZml4IGlmIHByZXNlbnRcbiAgaWYgKGV4dHJhY3RlZFJlcG9OYW1lLmVuZHNXaXRoKFwiLmdpdFwiKSkge1xuICAgIGV4dHJhY3RlZFJlcG9OYW1lID0gZXh0cmFjdGVkUmVwb05hbWUuc2xpY2UoMCwgLTQpO1xuICB9XG5cbiAgY29uc3QgZXh0cmFjdGVkUmVwbyA9IGAke2V4dHJhY3RlZE93bmVyfS8ke2V4dHJhY3RlZFJlcG9OYW1lfWA7XG5cbiAgLy8gVmFsaWRhdGUgZXh0cmFjdGVkIHJlcG8gbWF0Y2hlcyBleHBlY3RlZCByZXBvXG4gIGlmIChleHRyYWN0ZWRSZXBvICE9PSBleHBlY3RlZFJlcG8pIHtcbiAgICByZXR1cm4geyB2YWxpZDogZmFsc2UsIHJlYXNvbjogXCJyZXBvX21pc21hdGNoXCIgfTtcbiAgfVxuXG4gIHJldHVybiB7IHZhbGlkOiB0cnVlIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7O0NBUUMsR0FTRCxTQUFTLHNCQUFzQixRQUFRLGtCQUFrQjtBQUN6RCxTQUNFLHVCQUF1QixFQUN2QixVQUFVLEVBQ1Ysc0JBQXNCLFFBQ2pCLHdCQUF3QjtBQUMvQixTQUNFLHlCQUF5QixFQUN6QiwyQkFBMkIsRUFDM0IsWUFBWSxFQUNaLFlBQVksUUFDUCx1QkFBdUI7QUFzQjlCLGdGQUFnRjtBQUNoRiw4QkFBOEI7QUFDOUIsZ0ZBQWdGO0FBRWhGOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sU0FBUyxtQkFBbUIsSUFBWTtFQUM3QyxJQUFJLENBQUMsTUFBTSxPQUFPO0VBQ2xCLE9BQU8sb0NBQW9DLElBQUksQ0FBQztBQUNsRDtBQUVBOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLHVCQUF1QixRQUFnQjtFQUNyRCxJQUFJLENBQUMsVUFBVSxPQUFPO0VBQ3RCLE9BQU8sNkJBQTZCLElBQUksQ0FBQztBQUMzQztBQUVBOzs7Ozs7Ozs7Q0FT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
// denoCacheMetadata=15202286330467180119,13040386779732369170