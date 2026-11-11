/**
 * Tests for the CI failure classifier (Issue #1690).
 *
 * The classifier must categorise failing CI checks into actionable
 * buckets (code-fix-required, timing, infrastructure, unknown) so
 * downstream code can route the failure intelligently.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type CiFailureCategory,
  classifyCiFailure,
  HUMAN_STEP_MAX_LENGTH,
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

Deno.test("ci_failure_classifier - a clean gitleaks 'no leaks found' line does not route to history-rewrite (Issue #4506)", () => {
  // gitleaks prints "no leaks found" on a clean scan, so a failing lint job
  // whose log carries it must still route to the code fix it actually needs.
  const result = classifyCiFailure(
    "lint",
    [],
    [
      "AssertionError: expected 1 to equal 2",
      "INF no leaks found",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - a passing --no-git 'leaks found: 1' proof does not route to history-rewrite (Issue #4506)", () => {
  // A negative proof that passes can log "leaks found: 1"; that is not a
  // finding in the commit range, so the failing lint job stays a code fix.
  const result = classifyCiFailure(
    "lint",
    [],
    [
      "AssertionError: expected 1 to equal 2",
      "WRN leaks found: 1",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - a bare 'leaks found: 1' under a security check is not history-rewrite (Issue #4506)", () => {
  // With no range-scoped check name or fingerprint, the phrase alone is not
  // evidence of a commit-range secret finding.
  const result = classifyCiFailure(
    "security",
    [],
    "WRN leaks found: 1",
  );
  assertNotEquals(result.category, "history-rewrite-required");
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

// =============================================================================
// Incidental "timeout" mentions (Issue #1882)
//
// NEAT-AI-Backpropagation PR 150's `Project Validation` failure was an ordinary
// exit-1 script failure, but the job log echoed a `timeout-minutes:` setting
// and the bare "timeout" substring outranked the failing step's own verdict.
// =============================================================================

Deno.test("ci_failure_classifier - regression for PR 150 (exit-1 script, incidental timeout mention)", () => {
  const result = classifyCiFailure(
    "Project Validation",
    [],
    [
      "Run scripts/check-neat-core-version.sh",
      "  timeout-minutes: 20",
      "::error::breaking neat-core bump: 0.15.5 exceeds handled baseline 0.13.0",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
  assertEquals(result.category, "code-fix-required");
  // The routing must be explainable: the step's own exit is the evidence.
  assertEquals(result.reason.includes("exited non-zero"), true);
  assertEquals(result.signals.includes("check:project validation"), true);
  assertEquals(result.signals.includes("exit:1"), true);
});

Deno.test("ci_failure_classifier - a bare timeout-minutes echo alone is not a timing failure", () => {
  const result = classifyCiFailure(
    "build",
    [],
    ["Run make build", "  timeout-minutes: 30"].join("\n"),
  );
  assertEquals(result.category, "unknown");
});

Deno.test("ci_failure_classifier - a timeout wrapper in the command line is not a timing failure", () => {
  const result = classifyCiFailure(
    "test",
    [],
    "Run timeout 900 npx cypress run --config video=false",
  );
  assertEquals(result.category, "unknown");
});

Deno.test("ci_failure_classifier - a timeout named as the failure still routes to timing", () => {
  const result = classifyCiFailure(
    "test",
    [],
    "Timeout of 30000ms exceeded while waiting for the fixture",
  );
  assertEquals(result.category, "timing");
  assertEquals(result.reason.startsWith("timing failure:"), true);
  assertEquals(result.signals.some((s) => s.startsWith("regex:")), true);
});

Deno.test("ci_failure_classifier - a timeout named as the cause of a failure routes to timing", () => {
  const result = classifyCiFailure(
    "e2e",
    [{ message: "fetch failed: timeout while contacting the dev server" }],
  );
  assertEquals(result.category, "timing");
});

Deno.test("ci_failure_classifier - a genuine timeout outranks the step's non-zero exit", () => {
  // The exit-code rule must not swallow a real timing failure: the step that
  // timed out also reports a non-zero exit.
  const result = classifyCiFailure(
    "test",
    [],
    [
      "##[error]The action 'run tests' has timed out after 10 minutes.",
      "##[error]Process completed with exit code 124.",
    ].join("\n"),
  );
  assertEquals(result.category, "timing");
});

Deno.test("ci_failure_classifier - an explicit non-zero exit routes to code-fix-required", () => {
  const result = classifyCiFailure(
    "validate",
    [],
    "##[error]Process completed with exit code 2.",
  );
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - Jest's 'Exceeded timeout of 5000 ms' stays timing", () => {
  // The overrun budget can be named either side of the word "timeout".
  const result = classifyCiFailure(
    "unit tests",
    [{ message: "thrown: Exceeded timeout of 5000 ms for a test." }],
    "##[error]Process completed with exit code 1.",
  );
  assertEquals(result.category, "timing");
});

Deno.test("ci_failure_classifier - a socket timeout named as the failure stays timing", () => {
  const result = classifyCiFailure(
    "install",
    [],
    [
      "npm ERR! network Socket timeout",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
  assertEquals(result.category, "timing");
});

Deno.test("ci_failure_classifier - a --timeout flag beside unrelated prose is not timing", () => {
  // The incidental-mention failure mode again: a flag on the command line
  // must not be read as the step running out of time, however the rest of
  // the line reads.
  const result = classifyCiFailure(
    "smoke",
    [],
    [
      "Run ./scripts/wait.sh --timeout 60 --retry after failure",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - exit code 124 claims no code fix", () => {
  // GNU `timeout`'s own verdict says how the step died, not what to fix.
  const result = classifyCiFailure(
    "e2e",
    [],
    "##[error]Process completed with exit code 124.",
  );
  assertEquals(result.category, "unknown");
});

Deno.test("ci_failure_classifier - a SIGKILLed step claims no code fix", () => {
  const result = classifyCiFailure(
    "build",
    [],
    "##[error]Process completed with exit code 137.",
  );
  assertEquals(result.category, "unknown");
});

Deno.test("ci_failure_classifier - exit code 0 is not a failure signal", () => {
  const result = classifyCiFailure(
    "validate",
    [],
    "step finished with exit code 0",
  );
  assertEquals(result.category, "unknown");
});

// =============================================================================
// Human gate (Issue #2726)
// =============================================================================

const GATE_STEP =
  "apply infra/bootstrap.yaml with AWS SSO, then add the bootstrap-applied label";

Deno.test("ci_failure_classifier - timestamped vibe-human-gate log line routes to human-gate", () => {
  const log = [
    "2026-09-27T03:17:59.1234567Z Run ./check-bootstrap.sh",
    `2026-09-27T03:18:00.0000000Z vibe-human-gate: ${GATE_STEP}`,
    "2026-09-27T03:18:00.1000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");
  const result = classifyCiFailure("bootstrap-applied", [], log);
  assertEquals(result.category, "human-gate");
  assertEquals(result.humanStep, GATE_STEP);
});

Deno.test("ci_failure_classifier - vibe-human-gate annotation is recognised with or without a timestamp", () => {
  for (
    const message of [
      `vibe-human-gate: ${GATE_STEP}`,
      `2026-09-27T03:18:00.0000000Z vibe-human-gate: ${GATE_STEP}`,
    ]
  ) {
    const result = classifyCiFailure("bootstrap-applied", [{ message }]);
    assertEquals(result.category, "human-gate", message);
    assertEquals(result.humanStep, GATE_STEP, message);
  }
});

Deno.test("ci_failure_classifier - ##[error] and ::error:: prefixes are tolerated", () => {
  for (
    const line of [
      `##[error]vibe-human-gate: ${GATE_STEP}`,
      `2026-09-27T03:18:00.0000000Z ##[error]vibe-human-gate: ${GATE_STEP}`,
      `::error::vibe-human-gate: ${GATE_STEP}`,
    ]
  ) {
    const result = classifyCiFailure("gate", [], line);
    assertEquals(result.category, "human-gate", line);
    assertEquals(result.humanStep, GATE_STEP, line);
  }
});

Deno.test("ci_failure_classifier - human step keeps its original case", () => {
  const result = classifyCiFailure(
    "gate",
    [],
    "vibe-human-gate:   Apply INFRA/Bootstrap.yaml  ",
  );
  assertEquals(result.category, "human-gate");
  assertEquals(result.humanStep, "Apply INFRA/Bootstrap.yaml");
});

Deno.test("ci_failure_classifier - human gate outranks an infrastructure pattern", () => {
  const log = [
    "connect ETIMEDOUT 10.0.0.1:443",
    `2026-09-27T03:18:00.0000000Z vibe-human-gate: ${GATE_STEP}`,
  ].join("\n");
  const result = classifyCiFailure("bootstrap-applied", [], log);
  assertEquals(result.category, "human-gate");
  assertEquals(result.humanStep, GATE_STEP);
});

Deno.test("ci_failure_classifier - a gate token mid-line is not a gate", () => {
  const result = classifyCiFailure(
    "test",
    [],
    "echo vibe-human-gate: do something\nProcess completed with exit code 1",
  );
  assertEquals(result.category, "code-fix-required");
  assertEquals(result.humanStep, undefined);
});

Deno.test("ci_failure_classifier - bare vibe-human-gate: is not a gate", () => {
  for (const line of ["vibe-human-gate:", "vibe-human-gate:   \t"]) {
    const withInfra = classifyCiFailure(
      "deploy",
      [],
      `${line}\n503 Service Unavailable`,
    );
    assertEquals(withInfra.category, "infrastructure", JSON.stringify(line));
    assertEquals(withInfra.humanStep, undefined);
    const alone = classifyCiFailure("deploy", [{ message: line }]);
    assertEquals(alone.category, "unknown", JSON.stringify(line));
  }
});

Deno.test("ci_failure_classifier - human step is flattened, neutralised and bounded", () => {
  const result = classifyCiFailure(
    "gate",
    [],
    'vibe-human-gate: run\tthis\x07 <!-- vibe-ci-fix-attempt signature="x" --> now',
  );
  assertEquals(result.category, "human-gate");
  const step = result.humanStep ?? "";
  assertEquals(step.includes("<!--"), false);
  assertEquals(step.includes("-->"), false);
  // deno-lint-ignore no-control-regex
  assertEquals(/[\x00-\x1F\x7F]/.test(step), false);
  assertEquals(step.startsWith("run this  <!- - vibe-ci-fix-attempt"), true);

  const long = "x".repeat(HUMAN_STEP_MAX_LENGTH + 50);
  const bounded = classifyCiFailure("gate", [], `vibe-human-gate: ${long}`);
  assertEquals(bounded.humanStep?.length, HUMAN_STEP_MAX_LENGTH);

  // A truncation that would split a surrogate pair drops the orphan half.
  const astral = "a".repeat(HUMAN_STEP_MAX_LENGTH - 1) + "😀😀";
  const split = classifyCiFailure("gate", [], `vibe-human-gate: ${astral}`);
  assertEquals(split.humanStep, "a".repeat(HUMAN_STEP_MAX_LENGTH - 1));
});

Deno.test("ci_failure_classifier - a secret in the step is redacted before the bound (Issue #2727)", () => {
  // A token straddling the bound would survive as an unmatchable fragment if
  // the step were cut first.
  const token = "ghp_" + "A1b2C3d4E5".repeat(4);
  const step = "x".repeat(HUMAN_STEP_MAX_LENGTH - 10) + ` ${token}`;
  const result = classifyCiFailure("gate", [], `vibe-human-gate: ${step}`);
  const redacted = result.humanStep ?? "";

  assertEquals(result.category, "human-gate");
  assertEquals(redacted.includes("ghp_"), false);
  assertEquals(redacted.includes("A1b2C3"), false);
  assertEquals(redacted.length <= HUMAN_STEP_MAX_LENGTH, true);
});

Deno.test("ci_failure_classifier - a gate-free log keeps humanStep absent", () => {
  const result = classifyCiFailure("semgrep", [], "Blocking code rules fired");
  assertEquals(result.category, "code-fix-required");
  assertEquals("humanStep" in result, false);
});

// =============================================================================
// Download-client 502/503/504 responses (Issue #4965)
//
// @actions/tool-cache (setup-deno, setup-node) and curl -f report a failed
// download as an `error:`-shaped line, which the code-fix regex would claim.
// A 502/503/504 from the download host is an outage, not a code finding.
// =============================================================================

const DOWNLOAD_5XX_CASES: ReadonlyArray<readonly [string, string]> = [
  [
    "Error: Unexpected HTTP response: 504",
    "error: unexpected http response: 504",
  ],
  [
    "Error: Unexpected HTTP response: 503",
    "error: unexpected http response: 503",
  ],
  [
    "Error: Unexpected HTTP response: 502",
    "error: unexpected http response: 502",
  ],
  [
    "curl: (22) The requested URL returned error: 502",
    "the requested url returned error: 502",
  ],
  [
    "curl: (22) The requested URL returned error: 503",
    "the requested url returned error: 503",
  ],
  [
    "curl: (22) The requested URL returned error: 504",
    "the requested url returned error: 504",
  ],
];

Deno.test("ci_failure_classifier - download-client 502/503/504 routes to infrastructure (Issue #4965)", () => {
  for (const [message, pattern] of DOWNLOAD_5XX_CASES) {
    const result = classifyCiFailure(
      "Soak on macos-latest / Run",
      [{ message }],
    );
    assertEquals(result.category, "infrastructure", message);
    assertEquals(result.signals.includes(`text:${pattern}`), true, message);
    // The infrastructure verdict outranks the code-fix `error:` signal.
    assertEquals(
      result.signals.includes("regex:(^|\\s)error:"),
      false,
      message,
    );
  }
});

Deno.test("ci_failure_classifier - download-client 502/503/504 in the log excerpt routes to infrastructure (Issue #4965)", () => {
  for (const [text, pattern] of DOWNLOAD_5XX_CASES) {
    const result = classifyCiFailure("Soak on macos-latest / Run", [], text);
    assertEquals(result.category, "infrastructure", text);
    assertEquals(result.signals.includes(`text:${pattern}`), true, text);
  }
});

Deno.test("ci_failure_classifier - a recovered tool-cache 504 retry does not mask a real lint finding (Issue #4965)", () => {
  const log = [
    "Downloading deno from https://dl.deno.land/release/v2.0.0/deno.zip",
    "Unexpected HTTP response: 504",
    "Waiting 14 seconds before trying again",
    "Extracting deno",
    "error: no-unused-vars 'x' is never used",
  ].join("\n");
  const result = classifyCiFailure("lint", [], log);
  assertEquals(result.category, "code-fix-required");
  assertEquals(
    result.signals.some((s) => s.startsWith("text:unexpected http response")),
    false,
  );
});

Deno.test("ci_failure_classifier - the ##[error] tool-cache 504 line routes to infrastructure (Issue #4965)", () => {
  const result = classifyCiFailure(
    "lint",
    [],
    "##[error]Error: Unexpected HTTP response: 504",
  );
  assertEquals(result.category, "infrastructure");
  assertEquals(
    result.signals.includes("text:error: unexpected http response: 504"),
    true,
  );
});

Deno.test("ci_failure_classifier - setup-node/setup-python terminal 504 (no Error: prefix) routes to infrastructure (Issue #4965)", () => {
  // core.setFailed(err.message): annotation message, no "Error: " prefix.
  const annotated = classifyCiFailure(
    "build",
    [{ message: "Unexpected HTTP response: 504" }],
  );
  assertEquals(annotated.category, "infrastructure");
  assertEquals(
    annotated.signals.includes("text:unexpected http response: 504"),
    true,
  );
  // The same terminal text as the ##[error] log line, with a timestamp and a
  // warning line that would otherwise make the log code-fix-required.
  const log = [
    "2026-11-10T01:02:03.0000000Z warning: deprecated option",
    "2026-11-10T01:02:04.0000000Z Waiting 14 seconds before trying again",
    "2026-11-10T01:02:05.0000000Z ##[error]Unexpected HTTP response: 503",
  ].join("\n");
  const logged = classifyCiFailure("build", [], log);
  assertEquals(logged.category, "infrastructure");
  assertEquals(
    logged.signals.includes("text:unexpected http response: 503"),
    true,
  );
});

Deno.test("ci_failure_classifier - a bare tool-cache 504 log line without ##[error] stays out of infrastructure (Issue #4965)", () => {
  const result = classifyCiFailure(
    "build",
    [],
    "warning: deprecated\nUnexpected HTTP response: 504\nWaiting 14 seconds",
  );
  assertEquals(result.category, "code-fix-required");
});

Deno.test("ci_failure_classifier - a recovered curl 504 retry does not mask a real lint finding (Issue #4965)", () => {
  const retried = [
    "curl: (22) The requested URL returned error: 504",
    "Warning: Problem : HTTP error. Will retry in 1 seconds. 3 retries left.",
    "Installing deno",
    "error: no-unused-vars x is never used",
    "##[error]Process completed with exit code 1.",
  ].join("\n");
  const a = classifyCiFailure("lint", [], retried);
  assertEquals(a.category, "code-fix-required");
  assertEquals(
    a.signals.some((s) => s.startsWith("text:the requested url")),
    false,
  );
  // curl -s: no retry notice, but the later failure is not curl's exit 22.
  const silent = [
    "curl: (22) The requested URL returned error: 504",
    "Installing deno",
    "error: no-unused-vars x is never used",
    "##[error]Process completed with exit code 1.",
  ].join("\n");
  assertEquals(
    classifyCiFailure("lint", [], silent).category,
    "code-fix-required",
  );
});

Deno.test("ci_failure_classifier - a curl 504 followed by a retry notice is not terminal even with exit code 22 (Issue #4965)", () => {
  const log = [
    "curl: (22) The requested URL returned error: 504",
    "Warning: Problem : HTTP error. Will retry in 1 seconds. 3 retries left.",
    "curl: (22) The requested URL returned error: 404",
    "error: download failed",
    "##[error]Process completed with exit code 22.",
  ].join("\n");
  assertEquals(
    classifyCiFailure("build", [], log).category,
    "code-fix-required",
  );
});

Deno.test("ci_failure_classifier - a curl 504 whose retry notice is the only later curl sign is not terminal despite exit code 22 (Issue #4965, PR #5042)", () => {
  // No later `curl: (N)` line, so only the retry notice marks the 504 recovered.
  const log = [
    "curl: (22) The requested URL returned error: 504",
    "Warning: Problem : HTTP error. Will retry in 1 seconds. 3 retries left.",
    "error: unrelated build failure",
    "##[error]Process completed with exit code 22.",
  ].join("\n");
  const result = classifyCiFailure("build", [], log);
  assertEquals(result.category, "code-fix-required");
  assertEquals(
    result.signals.some((s) => s.startsWith("text:the requested url")),
    false,
  );
});

Deno.test("ci_failure_classifier - a silent recovered curl 504 followed by a curl 404 and exit code 22 stays code-fix-required (Issue #4965)", () => {
  // curl -fsSL --retry 3 -o a.tgz URL_A && curl -fsSL -o b.tgz URL_B
  const lines = [
    "curl: (22) The requested URL returned error: 504",
    "curl: (22) The requested URL returned error: 404",
    "##[error]Process completed with exit code 22.",
  ];
  for (
    const log of [
      lines.join("\n"),
      lines.map((l) => `2026-11-11T01:02:03.4567890Z ${l}`).join("\n"),
    ]
  ) {
    const result = classifyCiFailure("build", [], log);
    assertEquals(result.category, "code-fix-required");
    assertEquals(
      result.signals.some((s) => s.startsWith("text:the requested url")),
      false,
    );
  }
});

Deno.test("ci_failure_classifier - a silent recovered curl 504 followed by a later silent exit-22 step stays code-fix-required (Issue #4965, PR #5042)", () => {
  // Step 1 recovered (-sS hides the notice); step 2 `curl -sf` fails silently.
  const lines = [
    "##[group]Run curl -fsSL --retry 3 https://deno.land/install.sh | sh",
    "curl: (22) The requested URL returned error: 504",
    "Deno was installed successfully to /home/runner/.deno/bin/deno",
    "##[group]Run curl -sf http://localhost:8000/health",
    "##[error]Process completed with exit code 22.",
  ];
  for (
    const log of [
      lines.join("\n"),
      lines.map((l) => `2026-11-11T01:02:03.4567890Z ${l}`).join("\n"),
    ]
  ) {
    const result = classifyCiFailure("build", [], log);
    assertEquals(result.category, "code-fix-required");
    assertEquals(
      result.signals.some((s) => s.startsWith("text:the requested url")),
      false,
    );
  }
});

Deno.test("ci_failure_classifier - the terminal curl 504 with exit code 22 routes to infrastructure (Issue #4965)", () => {
  const log = [
    "Warning: Problem : HTTP error. Will retry in 1 seconds. 1 retries left.",
    "curl: (22) The requested URL returned error: 504",
    "curl: (22) The requested URL returned error: 504",
    "##[error]Process completed with exit code 22.",
  ].join("\n");
  const result = classifyCiFailure("build", [], log);
  assertEquals(result.category, "infrastructure");
  assertEquals(
    result.signals.includes("text:the requested url returned error: 504"),
    true,
  );
});

Deno.test("ci_failure_classifier - bare 500 and 4xx download responses stay code-fix-required (Issue #4965)", () => {
  for (
    const message of [
      "Error: Unexpected HTTP response: 500",
      "Error: Unexpected HTTP response: 404",
      "curl: (22) The requested URL returned error: 404",
    ]
  ) {
    const result = classifyCiFailure(
      "Soak on macos-latest / Run",
      [{ message }],
    );
    assertEquals(result.category, "code-fix-required", message);
  }
});
