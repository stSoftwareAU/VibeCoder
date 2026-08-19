/**
 * Regression test for Issue #2315 — missing CI lint gate for `github-actions`.
 *
 * The github-actions-audit idle task filed a `BP-LINTER-github-actions`
 * finding because no workflow under `.github/workflows/` invoked
 * `actionlint`. This test pins that fix: it runs the canonical
 * linter-in-CI check against this repository's own workflows and asserts
 * the `github-actions` bucket is configured.
 *
 * If a future change removes the actionlint invocation from CI, this
 * test fails — preventing a silent regression that would re-open the
 * finding on the next scan.
 */

import { assertEquals } from "@std/assert";
import { checkLinterInCI } from "../lib/linter_in_ci_check.ts";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

Deno.test("Issue #2315 — actionlint is invoked in this repo's CI", async () => {
  const result = await checkLinterInCI(REPO_ROOT, "github-actions");
  assertEquals(
    result.configured,
    true,
    `actionlint must be invoked in CI (Issue #2315). details: ${result.details}`,
  );
  assertEquals(result.linter, "actionlint");
});
