/**
 * Provider-aware expected-model resolution for the degraded-model detector
 * (Issue #441, parent #396).
 *
 * `resolveExpectedPlanningModel()` used to read **Claude's** routing chain for
 * every invocation. That was harmless for Codex and Gemini — neither exposes a
 * served model, so the verdict is `indeterminate` — but DeepSeek runs on the
 * Anthropic CLI with `--output-format stream-json`, so its served model *is*
 * observable: a `planning` run served `deepseek-reasoner` was compared against
 * Claude's `fable` and flagged degraded for a tier the operator never
 * requested.
 *
 * The loop over {@link agentProviderIds} is the Failure Detection: a fifth
 * provider registered without a routing-aware expected model fails here rather
 * than mislabelling live issues.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildDegradationReport,
  type PlanningInvocationStats,
  resolveExpectedPlanningModel,
  UNRESOLVED_EXPECTED_MODEL,
} from "../lib/planning_run_stats.ts";
import {
  agentProviderIds,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import type { RunStats } from "../lib/run_stats.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

/**
 * The routing environment every case below is judged against (Issue #962).
 *
 * Deliberately empty rather than cleared-and-restored: every per-provider
 * `*_MODEL` / `*_MODEL_PLANNING` override, `VIBE_AGENT_PROVIDER` and the
 * image stamp all read as absent, so each provider is judged against its own
 * designed defaults — and a resolution that fell back to `Deno.env.get`
 * would be answered by whatever the suite was launched with rather than by
 * this map, which is the failure this seam exists to make visible.
 */
const CLEAN_ROUTING_ENV = emptyEnv;

/** One judged planning invocation served by `served`. */
function servedPlanningRun(served: string[]): PlanningInvocationStats[] {
  const runStats: RunStats = {
    servedModels: served,
    requestedModel: served[0] ?? "",
    wallClockMs: 1000,
  };
  return [{ phase: "planning", runStats }];
}

// ---------------------------------------------------------------------------
// Failure Detection: every registered provider judged against its own routing
// ---------------------------------------------------------------------------

Deno.test("buildDegradationReport - every provider's own planning model is not degraded (Issue #441)", () => {
  const ids = agentProviderIds();
  assert(ids.length > 0, "no coding-agent providers are registered");

  for (const id of ids) {
    const provider = resolveAgentProvider(id);
    const designed = provider.resolveModel("planning", CLEAN_ROUTING_ENV);
    assert(
      designed !== undefined && designed.trim() !== "",
      `provider ${id} routes "planning" to no model, so the degraded-model ` +
        `detector has no routing-aware expected model to judge it against`,
    );

    const report = buildDegradationReport({
      invocations: servedPlanningRun([designed]),
      provider,
      env: CLEAN_ROUTING_ENV,
    });

    assertEquals(
      report.expectedModel,
      designed,
      `provider ${id} must be judged against its own planning routing`,
    );
    assertEquals(
      report.verdict.degraded,
      false,
      `provider ${id} served its own designed planning model ` +
        `${designed} but was flagged degraded: ${report.verdict.reason}`,
    );
    assertEquals(report.verdict.indeterminate, undefined);
  }
});

// ---------------------------------------------------------------------------
// DeepSeek — the provider the Claude-only chain mislabelled
// ---------------------------------------------------------------------------

Deno.test("buildDegradationReport - DeepSeek served deepseek-reasoner is healthy (Issue #441)", () => {
  const provider = resolveAgentProvider("deepseek");
  const report = buildDegradationReport({
    invocations: servedPlanningRun(["deepseek-reasoner"]),
    provider,
    env: CLEAN_ROUTING_ENV,
  });
  assertEquals(report.expectedModel, "deepseek-reasoner");
  assertEquals(report.verdict.degraded, false);
});

