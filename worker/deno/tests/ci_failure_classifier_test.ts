/**
 * Tests for the CI failure classifier (Issue #1690).
 *
 * The classifier must categorise failing CI checks into actionable
 * buckets (code-fix-required, timing, infrastructure, unknown) so
 * downstream code can route the failure intelligently.
 */

import { assertEquals } from "@std/assert";
import {
  type CiFailureCategory,
  classifyCiFailure,
} from "../lib/ci_failure_classifier.ts";

// =============================================================================
// Happy path — one test per category
// =============================================================================

Deno.test("ci_failure_classifier - semgrep check name routes to code-fix-required", () => {
  const result = classifyCiFailure(
    "semgrep",
    [{
      message: "BLOCKING CODE RULES FIRED",
      title: "detect-non-literal-regexp",
    }],
  );
  assertEquals(result.category, "code-fix-required");
  assertEquals(result.signals.includes("check:semgrep"), true);
});

Deno.test("ci_failure_classifier - eslint check routes to code-fix-required", () => {
  const result = classifyCiFailure(
    "eslint",
    [{ message: "error: 'x' is not defined" }],
  );
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - deno check routes to code-fix-required", () => {
  const result = classifyCiFailure(
    "deno check",
    [{ message: "TS2304 [ERROR]: Cannot find name 'foo'" }],
  );
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - shellcheck routes to code-fix-required", () => {
  const result = classifyCiFailure("shellcheck", []);
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - codeql routes to code-fix-required", () => {
  const result = classifyCiFailure("CodeQL", []);
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - timeout in log routes to timing", () => {
  const result = classifyCiFailure(
    "test",
    [],
    "The job exceeded the maximum execution time of 10 minutes.",
  );
  assertEquals(result.category, "timing");
});

Deno.test("ci_failure_classifier - 'timed out' annotation routes to timing", () => {
  const result = classifyCiFailure(
    "test",
    [{ message: "Test timed out after 30000ms" }],
  );
  assertEquals(result.category, "timing");
});

Deno.test("ci_failure_classifier - cancelled job routes to timing", () => {
  const result = classifyCiFailure(
    "build",
    [],
    "The job was cancelled.",
  );
  assertEquals(result.category, "timing");
});

Deno.test("ci_failure_classifier - DNS error routes to infrastructure", () => {
  const result = classifyCiFailure(
    "test",
    [{ message: "getaddrinfo ENOTFOUND api.github.com" }],
  );
  assertEquals(result.category, "infrastructure");
});

Deno.test("ci_failure_classifier - 503 routes to infrastructure", () => {
  const result = classifyCiFailure(
    "test",
    [],
    "GET https://api.github.com returned 503 Service Unavailable",
  );
  assertEquals(result.category, "infrastructure");
});

Deno.test("ci_failure_classifier - rate limit routes to infrastructure", () => {
  const result = classifyCiFailure(
    "test",
    [{ message: "429 Too Many Requests" }],
  );
  assertEquals(result.category, "infrastructure");
});

Deno.test("ci_failure_classifier - runner restart routes to infrastructure", () => {
  const result = classifyCiFailure(
    "build",
    [],
    "The runner has received a shutdown signal — runner lost connection",
  );
  assertEquals(result.category, "infrastructure");
});

Deno.test("ci_failure_classifier - connect ETIMEDOUT routes to infrastructure", () => {
  const result = classifyCiFailure(
    "build",
    [{ message: "Error: connect ETIMEDOUT 140.82.121.4:443" }],
  );
  assertEquals(result.category, "infrastructure");
});

// =============================================================================
// Edge cases
// =============================================================================

Deno.test("ci_failure_classifier - empty annotations and unknown check returns unknown", () => {
  const result = classifyCiFailure("custom-check", []);
  assertEquals(result.category, "unknown");
  assertEquals(Array.isArray(result.signals), true);
  assertEquals(typeof result.reason, "string");
});

Deno.test("ci_failure_classifier - empty annotations with no log returns unknown", () => {
  const result = classifyCiFailure("ci", []);
  assertEquals(result.category, "unknown");
});

Deno.test("ci_failure_classifier - mixed signals: timing inside semgrep prefers code-fix-required", () => {
  // Code-fix signals should win over timing/infrastructure when both
  // present — a semgrep finding is actionable; a slow test inside a
  // semgrep job is still primarily a code finding.
  const result = classifyCiFailure(
    "semgrep",
    [
      { message: "BLOCKING CODE RULES FIRED" },
      { message: "step timed out after 600s" },
    ],
  );
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - infrastructure beats timing when both present", () => {
  // Without code-fix signals, infrastructure failures are more
  // actionable than generic timeouts (the timeout is a symptom).
  const result = classifyCiFailure(
    "test",
    [
      { message: "step timed out after 60s" },
      { message: "getaddrinfo ENOTFOUND" },
    ],
  );
  assertEquals(result.category, "infrastructure");
});

