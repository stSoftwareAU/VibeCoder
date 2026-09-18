/**
 * Phase-level tests for the quality-gate attempt recorded on the phase state
 * (Issue #2345, part of #2320).
 *
 * The gate is bounded to two attempts — the initial `./quality.sh` run plus one
 * `quality_fix` remediation and re-run — and which of them passed used to reach
 * the worker log only. `workOnIssueQualityGate` now records it on
 * `PhaseState.qualityGateOutcome`, which the completion phase renders on the
 * run-stats comment, so the pilot's first-attempt pass rate has a readable
 * source.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { CheckResult } from "../lib/quality_helpers.ts";

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 2345,
    issueTitle: "Report the quality-gate pass attempt",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-2345",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...overrides,
  };
}

/** A gate run that passed. */
function passedGate() {
  return Promise.resolve({
    ok: true as const,
    value: {
      checks: [] as CheckResult[],
      summary: { text: "passed", passed: true },
      passed: true,
      output: "All checks passed",
    },
  });
}

/** A gate run that failed on `deno test` — never a diffable finding. */
function failedGate() {
  return Promise.resolve({
    ok: true as const,
    value: {
      checks: [{ name: "deno test", status: "FAILED" }] as CheckResult[],
      summary: { text: "failed", passed: false },
      passed: false,
      output: "deno test failed",
    },
  });
}

/**
 * Deps whose gate returns `outcomes[n]` on the n-th run, and whose Claude fix
 * attempt does nothing but succeed.
 */
function makeDeps(outcomes: (() => ReturnType<typeof passedGate>)[]) {
  let call = 0;
  return createMockDeps({
    quality: {
      runQualityGate: () => (outcomes[call++] ?? failedGate)(),
      // A failing non-diffable check, so the baseline-aware bypass never fires.
      collectDiffableGateFindings: () => Promise.resolve([]),
    },
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({ ok: true, value: { output: "fixed" } })) as never,
    },
  });
}

Deno.test("quality gate - a gate that passes first time records attempt 1", async () => {
  const state = makeState();

  const result = await workOnIssueQualityGate(
    makeContext(),
    state,
    makeDeps([passedGate]),
  );

  assertEquals(result.status, "continue");
  assertEquals(state.qualityGateOutcome, { status: "passed", attempt: 1 });
});

Deno.test("quality gate - a gate that passes after remediation records attempt 2", async () => {
  const state = makeState({ baselineFailedChecks: [] });

  const result = await workOnIssueQualityGate(
    makeContext(),
    state,
    makeDeps([failedGate, passedGate]),
  );

  assertEquals(result.status, "continue");
  assertEquals(state.qualityGateOutcome, { status: "passed", attempt: 2 });
});

Deno.test("quality gate - a gate still red after remediation records failed", async () => {
  const state = makeState({ baselineFailedChecks: [] });

  const result = await workOnIssueQualityGate(
    makeContext(),
    state,
    makeDeps([failedGate, failedGate]),
  );

  assertEquals(result.status, "failure");
  assertEquals(state.qualityGateOutcome, { status: "failed" });
});

Deno.test("quality gate - a gate that could not run at all records failed", async () => {
  const state = makeState();
  const deps = createMockDeps({
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: false as const,
          error: new Error("quality.sh not found"),
        }),
    },
  });

  const result = await workOnIssueQualityGate(makeContext(), state, deps);

  assertEquals(result.status, "failure");
  // Absence of a pass is never read as a pass: the gate did not go green, so
  // the report says `failed` rather than staying silent.
  assertEquals(state.qualityGateOutcome, { status: "failed" });
});
