/**
 * Tests for planning_run_stats.ts — planning-run stats + degraded-model
 * detection (Issue #2649).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assessDegradation,
  buildDegradationReport,
  buildPlanningStatsSection,
  type FailureDetectionGateStats,
  modelFamily,
  modelsMatch,
  type PlanningInvocationStats,
  resolveExpectedPlanningModel,
  UNRESOLVED_EXPECTED_MODEL,
} from "../lib/planning_run_stats.ts";
import {
  setActiveRepoModelEffortOverrides,
  setPhaseModelConfigOverrides,
} from "../lib/claude_executor.ts";
import type { RunStats } from "../lib/run_stats.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function planningInvocation(
  served: string[],
  extra?: Partial<RunStats>,
): PlanningInvocationStats {
  return {
    phase: "planning",
    runStats: {
      servedModels: served,
      requestedModel: "fable",
      wallClockMs: 1000,
      ...extra,
    },
  };
}

/** Reset the module-level model resolution state between tests. */
function resetModelResolution(): void {
  setPhaseModelConfigOverrides({});
  setActiveRepoModelEffortOverrides(undefined);
  for (const v of ["CLAUDE_MODEL_PLANNING", "CLAUDE_MODEL"]) {
    Deno.env.delete(v);
  }
}

// ============================================================================
// modelsMatch — prefix/alias-aware
// ============================================================================

Deno.test("modelsMatch - exact match", () => {
  assertEquals(modelsMatch("claude-fable-5", "claude-fable-5"), true);
});

Deno.test("modelsMatch - dated variant of expected passes (prefix)", () => {
  assertEquals(
    modelsMatch("claude-fable-5", "claude-fable-5-20250101"),
    true,
  );
});

Deno.test("modelsMatch - alias matches dated served model (family)", () => {
  assertEquals(modelsMatch("fable", "claude-fable-5-20250101"), true);
});

Deno.test("modelsMatch - different tier fails", () => {
  assertEquals(modelsMatch("claude-fable-5", "claude-opus-4-7"), false);
  assertEquals(modelsMatch("fable", "claude-opus-4-7"), false);
});

Deno.test("modelsMatch - empty operands never match", () => {
  assertEquals(modelsMatch("", "claude-fable-5"), false);
  assertEquals(modelsMatch("fable", ""), false);
});

// Issue #3564: the served-model set now includes `claude-opus-5`. The `opus`
// alias must resolve to the 5-family served id, not only the 4-family — the
// tier-family matcher has no version segment to key on (Issue #3560), so guard
// against any assumption that `opus` maps to a 4-family id alone.
Deno.test("modelFamily - claude-opus-5 maps to the opus tier (Issue #3564)", () => {
  assertEquals(modelFamily("claude-opus-5"), "opus");
  assertEquals(modelFamily("claude-opus-5-1-20260901"), "opus");
});

Deno.test("modelsMatch - opus alias matches Opus 5 served id (Issue #3564)", () => {
  assertEquals(modelsMatch("opus", "claude-opus-5"), true);
  assertEquals(modelsMatch("opus", "claude-opus-5-1-20260901"), true);
});

Deno.test("modelsMatch - Opus 5 dated variant passes via prefix (Issue #3564)", () => {
  assertEquals(modelsMatch("claude-opus-5", "claude-opus-5-1-20260901"), true);
});

Deno.test("modelsMatch - Opus 5 never matches a different tier (Issue #3564)", () => {
  assertEquals(modelsMatch("claude-opus-5", "claude-fable-5"), false);
  assertEquals(modelsMatch("sonnet", "claude-opus-5"), false);
  assertEquals(modelsMatch("fable", "claude-opus-5"), false);
});

// ============================================================================
// assessDegradation
// ============================================================================

Deno.test("assessDegradation - not degraded when all served match expected", () => {
  const verdict = assessDegradation(
    [
      planningInvocation(["claude-fable-5-20250101"]),
      planningInvocation(["claude-fable-5-20250101"]),
    ],
    "fable",
  );
  assertEquals(verdict.degraded, false);
});

