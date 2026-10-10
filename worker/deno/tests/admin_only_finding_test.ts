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
import { REPO_ADMIN_ACTION } from "../lib/repo_settings_scanner.ts";
import { assertLinearGrowth } from "./support/growth.ts";

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

Deno.test("isAdminOnlyRepoSettingsIssue - the marker only inside an inline code span is NOT admin-only (Issue #3295)", () => {
  for (
    const body of [
      "The scanner files `<!-- finding-id: BP-REPO-DEFAULT-TOKEN-WRITE -->` on each finding.",
      "Double-backtick span: `` <!-- finding-id: BP-REPO-SECRET-SCANNING-OFF --> `` here.",
    ]
  ) {
    assertEquals(isAdminOnlyRepoSettingsIssue(body), false, body);
  }
});

Deno.test("isAdminOnlyRepoSettingsIssue - the marker only inside a fenced code block or blockquote is NOT admin-only (Issue #3295)", () => {
  for (
    const body of [
      "Example body:\n\n```markdown\n<!-- finding-id: BP-REPO-RULESET-NO-REVIEW -->\n```\n\nEnd.",
      "~~~\n<!-- finding-id: BP-REPO-RULESET-NO-REVIEW -->\n~~~",
      "> <!-- finding-id: BP-REPO-RULESET-NO-REVIEW -->\n\nQuoted above.",
    ]
  ) {
    assertEquals(isAdminOnlyRepoSettingsIssue(body), false, body);
  }
});

Deno.test("isAdminOnlyRepoSettingsIssue - the admin-action prose only inside backticks, a code fence or a blockquote is NOT admin-only (Issue #3295)", () => {
  for (
    const body of [
      "The scanner writes `Repository admin action — the worker cannot change repository settings.` as its fix.",
      "Fix text:\n\n```\nRepository admin action — the worker cannot change repository settings.\n```\n",
      "> Repository admin action — the worker cannot change repository settings.\n\nThat line is wrong.",
    ]
  ) {
    assertEquals(isAdminOnlyRepoSettingsIssue(body), false, body);
  }
});

Deno.test("isAdminOnlyRepoSettingsIssue - a scanner-format body is still admin-only with only the marker or only the prose (Issue #3295)", () => {
  const markerOnly =
    "<!-- finding-id: BP-REPO-DEFAULT-TOKEN-WRITE -->\n\n## Finding\n\n" +
    "The default `GITHUB_TOKEN` is read-write.\n\n```text\npermissions: write-all\n```\n\n" +
    "## Suggested fix\n\nSet the default token to read-only.";
  const proseOnly =
    "## Finding\n\nThe default `GITHUB_TOKEN` is read-write.\n\n" +
    "```text\npermissions: write-all\n```\n\n## Suggested fix\n\n" +
    "Repository admin action — the worker cannot change repository settings. " +
    "Settings → Actions → read-only.";
  const markerOnlyCrlf = markerOnly.replace(/\n/g, "\r\n");

  for (const body of [markerOnly, proseOnly, markerOnlyCrlf]) {
    assertEquals(isAdminOnlyRepoSettingsIssue(body), true, body);
  }
});

Deno.test("isAdminOnlyRepoSettingsIssue - hostile backtick and fence runs scale linearly (Issue #3295)", () => {
  for (
    const build of [
      // Fence-opener hostile case: a long backtick run at the start of a line
      // never reaches the inline-code-span regex at all — it is swallowed by
      // the fence-opener branch instead, so this alone does not exercise the
      // `(?<!`)` lookbehind that keeps that regex linear.
      (chars: number) => "`".repeat(chars) + "x",
      (chars: number) => "` ".repeat(chars / 2) + "``x",
      (chars: number) => "```\n" + "x\n".repeat(chars / 2),
      // Code-span hostile case: a long backtick run NOT at the start of a
      // line falls through to the inline-code-span regex, which is the one
      // the `(?<!`)` lookbehind keeps linear.
      (chars: number) => "x" + "`".repeat(chars) + "x",
    ]
  ) {
    const result = assertLinearGrowth(
      "isAdminOnlyRepoSettingsIssue, hostile backtick/fence runs",
      build,
      isAdminOnlyRepoSettingsIssue,
      { baseChars: 10_000 },
    );
    assertEquals(result, false);
  }
});

