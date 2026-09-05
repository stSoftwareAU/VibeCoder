/**
 * The baseline gate run is the fleet's only measurement of what the gate
 * costs on a repository (Issue #1138).
 *
 * The agent is told how much run budget the gate needs before it starts one,
 * and a fleet-wide assumption is a poor substitute for the figure this very
 * cycle produced. This phase is where that figure exists, so this is where it
 * is recorded.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueBaselineQuality } from "../lib/phases/baseline_quality_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { WorkerDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { BASELINE_QUALITY_CACHE_VERSION } from "../lib/baseline_quality_cache.ts";

const CLEAN_SHA = "0123456789abcdef0123456789abcdef01234567";

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Fix login bug",
    issueBody: "body",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: { ...buildDefaultWorkerConfig(), baselineAwareQualityGate: false },
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-42",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** Deps whose gate either runs (taking real time) or is served from cache. */
function makeDeps(options: { cached?: boolean; errors?: boolean }): WorkerDeps {
  return createMockDeps({
    git: {
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: args[0] === "status" ? "" : `${CLEAN_SHA}\n`,
            stderr: "",
          },
        }),
    },
    quality: {
      runQualityGate: async () => {
        // Real elapsed time, so the recorded duration is a measurement of
        // something rather than a constant the phase invented.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (options.errors) {
          return { ok: false as const, error: new Error("gate could not run") };
        }
        return {
          ok: true as const,
          value: {
            checks: [],
            summary: { text: "summary", passed: true },
            passed: true,
            output: "",
          },
        };
      },
      collectDiffableGateFindings: () => Promise.resolve([]),
      readBaselineQualityCache: () =>
        Promise.resolve(
          options.cached
            ? {
              version: BASELINE_QUALITY_CACHE_VERSION,
              passed: true,
              output: "",
              storedAt: Date.now(),
            }
            : null,
        ),
      writeBaselineQualityCache: () => Promise.resolve(),
    },
  });
}

Deno.test("baselineQuality - records how long the gate actually took (Issue #1138)", async () => {
  const state = makeState();
  await workOnIssueBaselineQuality(makeContext(), state, makeDeps({}));
  assert(
    (state.baselineQualityDurationSeconds ?? 0) > 0,
    `a gate that ran must leave a positive duration behind, got ` +
      `${state.baselineQualityDurationSeconds}`,
  );
});

Deno.test("baselineQuality - a reused baseline measures nothing (Issue #1138)", async () => {
  const state = makeState();
  await workOnIssueBaselineQuality(
    makeContext(),
    state,
    makeDeps({ cached: true }),
  );
  assertEquals(
    state.baselineQualityDurationSeconds,
    undefined,
    "a cache hit never ran the gate, so it has no duration to report",
  );
});

Deno.test("baselineQuality - a gate that could not run measures nothing (Issue #1138)", async () => {
  const state = makeState();
  await workOnIssueBaselineQuality(
    makeContext(),
    state,
    makeDeps({ errors: true }),
  );
  assertEquals(
    state.baselineQualityDurationSeconds,
    undefined,
    "a failed gate's elapsed time is not a measurement of the gate",
  );
});
