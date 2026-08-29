/**
 * Guard tests for the gate-clearing classification (Issue #524).
 *
 * The type checker already makes {@link SKIP_REASON_CLEARING} total over
 * `SKIP_REASONS` — a new gate is a compile error until somebody says how it
 * clears. These tests cover what the type checker cannot: that the map has no
 * stray keys, that the suppression rule is *derived* from the declaration
 * rather than restated, and that a gate needing a human or a re-approval can
 * never raise the suppression signal — the #499 defect.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { SKIP_REASONS } from "../lib/issue_finder_logger.ts";
import {
  type GateClearing,
  permanentlyBlockingReasons,
  SKIP_REASON_CLEARING,
  suppressesLowerTiers,
} from "../lib/skip_reason_clearing.ts";
import { CENSUS_SCAN_GATE_COVERAGE } from "../lib/idle_decision_census.ts";

Deno.test("skip-reason clearing - the map is total and carries no stray keys", () => {
  assertEquals(
    Object.keys(SKIP_REASON_CLEARING).sort(),
    [...SKIP_REASONS].sort(),
  );
});

Deno.test("skip-reason clearing - every gate declares one of the three behaviours", () => {
  const allowed: GateClearing[] = ["self", "permanent", "human"];
  for (const reason of SKIP_REASONS) {
    assertEquals(
      allowed.includes(SKIP_REASON_CLEARING[reason]),
      true,
      `${reason} carries an unknown clearing behaviour`,
    );
  }
});

Deno.test("skip-reason clearing - suppression is derived from the declaration, not restated", () => {
  for (const reason of SKIP_REASONS) {
    assertEquals(
      suppressesLowerTiers(reason),
      SKIP_REASON_CLEARING[reason] === "self",
      `${reason} suppresses against its own declaration`,
    );
  }
});

Deno.test("skip-reason clearing - an issue nothing refused always suppresses (Issue #2164)", () => {
  // The original serialisation signal: a repo with eligible higher-tier work
  // parks its lower tiers rather than opening a backlog PR beside it.
  assertEquals(suppressesLowerTiers(undefined), true);
});

Deno.test("skip-reason clearing - the #499 gates cannot raise the suppression signal", () => {
  // The two gates whose subtraction this map replaces. Flipping either one
  // back to `self` re-strands a repo's whole backlog behind work no cycle can
  // claim, so both are pinned by name as well as by rule.
  assertEquals(suppressesLowerTiers("merged-pr-permanent"), false);
  assertEquals(suppressesLowerTiers("dependency-blocked"), false);
});

Deno.test("skip-reason clearing - a bounded wait still suppresses", () => {
  // The covering assertion: over-correcting #499 into "nothing suppresses"
  // would break the one-PR-per-work-stream guarantee.
  assertEquals(suppressesLowerTiers("pr-blocked"), true);
  assertEquals(suppressesLowerTiers("milestone-occupied"), true);
  assertEquals(suppressesLowerTiers("closed-pr-cooldown"), true);
});

Deno.test("skip-reason clearing - the non-clearing class is enumerable, not restated", () => {
  const nonClearing = permanentlyBlockingReasons();
  assertEquals(nonClearing.includes("merged-pr-permanent"), true);
  assertEquals(nonClearing.includes("dependency-blocked"), true);
  assertEquals(nonClearing.includes("pr-blocked"), false);
  for (const reason of nonClearing) {
    assertEquals(suppressesLowerTiers(reason), false);
  }
});

Deno.test("skip-reason clearing - both gate maps cover exactly the same gates", () => {
  // Two total maps over the same union, one per axis. Keeping their key sets
  // checked here means a gate cannot be classified on one axis only — the
  // failure mode `CENSUS_SCAN_GATE_COVERAGE`'s own docblock records for
  // #3526, #3852 and GRQ#4419.
  assertEquals(
    Object.keys(SKIP_REASON_CLEARING).sort(),
    Object.keys(CENSUS_SCAN_GATE_COVERAGE).sort(),
  );
});

Deno.test("skip-reason clearing - no gate is left unclassified by the census", () => {
  for (const reason of SKIP_REASONS) {
    assertEquals(
      CENSUS_SCAN_GATE_COVERAGE[reason] === "unclassified",
      false,
      `${reason} is unclassified in the census coverage map`,
    );
  }
});
