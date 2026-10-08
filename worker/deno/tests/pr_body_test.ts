/**
 * Tests for pr_body.ts — PR body generation utilities (Issue #915).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  buildIdempotencyMarker,
  buildMilestonePrSection,
  buildSubAgentTierMarker,
  ensurePrReferencesIssue,
  extractClosingIssueNumbers,
  extractIssueNumberFromPrTitle,
  hasClosingKeyword,
  neutraliseSubAgentTierMarkers,
  subAgentTierFromBody,
} from "../lib/pr_body.ts";

// --- extractClosingIssueNumbers (Issue #1113) ---

Deno.test("pr_body - extractClosingIssueNumbers reads every keyword conjugation", () => {
  assertEquals(
    extractClosingIssueNumbers(
      "Closes #42\nfixed #7\nRESOLVE #9\nclosed #11\nFixes #13",
    ),
    [42, 7, 9, 11, 13],
  );
});

Deno.test("pr_body - extractClosingIssueNumbers keeps first-mention order and de-duplicates", () => {
  assertEquals(
    extractClosingIssueNumbers("Fixes #8. Also closes #3, and closes #8."),
    [8, 3],
  );
});

Deno.test("pr_body - hasClosingKeyword honours every conjugation GitHub does", () => {
  assertEquals(hasClosingKeyword("Fixed #42", 42), true);
  assertEquals(hasClosingKeyword("resolve #42", 42), true);
  // A keyword glued to a preceding word is not a closing keyword.
  assertEquals(hasClosingKeyword("Prefixes #42", 42), false);
  // A cross-repository reference names an issue in another repository.
  assertEquals(hasClosingKeyword("Closes owner/repo#42", 42), false);
});

Deno.test("pr_body - extractClosingIssueNumbers ignores bare and cross-repo references", () => {
  assertEquals(extractClosingIssueNumbers("See #42, related to #7"), []);
  assertEquals(extractClosingIssueNumbers("Closes owner/repo#42"), []);
  assertEquals(extractClosingIssueNumbers(""), []);
});

// --- hasClosingKeyword ---

Deno.test("pr_body - hasClosingKeyword detects 'Closes #42'", () => {
  assertEquals(hasClosingKeyword("Some text. Closes #42.", 42), true);
});

Deno.test("pr_body - hasClosingKeyword detects 'Fixes #100'", () => {
  assertEquals(hasClosingKeyword("Fixes #100\nMore text.", 100), true);
});

Deno.test("pr_body - hasClosingKeyword detects 'Resolves #7'", () => {
  assertEquals(hasClosingKeyword("Resolves #7", 7), true);
});

Deno.test("pr_body - hasClosingKeyword is case-insensitive", () => {
  assertEquals(hasClosingKeyword("CLOSES #42", 42), true);
  assertEquals(hasClosingKeyword("closes #42", 42), true);
});

Deno.test("pr_body - hasClosingKeyword does not match partial issue numbers", () => {
  // #42 should not match #421
  assertEquals(hasClosingKeyword("Closes #421", 42), false);
});

Deno.test("pr_body - hasClosingKeyword returns false when no keyword present", () => {
  assertEquals(hasClosingKeyword("Addresses #42", 42), false);
  assertEquals(hasClosingKeyword("Part of #42", 42), false);
  assertEquals(hasClosingKeyword("No reference at all", 42), false);
});

// --- ensurePrReferencesIssue ---

Deno.test("pr_body - ensurePrReferencesIssue leaves body unchanged when keyword present", () => {
  const body = "Some PR body. Closes #42.";
  assertEquals(ensurePrReferencesIssue(body, 42), body);
});

Deno.test("pr_body - ensurePrReferencesIssue appends 'Closes #N' when missing", () => {
  const body = "Some PR body without a closing keyword.";
  const result = ensurePrReferencesIssue(body, 42);
  assertEquals(result.includes("Closes #42"), true);
  assertEquals(result.startsWith(body), true);
});

Deno.test("pr_body - ensurePrReferencesIssue does not duplicate existing keyword", () => {
  const body = "Body text. Fixes #99.";
  const result = ensurePrReferencesIssue(body, 99);
  assertEquals(result, body);
});

// --- buildMilestonePrSection ---

Deno.test("pr_body - buildMilestonePrSection returns empty for no milestone", () => {
  assertEquals(
    buildMilestonePrSection({
      milestoneTitle: "",
      milestoneBranch: "",
      baseBranch: "Develop",
    }),
    "",
  );
  assertEquals(
    buildMilestonePrSection({
      milestoneTitle: "Title",
      milestoneBranch: "",
      baseBranch: "Develop",
    }),
    "",
  );
  assertEquals(
    buildMilestonePrSection({
      milestoneTitle: "",
      milestoneBranch: "branch",
      baseBranch: "branch",
    }),
    "",
  );
});

Deno.test("pr_body - buildMilestonePrSection generates markdown section", () => {
  const result = buildMilestonePrSection({
    milestoneTitle: "OIDC Auth",
    milestoneBranch: "milestone/oidc",
    baseBranch: "milestone/oidc",
  });
  assertEquals(result.includes("**OIDC Auth**"), true);
  assertEquals(result.includes("`milestone/oidc`"), true);
  assertEquals(result.includes("## Milestone"), true);
});

// Issue #3911: the footer must never name a branch that is not the PR's base.

Deno.test("pr_body - buildMilestonePrSection keeps today's wording when base is the milestone branch", () => {
  const result = buildMilestonePrSection({
    milestoneTitle: "OIDC Auth",
    milestoneBranch: "milestone/oidc",
    baseBranch: "milestone/oidc",
  });
  assertEquals(
    result,
    "\n## Milestone\nThis PR is part of the **OIDC Auth** milestone and targets the `milestone/oidc` feature branch.\n",
  );
});

Deno.test("pr_body - buildMilestonePrSection reports the actual base on mismatch (regression #3904)", () => {
  // PR #3904's shape: milestone set, but the PR was actually based on Develop.
  const milestoneBranch =
    "milestone/3872-security-scan-overflow-17-unfiled-findings";
  const result = buildMilestonePrSection({
    milestoneTitle: "#3872 security-scan-overflow: 17 unfiled findings",
    milestoneBranch,
    baseBranch: "Develop",
  });
  assertEquals(result.includes("## Milestone"), true);
  assertEquals(
    result.includes("**#3872 security-scan-overflow: 17 unfiled findings**"),
    true,
  );
  assertEquals(result.includes("`Develop`"), true);
  assertEquals(
    result.includes(milestoneBranch),
    false,
    "must not name the milestone branch when it is not the PR's base",
  );
});

Deno.test("pr_body - buildMilestonePrSection flags an undeterminable base", () => {
  const result = buildMilestonePrSection({
    milestoneTitle: "OIDC Auth",
    milestoneBranch: "milestone/oidc",
    baseBranch: "   ",
  });
  assertEquals(result.includes("could not be determined"), true);
  assertEquals(
    result.includes("milestone/oidc"),
    false,
    "must not name the milestone branch when the base is unknown",
  );
});

// --- buildIdempotencyMarker ---

Deno.test("pr_body - buildIdempotencyMarker returns HTML comment", () => {
  const marker = buildIdempotencyMarker(42);
  assertEquals(marker, "<!-- vibe-worker-issue-42 -->");
});

Deno.test("pr_body - buildIdempotencyMarker uses correct issue number", () => {
  assertEquals(buildIdempotencyMarker(100), "<!-- vibe-worker-issue-100 -->");
  assertEquals(buildIdempotencyMarker(1), "<!-- vibe-worker-issue-1 -->");
});

// --- extractIssueNumberFromPrTitle ---

Deno.test("pr_body - extractIssueNumberFromPrTitle extracts from (#NNN) pattern", () => {
  const result = extractIssueNumberFromPrTitle("Fix: Button alignment (#42)");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, 42);
});

Deno.test("pr_body - extractIssueNumberFromPrTitle extracts from (Issue #NNN) pattern", () => {
  const result = extractIssueNumberFromPrTitle(
    "Enhancement: New feature (Issue #100)",
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, 100);
});

Deno.test("pr_body - extractIssueNumberFromPrTitle returns error for no match", () => {
  const result = extractIssueNumberFromPrTitle("Fix: Button alignment");
  assertEquals(result.ok, false);
});

Deno.test("pr_body - extractIssueNumberFromPrTitle requires trailing pattern", () => {
  const result = extractIssueNumberFromPrTitle("Fix (#42) description");
  assertEquals(result.ok, false);
});

// --- buildSubAgentTierMarker / subAgentTierFromBody / neutraliseSubAgentTierMarkers (Issue #3403) ---

Deno.test("pr_body - buildSubAgentTierMarker renders the exact marker for each tier", () => {
  assertEquals(
    buildSubAgentTierMarker("haiku"),
    "<!-- vibe-sub-agent-tier: haiku -->",
  );
  assertEquals(
    buildSubAgentTierMarker("sonnet"),
    "<!-- vibe-sub-agent-tier: sonnet -->",
  );
});

Deno.test("pr_body - subAgentTierFromBody reads the last occurrence", () => {
  const body = `${buildSubAgentTierMarker("sonnet")}\n\nsome text\n\n${
    buildSubAgentTierMarker("haiku")
  }`;
  assertEquals(subAgentTierFromBody(body), "haiku");
});

Deno.test("pr_body - subAgentTierFromBody returns undefined when no marker is present", () => {
  assertEquals(
    subAgentTierFromBody("## Summary\n\nNo marker here."),
    undefined,
  );
});

Deno.test("pr_body - subAgentTierFromBody skips an occurrence naming an unknown tier", () => {
  const body = "<!-- vibe-sub-agent-tier: opus -->\n" +
    buildSubAgentTierMarker("sonnet");
  assertEquals(subAgentTierFromBody(body), "sonnet");
  // And when the unknown-tier marker is the only occurrence, there is
  // nothing recognised to return.
  assertEquals(
    subAgentTierFromBody("<!-- vibe-sub-agent-tier: opus -->"),
    undefined,
  );
});

Deno.test("pr_body - neutraliseSubAgentTierMarkers strips the comment delimiters off every occurrence", () => {
  const body = `Before ${buildSubAgentTierMarker("haiku")} middle ${
    buildSubAgentTierMarker("sonnet")
  } after`;
  const neutralised = neutraliseSubAgentTierMarkers(body);
  assertEquals(
    neutralised,
    "Before vibe-sub-agent-tier: haiku middle vibe-sub-agent-tier: sonnet after",
  );
  // The neutralised text no longer reads as a marker to the finder.
  assertEquals(subAgentTierFromBody(neutralised), undefined);
});

Deno.test("pr_body - subAgentTierFromBody completes quickly on an unterminated hostile marker prefix", () => {
  const hostile = "<!-- vibe-sub-agent-tier: " + "a".repeat(50_000);
  const start = performance.now();
  const result = subAgentTierFromBody(hostile);
  const elapsedMs = performance.now() - start;
  assertEquals(result, undefined);
  // No wall-clock assertion threshold — the point is that this returns at
  // all, rather than hanging on catastrophic regex backtracking.
  assertEquals(elapsedMs < 5_000, true);
});
