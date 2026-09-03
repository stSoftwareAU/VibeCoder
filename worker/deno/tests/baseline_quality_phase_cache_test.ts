/**
 * Tests for baseline gate reuse in the baseline quality phase (Issue #4283).
 *
 * The phase must reuse a recorded baseline outcome when the checkout is
 * byte-identical (clean tree, same HEAD SHA) and fall back to the full gate
 * on any ambiguity.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { workOnIssueBaselineQuality } from "../lib/phases/baseline_quality_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { WorkerDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type {
  BaselineQualityCacheEntry,
  BaselineQualityOutcome,
} from "../lib/baseline_quality_cache.ts";
import { BASELINE_QUALITY_CACHE_VERSION } from "../lib/baseline_quality_cache.ts";
import type { GenericFinding } from "../lib/baseline_gate.ts";

const CLEAN_SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * Context with the baseline-aware gate off by default so the reuse tests
 * exercise one axis at a time; the findings tests turn it back on.
 */
function makeContext(config?: Partial<WorkerConfig>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Fix login bug",
    issueBody: "body",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: {
      ...buildDefaultWorkerConfig(),
      baselineAwareQualityGate: false,
      ...config,
    },
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

interface Recorder {
  gateRuns: number;
  writes: Array<{ key: string; outcome: BaselineQualityOutcome }>;
  reads: string[];
}

interface Scenario {
  /** Working-tree porcelain output; empty means clean. */
  porcelain?: string;
  /** Cached entry returned for any key, or null for a miss. */
  cached?: BaselineQualityCacheEntry | null;
  /** Gate outcome when it actually runs. */
  gatePassed?: boolean;
  gateOutput?: string;
  findings?: GenericFinding[];
  gateErrors?: boolean;
  writeThrows?: boolean;
}

function makeDeps(
  scenario: Scenario,
): { deps: WorkerDeps; recorder: Recorder } {
  const recorder: Recorder = { gateRuns: 0, writes: [], reads: [] };

  const deps = createMockDeps({
    git: {
      runGitCommand: (args: string[]) => {
        if (args[0] === "status") {
          return Promise.resolve({
            ok: true as const,
            value: {
              code: 0,
              stdout: scenario.porcelain ?? "",
              stderr: "",
            },
          });
        }
        return Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: `${CLEAN_SHA}\n`, stderr: "" },
        });
      },
    },
    quality: {
      runQualityGate: () => {
        recorder.gateRuns++;
        if (scenario.gateErrors) {
          return Promise.resolve({
            ok: false as const,
            error: new Error("gate could not run"),
          });
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            checks: [],
            summary: {
              text: "summary",
              passed: scenario.gatePassed ?? true,
            },
            passed: scenario.gatePassed ?? true,
            output: scenario.gateOutput ?? "",
          },
        });
      },
      collectDiffableGateFindings: () =>
        Promise.resolve(scenario.findings ?? []),
      readBaselineQualityCache: (key: string) => {
        recorder.reads.push(key);
        return Promise.resolve(scenario.cached ?? null);
      },
      writeBaselineQualityCache: (
        key: string,
        outcome: BaselineQualityOutcome,
      ) => {
        if (scenario.writeThrows) {
          return Promise.reject(new Error("disk full"));
        }
        recorder.writes.push({ key, outcome });
        return Promise.resolve();
      },
    },
  });

  return { deps, recorder };
}

