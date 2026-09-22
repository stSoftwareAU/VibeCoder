/**
 * Tests for the GraphQL budget pacing decision (Issue #2447). Each acceptance
 * scenario is one pure `computePacedSleepSeconds` call. Australian English.
 */

import { assert, assertEquals } from "@std/assert";
import {
  BUDGET_RESERVE_FRACTION,
  computePacedSleepSeconds,
  MAX_PACED_SLEEP_SECONDS,
  type PacedSleepInput,
} from "../lib/budget_pacing.ts";

const LIMIT = 5000;
const RESERVE = LIMIT * BUDGET_RESERVE_FRACTION; // 1000
const NOW = 1_800_000_000;

function input(overrides: Partial<PacedSleepInput>): PacedSleepInput {
  return {
    limit: LIMIT,
    remaining: 4000,
    reset: NOW + 3600,
    nowSeconds: NOW,
    spentLastCycle: 100,
    cycleSeconds: 120,
    baseSleepSeconds: 120,
    ...overrides,
  };
}

Deno.test("plenty of budget returns the base sleep", () => {
  const result = computePacedSleepSeconds(input({
    remaining: 4000,
    spentLastCycle: 100,
  }));
  assertEquals(result.sleepSeconds, 120);
  assertEquals(result.inReserve, false);
  assertEquals(result.reason, "spend fits the remaining budget");
});

Deno.test("overspend stretches the sleep proportionally", () => {
  // remaining 1500, 40 min to reset, spent 270 — the acceptance example.
  const result = computePacedSleepSeconds(input({
    remaining: 1500,
    reset: NOW + 2400,
    spentLastCycle: 270,
    cycleSeconds: 120,
    baseSleepSeconds: 30,
  }));
  // cyclesLeft = 2400 / 150 = 16; affordable = 500 / 16 = 31.25;
  // stretched = 30 * (270 / 31.25) = 259.2.
  assertEquals(Math.round(result.sleepSeconds * 10) / 10, 259.2);
  assert(result.sleepSeconds > 30);
  assertEquals(result.inReserve, false);
});

Deno.test("the paced sleep never exceeds the cap", () => {
  const result = computePacedSleepSeconds(input({
    remaining: 2000,
    spentLastCycle: 10_000,
  }));
  assertEquals(result.sleepSeconds, MAX_PACED_SLEEP_SECONDS);
});

Deno.test("reaching the reserve flags inReserve and paces to the cap", () => {
  const result = computePacedSleepSeconds(input({
    remaining: RESERVE,
    spentLastCycle: 100,
  }));
  assertEquals(result.inReserve, true);
  assertEquals(result.sleepSeconds, MAX_PACED_SLEEP_SECONDS);
});

Deno.test("a window about to reset floors cyclesLeftInWindow at 1", () => {
  // 10 s to reset against a 240 s cycle would be a fraction of a cycle; the
  // floor makes it one, so affordable is the full post-reserve budget.
  const result = computePacedSleepSeconds(input({
    remaining: 1100,
    reset: NOW + 10,
    spentLastCycle: 200,
  }));
  // affordable = (1100 - 1000) / 1 = 100; stretched = 120 * 2 = 240.
  assertEquals(result.sleepSeconds, 240);
});

Deno.test("spentLastCycle of 0 keeps the base sleep", () => {
  const result = computePacedSleepSeconds(input({
    remaining: 1500,
    spentLastCycle: 0,
  }));
  assertEquals(result.sleepSeconds, 120);
});

Deno.test("a past reset clamps to one cycle instead of misbehaving", () => {
  const result = computePacedSleepSeconds(input({
    remaining: 1100,
    reset: NOW - 100,
    spentLastCycle: 200,
  }));
  assertEquals(result.sleepSeconds, 240);
  assertEquals(result.inReserve, false);
});

Deno.test("never returns less than the base sleep", () => {
  const result = computePacedSleepSeconds(input({
    remaining: 1500,
    spentLastCycle: 1_000_000,
  }));
  assert(result.sleepSeconds >= 120);
});

Deno.test("a base sleep of zero inside the reserve paces to the cap, not NaN", () => {
  // `0 × Infinity` is NaN, and a NaN sleep would reach `deps.sleep()`; with
  // nothing affordable the stretch goes straight to the cap instead.
  const result = computePacedSleepSeconds(input({
    remaining: 500,
    spentLastCycle: 200,
    baseSleepSeconds: 0,
  }));
  assert(
    Number.isFinite(result.sleepSeconds),
    "the paced sleep must be finite",
  );
  assertEquals(result.sleepSeconds, MAX_PACED_SLEEP_SECONDS);
  assertEquals(result.inReserve, true);
});

Deno.test("a base sleep of zero stays zero", () => {
  const result = computePacedSleepSeconds(input({
    remaining: 4000,
    spentLastCycle: 100,
    baseSleepSeconds: 0,
  }));
  assertEquals(result.sleepSeconds, 0);
});