Deno.test("ci_failure_classifier - signals contain the matched check name", () => {
  const result = classifyCiFailure("ESLint / lint", []);
  assertEquals(result.signals.includes("check:eslint / lint"), true);
});

Deno.test("ci_failure_classifier - returns CiFailureClassification shape", () => {
  const result = classifyCiFailure("x", []);
  // Sanity check the surface shape.
  assertEquals(typeof result.category, "string");
  assertEquals(typeof result.reason, "string");
  assertEquals(Array.isArray(result.signals), true);
  // Category must be one of the known values.
  const valid: CiFailureCategory[] = [
    "code-fix-required",
    "history-rewrite-required",
    "timing",
    "infrastructure",
    "unknown",
  ];
  assertEquals(valid.includes(result.category), true);
});

// =============================================================================
// Regression — PR #1678 exact case
// =============================================================================

Deno.test("ci_failure_classifier - regression for PR #1678 (semgrep ReDoS finding)", () => {
  const result = classifyCiFailure(
    "semgrep",
    [
      {
        message:
          "BLOCKING CODE RULES FIRED: ESLint detect-non-literal-regexp at worker/deno/lib/mermaid_validator.ts",
        title: "detect-non-literal-regexp",
        path: "worker/deno/lib/mermaid_validator.ts",
      },
    ],
  );
  assertEquals(result.category, "code-fix-required");
  // The reason should make the routing decision human-readable.
  assertEquals(result.reason.length > 0, true);
});

// =============================================================================
// Purity — no permissions required
// =============================================================================

Deno.test("ci_failure_classifier - is pure (no side effects on repeated calls)", () => {
  const a = classifyCiFailure("semgrep", [{
    message: "BLOCKING CODE RULES FIRED",
  }]);
  const b = classifyCiFailure("semgrep", [{
    message: "BLOCKING CODE RULES FIRED",
  }]);
  assertEquals(a, b);
});

// =============================================================================
// history-rewrite-required (Issue #630)
//
// The failure these describe is real: PR #629 fixed a flagged test fixture,
// pushed the fix, and gitleaks failed again naming the ORIGINAL commit. The
// scanners judge the commit range, so no follow-up commit can clear a finding.
// Misrouting this to a code fix produces a loop that cannot terminate.
// =============================================================================

Deno.test("ci_failure_classifier - gitleaks is a history-rewrite failure, not a code fix", () => {
  const result = classifyCiFailure("gitleaks", []);
  assertEquals(result.category, "history-rewrite-required");
});

Deno.test("ci_failure_classifier - the full-history sweep check name is recognised", () => {
  const result = classifyCiFailure(
    "Full-history secrets sweep (gitleaks + trufflehog)",
    [],
  );
  assertEquals(result.category, "history-rewrite-required");
});

Deno.test("ci_failure_classifier - a fingerprint line identifies an unfamiliar scanner", () => {
  // A repo may call its scanner anything. The fingerprint's `<sha>:<file>`
  // shape names the commit the finding lives in, which is the whole problem.
  const result = classifyCiFailure(
    "security",
    [],
    [
      "Finding: 'export AWS_SECRET_ACCESS_KEY=\"…\"'",
      "Fingerprint: 429b706b7a90442f0055a70a4098e8088b67f2a9:worker/deno/tests/x.ts:generic-api-key:27",
    ].join("\n"),
  );
  assertEquals(result.category, "history-rewrite-required");
});

Deno.test("ci_failure_classifier - outranks the code-fix signals in a gitleaks log", () => {
  // The exact misrouting that would restore the infinite loop: gitleaks logs
  // carry "error:"-shaped text, which the code-fix regexes match.
  const result = classifyCiFailure(
    "gitleaks",
    [],
    [
      "Error: leaks found: 2",
      "warning: 🛑 Leaks detected, see job summary for details",
    ].join("\n"),
  );
  assertEquals(result.category, "history-rewrite-required");
});

Deno.test("ci_failure_classifier - a genuinely broken scanner run stays infrastructure", () => {
  // A scanner that could not reach the network says nothing about the branch's
  // history. Rewriting it would be a destructive answer to a runner blip.
  const result = classifyCiFailure(
    "gitleaks",
    [],
    "getaddrinfo ENOTFOUND github.com",
  );
  assertEquals(result.category, "infrastructure");
});

Deno.test("ci_failure_classifier - semgrep stays a code fix", () => {
  // Guard against the new patterns swallowing the security check that IS
  // fixable in the working tree.
  const result = classifyCiFailure("semgrep", [{
    message: "BLOCKING CODE RULES FIRED: detect-non-literal-regexp",
  }]);
  assertEquals(result.category, "code-fix-required");
});
