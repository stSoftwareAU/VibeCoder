/**
 * Phase-level tests for the pre-existing gate failure stop (Issue #1852)
 * inside `workOnIssueQualityGate`.
 *
 * The production symptom: a repository whose own quality check is red on its
 * default branch failed every run at `quality_gate`, recorded a host health
 * failure and cooled the issue down — even though the worker's own log said
 * the failure predated the run. These tests drive the real phase wiring:
 *
 *   - baseline output X (failing check C) + post-change output X → the phase
 *     exits early as an expected skip, files one tracker, and never reaches
 *     `handleIssueFailure`;
 *   - baseline X + post-change X ∪ {D} → today's failure behaviour stands;
 *   - the remediation attempt is not spent on a failure no change can clear.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { CheckResult } from "../lib/quality_helpers.ts";

/** The repository's own check, red on its untouched default branch. */
const RED_CHECK = "repo quality.sh";
const RED_OUTPUT = "repo quality.sh: workflows do not carry one version " +
  "comment everywhere it appears.\n  .github/workflows/ci.yml:12";

function makeConfig(): WorkerConfig {
  // baselineAwareQualityGate defaults on. The infrastructure-retry backoff is
  // zeroed so the infra-class test does not sleep out its 15-second default.
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 0 };
}

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 1852,
    issueTitle: "Pre-existing gate failure",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-1852",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: false,
    baselineQualityOutput: RED_OUTPUT,
    baselineFailedChecks: [{ name: RED_CHECK, output: RED_OUTPUT }],
    ...overrides,
  };
}

function failedGate(checks: CheckResult[]) {
  return Promise.resolve({
    ok: true as const,
    value: {
      checks,
      summary: { text: "failed", passed: false },
      passed: false,
      output: `=== Running Quality Checks ===\n${
        checks.map((c) => c.output ?? "").join("\n")
      }`,
    },
  });
}

interface Harness {
  deps: ReturnType<typeof createMockDeps>;
  claudeCalls: () => number;
  trackerCalls: () => string[][];
  failureCalls: () => number;
}

function harness(checks: CheckResult[]): Harness {
  let claudeCalls = 0;
  let failureCalls = 0;
  const trackerCalls: string[][] = [];
  const deps = createMockDeps({
    quality: {
      runQualityGate: () => failedGate(checks),
      collectDiffableGateFindings: () => Promise.resolve([]),
      fileRedCheckTracker: ((_repo: string, names: readonly string[]) => {
        trackerCalls.push([...names]);
        return Promise.resolve();
      }) as never,
    },
    claude: {
      runClaudeWithRetry: (() => {
        claudeCalls++;
        return Promise.resolve({ ok: true, value: { output: "" } });
      }) as never,
    },
    github: {
      handleIssueFailure: (() => {
        failureCalls++;
        return Promise.resolve({
          ok: true,
          value: {
            markedAsFailed: false,
            markedAsFailedOnce: true,
            failureCategory: "quality_check",
            isInfrastructure: false,
          },
        });
      }) as never,
    },
  });
  return {
    deps,
    claudeCalls: () => claudeCalls,
    trackerCalls: () => trackerCalls,
    failureCalls: () => failureCalls,
  };
}

// ---------------------------------------------------------------------------
// Same check, same output → pre-existing
// ---------------------------------------------------------------------------

Deno.test(
  "pre-existing gate - the same red check with the same output ends the run as an expected skip",
  async () => {
    const h = harness([
      { name: RED_CHECK, status: "FAILED", output: RED_OUTPUT },
    ]);
    const result = await workOnIssueQualityGate(
      makeContext(),
      makeState(),
      h.deps,
    );

    assertEquals(result.status, "early_exit");
    assert(result.status === "early_exit");
    assertEquals(result.expectedSkip, true, "must not be a worker failure");
    assertStringIncludes(result.reason, "pre_existing_gate_failure");
    assertStringIncludes(result.reason, RED_CHECK);
    assertEquals(result.outcome?.kind, "no_pr_expected");
    assertEquals(
      h.failureCalls(),
      0,
      "a pre-existing failure must not enter the failure path",
    );
    assertEquals(
      h.claudeCalls(),
      0,
      "no remediation attempt for a failure no change can clear",
    );
    assertEquals(
      h.trackerCalls(),
      [[RED_CHECK]],
      "one tracker naming the check that is red",
    );
  },
);

