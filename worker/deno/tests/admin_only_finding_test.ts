/**
 * Tests for admin_only_finding.ts — recognising a repository-admin finding the
 * worker cannot resolve (Issue #53).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  isAdminOnlyRepoSettingsIssue,
  parseRepoSettingsFindingId,
} from "../lib/admin_only_finding.ts";

Deno.test("isAdminOnlyRepoSettingsIssue - a BP-REPO finding-id marker matches", () => {
  for (
    const id of [
      "BP-REPO-RULESET-NO-REVIEW",
      "BP-REPO-CODEOWNERS-NOT-ENFORCED",
      "BP-REPO-SECRET-SCANNING-OFF",
      "BP-REPO-DEFAULT-TOKEN-WRITE",
    ]
  ) {
    assertEquals(
      isAdminOnlyRepoSettingsIssue(`<!-- finding-id: ${id} -->\n\nbody`),
      true,
      id,
    );
  }
});

Deno.test("isAdminOnlyRepoSettingsIssue - the admin-action prose matches even without the marker", () => {
  assertEquals(
    isAdminOnlyRepoSettingsIssue(
      "## Suggested fix\n\nRepository admin action — the worker cannot change " +
        "repository settings. Settings → Rules → require a review.",
    ),
    true,
  );
});

Deno.test("isAdminOnlyRepoSettingsIssue - a non-repo finding does NOT match", () => {
  for (
    const body of [
      "<!-- finding-id: BP-LINTER-github-actions -->\n\nadd actionlint",
      "<!-- finding-id: BP-SUPPLY-CHAIN-STALE -->\n\nbump deps",
      "Fix the null pointer in main.ts",
      "",
    ]
  ) {
    assertEquals(isAdminOnlyRepoSettingsIssue(body), false, body);
  }
});

Deno.test("isAdminOnlyRepoSettingsIssue - matching is case-insensitive and whitespace-tolerant", () => {
  assertEquals(
    isAdminOnlyRepoSettingsIssue(
      "<!--   finding-id:   bp-repo-secret-scanning-off   -->",
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// parseRepoSettingsFindingId — the one source of truth for the marker, shared
// with setup's audit-issue close-out (Issue #2629).
// ---------------------------------------------------------------------------

Deno.test("parseRepoSettingsFindingId - a valid marker yields its finding id", () => {
  assertEquals(
    parseRepoSettingsFindingId(
      "<!-- finding-id: BP-REPO-DEFAULT-TOKEN-WRITE -->\n\n## Finding",
    ),
    "BP-REPO-DEFAULT-TOKEN-WRITE",
  );
});

Deno.test("parseRepoSettingsFindingId - whitespace variants and case are normalised", () => {
  for (
    const body of [
      "<!--finding-id:BP-REPO-SECRET-SCANNING-OFF-->",
      "<!--   finding-id:   BP-REPO-SECRET-SCANNING-OFF   -->",
      "<!--\tfinding-id:\tbp-repo-secret-scanning-off\n-->",
      "intro text\n<!-- finding-id: BP-REPO-SECRET-SCANNING-OFF -->\nmore",
    ]
  ) {
    assertEquals(
      parseRepoSettingsFindingId(body),
      "BP-REPO-SECRET-SCANNING-OFF",
      body,
    );
  }
});

Deno.test("parseRepoSettingsFindingId - a non-BP-REPO id yields null", () => {
  for (
    const body of [
      "<!-- finding-id: BP-WORKER-TOKEN-CAN-EDIT-RULESETS -->",
      "<!-- finding-id: BP-LINTER-github-actions -->",
      "<!-- finding-id: SEC-0123abcd -->",
    ]
  ) {
    assertEquals(parseRepoSettingsFindingId(body), null, body);
  }
});

Deno.test("parseRepoSettingsFindingId - a body with no marker yields null", () => {
  for (
    const body of [
      "",
      "Repository admin action — the worker cannot change repository settings.",
      "finding-id: BP-REPO-DEFAULT-TOKEN-WRITE (not inside an HTML comment)",
    ]
  ) {
    assertEquals(parseRepoSettingsFindingId(body), null, body);
  }
});
