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

// ---------------------------------------------------------------------------
// Test environment helpers
// ---------------------------------------------------------------------------

/** Snapshot/restore env vars that influence model selection. */
function withCleanEnv(fn: () => void): void {
  const keys = [
    "CLAUDE_MODEL",
    "CLAUDE_MODEL_SUMMARISE",
    "CLAUDE_MODEL_HEALTH",
    "CLAUDE_MODEL_SPELLING_FIX",
  ];
  const snapshot: Record<string, string | undefined> = {};
  for (const k of keys) {
    snapshot[k] = Deno.env.get(k);
    Deno.env.delete(k);
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      const v = snapshot[k];
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

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
  withCleanEnv(() => {
    const result = selectModelForLargeInput("summarise", 5_000);
    assertEquals(result.escalated, false);
    assertEquals(result.model, "haiku");
    assertEquals(result.reason, undefined);
  });
});

Deno.test("phase_model_escalation - summarise input just below threshold stays on haiku", () => {
  withCleanEnv(() => {
    const haikuWindow = MODEL_CONTEXT_WINDOWS.haiku!;
    const justBelow = Math.floor(
      (haikuWindow * HAIKU_ESCALATION_THRESHOLD_PERCENT) / 100,
    ) - 1;
    const result = selectModelForLargeInput("summarise", justBelow);
    assertEquals(result.escalated, false);
    assertEquals(result.model, "haiku");
  });
});

// ---------------------------------------------------------------------------
// Escalation path — Haiku phase, large input escalates to Sonnet
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - summarise input at threshold escalates to sonnet", () => {
  withCleanEnv(() => {
    const haikuWindow = MODEL_CONTEXT_WINDOWS.haiku!;
    const atThreshold = Math.floor(
      (haikuWindow * HAIKU_ESCALATION_THRESHOLD_PERCENT) / 100,
    );
    const result = selectModelForLargeInput("summarise", atThreshold);
    assertEquals(result.escalated, true);
    assertEquals(result.model, DEFAULT_ESCALATION_TARGET);
    assert(result.reason !== undefined && result.reason.length > 0);
  });
});

Deno.test("phase_model_escalation - summarise input over 200k escalates to sonnet", () => {
  withCleanEnv(() => {
    const result = selectModelForLargeInput("summarise", 250_000);
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
});

// ---------------------------------------------------------------------------
// No-op on already-large-window models
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - phase pinned to sonnet via env var does not escalate", () => {
  withCleanEnv(() => {
    Deno.env.set("CLAUDE_MODEL_SUMMARISE", "sonnet");
    const result = selectModelForLargeInput("summarise", 500_000);
    assertEquals(result.escalated, false);
    assertEquals(result.model, "sonnet");
  });
});

Deno.test("phase_model_escalation - phase pinned to opus via env var does not escalate", () => {
  withCleanEnv(() => {
    Deno.env.set("CLAUDE_MODEL_SUMMARISE", "opus");
    const result = selectModelForLargeInput("summarise", 500_000);
    assertEquals(result.escalated, false);
    assertEquals(result.model, "opus");
  });
});

Deno.test("phase_model_escalation - phase pinned to full sonnet model ID does not escalate", () => {
  withCleanEnv(() => {
    Deno.env.set("CLAUDE_MODEL_SUMMARISE", "claude-sonnet-4-7");
    const result = selectModelForLargeInput("summarise", 500_000);
    assertEquals(result.escalated, false);
    assertEquals(result.model, "claude-sonnet-4-7");
  });
});

// ---------------------------------------------------------------------------
// Other Haiku-pinned phases (health, spelling_fix) — trivial inputs only
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - health phase small input stays on haiku", () => {
  withCleanEnv(() => {
    const result = selectModelForLargeInput("health", 50);
    assertEquals(result.escalated, false);
    assertEquals(result.model, "haiku");
  });
});

Deno.test("phase_model_escalation - any haiku-pinned phase escalates if input is huge", () => {
  // The function is generic — it triggers on the resolved model's window,
  // not on the phase name. If health were ever called with a giant input
  // we still want the same protection.
  withCleanEnv(() => {
    const result = selectModelForLargeInput("health", 300_000);
    assertEquals(result.escalated, true);
    assertEquals(result.model, DEFAULT_ESCALATION_TARGET);
  });
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - custom escalation target honoured", () => {
  withCleanEnv(() => {
    const result = selectModelForLargeInput("summarise", 250_000, {
      escalationTarget: "opus",
    });
    assertEquals(result.escalated, true);
    assertEquals(result.model, "opus");
  });
});

Deno.test("phase_model_escalation - custom threshold percent honoured", () => {
  withCleanEnv(() => {
    // Threshold of 50% → 100k tokens.
    const result = selectModelForLargeInput("summarise", 120_000, {
      thresholdPercent: 50,
    });
    assertEquals(result.escalated, true);
    assertEquals(result.model, "sonnet");
  });
});

Deno.test("phase_model_escalation - custom threshold percent suppresses escalation under threshold", () => {
  withCleanEnv(() => {
    // Threshold of 95% → 190k tokens. 180k stays on haiku.
    const result = selectModelForLargeInput("summarise", 180_000, {
      thresholdPercent: 95,
    });
    assertEquals(result.escalated, false);
    assertEquals(result.model, "haiku");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("phase_model_escalation - zero tokens never escalates", () => {
  withCleanEnv(() => {
    const result = selectModelForLargeInput("summarise", 0);
    assertEquals(result.escalated, false);
    assertEquals(result.model, "haiku");
  });
});

Deno.test("phase_model_escalation - negative tokens treated as zero", () => {
  withCleanEnv(() => {
    const result = selectModelForLargeInput("summarise", -100);
    assertEquals(result.escalated, false);
    assertEquals(result.model, "haiku");
  });
});

Deno.test("phase_model_escalation - unknown phase falls back to default window (200k) and escalates when huge", () => {
  withCleanEnv(() => {
    // No PHASE_MODEL_DEFAULTS entry for "totally-made-up-phase" and no env var
    // means resolveCurrentModel returns "". The escalation logic should treat
    // an unresolved model conservatively (default 200k window) and escalate
    // when the input is large.
    const result = selectModelForLargeInput("totally-made-up-phase", 250_000);
    assertEquals(result.escalated, true);
    assertEquals(result.model, DEFAULT_ESCALATION_TARGET);
  });
});
