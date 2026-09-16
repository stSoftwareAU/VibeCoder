/**
 * Tests for the call-storm stall guard (Issue #2230).
 *
 * The decision is pure — the call count, the tree verdict and how long the
 * tree has stood still are all arguments — so every rule is pinned here with
 * no timer, no subprocess and no repository.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CALL_STORM_CONSECUTIVE_CHECKS,
  type CallStormPolicy,
  callStormWindowMs,
  decideCallStorm,
} from "../lib/call_storm.ts";

/** The shipped defaults: 60 calls in five minutes. */
const POLICY: CallStormPolicy = {
  enabled: true,
  windowSeconds: 300,
  callThreshold: 60,
};

const WINDOW_MS = 300_000;

Deno.test("decideCallStorm - 60 calls in five minutes with an unchanged tree is a stall naming the loop", () => {
  const verdict = decideCallStorm({
    toolCalls: 60,
    treeState: "unchanged",
    treeUnchangedForMs: WINDOW_MS,
    lastToolSummary: "Bash echo w252",
  }, POLICY);

  assert(verdict.stalled, "a call storm must be stalled");
  if (!verdict.stalled) return;
  assert(
    verdict.reason.includes("call storm"),
    `the reason must name the storm: ${verdict.reason}`,
  );
  assert(
    verdict.reason.includes("60 calls in 5m"),
    `the reason must name the rate: ${verdict.reason}`,
  );
  assert(
    verdict.reason.includes("tree unchanged"),
    `the reason must name the unchanged tree: ${verdict.reason}`,
  );
  assert(
    verdict.reason.includes("Bash echo w252"),
    `the reason must name the loop's last call: ${verdict.reason}`,
  );
});

Deno.test("decideCallStorm - 60 calls with a working-tree change is not a stall", () => {
  assertEquals(
    decideCallStorm({
      toolCalls: 60,
      treeState: "advanced",
      // The tree advanced at the last check, so it has not stood still for a
      // window — a busy agent that is actually changing files.
      treeUnchangedForMs: 0,
      lastToolSummary: "Edit worker/deno/lib/x.ts",
    }, POLICY),
    { stalled: false },
  );
});

Deno.test("decideCallStorm - a tree that advanced inside the window is not a stall even when read as unchanged", () => {
  // The freshest probe says unchanged, but the tree moved two minutes ago:
  // the window has not been observed whole, so there is nothing to judge.
  assertEquals(
    decideCallStorm({
      toolCalls: 200,
      treeState: "unchanged",
      treeUnchangedForMs: 120_000,
    }, POLICY),
    { stalled: false },
  );
});

Deno.test("decideCallStorm - 10 calls in five minutes is not a stall", () => {
  assertEquals(
    decideCallStorm({
      toolCalls: 10,
      treeState: "unchanged",
      treeUnchangedForMs: WINDOW_MS,
      lastToolSummary: "Read lib/x.ts",
    }, POLICY),
    { stalled: false },
  );
});

Deno.test("decideCallStorm - an unverifiable tree never stops a run early", () => {
  // The opposite fail-safe direction to the extension policy, deliberately:
  // this guard kills inside the budget, so a probe that cannot answer is not
  // enough. The deadline check still owns `unknown` (Issue #4294).
  assertEquals(
    decideCallStorm({
      toolCalls: 600,
      treeState: "unknown",
      treeUnchangedForMs: WINDOW_MS * 4,
    }, POLICY),
    { stalled: false },
  );
});

Deno.test("decideCallStorm - the guard is silent when disabled or unconfigured", () => {
  const storming = {
    toolCalls: 600,
    treeState: "unchanged" as const,
    treeUnchangedForMs: WINDOW_MS * 4,
  };
  assertEquals(
    decideCallStorm(storming, { ...POLICY, enabled: false }),
    { stalled: false },
    "disabled restores the pre-#2230 behaviour",
  );
  assertEquals(
    decideCallStorm(storming, { ...POLICY, callThreshold: 0 }),
    { stalled: false },
    "a non-positive threshold would stop every run",
  );
  assertEquals(
    decideCallStorm(storming, { ...POLICY, windowSeconds: 0 }),
    { stalled: false },
    "a non-positive window has no rate to measure",
  );
});

Deno.test("decideCallStorm - the threshold is inclusive and one call below it is not a stall", () => {
  assert(
    decideCallStorm({
      toolCalls: 60,
      treeState: "unchanged",
      treeUnchangedForMs: WINDOW_MS,
    }, POLICY).stalled,
  );
  assertEquals(
    decideCallStorm({
      toolCalls: 59,
      treeState: "unchanged",
      treeUnchangedForMs: WINDOW_MS,
    }, POLICY),
    { stalled: false },
  );
});

Deno.test("callStormWindowMs - reports the window, and zero when the guard is off", () => {
  assertEquals(callStormWindowMs(POLICY), WINDOW_MS);
  assertEquals(callStormWindowMs({ ...POLICY, enabled: false }), 0);
  assertEquals(callStormWindowMs({ ...POLICY, windowSeconds: -1 }), 0);
});

Deno.test("decideCallStorm - a sub-minute window reads in seconds", () => {
  const verdict = decideCallStorm({
    toolCalls: 5,
    treeState: "unchanged",
    treeUnchangedForMs: 45_000,
  }, { enabled: true, windowSeconds: 45, callThreshold: 5 });
  assert(verdict.stalled);
  if (!verdict.stalled) return;
  assert(
    verdict.reason.includes("5 calls in 45s"),
    `the window must read in seconds: ${verdict.reason}`,
  );
});

Deno.test("decideCallStorm - a mixed window reads as minutes and seconds", () => {
  const verdict = decideCallStorm({
    toolCalls: 70,
    treeState: "unchanged",
    treeUnchangedForMs: 330_000,
  }, { enabled: true, windowSeconds: 330, callThreshold: 60 });
  assert(verdict.stalled);
  if (!verdict.stalled) return;
  assert(
    verdict.reason.includes("70 calls in 5m30s"),
    `a window of minutes and seconds must read as both: ${verdict.reason}`,
  );
});

Deno.test("decideCallStorm - one window is a warning, so a storm needs more than one check", () => {
  // The read-heavy shape the shipped defaults could otherwise stop: sixty
  // Read/Grep calls in the first five minutes of a run, before the first
  // edit. The window verdict is a storm — that is what this function
  // answers — but the runner requires CALL_STORM_CONSECUTIVE_CHECKS of them
  // in a row, so ten minutes of it, not five, is what stops a run.
  const exploration = decideCallStorm({
    toolCalls: 60,
    treeState: "unchanged",
    treeUnchangedForMs: WINDOW_MS,
    lastToolSummary: "Read worker/deno/lib/claude_runner.ts",
  }, POLICY);
  assert(exploration.stalled, "the window itself reads as a storm");
  assert(
    CALL_STORM_CONSECUTIVE_CHECKS >= 2,
    "one window must never be enough to stop a run",
  );
});
