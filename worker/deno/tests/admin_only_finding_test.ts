/**
 * Tests for admin_only_finding.ts — recognising a repository-admin finding the
 * worker cannot resolve (Issue #53).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { isAdminOnlyRepoSettingsIssue } from "../lib/admin_only_finding.ts";

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
