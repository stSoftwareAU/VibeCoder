/**
 * Tests for claim-runway floor resolution (Issues #4304/#425, parent #397).
 *
 * The floor decides how much runway **to the supervisor hard cap** a new
 * implementation claim must have. Three regimes: a capped run (the floor
 * applies), an uncapped run (inert, with the reason stated), and a floor
 * configured to `0` (inert, with the reason stated).
 *
 * The Issue #47 rule that raised the floor to the whole execute budget is
 * gone: it existed to make deadline-bound executes rare, and Issue #420
 * retired deadline-bound executes altogether.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  belowClaimRunwayFloor,
  DEFAULT_MIN_CLAIM_RUNWAY_SECONDS,
  hardCapRunwaySeconds,
  resolveClaimRunwayFloor,
} from "../lib/claim_runway.ts";

/** A three-hour cap whose ceiling is `runwaySeconds` away from `nowMs`. */
function capWithRunway(nowMs: number, runwaySeconds: number) {
  return { ceilingMs: nowMs + runwaySeconds * 1000, windowSeconds: 10800 };
}

Deno.test("claim runway #425 - a capped run keeps the configured floor and its cap", () => {
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 300,
    hardCap: capWithRunway(0, 7200),
  });
  assertEquals(floor.floorSeconds, 300);
  assertEquals(floor.hardCap?.ceilingMs, 7_200_000);
  assertEquals(floor.inertReason, undefined);
});

Deno.test("claim runway #425 - an uncapped run leaves the floor inert, and says so", () => {
  const floor = resolveClaimRunwayFloor({ minClaimRunwaySeconds: 300 });
  assertEquals(floor.floorSeconds, 300);
  assertEquals(floor.hardCap, undefined);
  assert(
    floor.inertReason !== undefined &&
      floor.inertReason.includes("VIBE_RUN_MAX_SECONDS"),
    `expected the uncapped reason, got: ${floor.inertReason}`,
  );
  // Inert means inert: no claim is refused, however little cycle is left.
  assertEquals(belowClaimRunwayFloor(floor, 3_599_000), false);
  assertEquals(hardCapRunwaySeconds(floor, 0), undefined);
});

Deno.test("claim runway #425 - a floor of 0 is disabled, and says so", () => {
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 0,
    hardCap: capWithRunway(0, 60),
  });
  assertEquals(floor.floorSeconds, 0);
  assert(
    floor.inertReason !== undefined &&
      floor.inertReason.includes("min_claim_runway_seconds is 0"),
    `expected the disabled reason, got: ${floor.inertReason}`,
  );
  assertEquals(belowClaimRunwayFloor(floor, 0), false);
});

Deno.test("claim runway #425 - the floor is measured against the hard cap, not the cycle", () => {
  // Twenty minutes before a 3600 s cycle deadline, but hours of hard-cap
  // runway left: the acceptance case from Issue #425.
  const now = 2400 * 1000;
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: DEFAULT_MIN_CLAIM_RUNWAY_SECONDS,
    hardCap: capWithRunway(now, 2 * 3600),
  });
  assertEquals(belowClaimRunwayFloor(floor, now), false);
  assertEquals(hardCapRunwaySeconds(floor, now), 7200);
});

Deno.test("claim runway #425 - a claim inside the floor of the hard cap is refused", () => {
  const now = 1_000_000;
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 300,
    hardCap: capWithRunway(now, 299),
  });
  assertEquals(belowClaimRunwayFloor(floor, now), true);
  assertEquals(hardCapRunwaySeconds(floor, now), 299);
  // Exactly at the floor is still refused — the boundary is inclusive.
  const exact = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 300,
    hardCap: capWithRunway(now, 300),
  });
  assertEquals(belowClaimRunwayFloor(exact, now), true);
});

Deno.test("claim runway #425 - a ceiling already passed reports zero runway and refuses", () => {
  const now = 5_000_000;
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: 300,
    hardCap: { ceilingMs: now - 60_000, windowSeconds: 10800 },
  });
  assertEquals(hardCapRunwaySeconds(floor, now), 0);
  assertEquals(belowClaimRunwayFloor(floor, now), true);
});

Deno.test("DEFAULT_MIN_CLAIM_RUNWAY_SECONDS is five minutes so a run keeps claiming until its last minutes (VibeCoder#170)", () => {
  assertEquals(DEFAULT_MIN_CLAIM_RUNWAY_SECONDS, 300);
  const floor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: DEFAULT_MIN_CLAIM_RUNWAY_SECONDS,
    hardCap: capWithRunway(0, 1200),
  });
  assertEquals(floor.floorSeconds, 300);
  assertEquals(belowClaimRunwayFloor(floor, 0), false);
});
