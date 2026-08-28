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

/**
 * Per-provider routing env vars that would otherwise steer the chain away from
 * each provider's designed defaults.
 */
const ROUTING_ENV_VARS = [
  "CLAUDE_MODEL",
  "CLAUDE_MODEL_PLANNING",
  "CODEX_MODEL",
  "CODEX_MODEL_PLANNING",
  "GEMINI_MODEL",
  "GEMINI_MODEL_PLANNING",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_MODEL_PLANNING",
  "VIBE_AGENT_PROVIDER",
  "VIBE_IMAGE_AGENT_PROVIDERS",
];

/** Snapshot, clear, and restore the routing environment around one test. */
function withCleanRoutingEnv(run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const name of ROUTING_ENV_VARS) {
    saved.set(name, Deno.env.get(name));
    Deno.env.delete(name);
  }
  try {
    run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

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
  withCleanRoutingEnv(() => {
    const ids = agentProviderIds();
    assert(ids.length > 0, "no coding-agent providers are registered");

    for (const id of ids) {
      const provider = resolveAgentProvider(id);
      const designed = provider.resolveModel("planning");
      assert(
        designed !== undefined && designed.trim() !== "",
        `provider ${id} routes "planning" to no model, so the degraded-model ` +
          `detector has no routing-aware expected model to judge it against`,
      );

      const report = buildDegradationReport({
        invocations: servedPlanningRun([designed]),
        provider,
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
});

// ---------------------------------------------------------------------------
// DeepSeek — the provider the Claude-only chain mislabelled
// ---------------------------------------------------------------------------

Deno.test("buildDegradationReport - DeepSeek served deepseek-reasoner is healthy (Issue #441)", () => {
  withCleanRoutingEnv(() => {
    const provider = resolveAgentProvider("deepseek");
    const report = buildDegradationReport({
      invocations: servedPlanningRun(["deepseek-reasoner"]),
      provider,
    });
    assertEquals(report.expectedModel, "deepseek-reasoner");
    assertEquals(report.verdict.degraded, false);
  });
});

Deno.test("buildDegradationReport - DeepSeek served the wrong DeepSeek tier is degraded (Issue #441)", () => {
  withCleanRoutingEnv(() => {
    const provider = resolveAgentProvider("deepseek");
    const report = buildDegradationReport({
      invocations: servedPlanningRun(["deepseek-chat"]),
      provider,
    });
    assertEquals(report.verdict.degraded, true);
    assert(report.verdict.reason?.includes("deepseek-chat"));
    assert(report.verdict.reason?.includes("deepseek-reasoner"));
  });
});

Deno.test("resolveExpectedPlanningModel - a pinned best model still wins per provider (Issue #441)", () => {
  withCleanRoutingEnv(() => {
    for (const id of agentProviderIds()) {
      assertEquals(
        resolveExpectedPlanningModel(
          "  pinned-model  ",
          "planning",
          resolveAgentProvider(id),
        ),
        "pinned-model",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Codex / Gemini — unchanged: no served model observed ⇒ ❓ unknown
// ---------------------------------------------------------------------------

Deno.test("buildDegradationReport - Codex and Gemini still report indeterminate (Issue #441)", () => {
  withCleanRoutingEnv(() => {
    for (const id of ["codex", "gemini"]) {
      const report = buildDegradationReport({
        invocations: servedPlanningRun([]),
        provider: resolveAgentProvider(id),
      });
      assertEquals(report.verdict.degraded, false, id);
      assertEquals(report.verdict.indeterminate, true, id);
    }
  });
});

// ---------------------------------------------------------------------------
// Claude — byte-for-byte the behaviour that shipped before this change
// ---------------------------------------------------------------------------

Deno.test("resolveExpectedPlanningModel - defaults to the active provider, Claude when none is selected (Issue #441)", () => {
  withCleanRoutingEnv(() => {
    assertEquals(resolveExpectedPlanningModel(), "fable");
    assertEquals(resolveExpectedPlanningModel(undefined, "grill_me"), "fable");
    assertEquals(
      resolveExpectedPlanningModel(undefined, "unknown_phase_441"),
      UNRESOLVED_EXPECTED_MODEL,
    );
  });
});

Deno.test("resolveExpectedPlanningModel - VIBE_AGENT_PROVIDER selects the chain (Issue #441)", () => {
  withCleanRoutingEnv(() => {
    Deno.env.set("VIBE_AGENT_PROVIDER", "deepseek");
    assertEquals(resolveExpectedPlanningModel(), "deepseek-reasoner");
  });
});

Deno.test("buildDegradationReport - a provider with no routing for the phase skips served matching (Issue #441)", () => {
  withCleanRoutingEnv(() => {
    const report = buildDegradationReport({
      invocations: servedPlanningRun(["some-other-model"]),
      phase: "unknown_phase_441",
      provider: { resolveModel: () => undefined },
    });
    assertEquals(report.expectedModel, UNRESOLVED_EXPECTED_MODEL);
    assertEquals(report.verdict.degraded, false);
  });
});
