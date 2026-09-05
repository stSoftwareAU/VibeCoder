import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderRunSummary } from "../lib/idle_task_templates/security_scan_template.ts";
import { renderBestPracticesSummary } from "../lib/idle_task_templates/best_practices_template.ts";
import { renderTestAuditSummary } from "../lib/idle_task_templates/test_audit_template.ts";
import { renderGitHubActionsAuditSummary } from "../lib/idle_task_templates/github_actions_audit_template.ts";
import { renderSupplyChainReadinessSummary } from "../lib/idle_task_templates/supply_chain_readiness_template.ts";
import { renderAlertFeedSummary } from "../lib/idle_task_templates/alert_feed_template.ts";
import { renderBashSyntaxAuditSummary } from "../lib/idle_task_templates/bash_syntax_audit_template.ts";
import { renderBashScriptRefsSummary } from "../lib/idle_task_templates/bash_script_refs_template.ts";
import { renderDeadCodeSummary } from "../lib/idle_task_templates/dead_code_template.ts";
import { renderDeprecatedApiSummary } from "../lib/idle_task_templates/deprecated_api_template.ts";
import { renderDocCoverageSummary } from "../lib/idle_task_templates/doc_coverage_template.ts";
import { renderDocumentationAuditSummary } from "../lib/idle_task_templates/documentation_audit_template.ts";
import { renderDuplicatedKnowledgeSummary } from "../lib/idle_task_templates/duplicated_knowledge_template.ts";
import { renderFormatDriftSummary } from "../lib/idle_task_templates/format_drift_template.ts";
import { renderOrphanDepsSummary } from "../lib/idle_task_templates/orphan_deps_template.ts";
import { renderPrivateRepoReferenceSummary } from "../lib/idle_task_templates/private_repo_reference_template.ts";
import { renderRetroSummary } from "../lib/idle_task_templates/retro_template.ts";
import { renderWorkflowAnnotationScanSummary } from "../lib/idle_task_templates/workflow_annotation_scan_template.ts";
import { NEWLY_FILED_UNKNOWN_SUMMARY } from "../lib/idle_task_snapshot.ts";

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

// ---------------------------------------------------------------------------
// Unknown newly-filed set (Issue #1105)
//
// Every template's renderer takes `readonly number[] | null`, and `null` means
// a before/after snapshot lookup failed. Each must say the count is unknown —
// never "no findings" / "0 findings.", which is what a genuinely clean scan
// renders. Table-driven so a nineteenth template cannot quietly skip the rule.
// ---------------------------------------------------------------------------

/** Every scan renderer, invoked with an unknown newly-filed set. */
const UNKNOWN_RENDERERS: ReadonlyArray<[string, () => string]> = [
  ["security-scan", () => renderRunSummary(null)],
  ["best-practices", () => renderBestPracticesSummary("rust", null)],
  ["test-audit", () => renderTestAuditSummary(null)],
  ["github-actions-audit", () => renderGitHubActionsAuditSummary(null)],
  ["supply-chain-readiness", () => renderSupplyChainReadinessSummary(null)],
  ["alert-feed", () => renderAlertFeedSummary(null)],
  ["bash-syntax-audit", () => renderBashSyntaxAuditSummary(null, [], "")],
  ["bash-script-refs", () => renderBashScriptRefsSummary(null)],
  ["dead-code", () => renderDeadCodeSummary(null)],
  ["deprecated-api", () => renderDeprecatedApiSummary(null)],
  ["doc-coverage", () => renderDocCoverageSummary(null)],
  ["documentation-audit", () => renderDocumentationAuditSummary(null)],
  ["duplicated-knowledge", () => renderDuplicatedKnowledgeSummary(null)],
  ["format-drift", () => renderFormatDriftSummary(null)],
  ["orphan-deps", () => renderOrphanDepsSummary(null, "")],
  ["private-repo-reference", () => renderPrivateRepoReferenceSummary(null)],
  ["retro", () => renderRetroSummary(null)],
  ["workflow-annotation-scan", () => renderWorkflowAnnotationScanSummary(null)],
];

Deno.test("every scan renderer reports an unknown newly-filed set as unknown", () => {
  for (const [template, render] of UNKNOWN_RENDERERS) {
    const summary = render();
    assertStringIncludes(summary, NEWLY_FILED_UNKNOWN_SUMMARY);
    assertEquals(
      /\b(no findings|no candidates|0 findings)\b/i.test(summary),
      false,
      `${template} rendered a clean-scan phrase for an unknown count`,
    );
  }
});

Deno.test("renderOrphanDepsSummary - the suppression report still follows an unknown count", () => {
  assertEquals(
    renderOrphanDepsSummary(null, "Suppressed: BP-x."),
    `${NEWLY_FILED_UNKNOWN_SUMMARY} Suppressed: BP-x.`,
  );
});

Deno.test("renderAlertFeedSummary - fetcher errors still follow an unknown count", () => {
  assertEquals(
    renderAlertFeedSummary(null, [], ["Dependabot fetch failed: boom"]),
    `${NEWLY_FILED_UNKNOWN_SUMMARY} Fetcher errors: Dependabot fetch failed: boom.`,
  );
});
