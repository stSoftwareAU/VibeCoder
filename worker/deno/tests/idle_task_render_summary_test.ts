import { assertEquals } from "@std/assert";
import { renderRunSummary } from "../lib/idle_task_templates/security_scan_template.ts";
import { renderBestPracticesSummary } from "../lib/idle_task_templates/best_practices_template.ts";
import { renderTestAuditSummary } from "../lib/idle_task_templates/test_audit_template.ts";
import { renderGitHubActionsAuditSummary } from "../lib/idle_task_templates/github_actions_audit_template.ts";
import { renderSupplyChainReadinessSummary } from "../lib/idle_task_templates/supply_chain_readiness_template.ts";

// --- security-scan: renderRunSummary ---------------------------------------

Deno.test("renderRunSummary - no findings reports the audit-trail phrase", () => {
  assertEquals(renderRunSummary([]), "0 findings.");
});

Deno.test("renderRunSummary - sorts issue numbers ascending", () => {
  assertEquals(
    renderRunSummary([9, 3, 12]),
    "Security scan complete. Filed 3 issues: #3, #9, #12",
  );
});

// --- best-practices: renderBestPracticesSummary ----------------------------

Deno.test("renderBestPracticesSummary - no findings returns 'no findings'", () => {
  assertEquals(renderBestPracticesSummary("rust", []), "no findings");
});

Deno.test("renderBestPracticesSummary - includes bucket and sorted numbers", () => {
  assertEquals(
    renderBestPracticesSummary("typescript", [5, 1]),
    "Best-practices scan complete (bucket: typescript). Filed 2 issues: #1, #5",
  );
});

// --- test-audit: renderTestAuditSummary ------------------------------------

Deno.test("renderTestAuditSummary - no findings returns 'no findings'", () => {
  assertEquals(renderTestAuditSummary([]), "no findings");
});

Deno.test("renderTestAuditSummary - sorts issue numbers ascending", () => {
  assertEquals(
    renderTestAuditSummary([4, 2]),
    "Test-audit scan complete. Filed 2 issues: #2, #4",
  );
});

// --- github-actions-audit: renderGitHubActionsAuditSummary -----------------

Deno.test("renderGitHubActionsAuditSummary - no findings returns 'no findings'", () => {
  assertEquals(renderGitHubActionsAuditSummary([]), "no findings");
});

Deno.test("renderGitHubActionsAuditSummary - sorts issue numbers ascending", () => {
  assertEquals(
    renderGitHubActionsAuditSummary([7, 1, 3]),
    "GitHub Actions audit complete. Filed 3 issues: #1, #3, #7",
  );
});

// --- supply-chain-readiness: renderSupplyChainReadinessSummary -------------

Deno.test("renderSupplyChainReadinessSummary - no findings returns 'no findings'", () => {
  assertEquals(renderSupplyChainReadinessSummary([]), "no findings");
});

Deno.test("renderSupplyChainReadinessSummary - sorts issue numbers ascending", () => {
  assertEquals(
    renderSupplyChainReadinessSummary([8, 6]),
    "Supply-chain readiness scan complete. Filed 2 issues: #6, #8",
  );
});

// --- large counts + deterministic sort (Issue #2411) -----------------------
//
// A descending input of 60 numbers is the worst case for sort stability and
// count rendering: the output must always list every number ascending and
// report the exact count, so the wrapper close-comment is deterministic
// regardless of the order in which Claude filed the findings.

/** [60, 59, …, 1] — reverse order so a no-op sort would be visible. */
const DESCENDING_60: number[] = Array.from(
  { length: 60 },
  (_unused, i) => 60 - i,
);

/** "#1, #2, …, #60" — the expected ascending render of DESCENDING_60. */
const ASCENDING_60_LIST: string = Array.from(
  { length: 60 },
  (_unused, i) => `#${i + 1}`,
).join(", ");

Deno.test("renderRunSummary - large count is sorted ascending with exact count", () => {
  assertEquals(
    renderRunSummary(DESCENDING_60),
    `Security scan complete. Filed 60 issues: ${ASCENDING_60_LIST}`,
  );
});

Deno.test("renderBestPracticesSummary - large count is sorted ascending with exact count", () => {
  assertEquals(
    renderBestPracticesSummary("rust", DESCENDING_60),
    `Best-practices scan complete (bucket: rust). Filed 60 issues: ${ASCENDING_60_LIST}`,
  );
});

Deno.test("renderTestAuditSummary - large count is sorted ascending with exact count", () => {
  assertEquals(
    renderTestAuditSummary(DESCENDING_60),
    `Test-audit scan complete. Filed 60 issues: ${ASCENDING_60_LIST}`,
  );
});

Deno.test("renderGitHubActionsAuditSummary - large count is sorted ascending with exact count", () => {
  assertEquals(
    renderGitHubActionsAuditSummary(DESCENDING_60),
    `GitHub Actions audit complete. Filed 60 issues: ${ASCENDING_60_LIST}`,
  );
});

Deno.test("renderSupplyChainReadinessSummary - large count is sorted ascending with exact count", () => {
  assertEquals(
    renderSupplyChainReadinessSummary(DESCENDING_60),
    `Supply-chain readiness scan complete. Filed 60 issues: ${ASCENDING_60_LIST}`,
  );
});

// A shuffled input must produce the same deterministic ascending output as a
// pre-sorted input — the render functions own the sort, callers need not.
Deno.test("renderRunSummary - shuffled input renders deterministically", () => {
  const shuffled = [42, 1, 17, 3, 99, 8];
  assertEquals(
    renderRunSummary(shuffled),
    "Security scan complete. Filed 6 issues: #1, #3, #8, #17, #42, #99",
  );
});

Deno.test("renderRunSummary - does not mutate the caller's array", () => {
  const input = [5, 1, 3];
  renderRunSummary(input);
  assertEquals(input, [5, 1, 3]);
});