// Modified by Issue #3593: this test previously mixed a matching and a
// non-matching served model and expected degraded. Under the lenient run-level
// rule a mixed run is healthy, so the case now asserts the unmixed form — every
// judged invocation served a different tier — which is still degraded. The
// mixed case it used to cover is now asserted as *not* degraded below.
Deno.test("assessDegradation - degraded when every served model is a different tier", () => {
  const verdict = assessDegradation(
    [
      planningInvocation(["claude-opus-4-7"]),
      planningInvocation(["claude-opus-4-7"]),
    ],
    "fable",
  );
  assertEquals(verdict.degraded, true);
  assertStringIncludes(verdict.reason ?? "", "claude-opus-4-7");
});

// ---------------------------------------------------------------------------
// Lenient run-level served-model rule (Issue #3593)
// ---------------------------------------------------------------------------

Deno.test("assessDegradation - mixed run where the expected model also served is not degraded (Issue #3593)", () => {
  // private-repo-14#3505: `fable` requested, served by both `claude-fable-5` and
  // `claude-opus-5` across the run's invocations.
  const verdict = assessDegradation(
    [
      planningInvocation(["claude-opus-5"]),
      planningInvocation(["claude-fable-5"]),
    ],
    "fable",
  );
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.indeterminate ?? false, false);
});

Deno.test("assessDegradation - mixed serving within a single invocation is not degraded (Issue #3593)", () => {
  const verdict = assessDegradation(
    [planningInvocation(["claude-opus-5", "claude-fable-5"])],
    "fable",
  );
  assertEquals(verdict.degraded, false);
});

Deno.test("assessDegradation - no matching served model anywhere stays degraded (Issue #3593)", () => {
  const verdict = assessDegradation(
    [
      planningInvocation(["claude-opus-5"]),
      planningInvocation(["claude-sonnet-4-5"]),
    ],
    "fable",
  );
  assertEquals(verdict.degraded, true);
  assertStringIncludes(verdict.reason ?? "", "claude-opus-5");
  assertStringIncludes(verdict.reason ?? "", "claude-sonnet-4-5");
});

Deno.test("assessDegradation - explicit signals still degrade a mixed run (Issue #3593)", () => {
  // Leniency applies to the *inferred* served-model check only. An explicit
  // rate-limit fallback or pre-flight reroute is an out-of-band signal that the
  // served-model data cannot contradict — silencing it would report a known
  // downgrade as clean (fail-loud, Issue #3234), regressing #1113 and #3232.
  const fallback = assessDegradation(
    [
      { ...planningInvocation(["claude-opus-5"]), fallbackModel: "opus" },
      planningInvocation(["claude-fable-5"]),
    ],
    "fable",
  );
  assertEquals(fallback.degraded, true);

  const preflight = assessDegradation(
    [
      { ...planningInvocation(["claude-opus-5"]), preflightDegraded: true },
      planningInvocation(["claude-fable-5"]),
    ],
    "fable",
  );
  assertEquals(preflight.degraded, true);
});

Deno.test("assessDegradation - a matching served model on an invocation with no stats still counts (Issue #3593)", () => {
  // The expected model served one invocation; another invocation never ran
  // Claude at all. The run is still not degraded.
  const verdict = assessDegradation(
    [{ phase: "planning" }, planningInvocation(["claude-fable-5"])],
    "fable",
  );
  assertEquals(verdict.degraded, false);
});

Deno.test("assessDegradation - degraded on explicit fallbackModel", () => {
  const verdict = assessDegradation(
    [
      {
        phase: "planning",
        runStats: {
          servedModels: ["claude-fable-5-20250101"],
          requestedModel: "fable",
          wallClockMs: 1000,
        },
        fallbackModel: "claude-opus-4-7",
      },
    ],
    "fable",
  );
  assertEquals(verdict.degraded, true);
  assertStringIncludes(verdict.reason ?? "", "fallback");
});

