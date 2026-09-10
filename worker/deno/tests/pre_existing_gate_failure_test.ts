/**
 * Tests for the pre-existing whole-gate failure decision (Issue #1852).
 *
 * A repository whose own quality check is red on its default branch used to
 * fail every run at `quality_gate` and record a host health failure, even
 * though the worker's own diagnostics said the failure predated the run.
 * `decidePreExistingGateFailure` is the check-agnostic comparison that tells
 * the two apart: same checks red, same output → pre-existing; a new check or
 * a new line → the run owns it.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  decidePreExistingGateFailure,
  type FailedCheck,
  failedChecks,
  normaliseGateOutputLines,
} from "../lib/baseline_gate.ts";

const RED =
  "repo check: workflows must carry one version comment everywhere\n" +
  "  .github/workflows/ci.yml:12 version-comment-drift";

function check(name: string, output: string): FailedCheck {
  return { name, output };
}

// ---------------------------------------------------------------------------
// failedChecks
// ---------------------------------------------------------------------------

Deno.test("failedChecks - keeps only FAILED checks with their output", () => {
  const result = failedChecks([
    { name: "deno tests", status: "PASSED", output: "ok" },
    { name: "repo check", status: "FAILED", output: RED },
    { name: "markdownlint", status: "SKIPPED" },
  ]);
  assertEquals(result, [{ name: "repo check", output: RED }]);
});

Deno.test("failedChecks - a FAILED check with no recorded output yields an empty string", () => {
  assertEquals(failedChecks([{ name: "mermaid", status: "FAILED" }]), [
    { name: "mermaid", output: "" },
  ]);
});

// ---------------------------------------------------------------------------
// normaliseGateOutputLines
// ---------------------------------------------------------------------------

Deno.test("normaliseGateOutputLines - drops blank lines, timing lines and durations", () => {
  const lines = normaliseGateOutputLines(
    "check failed in 12.4s\n\n  ⏱  repo check: 3.1s\n  indented   detail  \n",
  );
  assertEquals(lines, [
    "check failed in <duration>",
    "indented detail",
  ]);
});

Deno.test("normaliseGateOutputLines - masks secrets so a cached baseline compares with a live run", () => {
  // Assembled at run time so the fixture never exists as a token-shaped
  // literal in the source a secret scanner reads.
  const token = `ghp_${"a".repeat(36)}`;
  const live = normaliseGateOutputLines(
    `fatal: could not read https://${token}@example.com`,
  );
  assertEquals(live.length, 1);
  assertEquals(
    live[0]?.includes(token),
    false,
    "a token must be masked before the comparison sees it",
  );
});

// ---------------------------------------------------------------------------
// decidePreExistingGateFailure — the acceptance cases from Issue #1852
// ---------------------------------------------------------------------------

Deno.test("decidePreExistingGateFailure - baseline X, post-change X is pre-existing", () => {
  const decision = decidePreExistingGateFailure(
    { passed: false, failedChecks: [check("repo check", RED)] },
    [check("repo check", RED)],
  );
  assertEquals(decision.preExisting, true);
  assertEquals(decision.reason, "pre_existing");
  assertEquals(decision.checks, ["repo check"]);
  assertEquals(decision.newLines, []);
});

Deno.test("decidePreExistingGateFailure - baseline X, post-change X plus a new line is a failure", () => {
  const decision = decidePreExistingGateFailure(
    { passed: false, failedChecks: [check("repo check", RED)] },
    [check("repo check", `${RED}\n  docs/new.md:1 version-comment-drift`)],
  );
  assertEquals(decision.preExisting, false);
  assertEquals(decision.reason, "new_output");
  assertEquals(decision.newLines, [
    "repo check: docs/new.md:1 version-comment-drift",
  ]);
});

Deno.test("decidePreExistingGateFailure - a check that was green at baseline is a failure", () => {
  const decision = decidePreExistingGateFailure(
    { passed: false, failedChecks: [check("repo check", RED)] },
    [check("repo check", RED), check("deno tests", "1 test failed")],
  );
  assertEquals(decision.preExisting, false);
  assertEquals(decision.reason, "new_failing_check");
});

Deno.test("decidePreExistingGateFailure - a subset of the baseline's red checks is pre-existing", () => {
  const decision = decidePreExistingGateFailure(
    {
      passed: false,
      failedChecks: [check("repo check", RED), check("mermaid", "bad block")],
    },
    [check("repo check", RED)],
  );
  assertEquals(decision.preExisting, true);
  assertEquals(decision.checks, ["repo check"]);
});

Deno.test("decidePreExistingGateFailure - only timings differ, so the failure is pre-existing", () => {
  const decision = decidePreExistingGateFailure(
    {
      passed: false,
      failedChecks: [check("repo check", `${RED}\n  ⏱  repo check: 3.1s`)],
    },
    [check("repo check", `${RED}\n  ⏱  repo check: 7.9s`)],
  );
  assertEquals(decision.preExisting, true);
});

// ---------------------------------------------------------------------------
// decidePreExistingGateFailure — fail-closed cases
// ---------------------------------------------------------------------------

Deno.test("decidePreExistingGateFailure - no baseline decides against the bypass", () => {
  assertEquals(
    decidePreExistingGateFailure(undefined, [check("repo check", RED)]),
    { preExisting: false, reason: "baseline_passed", checks: [], newLines: [] },
  );
});

Deno.test("decidePreExistingGateFailure - a passing baseline decides against the bypass", () => {
  const decision = decidePreExistingGateFailure(
    { passed: true, failedChecks: [] },
    [check("repo check", RED)],
  );
  assertEquals(decision.preExisting, false);
  assertEquals(decision.reason, "baseline_passed");
});

Deno.test("decidePreExistingGateFailure - a baseline with no recorded checks decides against the bypass", () => {
  const decision = decidePreExistingGateFailure(
    { passed: false },
    [check("repo check", RED)],
  );
  assertEquals(decision.preExisting, false);
  assertEquals(decision.reason, "baseline_unattributed");
});

Deno.test("decidePreExistingGateFailure - no current failing check decides against the bypass", () => {
  const decision = decidePreExistingGateFailure(
    { passed: false, failedChecks: [check("repo check", RED)] },
    [],
  );
  assertEquals(decision.preExisting, false);
  assertEquals(decision.reason, "no_failing_checks");
});
