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
  handleOutcome: { split: boolean; failed?: boolean; invokeHook?: boolean },
) {
  const seen: Array<{
    category?: string;
    splitOnRepeatGate?: unknown;
  }> = [];
  const gitCalls: string[][] = [];
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
    git: {
      runGitCommand: ((args: string[]) => {
        gitCalls.push(args);
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      }) as never,
    },
    github: {
      // A client whose thread holds a fleet-authored failure record, so the
      // hook gets as far as summarising the branch.
      createClient: (() => ({
        getIssueComments: () =>
          Promise.resolve([{
            id: 1,
            body: "## Automated Processing Failed (First Attempt)",
            author: "testbot",
            createdAt: "2026-10-01T00:00:00Z",
            reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
          }]),
      })) as never,
      handleIssueFailure: (async (options: {
        category?: string;
        splitOnRepeatGate?: (
          req: { category: string; gateOutput: string },
        ) => Promise<unknown>;
      }) => {
        seen.push(options);
        if (handleOutcome.failed) {
          return { ok: false, error: new Error("label write failed") };
        }
        // Run the real hook, so the branch it was built for is observable.
        if (handleOutcome.invokeHook) {
          await options.splitOnRepeatGate?.({
            category: "quality_check",
            gateOutput: "quality.sh: 2 tests failed",
          });
        }
        const value = handleOutcome.split
          ? {
            markedAsFailedOnce: false,
            failureCategory: "quality_check",
            isInfrastructure: false,
            split: { subIssueUrls: [SUB_ISSUE_URL], notes: [] },
          }
          : {
            markedAsFailedOnce: true,
            failureCategory: "quality_check",
            isInfrastructure: false,
          };
        return { ok: true, value };
      }) as never,
    },
  });

  const result = await workOnIssueQualityGate(makeContext(), state, deps);
  return { result, seen, gitCalls };
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

Deno.test(
  "quality gate split - a state with no branch name supplies no hook (Issue #4130)",
  async () => {
    const state = makeState({
      baselineGateFindings: [PRE_EXISTING_MERMAID],
      branchName: "",
    });
    const { seen } = await runFailingGate(state, { split: false });

    assertEquals(seen.length, 1, "handleIssueFailure must be reached");
    assertEquals(seen[0]?.splitOnRepeatGate, undefined);
  },
);

Deno.test(
  "quality gate split - a failed failure record leaves issueSplit unset and does not throw (Issue #4130)",
  async () => {
    const state = makeState({ baselineGateFindings: [PRE_EXISTING_MERMAID] });
    const { seen } = await runFailingGate(state, {
      split: false,
      failed: true,
    });

    assertEquals(seen.length, 1, "handleIssueFailure must be reached");
    assertEquals(state.issueSplit, undefined);
    assertEquals(state.failureLadderApplied, true);
  },
);

for (
  const c of [
    {
      name: "a milestone branch",
      milestone: "milestone/m1",
      base: "milestone/m1",
    },
    { name: "no milestone branch", milestone: undefined, base: "main" },
  ]
) {
  Deno.test(
    `quality gate split - the hook compares the branch with ${c.name} as its base (Issue #4130)`,
    async () => {
      const state = makeState({
        baselineGateFindings: [PRE_EXISTING_MERMAID],
        ...(c.milestone ? { milestoneBranch: c.milestone } : {}),
      });
      const { gitCalls } = await runFailingGate(state, {
        split: false,
        invokeHook: true,
      });

      const log = gitCalls.find((args) => args[0] === "log");
      assertEquals(
        log?.at(-1),
        `origin/${c.base}..refs/heads/issue-4130-repeat-gate`,
      );
    },
  );
}