Deno.test("assessDegradation - degraded on explicit pre-flight flag even when served matches expected (Issue #3232)", () => {
  const verdict = assessDegradation(
    [
      {
        phase: "planning",
        runStats: {
          servedModels: ["claude-fable-5-20250101"],
          requestedModel: "fable",
          wallClockMs: 1000,
        },
        preflightDegraded: true,
        preflightDegradedReason: "fable-unavailable (pre-flight health probe)",
      },
    ],
    "fable",
  );
  assertEquals(verdict.degraded, true);
  assertStringIncludes(verdict.reason ?? "", "pre-flight");
});

Deno.test("assessDegradation - pre-flight flag flags even when the expected model is unresolved (Issue #3232)", () => {
  const verdict = assessDegradation(
    [
      {
        phase: "planning",
        runStats: {
          servedModels: [],
          requestedModel: "fable",
          wallClockMs: 1000,
        },
        preflightDegraded: true,
      },
    ],
    "(CLI default)",
  );
  assertEquals(verdict.degraded, true);
});

Deno.test("assessDegradation - non-planning invocations never affect the verdict", () => {
  const verdict = assessDegradation(
    [
      planningInvocation(["claude-fable-5-20250101"]),
      // A haiku helper served by a different tier must not flag degradation.
      {
        phase: "summarise",
        runStats: {
          servedModels: ["claude-haiku-4-5"],
          requestedModel: "claude-haiku-4-5",
          wallClockMs: 50,
        },
      },
    ],
    "fable",
  );
  assertEquals(verdict.degraded, false);
});

Deno.test("assessDegradation - no invocations is not degraded", () => {
  assertEquals(assessDegradation([], "fable").degraded, false);
});

// ---------------------------------------------------------------------------
// Indeterminate verdict — empty served-model set (Issue #2745)
// ---------------------------------------------------------------------------

Deno.test("assessDegradation - empty servedModels with output present is indeterminate, not healthy (Issue #2745)", () => {
  // The invocation ran (runStats present) but no served model was observed.
  const verdict = assessDegradation([planningInvocation([])], "fable");
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.indeterminate, true);
  assertStringIncludes(verdict.reason ?? "", "no served model observed");
});

Deno.test("assessDegradation - populated matching served model is healthy, not indeterminate (Issue #2745)", () => {
  const verdict = assessDegradation(
    [planningInvocation(["claude-fable-5-20250101"])],
    "fable",
  );
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.indeterminate ?? false, false);
});

Deno.test("assessDegradation - mismatching served model stays degraded, not indeterminate (Issue #2745)", () => {
  const verdict = assessDegradation(
    [planningInvocation(["claude-opus-4-7"])],
    "fable",
  );
  assertEquals(verdict.degraded, true);
  assertEquals(verdict.indeterminate ?? false, false);
});

Deno.test("assessDegradation - no invocations at all is neither degraded nor indeterminate (Issue #2745)", () => {
  // Nothing ran, so there is no run to call indeterminate (distinct from a run
  // that produced output but no served model).
  const verdict = assessDegradation([], "fable");
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.indeterminate ?? false, false);
});

Deno.test("assessDegradation - judged invocation with no runStats is not indeterminate (Issue #2745)", () => {
  // A planning invocation that never ran Claude (no runStats) produced no
  // output, so it is not the indeterminate case.
  const verdict = assessDegradation([{ phase: "planning" }], "fable");
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.indeterminate ?? false, false);
});

Deno.test("assessDegradation - one observed served model suppresses indeterminate even when another invocation observed none (Issue #2745)", () => {
  const verdict = assessDegradation(
    [planningInvocation([]), planningInvocation(["claude-fable-5-20250101"])],
    "fable",
  );
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.indeterminate ?? false, false);
});

Deno.test("assessDegradation - unresolved expected model with empty served set is not indeterminate (Issue #2746 boundary)", () => {
  // When the expected model is the CLI-default sentinel, served-model matching
  // is skipped, so the indeterminate check does not apply.
  const verdict = assessDegradation(
    [planningInvocation([])],
    UNRESOLVED_EXPECTED_MODEL,
  );
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.indeterminate ?? false, false);
});

