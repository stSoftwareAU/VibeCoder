/**
 * Regression test for Issue #3940: this repo's own PR quality gates must
 * run on `milestone/*` pull requests.
 *
 * `branches: ["*"]` looks like "every branch" but a GitHub `*` matches
 * zero or more characters *except* `/`, so it never matches
 * `milestone/<slug>` — the dominant merge path for milestone sub-issue
 * PRs (Issue #1300). Under that filter `gitleaks.yml` (secret detection),
 * `semgrep.yml` (SAST) and `markdown-lint.yml` never ran on those PRs.
 *
 * The check runs this repo's own `scanMilestoneBranchFilters` pre-filer —
 * the same code that files `BP-MILESTONE-FILTER-*` findings against other
 * repos (Issue #3360) — over the real `.github/workflows` tree, so the
 * repo is held to the standard it audits others against (Issue #3239: each
 * repo enforces its own gate). It fails against the unfixed tree with a
 * finding for each of the three workflows.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assertEquals } from "@std/assert";
import { scanMilestoneBranchFilters } from "../lib/milestone_branch_filter_scanner.ts";
import { readWorkflowFiles } from "../lib/workflow_scan_common.ts";

/** Repository root — three levels up from `worker/deno/tests/`. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

Deno.test("this repo's own CI quality workflows gate milestone/* PRs", async () => {
  const files = await readWorkflowFiles(REPO_ROOT);
  assertEquals(
    files.length > 0,
    true,
    "expected to read this repo's .github/workflows tree",
  );

  const findings = scanMilestoneBranchFilters(files);
  assertEquals(
    findings.map((f) => f.workflowPath),
    [],
    "every CI quality workflow must include `milestone/*` in its " +
      '`pull_request.branches` filter (Issue #3940) — `["*"]` does not ' +
      "match a branch name containing `/`",
  );
});
