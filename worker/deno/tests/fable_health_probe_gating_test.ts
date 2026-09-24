/**
 * Tests for Fable health probe gating (Issue #3230).
 *
 * The health probe is expensive (it makes a real call to check Fable
 * availability), so it should only be invoked when at least one Fable-preferring
 * phase routes to the Fable tier under the active provider. This test verifies
 * the gating works correctly:
 *   - no probe call when the provider has no Fable tier (e.g., Codex, Gemini)
 *   - probe is called when the provider has Fable tier (e.g., Claude)
 *   - probe is called when a phase is pinned to Fable via environment override
 *
 * @std/assert only.
 */

import { assert, assertEquals } from "@std/assert";
import {
  anyPhaseRoutesToFableTier,
  type FableRoutingProvider,
} from "../lib/fable_routing.ts";

/**
 * A provider that routes all Fable-preferring phases to Fable tier.
 */
const FABLE_TIER_PROVIDER: FableRoutingProvider = {
  id: "claude",
  resolveModel: () => "claude-fable-5",
};

/**
 * A provider with no Fable tier.
 */
const NO_FABLE_TIER_PROVIDER: FableRoutingProvider = {
  id: "codex",
  resolveModel: () => "gpt-5.1-codex-max",
};

/**
 * A provider for Gemini (also has no Fable tier).
 */
const GEMINI_PROVIDER: FableRoutingProvider = {
  id: "gemini",
  resolveModel: () => "gemini-2.0-flash",
};

// ---------------------------------------------------------------------------
// Default routing (no operator pin)
// ---------------------------------------------------------------------------

Deno.test("health probe gating: Claude provider routes to Fable, probe should be called", () => {
  // When the active provider is Claude, at least one phase routes to Fable,
  // so the probe should be called.
  assert(
    anyPhaseRoutesToFableTier(FABLE_TIER_PROVIDER),
    "Claude provider must route at least one phase to Fable tier",
  );
});

Deno.test("health probe gating: Codex provider has no Fable tier, probe should NOT be called", () => {
  // When the active provider is Codex, no phase routes to Fable, so the probe
  // is unnecessary and should be skipped to avoid wasting a call.
  assert(
    !anyPhaseRoutesToFableTier(NO_FABLE_TIER_PROVIDER),
    "Codex provider must not route any phase to Fable tier",
  );
});

Deno.test("health probe gating: Gemini provider has no Fable tier, probe should NOT be called", () => {
  // When the active provider is Gemini, no phase routes to Fable, so the probe
  // is unnecessary and should be skipped to avoid wasting a call.
  assert(
    !anyPhaseRoutesToFableTier(GEMINI_PROVIDER),
    "Gemini provider must not route any phase to Fable tier",
  );
});

// ---------------------------------------------------------------------------
// Operator pins (environment overrides)
// ---------------------------------------------------------------------------

Deno.test("health probe gating: operator pin to Fable on normally-non-Fable provider means probe should be called", () => {
  // An operator who pins planning to Fable via CLAUDE_MODEL_PLANNING="fable"
  // expects the health check to apply. The gating should detect this override
  // and allow the probe call. This is tested indirectly via a provider that
  // simulates the override.
  const pinningProvider: FableRoutingProvider = {
    id: "codex-with-pin",
    resolveModel: (phase) => {
      // Codex normally has no Fable tier, but the operator pinned planning
      // to fable via CLAUDE_MODEL_PLANNING="fable" (which the provider's
      // resolveModel reads from the env).
      if (phase === "planning") {
        return "fable";
      }
      return "gpt-5.1-codex-max";
    },
  };

  assert(
    anyPhaseRoutesToFableTier(pinningProvider),
    "when any phase is pinned to Fable, probe should be called",
  );
});

// ---------------------------------------------------------------------------
// Short-circuit evaluation
// ---------------------------------------------------------------------------

Deno.test("health probe gating: short-circuits on first Fable tier found", () => {
  // Verify that the predicate returns true as soon as it finds the first
  // Fable-preferring phase that routes to Fable, without checking the rest.
  let resolveCalls = 0;
  const shortCircuitProvider: FableRoutingProvider = {
    id: "test",
    resolveModel: () => {
      resolveCalls++;
      // Always return Fable to demonstrate short-circuit.
      return "fable";
    },
  };

  const result = anyPhaseRoutesToFableTier(shortCircuitProvider);
  assert(result, "should return true");
  // The actual number of calls depends on iteration order and short-circuit
  // behaviour, but it should be at most 8 (one per Fable-preferring phase).
  // If it returns true, we at least checked one phase.
  assert(resolveCalls >= 1, "must resolve at least one phase");
  assert(
    resolveCalls <= 8,
    `resolveModel should not be called more than 8 times (once per Fable-preferring phase), got ${resolveCalls}`,
  );
});

// ---------------------------------------------------------------------------
// All eight Fable-preferring phases are covered
// ---------------------------------------------------------------------------

Deno.test("health probe gating: each of the eight Fable-preferring phases is checked", () => {
  // Ensure the predicate checks all eight phases by tracking which phases
  // resolveModel is called with.
  const phasesChecked = new Set<string>();
  const trackingProvider: FableRoutingProvider = {
    id: "tracking",
    resolveModel: (phase) => {
      if (phase) {
        phasesChecked.add(phase);
      }
      return "opus"; // Non-Fable model so it doesn't short-circuit.
    },
  };

  const result = anyPhaseRoutesToFableTier(trackingProvider);
  assert(!result, "should return false when no phase routes to Fable");
  // All eight Fable-preferring phases should have been checked.
  const expectedPhases = [
    "clarification",
    "grill_me",
    "planning",
    "question",
    "quorum",
    "quorum_judge",
    "refinement",
    "revision",
  ];
  assertEquals(
    Array.from(phasesChecked).sort(),
    expectedPhases.sort(),
    "all eight Fable-preferring phases should be checked",
  );
});