// ============================================================================
// resolveExpectedPlanningModel — single source of truth (no duplicated chain)
// ============================================================================

Deno.test("resolveExpectedPlanningModel - default planning model when no overrides", () => {
  resetModelResolution();
  try {
    // PHASE_MODEL_DEFAULTS.planning is the top tier alias.
    assertEquals(resolveExpectedPlanningModel(), "fable");
  } finally {
    resetModelResolution();
  }
});

Deno.test("resolveExpectedPlanningModel - honours global phase_model_overrides", () => {
  resetModelResolution();
  try {
    setPhaseModelConfigOverrides({ planning: "claude-opus-4-7" });
    assertEquals(resolveExpectedPlanningModel(), "claude-opus-4-7");
  } finally {
    resetModelResolution();
  }
});

Deno.test("resolveExpectedPlanningModel - honours per-repo phase_model_overrides", () => {
  resetModelResolution();
  try {
    setActiveRepoModelEffortOverrides({
      phaseModelOverrides: { planning: "claude-sonnet-4-6" },
    } as never);
    assertEquals(resolveExpectedPlanningModel(), "claude-sonnet-4-6");
  } finally {
    resetModelResolution();
  }
});

Deno.test("resolveExpectedPlanningModel - pinned bestPlanningModel wins over routing chain (Issue #2654)", () => {
  resetModelResolution();
  try {
    // Route planning to opus, but pin the expected best model to fable.
    setPhaseModelConfigOverrides({ planning: "claude-opus-4-7" });
    assertEquals(resolveExpectedPlanningModel("fable"), "fable");
  } finally {
    resetModelResolution();
  }
});

Deno.test("resolveExpectedPlanningModel - empty/whitespace configured value falls back to routing chain (Issue #2654)", () => {
  resetModelResolution();
  try {
    assertEquals(resolveExpectedPlanningModel(""), "fable");
    assertEquals(resolveExpectedPlanningModel("   "), "fable");
    assertEquals(resolveExpectedPlanningModel(undefined), "fable");
  } finally {
    resetModelResolution();
  }
});

Deno.test("resolveExpectedPlanningModel - pinned value is trimmed (Issue #2654)", () => {
  resetModelResolution();
  try {
    assertEquals(resolveExpectedPlanningModel("  opus  "), "opus");
  } finally {
    resetModelResolution();
  }
});

// ----------------------------------------------------------------------------
// Unresolved routing chain — sentinel must not invert the verdict (Issue #2746)
// ----------------------------------------------------------------------------

Deno.test("resolveExpectedPlanningModel - unresolved routing chain returns the sentinel (Issue #2746)", () => {
  resetModelResolution();
  try {
    // An unknown phase has no PHASE_MODEL_DEFAULTS entry and (with no env or
    // overrides) buildClaudeModelArgs returns [] — the previously-unmatchable
    // "default" path. The sentinel, not a literal that can never match, is used.
    assertEquals(
      resolveExpectedPlanningModel(undefined, "unknown_phase_2746"),
      UNRESOLVED_EXPECTED_MODEL,
    );
  } finally {
    resetModelResolution();
  }
});

Deno.test("assessDegradation - unresolved expected model does not flag every invocation (Issue #2746)", () => {
  // Any real served model must NOT be flagged degraded when the expected model
  // could not be resolved — the regression the unmatchable "default" caused.
  for (
    const served of ["claude-fable-5-20250101", "claude-opus-4-7", "haiku"]
  ) {
    const verdict = assessDegradation(
      [planningInvocation([served])],
      UNRESOLVED_EXPECTED_MODEL,
    );
    assertEquals(
      verdict.degraded,
      false,
      `served ${served} spuriously flagged`,
    );
  }
});

Deno.test("assessDegradation - unresolved expected model still flags an explicit fallback (Issue #2746)", () => {
  // An explicit rate-limit fallback is observable degradation regardless of
  // whether the expected model could be resolved.
  const verdict = assessDegradation(
    [{ phase: "planning", fallbackModel: "haiku" }],
    UNRESOLVED_EXPECTED_MODEL,
  );
  assertEquals(verdict.degraded, true);
});

