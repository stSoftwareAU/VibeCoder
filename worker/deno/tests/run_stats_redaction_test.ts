/**
 * Run-stats comments must survive the secret-redaction chokepoint (Issue #4004).
 *
 * Every body the worker posts through `gh` is passed through `redactSecrets`.
 * The stats block renders a bold `- **Tokens:** …` label, and the
 * secret-assignment rule used to read `Tokens` + `:` + the bold closer as a
 * secret assignment, substituting the placeholder over the `**` and breaking
 * the rendering. These tests assert the rendered block passes redaction
 * byte-for-byte unchanged.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPlanningStatsSection,
  type PlanningInvocationStats,
} from "../lib/planning_run_stats.ts";
import { containsSecret, redactSecrets } from "../lib/secret_redaction.ts";

/** A planning invocation with full token usage, turns and duration. */
function invocation(phase: string): PlanningInvocationStats {
  return {
    phase,
    runStats: {
      servedModels: ["claude-fable-5-20250101"],
      requestedModel: "claude-fable-5-20250101",
      effort: "max",
      tokenUsage: {
        inputTokens: 27,
        outputTokens: 11901,
        cacheCreationTokens: 45678,
        cacheReadTokens: 1234567,
      },
      numTurns: 12,
      durationMs: 90_500,
      wallClockMs: 91_000,
    },
  };
}

for (const phase of ["planning", "grill_me"]) {
  Deno.test(`run-stats section survives redaction unchanged - ${phase} (Issue #4004)`, () => {
    const section = buildPlanningStatsSection({
      invocations: [invocation(phase)],
      expectedModel: "claude-fable-5-20250101",
      verdict: { degraded: false },
      phase,
    });

    assertStringIncludes(section, "- **Tokens:** input 27 · output 11,901");
    assertEquals(containsSecret(section), false);
    assertEquals(redactSecrets(section), section);
  });
}
