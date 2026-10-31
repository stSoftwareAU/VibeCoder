/**
 * Tests for decision_warn_dedup.ts — once-per-decision warning suppression
 * (Issue #4495).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  resetDecisionWarnings,
  shouldWarnDecision,
} from "../lib/decision_warn_dedup.ts";

Deno.test("shouldWarnDecision - a first sighting warns and an identical repeat does not (Issue #4495)", () => {
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "sig"), true);
  assertEquals(shouldWarnDecision("k", "sig"), false);
  assertEquals(shouldWarnDecision("k", "sig"), false);
});

Deno.test("shouldWarnDecision - a changed signature warns again and is then remembered (Issue #4495)", () => {
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "orphaned"), true);
  assertEquals(shouldWarnDecision("k", "not-merged"), true);
  assertEquals(shouldWarnDecision("k", "not-merged"), false);
  // Reverting to an earlier signature is a change from the last one recorded.
  assertEquals(shouldWarnDecision("k", "orphaned"), true);
});

Deno.test("shouldWarnDecision - keys are tracked independently (Issue #4495)", () => {
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("pr-1", "sig"), true);
  assertEquals(shouldWarnDecision("pr-2", "sig"), true);
  assertEquals(shouldWarnDecision("pr-1", "sig"), false);
  assertEquals(shouldWarnDecision("pr-2", "sig"), false);
});

Deno.test("resetDecisionWarnings - clears every recorded signature (Issue #4495)", () => {
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "sig"), true);
  assertEquals(shouldWarnDecision("k", "sig"), false);
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "sig"), true);
});
