/**
 * Tests for phase model escalation on large inputs (Issue #2393).
 *
 * Verifies that when a Haiku-pinned phase (e.g. `summarise`) receives an
 * input approaching the Haiku 200k context window, the model is escalated
 * to a larger-window tier so the input is not silently truncated.
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_ESCALATION_TARGET,
  HAIKU_ESCALATION_THRESHOLD_PERCENT,
  selectModelForLargeInput,
} from "../lib/phase_model_escalation.ts";
import { MODEL_CONTEXT_WINDOWS } from "../lib/context_budget.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

// ---------------------------------------------------------------------------
// The environment these tests run against
// ---------------------------------------------------------------------------
//
// `selectModelForLargeInput` takes the environment its model resolution reads
// through (Issue #957), so every call below states what the routing chain may
// see. `emptyEnv` is the *empty* environment — stricter than the four names this
// file used to delete from the process, which left any other `CLAUDE_MODEL_*`
// the worker container exports free to decide the phase's model.

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - exposes DEFAULT_ESCALATION_TARGET as sonnet", () => {
  assertEquals(DEFAULT_ESCALATION_TARGET, "sonnet");
});

Deno.test("phase_model_escalation - threshold sits within (0, 100)", () => {
  assert(HAIKU_ESCALATION_THRESHOLD_PERCENT > 0);
  assert(HAIKU_ESCALATION_THRESHOLD_PERCENT < 100);
});

// ---------------------------------------------------------------------------
// Happy path — Haiku phase, small input stays on Haiku
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - summarise small input stays on haiku", () => {
  const result = selectModelForLargeInput("summarise", 5_000, {
    env: emptyEnv,
  });
  assertEquals(result.escalated, false);
  assertEquals(result.model, "haiku");
  assertEquals(result.reason, undefined);
});

Deno.test("phase_model_escalation - summarise input just below threshold stays on haiku", () => {
  const haikuWindow = MODEL_CONTEXT_WINDOWS.haiku!;
  const justBelow = Math.floor(
    (haikuWindow * HAIKU_ESCALATION_THRESHOLD_PERCENT) / 100,
  ) - 1;
  const result = selectModelForLargeInput("summarise", justBelow, {
    env: emptyEnv,
  });
  assertEquals(result.escalated, false);
  assertEquals(result.model, "haiku");
});

// ---------------------------------------------------------------------------
// Escalation path — Haiku phase, large input escalates to Sonnet
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - summarise input at threshold escalates to sonnet", () => {
  const haikuWindow = MODEL_CONTEXT_WINDOWS.haiku!;
  const atThreshold = Math.floor(
    (haikuWindow * HAIKU_ESCALATION_THRESHOLD_PERCENT) / 100,
  );
  const result = selectModelForLargeInput("summarise", atThreshold, {
    env: emptyEnv,
  });
  assertEquals(result.escalated, true);
  assertEquals(result.model, DEFAULT_ESCALATION_TARGET);
  assert(result.reason !== undefined && result.reason.length > 0);
});

Deno.test("phase_model_escalation - summarise input over 200k escalates to sonnet", () => {
  const result = selectModelForLargeInput("summarise", 250_000, {
    env: emptyEnv,
  });
  assertEquals(result.escalated, true);
  assertEquals(result.model, "sonnet");
  assert(result.reason !== undefined);
  assert(
    result.reason!.toLowerCase().includes("haiku") ||
      result.reason!.includes("200,000") ||
      result.reason!.includes("200000"),
    `Reason should mention the haiku window; got: ${result.reason}`,
  );
});

// ---------------------------------------------------------------------------
// No-op on already-large-window models
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - phase pinned to sonnet via env var does not escalate", () => {
  const result = selectModelForLargeInput("summarise", 500_000, {
    env: envFrom({ CLAUDE_MODEL_SUMMARISE: "sonnet" }),
  });
  assertEquals(result.escalated, false);
  assertEquals(result.model, "sonnet");
});

Deno.test("phase_model_escalation - phase pinned to opus via env var does not escalate", () => {
  const result = selectModelForLargeInput("summarise", 500_000, {
    env: envFrom({ CLAUDE_MODEL_SUMMARISE: "opus" }),
  });
  assertEquals(result.escalated, false);
  assertEquals(result.model, "opus");
});

Deno.test("phase_model_escalation - phase pinned to full sonnet model ID does not escalate", () => {
  const result = selectModelForLargeInput("summarise", 500_000, {
    env: envFrom({ CLAUDE_MODEL_SUMMARISE: "claude-sonnet-4-7" }),
  });
  assertEquals(result.escalated, false);
  assertEquals(result.model, "claude-sonnet-4-7");
});

// ---------------------------------------------------------------------------
// Other Haiku-pinned phases (health, spelling_fix) — trivial inputs only
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - health phase small input stays on haiku", () => {
  const result = selectModelForLargeInput("health", 50, { env: emptyEnv });
  assertEquals(result.escalated, false);
  assertEquals(result.model, "haiku");
});

Deno.test("phase_model_escalation - any haiku-pinned phase escalates if input is huge", () => {
  // The function is generic — it triggers on the resolved model's window,
  // not on the phase name. If health were ever called with a giant input
  // we still want the same protection.
  const result = selectModelForLargeInput("health", 300_000, { env: emptyEnv });
  assertEquals(result.escalated, true);
  assertEquals(result.model, DEFAULT_ESCALATION_TARGET);
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - custom escalation target honoured", () => {
  const result = selectModelForLargeInput("summarise", 250_000, {
    escalationTarget: "opus",
    env: emptyEnv,
  });
  assertEquals(result.escalated, true);
  assertEquals(result.model, "opus");
});

Deno.test("phase_model_escalation - custom threshold percent honoured", () => {
  // Threshold of 50% → 100k tokens.
  const result = selectModelForLargeInput("summarise", 120_000, {
    thresholdPercent: 50,
    env: emptyEnv,
  });
  assertEquals(result.escalated, true);
  assertEquals(result.model, "sonnet");
});

Deno.test("phase_model_escalation - custom threshold percent suppresses escalation under threshold", () => {
  // Threshold of 95% → 190k tokens. 180k stays on haiku.
  const result = selectModelForLargeInput("summarise", 180_000, {
    thresholdPercent: 95,
    env: emptyEnv,
  });
  assertEquals(result.escalated, false);
  assertEquals(result.model, "haiku");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - zero tokens never escalates", () => {
  const result = selectModelForLargeInput("summarise", 0, { env: emptyEnv });
  assertEquals(result.escalated, false);
  assertEquals(result.model, "haiku");
});

Deno.test("phase_model_escalation - negative tokens treated as zero", () => {
  const result = selectModelForLargeInput("summarise", -100, { env: emptyEnv });
  assertEquals(result.escalated, false);
  assertEquals(result.model, "haiku");
});

Deno.test("phase_model_escalation - unknown phase falls back to default window (200k) and escalates when huge", () => {
  // No PHASE_MODEL_DEFAULTS entry for "totally-made-up-phase" and no env var
  // means resolveCurrentModel returns "". The escalation logic should treat
  // an unresolved model conservatively (default 200k window) and escalate
  // when the input is large.
  const result = selectModelForLargeInput("totally-made-up-phase", 250_000, {
    env: emptyEnv,
  });
  assertEquals(result.escalated, true);
  assertEquals(result.model, DEFAULT_ESCALATION_TARGET);
});

// ---------------------------------------------------------------------------
// The injected environment lookup (Issue #957)
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - the phase's model is resolved through the injected lookup (Issue #957)", () => {
  // `haiku` has the small window this module escalates away from, so pinning
  // the phase to it through the lookup — under a name no process environment
  // carries a value for — proves the escalation decision reads the seam.
  const result = selectModelForLargeInput("made_up_phase", 500_000, {
    env: envFrom({ CLAUDE_MODEL_MADE_UP_PHASE: "haiku" }),
  });
  assertEquals(result.escalated, true);
  assertEquals(result.model, DEFAULT_ESCALATION_TARGET);
  assertEquals(Deno.env.get("CLAUDE_MODEL_MADE_UP_PHASE"), undefined);

  // The same phase with a large-window model pinned does not escalate.
  const pinned = selectModelForLargeInput("made_up_phase", 500_000, {
    env: envFrom({ CLAUDE_MODEL_MADE_UP_PHASE: "opus" }),
  });
  assertEquals(pinned.escalated, false);
  assertEquals(pinned.model, "opus");
});