// ---------------------------------------------------------------------------
// Same check, an extra finding → today's failure behaviour
// ---------------------------------------------------------------------------

Deno.test(
  "pre-existing gate - a new line under the same red check still fails the run",
  async () => {
    const h = harness([
      {
        name: RED_CHECK,
        status: "FAILED",
        output: `${RED_OUTPUT}\n  .github/workflows/new.yml:4`,
      },
    ]);
    const result = await workOnIssueQualityGate(
      makeContext(),
      makeState(),
      h.deps,
    );

    assertEquals(result.status, "failure");
    assertEquals(h.failureCalls(), 1, "a new finding is the run's own");
    assertEquals(h.trackerCalls(), [], "no tracker for a run's own failure");
  },
);

// ---------------------------------------------------------------------------
// A check that was green at baseline → today's failure behaviour
// ---------------------------------------------------------------------------

Deno.test(
  "pre-existing gate - a check that was green on the untouched tree still fails the run",
  async () => {
    const h = harness([
      { name: RED_CHECK, status: "FAILED", output: RED_OUTPUT },
      { name: "deno tests", status: "FAILED", output: "1 test failed" },
    ]);
    const result = await workOnIssueQualityGate(
      makeContext(),
      makeState(),
      h.deps,
    );

    assertEquals(result.status, "failure");
    assertEquals(h.failureCalls(), 1);
    assertEquals(h.trackerCalls(), []);
  },
);

// ---------------------------------------------------------------------------
// A clean baseline → today's failure behaviour
// ---------------------------------------------------------------------------

Deno.test(
  "pre-existing gate - a failure on a clean baseline still fails the run",
  async () => {
    const h = harness([
      { name: RED_CHECK, status: "FAILED", output: RED_OUTPUT },
    ]);
    const result = await workOnIssueQualityGate(
      makeContext(),
      makeState({
        baselineQualityPassed: true,
        baselineQualityOutput: "",
        baselineFailedChecks: [],
      }),
      h.deps,
    );

    assertEquals(result.status, "failure");
    assertEquals(h.failureCalls(), 1);
    assertEquals(h.trackerCalls(), []);
  },
);

// ---------------------------------------------------------------------------
// A baseline with no recorded per-check output → today's failure behaviour
// ---------------------------------------------------------------------------

Deno.test(
  "pre-existing gate - a baseline that recorded no per-check output still fails the run",
  async () => {
    const h = harness([
      { name: RED_CHECK, status: "FAILED", output: RED_OUTPUT },
    ]);
    const state = makeState();
    delete state.baselineFailedChecks;
    const result = await workOnIssueQualityGate(makeContext(), state, h.deps);

    assertEquals(result.status, "failure");
    assertEquals(h.failureCalls(), 1);
  },
);

// ---------------------------------------------------------------------------
// An environment fault is never re-attributed to the repository
// ---------------------------------------------------------------------------

Deno.test(
  "pre-existing gate - an infrastructure-class failure still fails the run",
  async () => {
    // A host without deno fails the baseline and the post-change gate with
    // byte-identical output. Waving that through would silence the host
    // health failure an operator needs and blame an innocent repository.
    const missingDeno =
      "[quality-gate] deno is not installed or not in PATH: Tool not found: " +
      "deno — every Deno check is reported FAILED";
    const h = harness([
      { name: "deno tests", status: "FAILED", output: missingDeno },
    ]);
    const result = await workOnIssueQualityGate(
      makeContext(),
      makeState({
        baselineFailedChecks: [{ name: "deno tests", output: missingDeno }],
      }),
      h.deps,
    );

    assertEquals(result.status, "failure");
    assertEquals(
      h.trackerCalls(),
      [],
      "a broken host must not file a tracker on the repository",
    );
  },
);
