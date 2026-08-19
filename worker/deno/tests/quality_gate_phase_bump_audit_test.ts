/**
 * Tests for the bump-audit gate inside `workOnIssueQualityGate`
 * (Issue #1613).
 *
 * After the quality gate's main remediation loop fails, if the worker
 * had earlier applied a bump (`state.bumpInfo.status === "applied"`) it
 * runs an audit pass: revert the bump and re-run quality once.
 *   - Audit pass — bump is dropped, gate continues, status flipped to
 *     `rejected_by_audit`.
 *   - Audit fail — original HEAD restored, gate fails as before.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { BumpInfo } from "../lib/bump_deps.ts";

function makeConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 1613,
    issueTitle: "Bump deps",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
    ...overrides,
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-1613-bump",
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

function makeAppliedBumpInfo(): BumpInfo {
  return {
    status: "applied",
    files: ["package.json"],
    output: "bumped 1 dep",
    sha: "bumpsha",
    beforeBumpSha: "beforesha",
  };
}

// =============================================================================
// Audit success — bump is dropped and gate passes
// =============================================================================

Deno.test(
  "qualityGate audit - bump applied + quality passes only without it -> rejected_by_audit and continue",
  async () => {
    const ctx = makeContext();
    const state = makeState({ bumpInfo: makeAppliedBumpInfo() });
    const gitCalls: string[][] = [];
    let qualityCallCount = 0;

    const deps = createMockDeps({
      quality: {
        runQualityGate: () => {
          qualityCallCount++;
          // First two calls: original gate (initial + Claude-fix retry) — both fail.
          // Third call: audit re-run after revert — passes.
          if (qualityCallCount <= 2) {
            return Promise.resolve({
              ok: true,
              value: {
                checks: [],
                summary: { text: "failed", passed: false },
                passed: false,
                output: "lint error from bumped dep",
              },
            });
          }
          return Promise.resolve({
            ok: true,
            value: {
              checks: [],
              summary: { text: "passed", passed: true },
              passed: true,
              output: "all good without the bump",
            },
          });
        },
      },
      git: {
        runGitCommand: ((args: string[]) => {
          gitCalls.push(args);
          // git rev-parse HEAD — return a deterministic sha
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return Promise.resolve({
              ok: true,
              value: { code: 0, stdout: "currenthead\n", stderr: "" },
            });
          }
          // git reset --hard <sha>
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as never,
      },
    });

    const result = await workOnIssueQualityGate(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.bumpInfo?.status, "rejected_by_audit");
    assertEquals(
      state.bumpInfo?.rejectionReason !== undefined,
      true,
      "audit must record a rejection reason",
    );

    // Audit must reset --hard to beforeBumpSha. We don't assert the exact
    // sequence (tests for git_history.ts cover that) but we do require at
    // least one reset --hard <beforeBumpSha> happened.
    const resetCall = gitCalls.find(
      (args) =>
        args[0] === "reset" && args[1] === "--hard" && args[2] === "beforesha",
    );
    assertEquals(
      resetCall !== undefined,
      true,
      "audit must reset --hard to beforeBumpSha",
    );
  },
);

// =============================================================================
// Audit failure — quality still fails without bump; HEAD restored
// =============================================================================

Deno.test(
  "qualityGate audit - quality still fails without bump -> restore HEAD and report failure",
  async () => {
    const ctx = makeContext();
    const state = makeState({ bumpInfo: makeAppliedBumpInfo() });
    const gitCalls: string[][] = [];
    let handleIssueFailureCalled = false;

    const deps = createMockDeps({
      quality: {
        runQualityGate: () =>
          Promise.resolve({
            ok: true,
            value: {
              checks: [],
              summary: { text: "failed", passed: false },
              passed: false,
              output: "lint error not caused by bump",
            },
          }),
      },
      git: {
        runGitCommand: ((args: string[]) => {
          gitCalls.push(args);
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return Promise.resolve({
              ok: true,
              value: { code: 0, stdout: "currenthead\n", stderr: "" },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as never,
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
      state.bumpInfo?.status,
      "applied",
      "audit fail must leave bumpInfo.status as applied (no audit-reject)",
    );
    assertEquals(
      handleIssueFailureCalled,
      true,
      "handleIssueFailure must still be called when audit does not exonerate",
    );

    // HEAD must be restored after a failed audit attempt.
    const restoreCall = gitCalls.find(
      (args) =>
        args[0] === "reset" &&
        args[1] === "--hard" &&
        args[2] === "currenthead",
    );
    assertEquals(
      restoreCall !== undefined,
      true,
      "must reset --hard back to original HEAD when audit fails",
    );
  },
);

// =============================================================================
// No bump applied — audit is skipped entirely
// =============================================================================

Deno.test(
  "qualityGate audit - no bump applied -> audit skipped, no extra git ops",
  async () => {
    const ctx = makeContext();
    const state = makeState(); // no bumpInfo
    const gitCalls: string[][] = [];

    const deps = createMockDeps({
      quality: {
        runQualityGate: () =>
          Promise.resolve({
            ok: true,
            value: {
              checks: [],
              summary: { text: "failed", passed: false },
              passed: false,
              output: "lint error",
            },
          }),
      },
      git: {
        runGitCommand: ((args: string[]) => {
          gitCalls.push(args);
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as never,
      },
    });

    const result = await workOnIssueQualityGate(ctx, state, deps);

    assertEquals(result.status, "failure");
    // Without a bump, the audit must not issue any reset --hard.
    const resetCall = gitCalls.find(
      (args) => args[0] === "reset" && args[1] === "--hard",
    );
    assertEquals(
      resetCall,
      undefined,
      "must not run git reset when no bump was applied",
    );
  },
);