Deno.test("isAdminOnlyRepoSettingsIssue - the fragment without the scanner's lead-in is NOT admin-only (Issue #3360)", () => {
  for (
    const body of [
      "The scanner's fix says the worker cannot change repository settings, so it hands off.",
      '- [ ] A body quoting "the worker cannot change repository settings" is not admin-only.',
      "- [ ] A body quoting \u201cthe worker cannot change repository settings\u201d is not admin-only.",
      'Repository admin action and "the worker cannot change repository settings" are both quoted here.',
    ]
  ) {
    assertEquals(isAdminOnlyRepoSettingsIssue(body), false, body);
  }
});

Deno.test("isAdminOnlyRepoSettingsIssue - the scanner's full sentence is admin-only, marker or not, even line-wrapped (Issue #3360)", () => {
  for (
    const body of [
      "<!-- finding-id: BP-REPO-DEFAULT-TOKEN-WRITE -->\n\n## Suggested fix\n\n" +
      "Repository admin action \u2014 the worker cannot change repository settings. " +
      "Settings \u2192 Actions \u2192 General \u2192 Workflow permissions.",
      "## Suggested fix\n\nRepository admin action \u2014 the worker cannot change repository settings.",
      "Repository admin action \u2014 the worker cannot change\nrepository settings.",
    ]
  ) {
    assertEquals(isAdminOnlyRepoSettingsIssue(body), true, body);
  }
});

Deno.test("isAdminOnlyRepoSettingsIssue - matches the scanner's REPO_ADMIN_ACTION constant (Issue #3360)", () => {
  assertEquals(isAdminOnlyRepoSettingsIssue(REPO_ADMIN_ACTION), true);
  assertEquals(
    isAdminOnlyRepoSettingsIssue(
      "## Suggested fix\n\n" + REPO_ADMIN_ACTION +
        " Settings \u2192 Code security.",
    ),
    true,
  );
});

Deno.test("isAdminOnlyRepoSettingsIssue - hostile whitespace and partial-sentence runs scale linearly (Issue #3360)", () => {
  for (
    const build of [
      (chars: number) =>
        "Repository admin action \u2014" + " ".repeat(chars) + "x",
      (chars: number) =>
        "Repository admin action \u2014 the worker cannot change repository"
          .repeat(Math.max(1, Math.floor(chars / 64))),
    ]
  ) {
    const result = assertLinearGrowth(
      "isAdminOnlyRepoSettingsIssue, hostile admin-action runs",
      build,
      isAdminOnlyRepoSettingsIssue,
      { baseChars: 10_000 },
    );
    assertEquals(result, false);
  }
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

Deno.test("parseRepoSettingsFindingId - a marker only quoted in code yields null, so setup's close-out ignores it (Issue #3295)", () => {
  for (
    const body of [
      "`<!-- finding-id: BP-REPO-DEFAULT-TOKEN-WRITE -->`",
      "```\n<!-- finding-id: BP-REPO-DEFAULT-TOKEN-WRITE -->\n```",
    ]
  ) {
    assertEquals(parseRepoSettingsFindingId(body), null, body);
  }
});

// Issue #3266 — a security-policy finding is fixed by an ordinary PR.
Deno.test("isAdminOnlyRepoSettingsIssue - BP-REPO-SECURITY-POLICY-MISSING is worker-fixable on its marker alone (Issue #3266)", () => {
  for (
    const marker of [
      "<!-- finding-id: BP-REPO-SECURITY-POLICY-MISSING -->",
      "<!--   finding-id:   bp-repo-security-policy-missing   -->",
    ]
  ) {
    assertEquals(
      isAdminOnlyRepoSettingsIssue(`${marker}\n\nAdd a SECURITY.md`),
      false,
      marker,
    );
  }
  assertEquals(
    parseRepoSettingsFindingId(
      "<!-- finding-id: BP-REPO-SECURITY-POLICY-MISSING -->",
    ),
    "BP-REPO-SECURITY-POLICY-MISSING",
  );
});

Deno.test("isAdminOnlyRepoSettingsIssue - the admin-action prose still wins over a worker-fixable marker (Issue #3266)", () => {
  assertEquals(
    isAdminOnlyRepoSettingsIssue(
      "<!-- finding-id: BP-REPO-SECURITY-POLICY-MISSING -->\n\n" +
        "Repository admin action — the worker cannot change repository settings.",
    ),
    true,
  );
});

Deno.test("isAdminOnlyRepoSettingsIssue - other BP-REPO ids stay admin-only beside the allowlist (Issue #3266)", () => {
  for (
    const id of ["BP-REPO-PVR-OFF", "BP-REPO-CODEOWNERS-REVIEW-OFF"]
  ) {
    assertEquals(
      isAdminOnlyRepoSettingsIssue(`<!-- finding-id: ${id} -->`),
      true,
      id,
    );
  }
});
