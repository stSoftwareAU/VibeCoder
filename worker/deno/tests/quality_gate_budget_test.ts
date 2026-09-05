/**
 * Tests for the budget-aware quality-gate decision (Issue #1138).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ASSUMED_GATE_SECONDS,
  buildQualityGateBudgetLines,
  decideQualityGateRun,
  formatQualityGateSkipNote,
  GATE_SKIP_MARKER,
  GATE_TAIL_SECONDS,
} from "../lib/quality_gate_budget.ts";

Deno.test("quality_gate_budget - a full budget runs the gate", () => {
  const decision = decideQualityGateRun({ remainingSeconds: 3600 });
  assertEquals(decision.run, true);
  assertEquals(decision.gateSeconds, ASSUMED_GATE_SECONDS);
  assertEquals(decision.measured, false);
  assertEquals(
    decision.requiredSeconds,
    ASSUMED_GATE_SECONDS + GATE_TAIL_SECONDS,
  );
});

Deno.test("quality_gate_budget - a budget shorter than the gate skips it", () => {
  const decision = decideQualityGateRun({ remainingSeconds: 600 });
  assertEquals(decision.run, false);
  assertStringIncludes(decision.reason, "600s");
  assertStringIncludes(decision.reason, "skipped");
});

Deno.test("quality_gate_budget - the fix-and-push tail is part of what the gate needs", () => {
  // Exactly the gate's own duration is NOT enough: a failing check has to be
  // fixed, committed and pushed after it, and that is what the tail buys.
  const decision = decideQualityGateRun({
    remainingSeconds: ASSUMED_GATE_SECONDS,
  });
  assertEquals(decision.run, false);
  const withTail = decideQualityGateRun({
    remainingSeconds: ASSUMED_GATE_SECONDS + GATE_TAIL_SECONDS,
  });
  assertEquals(withTail.run, true);
});

Deno.test("quality_gate_budget - a measured duration replaces the assumption", () => {
  const decision = decideQualityGateRun({
    remainingSeconds: 1200,
    typicalGateSeconds: 120,
  });
  assertEquals(decision.run, true);
  assertEquals(decision.gateSeconds, 120);
  assertEquals(decision.measured, true);
  assertStringIncludes(decision.reason, "measured");
});

Deno.test("quality_gate_budget - a measured duration can also refuse the run", () => {
  const decision = decideQualityGateRun({
    remainingSeconds: 1200,
    typicalGateSeconds: 1800,
  });
  assertEquals(decision.run, false);
  assertEquals(decision.gateSeconds, 1800);
  assertEquals(decision.measured, true);
});

Deno.test("quality_gate_budget - nonsense measurements fall back to the assumption", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const decision = decideQualityGateRun({
      remainingSeconds: 3600,
      typicalGateSeconds: bad,
    });
    assertEquals(decision.gateSeconds, ASSUMED_GATE_SECONDS, `for ${bad}`);
    assertEquals(decision.measured, false, `for ${bad}`);
  }
});

Deno.test("quality_gate_budget - an unknown budget runs the gate", () => {
  // No wind-down notice means the run is nowhere near its cap. Refusing the
  // gate on an unknown budget would skip it on every healthy run.
  const decision = decideQualityGateRun({ remainingSeconds: undefined });
  assertEquals(decision.run, true);
  assertStringIncludes(decision.reason, "no run-budget notice");
});

Deno.test("quality_gate_budget - a nonsense budget is treated as exhausted", () => {
  for (const bad of [-1, Number.NaN]) {
    const decision = decideQualityGateRun({ remainingSeconds: bad });
    assertEquals(decision.run, false, `for ${bad}`);
  }
});

Deno.test("quality_gate_budget - the skip note carries the marker and both figures", () => {
  const decision = decideQualityGateRun({
    remainingSeconds: 480,
    typicalGateSeconds: 1020,
  });
  const note = formatQualityGateSkipNote(decision);
  assertStringIncludes(note, GATE_SKIP_MARKER);
  assertStringIncludes(note, 'remaining="480s"');
  assertStringIncludes(note, 'required="1200s"');
  // The reader has to know what covers the gap.
  assertStringIncludes(note, "CI");
});

Deno.test("quality_gate_budget - a note is only ever written for a skipped gate", () => {
  const decision = decideQualityGateRun({ remainingSeconds: 3600 });
  assertEquals(formatQualityGateSkipNote(decision), "");
});

Deno.test("quality_gate_budget - the prompt lines make the gate conditional on budget", () => {
  const lines = buildQualityGateBudgetLines("./quality.sh").join("\n");
  assertStringIncludes(lines, "./quality.sh");
  assertStringIncludes(lines, ".vibe-run-budget.md");
  assertStringIncludes(lines, GATE_SKIP_MARKER);
  // The assumed duration is stated so the agent can compare it with the budget.
  assertStringIncludes(lines, "15m");
});

Deno.test("quality_gate_budget - the prompt lines quote the repo's own measurement", () => {
  const lines = buildQualityGateBudgetLines("make check", 1800).join("\n");
  assertStringIncludes(lines, "make check");
  assertStringIncludes(lines, "30m");
  assertStringIncludes(lines, "measured");
});