function cachedEntry(
  overrides?: Partial<BaselineQualityCacheEntry>,
): BaselineQualityCacheEntry {
  return {
    version: BASELINE_QUALITY_CACHE_VERSION,
    passed: true,
    output: "",
    storedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reuse
// ---------------------------------------------------------------------------

Deno.test("baselineQuality cache - reuses a cached pass without running the gate", async () => {
  const { deps, recorder } = makeDeps({ cached: cachedEntry() });
  const state = makeState();

  const result = await workOnIssueBaselineQuality(makeContext(), state, deps);

  assertEquals(result.status, "continue");
  assertEquals(recorder.gateRuns, 0, "the full gate must not re-run");
  assertEquals(recorder.reads, [`org/repo@${CLEAN_SHA}`]);
  assertEquals(state.baselineQualityPassed, true);
  assertEquals(state.baselineQualityOutput, "");
});

Deno.test("baselineQuality cache - reuses a cached failure and its output", async () => {
  const { deps, recorder } = makeDeps({
    cached: cachedEntry({ passed: false, output: "markdownlint: FAILED" }),
  });
  const state = makeState();

  await workOnIssueBaselineQuality(makeContext(), state, deps);

  assertEquals(recorder.gateRuns, 0);
  assertEquals(state.baselineQualityPassed, false);
  assertEquals(state.baselineQualityOutput, "markdownlint: FAILED");
});

Deno.test("baselineQuality cache - reuses cached diffable findings when the baseline-aware gate is on", async () => {
  const findings: GenericFinding[] = [
    { check: "mermaid", key: "docs/a.md:1", display: "a" },
  ];
  const { deps, recorder } = makeDeps({
    cached: cachedEntry({ passed: false, output: "mermaid: FAILED", findings }),
  });
  const state = makeState();

  await workOnIssueBaselineQuality(
    makeContext({ baselineAwareQualityGate: true }),
    state,
    deps,
  );

  assertEquals(recorder.gateRuns, 0);
  assertEquals(state.baselineGateFindings, findings);
});

Deno.test("baselineQuality cache - re-runs when the entry lacks findings the baseline-aware gate needs", async () => {
  const { deps, recorder } = makeDeps({
    cached: cachedEntry(),
    findings: [{ check: "markdownlint", key: "docs/x.md", display: "x" }],
  });
  const state = makeState();

  await workOnIssueBaselineQuality(
    makeContext({ baselineAwareQualityGate: true }),
    state,
    deps,
  );

  assertEquals(recorder.gateRuns, 1, "missing findings must not be reused");
  assertEquals(state.baselineGateFindings?.length, 1);
});

// ---------------------------------------------------------------------------
// Fallback to the full gate
// ---------------------------------------------------------------------------

Deno.test("baselineQuality cache - runs the full gate on a cache miss and records it", async () => {
  const { deps, recorder } = makeDeps({
    cached: null,
    gatePassed: false,
    gateOutput: "deno lint: FAILED",
  });
  const state = makeState();

  await workOnIssueBaselineQuality(makeContext(), state, deps);

  assertEquals(recorder.gateRuns, 1);
  assertEquals(recorder.writes.length, 1);
  assertEquals(recorder.writes[0]?.key, `org/repo@${CLEAN_SHA}`);
  assertEquals(recorder.writes[0]?.outcome.passed, false);
  assertEquals(recorder.writes[0]?.outcome.output, "deno lint: FAILED");
  assertEquals(state.baselineQualityPassed, false);
});

Deno.test("baselineQuality cache - a passing gate is recorded with empty output", async () => {
  const { deps, recorder } = makeDeps({ cached: null, gatePassed: true });
  const state = makeState();

  await workOnIssueBaselineQuality(makeContext(), state, deps);

  assertEquals(recorder.writes[0]?.outcome.passed, true);
  assertEquals(recorder.writes[0]?.outcome.output, "");
});

Deno.test("baselineQuality cache - a dirty tree neither reads nor writes the cache", async () => {
  const { deps, recorder } = makeDeps({
    porcelain: " M worker/deno/lib/foo.ts\n",
    cached: cachedEntry(),
  });
  const state = makeState();

  await workOnIssueBaselineQuality(makeContext(), state, deps);

  assertEquals(recorder.reads.length, 0);
  assertEquals(recorder.writes.length, 0);
  assertEquals(recorder.gateRuns, 1, "an ambiguous tree runs the full gate");
});

Deno.test("baselineQuality cache - a gate that could not run is never recorded", async () => {
  const { deps, recorder } = makeDeps({ cached: null, gateErrors: true });
  const state = makeState();

  const result = await workOnIssueBaselineQuality(makeContext(), state, deps);

  assertEquals(result.status, "continue");
  assertEquals(recorder.writes.length, 0);
});

Deno.test("baselineQuality cache - a failing cache write stays non-fatal", async () => {
  const { deps, recorder } = makeDeps({ cached: null, writeThrows: true });
  const state = makeState();

  const result = await workOnIssueBaselineQuality(makeContext(), state, deps);

  assertEquals(result.status, "continue");
  assertEquals(recorder.gateRuns, 1);
  assertEquals(state.baselineQualityPassed, true);
});

Deno.test("baselineQuality cache - findings captured on a miss are recorded for reuse", async () => {
  const findings: GenericFinding[] = [
    { check: "markdownlint", key: "README.md:MD013", display: "line length" },
  ];
  const { deps, recorder } = makeDeps({ cached: null, findings });
  const state = makeState();

  await workOnIssueBaselineQuality(
    makeContext({ baselineAwareQualityGate: true }),
    state,
    deps,
  );

  assertEquals(recorder.writes[0]?.outcome.findings, findings);
});