Deno.test("buildDegradationReport - unresolved routing chain is not degraded (Issue #2746)", () => {
  resetModelResolution();
  try {
    const report = buildDegradationReport({
      invocations: [{
        phase: "unknown_phase_2746",
        runStats: {
          servedModels: ["claude-opus-4-7"],
          requestedModel: UNRESOLVED_EXPECTED_MODEL,
          wallClockMs: 1000,
        },
      }],
      phase: "unknown_phase_2746",
    });
    assertEquals(report.expectedModel, UNRESOLVED_EXPECTED_MODEL);
    assertEquals(report.verdict.degraded, false);
  } finally {
    resetModelResolution();
  }
});

// A pinned best model that differs from the served model flags degradation,
// and one that matches does not — the end-to-end comparison wiring (#2654).
Deno.test("assessDegradation - pinned bestPlanningModel drives the verdict (Issue #2654)", () => {
  resetModelResolution();
  try {
    const expected = resolveExpectedPlanningModel("fable");
    const served = assessDegradation(
      [planningInvocation(["claude-opus-4-7"])],
      expected,
    );
    assertEquals(served.degraded, true);

    const ok = assessDegradation(
      [planningInvocation(["claude-fable-5-20250101"])],
      expected,
    );
    assertEquals(ok.degraded, false);
  } finally {
    resetModelResolution();
  }
});

// Issue #3564: an operator (or the `fable → opus` degrade) that expects `opus`
// must treat an Opus 5 served id as a match, not as degradation — the served
// model set now includes `claude-opus-5`.
Deno.test("assessDegradation - expected opus accepts an Opus 5 served id (Issue #3564)", () => {
  const ok = assessDegradation(
    [planningInvocation(["claude-opus-5"])],
    "opus",
  );
  assertEquals(ok.degraded, false);

  const dated = assessDegradation(
    [planningInvocation(["claude-opus-5-1-20260901"])],
    "opus",
  );
  assertEquals(dated.degraded, false);
});

// ============================================================================
// buildPlanningStatsSection
// ============================================================================

Deno.test("buildPlanningStatsSection - renders model, tokens, turns, invocations", () => {
  const invocations: PlanningInvocationStats[] = [
    planningInvocation(["claude-fable-5-20250101"], {
      effort: "max",
      numTurns: 7,
      durationMs: 45_600,
      tokenUsage: {
        inputTokens: 1234,
        outputTokens: 5678,
        cacheCreationTokens: 100,
        cacheReadTokens: 2000,
      },
    }),
    planningInvocation(["claude-fable-5-20250101"], {
      numTurns: 5,
      durationMs: 10_000,
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 2000,
        cacheCreationTokens: 0,
        cacheReadTokens: 500,
      },
    }),
  ];
  const verdict = assessDegradation(invocations, "fable");
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict,
  });

  assertStringIncludes(section, "## Planning run model stats");
  assertStringIncludes(section, "Requested model:** `fable`");
  assertStringIncludes(section, "claude-fable-5-20250101");
  assertStringIncludes(section, "Effort:** `max`");
  assertStringIncludes(section, "Planning invocations:** 2");
  // Aggregated tokens: 1234+1000 input, 5678+2000 output.
  assertStringIncludes(section, "input 2,234");
  assertStringIncludes(section, "output 7,678");
  assertStringIncludes(section, "cache read 2,500");
  assertStringIncludes(section, "Turns:** 12");
  assertStringIncludes(section, "Degraded:** no");
});

Deno.test("buildPlanningStatsSection - appends an estimate-only cost block (Issue #3557)", () => {
  const invocations: PlanningInvocationStats[] = [
    planningInvocation(["claude-opus-4-8"], {
      tokenUsage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    }),
  ];
  const verdict = assessDegradation(invocations, "opus");
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "opus",
    verdict,
  });
  // 1M input ($5) + 1M output ($25) on modern Opus = $30.00.
  assertStringIncludes(section, "Estimated cost (USD, estimate only):");
  assertStringIncludes(section, "$30.00");
  assertStringIncludes(section, "`claude-opus-4-8`");
});

