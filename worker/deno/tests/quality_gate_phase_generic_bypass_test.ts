/**
 * Phase-level tests for the generic baseline-aware quality-gate bypass
 * (Issue #2604) inside `workOnIssueQualityGate`.
 *
 * Verifies, through the real phase wiring (deps injected):
 *   - A mermaid-only pre-existing failure is bypassed → the phase
 *     short-circuits to `continue` without consuming a `failed-once`
 *     attempt and without invoking Claude.
 *   - A genuinely-new mermaid failure (clean baseline) is NOT bypassed —
 *     closing the shellcheck-only hole (Issue #1549).
 *   - A failing non-diffable check (deno tests) is never bypassed even
 *     when diffable carryover exists.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GenericFinding } from "../lib/baseline_gate.ts";
import { mermaidFinding } from "../lib/baseline_gate.ts";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { CheckResult } from "../lib/quality_helpers.ts";

function makeConfig(): WorkerConfig {
  // baselineAwareQualityGate defaults on.
  return buildDefaultWorkerConfig();
}

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 2604,
    issueTitle: "Generic gate bypass",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-2604",
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

function failedGate(checks: CheckResult[]) {
  return Promise.resolve({
    ok: true as const,
    value: {
      checks,
      summary: { text: "failed", passed: false },
      passed: false,
      output: "quality output",
    },
  });
}

const PRE_EXISTING_MERMAID: GenericFinding = mermaidFinding({
  file: "docs/x.md",
  startLine: 3,
  type: "sequenceDiagram",
  error: "participant Loop",
});

// ---------------------------------------------------------------------------
// Mermaid-only pre-existing failure → bypass
// ---------------------------------------------------------------------------

Deno.test(
  "generic bypass - mermaid-only pre-existing failure short-circuits to continue",
  async () => {
    const ctx = makeContext();
    const state = makeState({ baselineGateFindings: [PRE_EXISTING_MERMAID] });
    let claudeCalls = 0;
    const trackerCalls: GenericFinding[][] = [];

    const deps = createMockDeps({
      quality: {
        runQualityGate: () =>
          failedGate([{ name: "mermaid", status: "FAILED" }]),
        collectDiffableGateFindings: () =>
          Promise.resolve([PRE_EXISTING_MERMAID]),
        fileBaselineCarryoverTracker: ((
          _repo: string,
          findings: GenericFinding[],
        ) => {
          trackerCalls.push(findings);
          return Promise.resolve();
        }) as never,
      },
      claude: {
        runClaudeWithRetry: (() => {
          claudeCalls++;
          return Promise.resolve({ ok: true, value: { output: "" } });
        }) as never,
      },
    });

    const result = await workOnIssueQualityGate(ctx, state, deps);
    assertEquals(result.status, "continue");
    assertEquals(claudeCalls, 0, "bypass must not invoke Claude");
    // Issue #2605: the bypass branch files a carryover tracker carrying the
    // pre-existing findings.
    assertEquals(
      trackerCalls.length,
      1,
      "bypass must file a carryover tracker",
    );
    assertEquals(trackerCalls[0], [PRE_EXISTING_MERMAID]);
  },
);

// ---------------------------------------------------------------------------
// New mermaid failure (clean baseline) → NOT bypassed (the hole-fix)
// ---------------------------------------------------------------------------

Deno.test(
  "generic bypass - a NEW mermaid failure on a clean baseline is not bypassed",
  async () => {
    const ctx = makeContext();
    // Clean baseline — no diffable findings.
    const state = makeState({ baselineGateFindings: [] });
    let handleIssueFailureCalled = false;
    let trackerCalls = 0;

    const deps = createMockDeps({
      quality: {
        runQualityGate: () =>
          failedGate([{ name: "mermaid", status: "FAILED" }]),
        collectDiffableGateFindings: () =>
          Promise.resolve([PRE_EXISTING_MERMAID]),
        fileBaselineCarryoverTracker: (() => {
          trackerCalls++;
          return Promise.resolve();
        }) as never,
      },
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({ ok: true, value: { output: "" } })) as never,
      },
      github: {
        handleIssueFailure: (() => {
          handleIssueFailureCalled = true;
          return Promise.resolve({
            ok: true,
            value: {
              markedAsFailed: false,
              markedAsFailedOnce: true,
              failureCategory: "unknown",
              isInfrastructure: false,
            },
          });
        }) as never,
      },
    });

    const result = await workOnIssueQualityGate(ctx, state, deps);
    assertEquals(result.status, "failure");
    assertEquals(
      handleIssueFailureCalled,
      true,
      "a new finding must flow through the failure path",
    );
    // Issue #2605: no bypass → no carryover tracker.
    assertEquals(
      trackerCalls,
      0,
      "no bypass must not file a carryover tracker",
    );
  },
);

// ---------------------------------------------------------------------------
// Non-diffable failing check (deno tests) → never bypassed
// ---------------------------------------------------------------------------

Deno.test(
  "generic bypass - a failing deno-tests check is never bypassed",
  async () => {
    const ctx = makeContext();
    // Even with diffable carryover present, a failing non-diffable check
    // blocks the bypass.
    const state = makeState({ baselineGateFindings: [PRE_EXISTING_MERMAID] });

    const deps = createMockDeps({
      quality: {
        runQualityGate: () =>
          failedGate([
            { name: "mermaid", status: "FAILED" },
            { name: "deno tests", status: "FAILED" },
          ]),
        collectDiffableGateFindings: () =>
          Promise.resolve([PRE_EXISTING_MERMAID]),
      },
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({ ok: true, value: { output: "" } })) as never,
      },
      github: {
        handleIssueFailure: (() =>
          Promise.resolve({
            ok: true,
            value: {
              markedAsFailed: false,
              markedAsFailedOnce: true,
              failureCategory: "unknown",
              isInfrastructure: false,
            },
          })) as never,
      },
    });

    const result = await workOnIssueQualityGate(ctx, state, deps);
    assertEquals(
      result.status,
      "failure",
      "non-diffable failure must not bypass",
    );
  },
);

// ---------------------------------------------------------------------------
// Gate passes → no carryover tracker filed (Issue #2605)
// ---------------------------------------------------------------------------

Deno.test(
  "generic bypass - a passing gate files no carryover tracker",
  async () => {
    const ctx = makeContext();
    const state = makeState({ baselineGateFindings: [PRE_EXISTING_MERMAID] });
    let trackerCalls = 0;

    const deps = createMockDeps({
      quality: {
        runQualityGate: () =>
          Promise.resolve({
            ok: true as const,
            value: {
              checks: [{ name: "mermaid", status: "PASSED" }],
              summary: { text: "passed", passed: true },
              passed: true,
              output: "",
            },
          }),
        fileBaselineCarryoverTracker: (() => {
          trackerCalls++;
          return Promise.resolve();
        }) as never,
      },
    });

    const result = await workOnIssueQualityGate(ctx, state, deps);
    assertEquals(result.status, "continue");
    assertEquals(trackerCalls, 0, "a passing gate must not file a tracker");
  },
);
