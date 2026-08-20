/**
 * Tests for claim-runway floor resolution (Issue #47).
 *
 * The floor decides how much cycle runway a new implementation claim must
 * have. Three regimes: no execute budget known (plain #4304 floor), the
 * cycle fits a full budget (floor raised to the budget), and the cycle can
 * never fit the budget (plain floor plus a documented-exception reason).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { resolveClaimRunwayFloor } from "../lib/claim_runway.ts";

Deno.test("claim runway #47 - no budget keeps the plain #4304 floor", () => {
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 1800,
    cycleSeconds: 3600,
  });
  assertEquals(floor.floorSeconds, 1800);
  assertEquals(floor.fullBudgetGate, false);
  assertEquals(floor.exceptionReason, undefined);
});

Deno.test("claim runway #47 - a non-positive budget keeps the plain floor", () => {
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 1800,
    fullExecuteBudgetSeconds: 0,
    cycleSeconds: 3600,
  });
  assertEquals(floor.floorSeconds, 1800);
  assertEquals(floor.fullBudgetGate, false);
});

Deno.test("claim runway #47 - a cycle that fits the budget raises the floor to it", () => {
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 1800,
    fullExecuteBudgetSeconds: 3600,
    cycleSeconds: 4 * 3600,
  });
  assertEquals(floor.floorSeconds, 3600);
  assertEquals(floor.fullBudgetGate, true);
  assertEquals(floor.exceptionReason, undefined);
});

Deno.test("claim runway #47 - a raised floor never drops below the configured floor", () => {
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 5400,
    fullExecuteBudgetSeconds: 3600,
    cycleSeconds: 4 * 3600,
  });
  assertEquals(floor.floorSeconds, 5400);
  assertEquals(floor.fullBudgetGate, true);
});

Deno.test("claim runway #47 - a cycle shorter than the budget is the documented exception", () => {
  // The live case: a 3600 s cycle with a 3600 s claudeTimeout — raising the
  // floor would refuse every claim the host could ever make.
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 1800,
    fullExecuteBudgetSeconds: 3600,
    cycleSeconds: 3600,
  });
  assertEquals(floor.floorSeconds, 1800);
  assertEquals(floor.fullBudgetGate, false);
  assert(
    floor.exceptionReason !== undefined &&
      floor.exceptionReason.includes("can never offer"),
    `expected a documented-exception reason, got: ${floor.exceptionReason}`,
  );
  assert(
    floor.exceptionReason.includes("Issue #47"),
    "the exception reason must cite Issue #47",
  );
});