Deno.test("buildPlanningStatsSection - costs a mixed Fable→Opus run per model (Issue #3557)", () => {
  const invocations: PlanningInvocationStats[] = [
    planningInvocation(["claude-fable-5"], {
      tokenUsage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    }),
    planningInvocation(["claude-opus-4-8"], {
      tokenUsage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    }),
  ];
  const verdict = assessDegradation(invocations, "fable");
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict,
  });
  // Fable input $10 + Opus input $5 = $15.00, each listed separately.
  assertStringIncludes(section, "$15.00");
  assertStringIncludes(section, "`claude-fable-5`");
  assertStringIncludes(section, "`claude-opus-4-8`");
});

Deno.test("buildPlanningStatsSection - shows degraded reason when degraded", () => {
  const invocations = [planningInvocation(["claude-opus-4-7"])];
  const verdict = assessDegradation(invocations, "fable");
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict,
  });
  assertStringIncludes(section, "Degraded:** ⚠️ yes");
  assertStringIncludes(section, "claude-opus-4-7");
});

Deno.test("buildPlanningStatsSection - renders unknown verdict for an indeterminate run (Issue #2745)", () => {
  // The invocation ran but reported no served model — the stats line must read
  // "unknown", never a clean "Degraded: no".
  const invocations = [planningInvocation([])];
  const verdict = assessDegradation(invocations, "fable");
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict,
  });
  assertStringIncludes(section, "Served model(s):** _none reported_");
  assertStringIncludes(section, "Degraded:** ❓ unknown");
  assert(!section.includes("Degraded:** no"));
});

Deno.test("buildPlanningStatsSection - empty when no planning stats available", () => {
  const section = buildPlanningStatsSection({
    invocations: [{ phase: "planning" }],
    expectedModel: "fable",
    verdict: { degraded: false },
  });
  assertEquals(section, "");
});

Deno.test("buildPlanningStatsSection - omits token/turn lines when absent", () => {
  const invocations = [planningInvocation(["claude-fable-5-20250101"])];
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict: { degraded: false },
  });
  assert(!section.includes("Tokens:"));
  assert(!section.includes("Turns:"));
});

// ============================================================================
// Phase-parametric generalisation (Issue #2717)
//
// The grill_me phase routes to the same Fable 5 top tier as planning, so the
// detection helpers became phase-aware. The default ("planning") behaviour is
// unchanged; these tests pin the generalised phase-parameter behaviour.
// ============================================================================

Deno.test("assessDegradation - filters to the requested phase", () => {
  const invocations: PlanningInvocationStats[] = [
    {
      phase: "grill_me",
      runStats: {
        servedModels: ["claude-opus-4-8"],
        requestedModel: "fable",
        wallClockMs: 1,
      },
    },
  ];
  // Judged as planning → the grill_me invocation is ignored → not degraded.
  assertEquals(
    assessDegradation(invocations, "fable", "planning").degraded,
    false,
  );
  // Judged as grill_me → the opus-served invocation IS degraded.
  assertEquals(
    assessDegradation(invocations, "fable", "grill_me").degraded,
    true,
  );
});

Deno.test("buildPlanningStatsSection - grill_me phase emits a Grill-me heading", () => {
  const invocations: PlanningInvocationStats[] = [
    {
      phase: "grill_me",
      runStats: {
        servedModels: ["claude-opus-4-8"],
        requestedModel: "fable",
        wallClockMs: 1,
      },
    },
  ];
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict: { degraded: true, reason: "served opus" },
    phase: "grill_me",
  });
  assertStringIncludes(section, "## Grill-me run model stats");
  assertStringIncludes(section, "**Grill-me invocations:** 1");
  // The default planning heading must NOT leak into a grill_me block.
  assert(!section.includes("## Planning run model stats"));
});

Deno.test("buildPlanningStatsSection - default phase keeps the Planning heading", () => {
  const invocations = [planningInvocation(["claude-fable-5-20250101"])];
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict: { degraded: false },
  });
  assertStringIncludes(section, "## Planning run model stats");
  assertStringIncludes(section, "**Planning invocations:** 1");
});

