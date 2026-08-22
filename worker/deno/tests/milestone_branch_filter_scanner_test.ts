/**
 * Tests for milestone_branch_filter_scanner.ts — native
 * milestone-branch-filter pre-filer for the github-actions-audit template
 * (Issue #3360).
 *
 * Every test exercises the real `scanMilestoneBranchFilters` against
 * in-memory `WorkflowFile` fixtures — no filesystem, no network.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  _resetSuppressionCommitAuthors as _clearSuppressionCommitAuthors,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
  setSuppressionCommitAuthors as _setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { scanMilestoneBranchFilters } from "../lib/milestone_branch_filter_scanner.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

/** Build a parsed workflow `WorkflowFile` from YAML text. */
function wf(
  path: string,
  rawText: string,
  kind: WorkflowFile["kind"] = "workflow",
): WorkflowFile {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(rawText);
  } catch {
    parsed = null;
  }
  return { path, rawText, parsed, kind };
}

const TEST_JOB =
  "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: deno test\n";
const DEPLOY_JOB =
  "jobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n";

// ---------------------------------------------------------------------------
// Positive: CI quality workflow whose PR filter misses milestone/*
// ---------------------------------------------------------------------------

Deno.test("scanMilestoneBranchFilters - branches [Develop, main] is flagged", () => {
  const files = [
    wf(
      ".github/workflows/validate.yml",
      `name: Validate\non:\n  pull_request:\n    branches: [Develop, main]\n${TEST_JOB}`,
    ),
  ];
  const findings = scanMilestoneBranchFilters(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.findingId, "BP-MILESTONE-FILTER-validate");
  assert(f.findingId.startsWith("BP-"));
  assertEquals(f.severity, "medium");
  assertEquals(f.workflowPath, ".github/workflows/validate.yml");
  assert(f.suggestedFix.includes("milestone/*"));
});

// Issue #3940: `["*"]` reads as "every branch" but a GitHub `*` never
// matches `/`, so it misses `milestone/<slug>` exactly as `[Develop, main]`
// does. This repo's own gitleaks/semgrep/markdown-lint workflows carried
// that spelling.
Deno.test('scanMilestoneBranchFilters - branches ["*"] single-star is flagged', () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\non:\n  pull_request:\n    branches: ["*"]\n${TEST_JOB}`,
    ),
  ];
  const findings = scanMilestoneBranchFilters(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.findingId, "BP-MILESTONE-FILTER-gitleaks");
});

Deno.test("scanMilestoneBranchFilters - branches-ignore excluding milestone is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  pull_request:\n    branches-ignore: ['milestone/**']\n${TEST_JOB}`,
    ),
  ];
  const findings = scanMilestoneBranchFilters(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.findingId, "BP-MILESTONE-FILTER-ci");
});

// ---------------------------------------------------------------------------
// Negative: filters that already cover milestone branches
// ---------------------------------------------------------------------------

Deno.test("scanMilestoneBranchFilters - branches including milestone/* is covered", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  pull_request:\n    branches: [Develop, main, 'milestone/*']\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanMilestoneBranchFilters(files).length, 0);
});

Deno.test("scanMilestoneBranchFilters - branches ** wildcard is covered", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  pull_request:\n    branches: ['**']\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanMilestoneBranchFilters(files).length, 0);
});

Deno.test("scanMilestoneBranchFilters - pull_request with no branch filter is covered", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  pull_request:\n    paths: ['**.ts']\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanMilestoneBranchFilters(files).length, 0);
});

Deno.test("scanMilestoneBranchFilters - bare `on: pull_request` is covered", () => {
  const files = [
    wf(".github/workflows/ci.yml", `name: CI\non: pull_request\n${TEST_JOB}`),
  ];
  assertEquals(scanMilestoneBranchFilters(files).length, 0);
});

Deno.test("scanMilestoneBranchFilters - array `on: [pull_request]` is covered", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non: [push, pull_request]\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanMilestoneBranchFilters(files).length, 0);
});

Deno.test("scanMilestoneBranchFilters - no pull_request trigger yields no finding", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches: [main]\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanMilestoneBranchFilters(files).length, 0);
});

// ---------------------------------------------------------------------------
// Classification gating
// ---------------------------------------------------------------------------

Deno.test("scanMilestoneBranchFilters - deploy workflow is never flagged", () => {
  const files = [
    wf(
      ".github/workflows/release.yml",
      `name: Release\non:\n  pull_request:\n    branches: [main]\n${DEPLOY_JOB}`,
    ),
  ];
  assertEquals(scanMilestoneBranchFilters(files).length, 0);
});

Deno.test("scanMilestoneBranchFilters - composite action file is ignored", () => {
  const files = [
    wf(
      ".github/actions/foo/action.yml",
      `name: Foo\non:\n  pull_request:\n    branches: [main]\n${TEST_JOB}`,
      "composite-action",
    ),
  ];
  assertEquals(scanMilestoneBranchFilters(files).length, 0);
});

Deno.test("scanMilestoneBranchFilters - unparseable workflow yields no finding", () => {
  const files = [
    wf(".github/workflows/broken.yml", ":\n  not: [valid\n"),
  ];
  // Malformed YAML → parsed null → skipped without throwing.
  assertEquals(scanMilestoneBranchFilters(files).length, 0);
});

// ---------------------------------------------------------------------------
// Dedup / suppression
// ---------------------------------------------------------------------------

Deno.test("scanMilestoneBranchFilters - knownOpen id is skipped", () => {
  const files = [
    wf(
      ".github/workflows/validate.yml",
      `name: Validate\non:\n  pull_request:\n    branches: [main]\n${TEST_JOB}`,
    ),
  ];
  const findings = scanMilestoneBranchFilters(files, {
    knownOpenFindingIds: ["BP-MILESTONE-FILTER-validate"],
  });
  assertEquals(findings.length, 0);
});

Deno.test("scanMilestoneBranchFilters - suppressedIds id is skipped", () => {
  const files = [
    wf(
      ".github/workflows/validate.yml",
      `name: Validate\non:\n  pull_request:\n    branches: [main]\n${TEST_JOB}`,
    ),
  ];
  const findings = scanMilestoneBranchFilters(files, {
    suppressedIds: ["BP-MILESTONE-FILTER-validate"],
  });
  assertEquals(findings.length, 0);
});

Deno.test("scanMilestoneBranchFilters - in-source suppression marker drops the finding", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const raw = `name: Validate
  on:
    pull_request:
      # best-practice-ignore: BP-MILESTONE-FILTER-validate — author=nigel expires=2099-12-31 intentional, milestone PRs use a separate gate
      branches: [main]
  ${TEST_JOB}`;
    const files = [wf(".github/workflows/validate.yml", raw)];
    assertEquals(scanMilestoneBranchFilters(files).length, 0);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

Deno.test("scanMilestoneBranchFilters - findings sorted by stable id", () => {
  const files = [
    wf(
      ".github/workflows/zeta.yml",
      `name: Zeta\non:\n  pull_request:\n    branches: [main]\n${TEST_JOB}`,
    ),
    wf(
      ".github/workflows/alpha.yml",
      `name: Alpha\non:\n  pull_request:\n    branches: [main]\n${TEST_JOB}`,
    ),
  ];
  const findings = scanMilestoneBranchFilters(files);
  assertEquals(findings.map((f) => f.findingId), [
    "BP-MILESTONE-FILTER-alpha",
    "BP-MILESTONE-FILTER-zeta",
  ]);
});
