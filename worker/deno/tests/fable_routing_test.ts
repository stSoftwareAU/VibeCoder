/**
 * Unit tests for the pre-flight Fable reroute decision (Issue #3231).
 *
 * Covers the full matrix for `resolveFablePreflightRouting`:
 *   phase ∈/∉ the Fable-preferring set × verdict available/unavailable/unknown
 *   × explicit override present/absent
 * plus the invocation-layer `applyFablePreflightRouting` helper.
 *
 * @std/assert only — no external frameworks.
 */

import {
  DEFAULT_CLAUDE_MODEL_TOP_TIER,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { assert, assertEquals } from "@std/assert";
import type { FableCacheRead } from "../lib/health_check_cache.ts";
import {
  applyFablePreflightRouting,
  FABLE_PREFERRING_PHASES,
  FABLE_PREFLIGHT_DEGRADED_REASON,
  FABLE_PREFLIGHT_EFFORT,
  FABLE_PREFLIGHT_MODEL,
  isFablePreferringPhase,
  resolveFablePreflightRouting,
} from "../lib/fable_routing.ts";

// ---------------------------------------------------------------------------
// isFablePreferringPhase / the set
// ---------------------------------------------------------------------------

Deno.test("FABLE_PREFERRING_PHASES holds exactly the eight planning-shaped phases (Issues #3217, #4429)", () => {
  assertEquals(
    [...FABLE_PREFERRING_PHASES].sort(),
    [
      "clarification",
      "grill_me",
      "planning",
      "question",
      "quorum",
      "quorum_judge",
      "refinement",
      "revision",
    ],
  );
});

Deno.test("FABLE_PREFERRING_PHASES - every phase whose default model is the Fable top tier is Fable-preferring, and vice versa (Issue #4429)", () => {
  const fableDefault = Object.entries(PHASE_MODEL_DEFAULTS)
    .filter(([, model]) => model === DEFAULT_CLAUDE_MODEL_TOP_TIER)
    .map(([phase]) => phase)
    .sort();
  assertEquals([...FABLE_PREFERRING_PHASES].sort(), fableDefault);
});

Deno.test("isFablePreferringPhase - true for each of the eight phases", () => {
  for (const phase of FABLE_PREFERRING_PHASES) {
    assert(
      isFablePreferringPhase(phase),
      `${phase} should be Fable-preferring`,
    );
  }
});

Deno.test("isFablePreferringPhase - false for non-preferring phases and undefined", () => {
  for (
    const phase of ["issue", "ci_fix", "pr_feedback", "health", "spelling_fix"]
  ) {
    assert(!isFablePreferringPhase(phase), `${phase} should not be preferring`);
  }
  assert(!isFablePreferringPhase(undefined));
});

// ---------------------------------------------------------------------------
// resolveFablePreflightRouting - full matrix
// ---------------------------------------------------------------------------

const NOOP = { degraded: false };

Deno.test("resolveFablePreflightRouting - unavailable + no override ⇒ Opus @ max degraded", () => {
  for (const phase of FABLE_PREFERRING_PHASES) {
    const routing = resolveFablePreflightRouting(phase, "unavailable", false);
    assertEquals(routing, {
      model: FABLE_PREFLIGHT_MODEL,
      effort: FABLE_PREFLIGHT_EFFORT,
      degraded: true,
      reason: FABLE_PREFLIGHT_DEGRADED_REASON,
    });
    // Concrete values, per the acceptance criteria.
    assertEquals(routing.model, "opus");
    assertEquals(routing.effort, "max");
  }
});

Deno.test("resolveFablePreflightRouting - available verdict ⇒ no-op (never rerouted)", () => {
  for (const phase of FABLE_PREFERRING_PHASES) {
    assertEquals(resolveFablePreflightRouting(phase, "available", false), NOOP);
  }
});

Deno.test("resolveFablePreflightRouting - unknown/expired verdict ⇒ no-op (optimistic)", () => {
  for (const phase of FABLE_PREFERRING_PHASES) {
    assertEquals(resolveFablePreflightRouting(phase, "unknown", false), NOOP);
  }
});

Deno.test("resolveFablePreflightRouting - explicit override suppresses reroute even when unavailable", () => {
  for (const phase of FABLE_PREFERRING_PHASES) {
    assertEquals(
      resolveFablePreflightRouting(phase, "unavailable", true),
      NOOP,
    );
  }
});

Deno.test("resolveFablePreflightRouting - non-Fable-preferring phases are never rerouted", () => {
  const verdicts: FableCacheRead[] = ["available", "unavailable", "unknown"];
  for (const phase of ["issue", "ci_fix", "pr_feedback", "health", undefined]) {
    for (const verdict of verdicts) {
      for (const override of [true, false]) {
        assertEquals(
          resolveFablePreflightRouting(phase, verdict, override),
          NOOP,
          `phase=${phase} verdict=${verdict} override=${override}`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// applyFablePreflightRouting - invocation-layer wiring
// ---------------------------------------------------------------------------

Deno.test("applyFablePreflightRouting - forwards Opus @ max onto the run options when rerouted", () => {
  const base: {
    phase: string;
    prompt: string;
    timeoutSeconds: number;
    model?: string;
    effort?: string;
  } = { phase: "planning", prompt: "plan it", timeoutSeconds: 100 };
  const { options, routing } = applyFablePreflightRouting(
    base,
    "unavailable",
    false,
  );

  // Override reaches the run options.
  assertEquals(options.model, "opus");
  assertEquals(options.effort, "max");
  // Other fields preserved.
  assertEquals(options.prompt, "plan it");
  assertEquals(options.timeoutSeconds, 100);
  // Degraded flag + reason threaded through.
  assert(routing.degraded);
  assertEquals(routing.reason, FABLE_PREFLIGHT_DEGRADED_REASON);
  // Original object not mutated (a copy is returned).
  assertEquals((base as { model?: string }).model, undefined);
  assert(options !== base);
});

Deno.test("applyFablePreflightRouting - returns options unchanged when not rerouted", () => {
  const base: {
    phase: string;
    prompt: string;
    model?: string;
    effort?: string;
  } = { phase: "planning", prompt: "plan it" };
  // Available verdict ⇒ no reroute.
  const { options, routing } = applyFablePreflightRouting(
    base,
    "available",
    false,
  );
  assertEquals(options.model, undefined);
  assertEquals(options.effort, undefined);
  assert(!routing.degraded);
  assert(options === base, "same object returned when no reroute");
});

Deno.test("applyFablePreflightRouting - explicit override on options is respected by caller", () => {
  // Simulates a call site that already pinned the model; the caller passes
  // hasExplicitOverride=true so the reroute is suppressed.
  const base = { phase: "planning", model: "sonnet" };
  const { options, routing } = applyFablePreflightRouting(
    base,
    "unavailable",
    true,
  );
  assertEquals(options.model, "sonnet");
  assert(!routing.degraded);
});
