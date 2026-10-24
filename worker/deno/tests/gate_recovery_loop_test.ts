/**
 * Unit tests for the bounded completion-gate recovery loop (Issue #4234).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  clampTurnTimeout,
  countBlockingFindings,
  describeRecoveryEnd,
  MIN_RECOVERY_TURN_SECONDS,
  shouldRunRecoveryTurn,
} from "../lib/gate_recovery_loop.ts";

// ---------------------------------------------------------------------------
// countBlockingFindings
// ---------------------------------------------------------------------------

Deno.test("countBlockingFindings: each section without a count is one finding", () => {
  assertEquals(
    countBlockingFindings({
      sections: [{ gate: "docs-sweep" }, { gate: "branch-outcomes" }],
      unmetCriteria: 0,
      standingViolations: 0,
    }),
    2,
  );
});

Deno.test("countBlockingFindings: a section's own finding count is used", () => {
  assertEquals(
    countBlockingFindings({
      sections: [{ gate: "pre-pr-verifier", findings: 4 }],
      unmetCriteria: 0,
      standingViolations: 0,
    }),
    4,
  );
});

Deno.test("countBlockingFindings: a zero finding count still counts one section", () => {
  assertEquals(
    countBlockingFindings({
      sections: [{ gate: "removed-assertions", findings: 0 }],
      unmetCriteria: 0,
      standingViolations: 0,
    }),
    1,
  );
});

Deno.test("countBlockingFindings: adds unmet criteria and standing violations", () => {
  assertEquals(
    countBlockingFindings({
      sections: [
        { gate: "docs-sweep" },
        { gate: "removed-assertions", findings: 2 },
      ],
      unmetCriteria: 3,
      standingViolations: 5,
    }),
    11,
  );
});

// ---------------------------------------------------------------------------
// shouldRunRecoveryTurn
// ---------------------------------------------------------------------------

Deno.test("shouldRunRecoveryTurn: no recorded pass grants no turn", () => {
  assertEquals(shouldRunRecoveryTurn([], 2), false);
});

Deno.test("shouldRunRecoveryTurn: a turn limit below one grants no turn", () => {
  assertEquals(shouldRunRecoveryTurn([5], 0), false);
  assertEquals(shouldRunRecoveryTurn([5, 3], 0), false);
});

Deno.test("shouldRunRecoveryTurn: the first block always gets its turn", () => {
  assertEquals(shouldRunRecoveryTurn([5], 1), true);
  assertEquals(shouldRunRecoveryTurn([1], 2), true);
});

Deno.test("shouldRunRecoveryTurn: decreasing counts continue", () => {
  assertEquals(shouldRunRecoveryTurn([5, 3], 2), true);
  assertEquals(shouldRunRecoveryTurn([5, 3, 1], 3), true);
});

Deno.test("shouldRunRecoveryTurn: an equal count stops the loop", () => {
  assertEquals(shouldRunRecoveryTurn([5, 5], 3), false);
  assertEquals(shouldRunRecoveryTurn([5, 3, 3], 3), false);
});

Deno.test("shouldRunRecoveryTurn: a count one lower still continues (sibling of equal)", () => {
  assertEquals(shouldRunRecoveryTurn([5, 4], 3), true);
  assertEquals(shouldRunRecoveryTurn([5, 3, 2], 3), true);
});

Deno.test("shouldRunRecoveryTurn: an increasing count stops the loop", () => {
  assertEquals(shouldRunRecoveryTurn([3, 5], 3), false);
  assertEquals(shouldRunRecoveryTurn([5, 3, 4], 3), false);
});

Deno.test("shouldRunRecoveryTurn: the turn limit stops a decreasing loop", () => {
  assertEquals(shouldRunRecoveryTurn([5, 4, 3], 2), false);
});

Deno.test("shouldRunRecoveryTurn: one turn below the limit still runs (sibling of turn limit)", () => {
  assertEquals(shouldRunRecoveryTurn([5, 4, 3], 3), true);
});

Deno.test("shouldRunRecoveryTurn: a single turn allowed is spent on the first pair", () => {
  assertEquals(shouldRunRecoveryTurn([5, 4], 1), false);
  assertEquals(shouldRunRecoveryTurn([5], 1), true);
});

// ---------------------------------------------------------------------------
// describeRecoveryEnd
// ---------------------------------------------------------------------------

Deno.test("describeRecoveryEnd: undefined when no recovery turn was spent", () => {
  assertEquals(describeRecoveryEnd([], 2), undefined);
  assertEquals(describeRecoveryEnd([5], 2), undefined);
});

Deno.test("describeRecoveryEnd: names a non-decreasing count as no-progress", () => {
  assertEquals(
    describeRecoveryEnd([5, 3, 3], 5),
    "recovery stopped after 2 turns: blocking findings did not decrease (5 → 3 → 3)",
  );
});

Deno.test("describeRecoveryEnd: singular turn wording", () => {
  assertEquals(
    describeRecoveryEnd([3, 3], 2),
    "recovery stopped after 1 turn: blocking findings did not decrease (3 → 3)",
  );
});

Deno.test("describeRecoveryEnd: an increase is no-progress too", () => {
  assertEquals(
    describeRecoveryEnd([2, 4], 2),
    "recovery stopped after 1 turn: blocking findings did not decrease (2 → 4)",
  );
});

Deno.test("describeRecoveryEnd: no-progress takes precedence over the turn limit", () => {
  assertEquals(
    describeRecoveryEnd([5, 4, 4], 2),
    "recovery stopped after 2 turns: blocking findings did not decrease (5 → 4 → 4)",
  );
});

Deno.test("describeRecoveryEnd: names the turn limit with the findings left", () => {
  assertEquals(
    describeRecoveryEnd([5, 4, 2], 2),
    "recovery stopped at the 2-turn limit with 2 blocking findings left (5 → 4 → 2)",
  );
});

Deno.test("describeRecoveryEnd: singular finding wording at the turn limit", () => {
  assertEquals(
    describeRecoveryEnd([4, 1], 1),
    "recovery stopped at the 1-turn limit with 1 blocking finding left (4 → 1)",
  );
});

Deno.test("describeRecoveryEnd: a count reaching zero is recovered", () => {
  assertEquals(
    describeRecoveryEnd([5, 0], 2),
    "recovery cleared every blocking finding after 1 turn (5 → 0)",
  );
});

Deno.test("describeRecoveryEnd: a falling count still under the limit is not a stop", () => {
  assertEquals(
    describeRecoveryEnd([5, 3], 3),
    "recovery is still making progress after 1 turn: blocking findings fell (5 → 3)",
  );
});

// ---------------------------------------------------------------------------
// clampTurnTimeout
// ---------------------------------------------------------------------------

Deno.test("clampTurnTimeout: uncapped keeps the configured timeout", () => {
  assertEquals(
    clampTurnTimeout({ configuredSeconds: 600, nowMs: 0 }),
    { skip: false, timeoutSeconds: 600 },
  );
});

Deno.test("clampTurnTimeout: plenty of runway keeps the configured timeout", () => {
  assertEquals(
    clampTurnTimeout({
      configuredSeconds: 600,
      nowMs: 0,
      ceilingMs: 1_000_000,
    }),
    { skip: false, timeoutSeconds: 600 },
  );
});

Deno.test("clampTurnTimeout: runway shorter than the configured timeout clamps it", () => {
  assertEquals(
    clampTurnTimeout({
      configuredSeconds: 600,
      nowMs: 0,
      ceilingMs: 300_000,
    }),
    { skip: false, timeoutSeconds: 300 },
  );
});

Deno.test("clampTurnTimeout: runway is floored to whole seconds", () => {
  assertEquals(
    clampTurnTimeout({
      configuredSeconds: 600,
      nowMs: 0,
      ceilingMs: 120_999,
    }),
    { skip: false, timeoutSeconds: 120 },
  );
});

Deno.test("clampTurnTimeout: below the minimum runway skips the turn", () => {
  const result = clampTurnTimeout({
    configuredSeconds: 600,
    nowMs: 0,
    ceilingMs: 119_999,
  });
  assertEquals(result.skip, true);
  assertEquals(result.timeoutSeconds, 0);
  assertEquals(
    result.reason,
    `only 119 seconds of run time remain, below the ${MIN_RECOVERY_TURN_SECONDS}-second minimum for a recovery turn`,
  );
});

Deno.test("clampTurnTimeout: a ceiling already past skips the turn", () => {
  const result = clampTurnTimeout({
    configuredSeconds: 600,
    nowMs: 500_000,
    ceilingMs: 400_000,
  });
  assertEquals(result.skip, true);
  assertEquals(result.timeoutSeconds, 0);
});

Deno.test("clampTurnTimeout: exactly the minimum runway runs the turn", () => {
  assertEquals(
    clampTurnTimeout({
      configuredSeconds: 600,
      nowMs: 1_000,
      ceilingMs: 1_000 + MIN_RECOVERY_TURN_SECONDS * 1000,
    }),
    { skip: false, timeoutSeconds: MIN_RECOVERY_TURN_SECONDS },
  );
});

Deno.test("clampTurnTimeout: exactly the minimum runway keeps a shorter configured timeout", () => {
  assertEquals(
    clampTurnTimeout({
      configuredSeconds: 100,
      nowMs: 0,
      ceilingMs: MIN_RECOVERY_TURN_SECONDS * 1000,
    }),
    { skip: false, timeoutSeconds: 100 },
  );
});

Deno.test("clampTurnTimeout: NaN inputs throw", () => {
  assertThrows(() => clampTurnTimeout({ configuredSeconds: NaN, nowMs: 0 }));
  assertThrows(() =>
    clampTurnTimeout({ configuredSeconds: 600, nowMs: NaN, ceilingMs: 1 })
  );
  assertThrows(() =>
    clampTurnTimeout({ configuredSeconds: 600, nowMs: 0, ceilingMs: NaN })
  );
});

Deno.test("clampTurnTimeout: infinite ceiling throws rather than running uncapped", () => {
  assertThrows(() =>
    clampTurnTimeout({
      configuredSeconds: 600,
      nowMs: 0,
      ceilingMs: Infinity,
    })
  );
});

Deno.test("clampTurnTimeout: a non-positive configured timeout throws", () => {
  assertThrows(() => clampTurnTimeout({ configuredSeconds: 0, nowMs: 0 }));
  assertThrows(() => clampTurnTimeout({ configuredSeconds: -1, nowMs: 0 }));
});