Deno.test("resolveExpectedPlanningModel - grill_me phase derives the grill_me tier", () => {
  for (const v of ["CLAUDE_MODEL_GRILL_ME", "CLAUDE_MODEL"]) Deno.env.delete(v);
  setPhaseModelConfigOverrides({});
  setActiveRepoModelEffortOverrides(undefined);
  // grill_me routes to the Fable top tier by default (DEFAULT_CLAUDE_MODEL_GRILL_ME).
  assertEquals(resolveExpectedPlanningModel(undefined, "grill_me"), "fable");
});

// ============================================================================
// Shared assess-and-render orchestration (Issue #2734)
//
// buildDegradationReport runs the resolve → assess → build triple both the
// planning closure and the grill-me round share, so the two paths cannot drift.
// ============================================================================

Deno.test("buildDegradationReport - healthy planning run: not degraded, Planning heading", () => {
  for (const v of ["CLAUDE_MODEL_PLANNING", "CLAUDE_MODEL"]) Deno.env.delete(v);
  setPhaseModelConfigOverrides({});
  setActiveRepoModelEffortOverrides(undefined);

  const report = buildDegradationReport({
    invocations: [planningInvocation(["claude-fable-5-20250101"])],
  });

  assertEquals(report.expectedModel, "fable");
  assertEquals(report.verdict.degraded, false);
  assertStringIncludes(report.section, "## Planning run model stats");
  assertStringIncludes(report.section, "- **Degraded:** no");
});

Deno.test("buildDegradationReport - degraded grill_me run: verdict + Grill-me stats section", () => {
  for (const v of ["CLAUDE_MODEL_GRILL_ME", "CLAUDE_MODEL"]) Deno.env.delete(v);
  setPhaseModelConfigOverrides({});
  setActiveRepoModelEffortOverrides(undefined);

  const report = buildDegradationReport({
    invocations: [
      {
        phase: "grill_me",
        runStats: {
          servedModels: ["claude-opus-4-8"],
          requestedModel: "fable",
          wallClockMs: 1,
        },
      },
    ],
    phase: "grill_me",
  });

  assertEquals(report.expectedModel, "fable");
  assert(
    report.verdict.degraded,
    "opus served when fable expected must degrade",
  );
  assertStringIncludes(report.section, "## Grill-me run model stats");
  assertStringIncludes(report.section, "claude-opus-4-8");
  // The planning heading must not leak into a grill_me report.
  assert(!report.section.includes("## Planning run model stats"));
});

Deno.test("buildDegradationReport - pinned best model drives the verdict", () => {
  for (const v of ["CLAUDE_MODEL_PLANNING", "CLAUDE_MODEL"]) Deno.env.delete(v);
  setPhaseModelConfigOverrides({});
  setActiveRepoModelEffortOverrides(undefined);

  // Served fable but the operator pinned opus as the expected best → degraded.
  const report = buildDegradationReport({
    invocations: [planningInvocation(["claude-fable-5-20250101"])],
    configuredBestModel: "opus",
  });

  assertEquals(report.expectedModel, "opus");
  assert(report.verdict.degraded, "fable served when opus pinned must degrade");
});

Deno.test("buildDegradationReport - default phase only judges planning invocations", () => {
  setPhaseModelConfigOverrides({});
  setActiveRepoModelEffortOverrides(undefined);

  // A degraded grill_me invocation must NOT flag a default (planning) report.
  const report = buildDegradationReport({
    invocations: [
      {
        phase: "grill_me",
        runStats: {
          servedModels: ["claude-opus-4-8"],
          requestedModel: "fable",
          wallClockMs: 1,
        },
      },
    ],
  });

  assertEquals(report.verdict.degraded, false);
  // No planning invocation produced stats → empty section.
  assertEquals(report.section, "");
});

