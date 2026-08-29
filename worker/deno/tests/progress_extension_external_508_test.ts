/**
 * Tests for external progress in the extension policy (Issue #508).
 *
 * The gate used to turn entirely on the working tree, so an agent supervising
 * a long-running job — tool calls every few seconds, nothing changing in the
 * checkout — was killed at the base budget mid-flight. External progress (a
 * descendant process burning CPU) is now a signal of its own, and these tests
 * pin exactly how far it goes: it rescues an unchanged tree, and nothing
 * else.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  combineExternalEvidence,
  decideProgressExtension,
  type ProgressExtensionInput,
  type ProgressExtensionPolicy,
} from "../lib/progress_extension.ts";

const POLICY: ProgressExtensionPolicy = {
  enabled: true,
  grantSeconds: 900,
  activityStallSeconds: 300,
};

const NOW = 1_000_000;
const START = NOW - 3_600_000;

function input(
  overrides: Partial<ProgressExtensionInput> = {},
): ProgressExtensionInput {
  return {
    nowMs: NOW,
    startMs: START,
    deadlineMs: NOW,
    lastToolCallAtMs: NOW - 26_000,
    treeState: "unchanged",
    extensionsGranted: 0,
    ...overrides,
  };
}

Deno.test("decideProgressExtension - a descendant burning CPU earns an extension despite an unchanged tree (Issue #508)", () => {
  const decision = decideProgressExtension(
    input({ externalState: "active" }),
    POLICY,
  );
  assertEquals(
    decision.action,
    "extend",
    "supervising a live job is progress, not a stall",
  );
  if (decision.action !== "extend") return;
  assertEquals(decision.newDeadlineMs, NOW + POLICY.grantSeconds * 1000);
  assert(
    decision.reason.includes("descendant"),
    `the reason must name the signal that decided it: ${decision.reason}`,
  );
});

Deno.test("decideProgressExtension - tool calls with no tree delta and no live descendant are still refused (Issue #508)", () => {
  const decision = decideProgressExtension(
    input({ externalState: "idle" }),
    POLICY,
  );
  assertEquals(decision.action, "kill", "a spinning agent still dies");
  assert(
    decision.reason.includes("unchanged") &&
      decision.reason.includes("descendant"),
    `the reason must name both refused signals: ${decision.reason}`,
  );
});

Deno.test("decideProgressExtension - an unevaluable external probe never earns an extension (Issue #508)", () => {
  const decision = decideProgressExtension(
    input({ externalState: "unknown" }),
    POLICY,
  );
  assertEquals(
    decision.action,
    "kill",
    "being unmeasurable must not become a way to buy time",
  );
});

Deno.test("decideProgressExtension - an unknown tree probe still kills even with a live descendant (Issue #4294)", () => {
  const decision = decideProgressExtension(
    input({ treeState: "unknown", externalState: "active" }),
    POLICY,
  );
  assertEquals(
    decision.action,
    "kill",
    "a probe that cannot answer keeps the fail-safe direction",
  );
  assert(decision.reason.includes("unknown"), decision.reason);
});

Deno.test("decideProgressExtension - stale tool activity is refused however busy the descendants are (Issue #399)", () => {
  const decision = decideProgressExtension(
    input({
      lastToolCallAtMs: NOW - (POLICY.activityStallSeconds + 1) * 1000,
      externalState: "active",
    }),
    POLICY,
  );
  assertEquals(decision.action, "kill");
  assert(decision.reason.includes("stale"), decision.reason);
});

Deno.test("decideProgressExtension - with no external probe wired the legacy refusal is unchanged (Issue #4296)", () => {
  const decision = decideProgressExtension(input(), POLICY);
  assertEquals(decision.action, "kill");
  assertEquals(
    decision.reason,
    "working tree unchanged despite tool activity 26s ago",
  );
});

Deno.test("decideProgressExtension - an external grant is still bounded by the run hard cap (Issue #421)", () => {
  const noRunway = decideProgressExtension(
    input({ externalState: "active", ceilingMs: NOW }),
    POLICY,
  );
  assertEquals(noRunway.action, "kill");
  if (noRunway.action !== "kill") return;
  assertEquals(noRunway.cause, "hard-cap");

  const clamped = decideProgressExtension(
    input({ externalState: "active", ceilingMs: NOW + 200_000 }),
    POLICY,
  );
  assertEquals(clamped.action, "extend");
  if (clamped.action !== "extend") return;
  assertEquals(
    clamped.newDeadlineMs,
    NOW + 200_000,
    "the grant is clamped to the ceiling, never past it",
  );
});

Deno.test("combineExternalEvidence - a fresh reading always wins when it is active", () => {
  assertEquals(
    combineExternalEvidence("active", { outcome: "idle", ageMs: 0 }, {
      ...POLICY,
      checkSeconds: 300,
    }),
    "active",
  );
});

Deno.test("combineExternalEvidence - an interim active sample carries for one check interval", () => {
  const policy = { ...POLICY, checkSeconds: 300 };
  assertEquals(
    combineExternalEvidence(
      "idle",
      { outcome: "active", ageMs: 10_000 },
      policy,
    ),
    "active",
    "a deadline landing moments after a check must not shrink the window to nothing",
  );
  assertEquals(
    combineExternalEvidence(
      "idle",
      { outcome: "active", ageMs: 300_001 },
      policy,
    ),
    "idle",
    "evidence older than one interval is spent",
  );
});

Deno.test("combineExternalEvidence - an unknown reading is never overridden by a sample", () => {
  assertEquals(
    combineExternalEvidence("unknown", { outcome: "active", ageMs: 0 }, {
      ...POLICY,
      checkSeconds: 300,
    }),
    "unknown",
  );
});

Deno.test("combineExternalEvidence - without interim sampling the fresh reading stands alone", () => {
  assertEquals(
    combineExternalEvidence("idle", { outcome: "active", ageMs: 1 }, POLICY),
    "idle",
  );
  assertEquals(combineExternalEvidence("active", undefined, POLICY), "active");
});
