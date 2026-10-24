/**
 * Issue #4130: a repeat quality-gate failure splits the parent issue into
 * sub-issues, and a split is not a failed attempt.
 *
 * Verifies, through the real remediation phase wiring (deps injected):
 *   - a failing quality gate hands `handleIssueFailure` a split hook for the
 *     run's branch, with the `quality_check` category it classifies;
 *   - a split reported back sets `state.issueSplit`, so the main loop records
 *     no cooldown kind for the run;
 *   - no split leaves `state.issueSplit` unset;
 *   - a state with no branch to split from supplies no hook.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
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

const SUB_ISSUE_URL = "https://github.com/org/repo/issues/101";

function makeConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 4130,
    issueTitle: "Repeat gate failure",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-4130-repeat-gate",
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

/** Runs the failing gate through the phase, with `handleIssueFailure` stubbed. */
async function runFailingGate(
  state: PhaseState,
  handleOutcome: { split: boolean },
) {
  const seen: Array<{
    category?: string;
    splitOnRepeatGate?: unknown;
  }> = [];
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
      handleIssueFailure: ((options: {
        category?: string;
        splitOnRepeatGate?: unknown;
      }) => {
        seen.push(options);
        return Promise.resolve({
          ok: true,
          value: {
            markedAsFailedOnce: !handleOutcome.split,
            failureCategory: "quality_check",
            isInfrastructure: false,
            ...(handleOutcome.split
              ? {
                markedAsFailedOnce: false,
                split: { subIssueUrls: [SUB_ISSUE_URL], notes: [] },
              }
              : {}),
          },
        });
      }) as never,
    },
  });

  const result = await workOnIssueQualityGate(makeContext(), state, deps);
  return { result, seen };
}

Deno.test(
  "quality gate split - a repeat quality failure hands handleIssueFailure a split hook (Issue #4130)",
  async () => {
    const state = makeState({ baselineGateFindings: [PRE_EXISTING_MERMAID] });
    const { seen } = await runFailingGate(state, { split: false });

    assertEquals(seen.length, 1, "handleIssueFailure must be reached");
    assertEquals(
      seen[0]?.category,
      "quality_check",
      "a real quality-gate failure is classified quality_check",
    );
    assertEquals(
      typeof seen[0]?.splitOnRepeatGate,
      "function",
      "the failing gate must supply a split hook",
    );
  },
);

Deno.test(
  "quality gate split - a split sets issueSplit and keeps the ladder applied (Issue #4130)",
  async () => {
    const state = makeState({ baselineGateFindings: [PRE_EXISTING_MERMAID] });
    const { seen } = await runFailingGate(state, { split: true });

    assertEquals(seen.length, 1, "handleIssueFailure must be reached");
    assertEquals(state.issueSplit, true);
    assertEquals(
      state.failureLadderApplied,
      true,
      "a split wrote nothing for the main loop to step again",
    );
  },
);

Deno.test(
  "quality gate split - a recorded repeat leaves issueSplit unset (Issue #4130)",
  async () => {
    const state = makeState({ baselineGateFindings: [PRE_EXISTING_MERMAID] });
    const { seen } = await runFailingGate(state, { split: false });

    assertEquals(seen.length, 1, "handleIssueFailure must be reached");
    assertEquals(state.issueSplit, undefined);
  },
);

Deno.test(
  "quality gate split - a state with no branch to split from supplies no hook (Issue #4130)",
  async () => {
    const state = makeState({
      baselineGateFindings: [PRE_EXISTING_MERMAID],
      repoPath: "",
    });
    const { seen } = await runFailingGate(state, { split: false });

    assertEquals(seen.length, 1, "handleIssueFailure must be reached");
    assertEquals(seen[0]?.splitOnRepeatGate, undefined);
  },
);