// ============================================================================
// Failure-Detection gate + self-repair counters (Issue #63)
//
// The gate's hit rate used to be visible only by grepping worker logs, so the
// scale of the problem (8/8 offenders on one run) went unnoticed for weeks.
// These cases pin the counters into the rendered stats block — including the
// explicit-zero case, which is what distinguishes "healthy" from "not
// reporting".
// ============================================================================

function gateStats(
  overrides: Partial<FailureDetectionGateStats> = {},
): FailureDetectionGateStats {
  return {
    published: 0,
    offenders: 0,
    repaired: 0,
    stillOffending: 0,
    deferred: 0,
    repairDurationMs: 0,
    ...overrides,
  };
}

Deno.test("buildPlanningStatsSection - records the gate counts for a partially repaired run (Issue #63)", () => {
  const invocations = [planningInvocation(["claude-fable-5-20250101"])];
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict: { degraded: false },
    gate: gateStats({
      published: 8,
      offenders: 8,
      repaired: 6,
      stillOffending: 1,
      deferred: 1,
      repairDurationMs: 64_000,
    }),
  });

  assertStringIncludes(
    section,
    "- **Failure-Detection gate:** published 8 · offenders 8 · repaired 6 · " +
      "still offending 1 · deferred 1",
  );
  assertStringIncludes(section, "- **Failure-Detection repair:** 1m 4s");
});

Deno.test("buildPlanningStatsSection - records explicit zeros when the gate found no offenders (Issue #63)", () => {
  // The failure mode this issue exists to fix: a metric only emitted on the
  // unhappy path cannot distinguish "healthy" from "not reporting".
  const invocations = [planningInvocation(["claude-fable-5-20250101"])];
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict: { degraded: false },
    gate: gateStats({ published: 3 }),
  });

  assertStringIncludes(
    section,
    "- **Failure-Detection gate:** published 3 · offenders 0 · repaired 0 · " +
      "still offending 0 · deferred 0",
  );
  assertStringIncludes(section, "- **Failure-Detection repair:** 0ms");
});

Deno.test("buildPlanningStatsSection - omits the gate lines entirely when no gate stats are supplied (Issue #63)", () => {
  // Additive: the grill-me / phase / quorum callers pass no gate stats and
  // their output is unchanged.
  const invocations = [planningInvocation(["claude-fable-5-20250101"])];
  const section = buildPlanningStatsSection({
    invocations,
    expectedModel: "fable",
    verdict: { degraded: false },
  });
  assert(!section.includes("Failure-Detection gate:"));
  assert(!section.includes("Failure-Detection repair:"));
  // The pre-existing lines are untouched.
  assertStringIncludes(section, "## Planning run model stats");
  assertStringIncludes(section, "- **Degraded:** no");
});

Deno.test("buildPlanningStatsSection - reports the gate counts even when no planning invocation produced stats (Issue #63)", () => {
  // A recovery close that skipped Claude still gated the published sub-issues,
  // so the counts must not vanish with the model stats.
  const section = buildPlanningStatsSection({
    invocations: [{ phase: "planning" }],
    expectedModel: "fable",
    verdict: { degraded: false },
    gate: gateStats({ published: 2, offenders: 1, repaired: 1 }),
  });
  assertStringIncludes(section, "## Planning run model stats");
  assertStringIncludes(
    section,
    "- **Failure-Detection gate:** published 2 · offenders 1 · repaired 1 · " +
      "still offending 0 · deferred 0",
  );
});

Deno.test("buildDegradationReport - threads the gate counts into the rendered section (Issue #63)", () => {
  for (const v of ["CLAUDE_MODEL_PLANNING", "CLAUDE_MODEL"]) Deno.env.delete(v);
  setPhaseModelConfigOverrides({});
  setActiveRepoModelEffortOverrides(undefined);

  const report = buildDegradationReport({
    invocations: [planningInvocation(["claude-fable-5-20250101"])],
    gate: gateStats({ published: 5, offenders: 2, repaired: 2 }),
  });

  assertStringIncludes(
    report.section,
    "- **Failure-Detection gate:** published 5 · offenders 2 · repaired 2 · " +
      "still offending 0 · deferred 0",
  );
});
