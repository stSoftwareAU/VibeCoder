/**
 * Tests for unknown config key detection (Issue #1334).
 *
 * Validates that .config.json is checked for unknown attributes at startup,
 * catching typos and camelCase/snake_case mistakes with clear warnings.
 */

import { assertEquals } from "@std/assert";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
  suggestSimilarKey,
} from "../lib/config_unknown_keys.ts";

// --- Known keys completeness ---

Deno.test("config_unknown_keys - KNOWN_CONFIG_KEYS includes core fields", () => {
  // Issue #1834: `issue_labels` removed from accepted keys.
  const coreFields = [
    "allowed_authors",
    "pr_reviewers",
    "repos",
    "authorized_commenters",
    "author_source",
    "exclusion_team",
    "repo_config",
    "claude_model",
    "phase_model_overrides",
  ];
  for (const field of coreFields) {
    assertEquals(
      KNOWN_CONFIG_KEYS.has(field),
      true,
      `Missing core field: ${field}`,
    );
  }
});

Deno.test("config_unknown_keys - KNOWN_CONFIG_KEYS includes label fields", () => {
  // Issue #1834: `work_on_label` and `low_priority_label` removed from
  // accepted keys (work-on and low-priority are hardwired).
  // Issue #2031: needs_clarification_label retired (no longer a known key).
  // Issue #2030: answered_label retired (no longer a known key).
  const labelFields = [
    "failed_once_label",
    "failed_label",
    "refine_issue_label",
    "planning_label",
    "question_label",
    "needs_revision_label",
    "needs_human_label",
  ];
  for (const field of labelFields) {
    assertEquals(
      KNOWN_CONFIG_KEYS.has(field),
      true,
      `Missing label field: ${field}`,
    );
  }
});

Deno.test("config_unknown_keys - hardwired discovery label keys are NOT accepted (Issue #1834)", () => {
  // Issue #1834: top-priority, work-on, and low-priority are hardwired
  // discovery labels. The corresponding `.config.json` keys must be
  // rejected so stale configs surface as unknown-key warnings.
  for (
    const removed of ["issue_labels", "work_on_label", "low_priority_label"]
  ) {
    assertEquals(
      KNOWN_CONFIG_KEYS.has(removed),
      false,
      `${removed} should no longer be a known config key`,
    );
  }
});

Deno.test("config_unknown_keys - issue_labels in config triggers unknown-key warning (Issue #1834)", () => {
  // The bug from Issue #1834: a config with issue_labels was silently
  // honoured and could drop top-priority. After the fix the key fails
  // validation with a clear warning.
  const data = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    issue_labels: ["help wanted", "work-on"],
  };
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.field, "issue_labels");
});

Deno.test("config_unknown_keys - KNOWN_CONFIG_KEYS includes operational fields", () => {
  const opFields = [
    "claude_timeout",
    "claude_kill_after",
    "sleep_interval",
    "shuffle_repos",
    "worker_name",
    "enable_model_fallback",
    "min_disk_space_mb",
    "sync_milestone_branches",
    "milestone_sync_cooldown_seconds",
    "health_cache_ttl",
    "quality_check_timeout",
  ];
  for (const field of opFields) {
    assertEquals(
      KNOWN_CONFIG_KEYS.has(field),
      true,
      `Missing operational field: ${field}`,
    );
  }
});

// --- detectUnknownConfigKeys ---

Deno.test("config_unknown_keys - detectUnknownConfigKeys returns empty for valid config", () => {
  const data = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    claude_timeout: 7200,
  };
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 0);
});

Deno.test("config_unknown_keys - detectUnknownConfigKeys accepts author_source and exclusion_team (Issue #252)", () => {
  const data = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    author_source: "github",
    exclusion_team: "stSoftwareAU/vibe-workers",
  };
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 0);
});

Deno.test("config_unknown_keys - detectUnknownConfigKeys returns empty for empty object", () => {
  const warnings = detectUnknownConfigKeys({});
  assertEquals(warnings.length, 0);
});

Deno.test("config_unknown_keys - detectUnknownConfigKeys detects unknown key", () => {
  const data = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    typo_field: "oops",
  };
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.field, "typo_field");
});

Deno.test("config_unknown_keys - detectUnknownConfigKeys detects camelCase key and suggests snake_case", () => {
  const data = {
    allowedAuthors: ["user1"],
  };
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.field, "allowedAuthors");
  // Should suggest the snake_case equivalent
  assertEquals(warnings[0]!.suggestion, "allowed_authors");
});

Deno.test("config_unknown_keys - detectUnknownConfigKeys detects claudeTimeout camelCase", () => {
  const data = {
    claudeTimeout: 7200,
  };
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.field, "claudeTimeout");
  assertEquals(warnings[0]!.suggestion, "claude_timeout");
});

Deno.test("config_unknown_keys - detectUnknownConfigKeys detects multiple unknown keys", () => {
  const data = {
    repos: ["org/repo"],
    allowedAuthors: ["user1"],
    sleepInterval: 60,
    completely_fake: true,
  };
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 3);
  const fields = warnings.map((w) => w.field).sort();
  assertEquals(fields, ["allowedAuthors", "completely_fake", "sleepInterval"]);
});

Deno.test("config_unknown_keys - detectUnknownConfigKeys accepts all known fields without warnings", () => {
  // Build an object with every known key to ensure none are false positives
  const data: Record<string, unknown> = {};
  for (const key of KNOWN_CONFIG_KEYS) {
    data[key] = "test";
  }
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 0);
});

// --- suggestSimilarKey ---

Deno.test("config_unknown_keys - suggestSimilarKey finds camelCase to snake_case match", () => {
  const result = suggestSimilarKey("allowedAuthors");
  assertEquals(result, "allowed_authors");
});

Deno.test("config_unknown_keys - suggestSimilarKey finds claudeModel match", () => {
  const result = suggestSimilarKey("claudeModel");
  assertEquals(result, "claude_model");
});

Deno.test("config_unknown_keys - suggestSimilarKey finds shuffleRepos match", () => {
  const result = suggestSimilarKey("shuffleRepos");
  assertEquals(result, "shuffle_repos");
});

Deno.test("config_unknown_keys - suggestSimilarKey returns null for unrecognised key", () => {
  const result = suggestSimilarKey("completely_unknown_field_xyz");
  assertEquals(result, null);
});

Deno.test("config_unknown_keys - suggestSimilarKey finds close typo match", () => {
  // "repos" vs "repo" — close enough to suggest
  const result = suggestSimilarKey("repo");
  assertEquals(result, "repos");
});

Deno.test("config_unknown_keys - suggestSimilarKey finds phaseModelOverrides match", () => {
  const result = suggestSimilarKey("phaseModelOverrides");
  assertEquals(result, "phase_model_overrides");
});

// --- Warning message formatting ---

Deno.test("config_unknown_keys - warning message includes suggestion when available", () => {
  const data = { claudeTimeout: 7200 };
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 1);
  assertEquals(
    warnings[0]!.message.includes("claude_timeout"),
    true,
    "Warning message should mention the suggested key",
  );
});

Deno.test("config_unknown_keys - warning message for truly unknown key has no suggestion", () => {
  const data = { xyzzy_plugh: 42 };
  const warnings = detectUnknownConfigKeys(data);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.suggestion, null);
  assertEquals(
    warnings[0]!.message.includes("Unknown"),
    true,
    "Warning message should indicate the key is unknown",
  );
});
