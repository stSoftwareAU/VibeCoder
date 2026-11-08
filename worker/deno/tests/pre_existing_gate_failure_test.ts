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
import { normaliseLogExcerpt } from "../lib/auto_fix_attempt_tracker.ts";

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

Deno.test("normaliseGateOutputLines - compact Deno durations compare as pre-existing", () => {
  const baselineOutput = "FAILED | 17451 passed | 2 failed (1m43s)";
  const currentOutput = "FAILED | 17451 passed | 2 failed (2m14s)";
  const baselineLines = normaliseGateOutputLines(baselineOutput);
  const currentLines = normaliseGateOutputLines(currentOutput);

  assertEquals(baselineLines, [
    "FAILED | 17451 passed | 2 failed (<duration>)",
  ]);
  assertEquals(currentLines, baselineLines);

  const decision = decidePreExistingGateFailure(
    { passed: false, failedChecks: [check("deno tests", baselineOutput)] },
    [check("deno tests", currentOutput)],
  );
  assertEquals(decision.preExisting, true);
  assertEquals(decision.reason, "pre_existing");
  assertEquals(decision.newLines, []);
});

Deno.test("normaliseGateOutputLines - changed failure counts and diagnostics remain new output", () => {
  const baselineOutput =
    "FAILED | 17451 passed | 2 failed (1m43s)\nerror: test A";
  const currentOutput =
    "FAILED | 17451 passed | 3 failed (2m14s)\nerror: test B";
  const decision = decidePreExistingGateFailure(
    { passed: false, failedChecks: [check("deno tests", baselineOutput)] },
    [check("deno tests", currentOutput)],
  );

  assertEquals(decision.preExisting, false);
  assertEquals(decision.reason, "new_output");
  assertEquals(decision.newLines, [
    "deno tests: FAILED | 17451 passed | 3 failed (<duration>)",
    "deno tests: error: test B",
  ]);
});

Deno.test("normaliseGateOutputLines - compound durations and existing formats normalise", () => {
  const pairs: Array<[string, string]> = [
    ["test finished (1h2m3s)", "test finished (4h5m6s)"],
    ["test finished (1h 2m 3s)", "test finished (4h 5m 6s)"],
    ["test finished (2m14s)", "test finished (3m21s)"],
    ["test finished (2m 14s)", "test finished (3m 21s)"],
    ["test finished in 12.4s", "test finished in 18.6s"],
    ["test finished in 12,4ms", "test finished in 18,6ms"],
    ["test finished in 12µs", "test finished in 18µs"],
    ["test finished in 12us", "test finished in 18us"],
    ["test finished in 12ns", "test finished in 18ns"],
    ["test finished in 2m", "test finished in 3m"],
  ];
  for (const [baseline, current] of pairs) {
    assertEquals(
      normaliseGateOutputLines(baseline),
      normaliseGateOutputLines(current),
      `${baseline} vs ${current}`,
    );
  }
});

Deno.test("normaliseGateOutputLines - duration matching handles hostile digits and whitespace", () => {
  const digitRun = "9".repeat(50000);
  const whitespaceRun = "1m ".repeat(20000) + "x";

  assertEquals(normaliseGateOutputLines(`${digitRun}!`), [`${digitRun}!`]);
  const normalisedWhitespace = normaliseGateOutputLines(whitespaceRun);
  assertEquals(normalisedWhitespace.length, 1);
  assertEquals(normalisedWhitespace[0]?.endsWith("x"), true);
});

Deno.test("normalisers agree that overlapping duration formats are volatile", () => {
  const pairs: Array<[string, string]> = [
    [
      "FAILED | 17451 passed | 2 failed (1m43s)",
      "FAILED | 17451 passed | 2 failed (2m14s)",
    ],
    ["finished (1h2m3s)", "finished (4h5m6s)"],
    ["finished (2m 14s)", "finished (3m 21s)"],
    ["finished in 12.4s", "finished in 18.6s"],
  ];
  for (const [baseline, current] of pairs) {
    assertEquals(
      normaliseGateOutputLines(baseline),
      normaliseGateOutputLines(current),
      `baseline gate: ${baseline} vs ${current}`,
    );
    assertEquals(
      normaliseLogExcerpt(baseline),
      normaliseLogExcerpt(current),
      `auto-fix tracker: ${baseline} vs ${current}`,
    );
  }
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