Deno.test("buildDegradationReport - DeepSeek served the wrong DeepSeek tier is degraded (Issue #441)", () => {
  const provider = resolveAgentProvider("deepseek");
  const report = buildDegradationReport({
    invocations: servedPlanningRun(["deepseek-chat"]),
    provider,
    env: CLEAN_ROUTING_ENV,
  });
  assertEquals(report.verdict.degraded, true);
  assert(report.verdict.reason?.includes("deepseek-chat"));
  assert(report.verdict.reason?.includes("deepseek-reasoner"));
});

Deno.test("resolveExpectedPlanningModel - a pinned best model still wins per provider (Issue #441)", () => {
  for (const id of agentProviderIds()) {
    assertEquals(
      resolveExpectedPlanningModel(
        "  pinned-model  ",
        "planning",
        resolveAgentProvider(id),
        CLEAN_ROUTING_ENV,
      ),
      "pinned-model",
    );
  }
});

// ---------------------------------------------------------------------------
// Codex / Gemini — unchanged: no served model observed ⇒ ❓ unknown
// ---------------------------------------------------------------------------

Deno.test("buildDegradationReport - Codex and Gemini still report indeterminate (Issue #441)", () => {
  for (const id of ["codex", "gemini"]) {
    const report = buildDegradationReport({
      invocations: servedPlanningRun([]),
      provider: resolveAgentProvider(id),
      env: CLEAN_ROUTING_ENV,
    });
    assertEquals(report.verdict.degraded, false, id);
    assertEquals(report.verdict.indeterminate, true, id);
  }
});

// ---------------------------------------------------------------------------
// Claude — byte-for-byte the behaviour that shipped before this change
// ---------------------------------------------------------------------------

Deno.test("resolveExpectedPlanningModel - defaults to the active provider, Claude when none is selected (Issue #441)", () => {
  const env = CLEAN_ROUTING_ENV;
  assertEquals(
    resolveExpectedPlanningModel(undefined, "planning", undefined, env),
    "fable",
  );
  assertEquals(
    resolveExpectedPlanningModel(undefined, "grill_me", undefined, env),
    "fable",
  );
  assertEquals(
    resolveExpectedPlanningModel(
      undefined,
      "unknown_phase_441",
      undefined,
      env,
    ),
    UNRESOLVED_EXPECTED_MODEL,
  );
});

Deno.test("resolveExpectedPlanningModel - VIBE_AGENT_PROVIDER selects the chain (Issue #962)", () => {
  // Provider selection is what decides which agent ran, so this is the case
  // the seam most has to carry. The override is stated through the injected
  // lookup, which answers only from its own map: a resolution that read the
  // process would see no override and answer Claude's "fable" instead.
  assertEquals(
    resolveExpectedPlanningModel(
      undefined,
      "planning",
      undefined,
      envFrom({ VIBE_AGENT_PROVIDER: "deepseek" }),
    ),
    "deepseek-reasoner",
  );
});

Deno.test("resolveExpectedPlanningModel - the routing chain reads the injected lookup too (Issue #962)", () => {
  // Not just the provider selection: the chosen provider's own phase override
  // has to come from the same map. `planning-441-sentinel` exists nowhere in
  // any real environment, so it can only have arrived through the lookup.
  assertEquals(
    resolveExpectedPlanningModel(
      undefined,
      "planning",
      undefined,
      envFrom({ CLAUDE_MODEL_PLANNING: "planning-441-sentinel" }),
    ),
    "planning-441-sentinel",
  );
});

Deno.test("buildDegradationReport - a provider with no routing for the phase skips served matching (Issue #441)", () => {
  const report = buildDegradationReport({
    invocations: servedPlanningRun(["some-other-model"]),
    phase: "unknown_phase_441",
    provider: { resolveModel: () => undefined },
    env: CLEAN_ROUTING_ENV,
  });
  assertEquals(report.expectedModel, UNRESOLVED_EXPECTED_MODEL);
  assertEquals(report.verdict.degraded, false);
});
