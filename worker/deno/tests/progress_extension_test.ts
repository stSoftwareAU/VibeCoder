/**
 * Tests for the progress-extension policy (Issue #4296, part of #4290).
 *
 * The policy is pure — the clock is an input — so every rule is pinned here
 * with no subprocess, no repository and no timers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
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
    lastToolCallAtMs: NOW - 10_000,
    treeState: "advanced",
    extensionsGranted: 0,
    ...overrides,
  };
}

Deno.test("decideProgressExtension - both signals hold: extend one increment from now", () => {
  const decision = decideProgressExtension(input(), POLICY);
  assertEquals(decision.action, "extend");
  if (decision.action !== "extend") return;
  assertEquals(
    decision.newDeadlineMs,
    NOW + POLICY.grantSeconds * 1000,
    "the grant is measured from now, never from the original start",
  );
  assert(
    decision.reason.includes("advanced") && decision.reason.includes("tool"),
    `the reason must name both signals: ${decision.reason}`,
  );
});

Deno.test("decideProgressExtension - repeated grants each move the deadline exactly one increment", () => {
  let deadlineMs = NOW;
  for (let granted = 0; granted < 5; granted++) {
    const nowMs = NOW + granted * 60_000;
    const decision = decideProgressExtension(
      input({
        nowMs,
        deadlineMs,
        lastToolCallAtMs: nowMs - 5_000,
        extensionsGranted: granted,
      }),
      POLICY,
    );
    assertEquals(decision.action, "extend");
    if (decision.action !== "extend") return;
    assertEquals(decision.newDeadlineMs, nowMs + POLICY.grantSeconds * 1000);
    deadlineMs = decision.newDeadlineMs;
  }
});

Deno.test("decideProgressExtension - the counter never caps the grants (Issue #4290)", () => {
  const decision = decideProgressExtension(
    input({ extensionsGranted: 500 }),
    POLICY,
  );
  assertEquals(
    decision.action,
    "extend",
    "there is deliberately no ceiling while both signals hold",
  );
});

Deno.test("decideProgressExtension - activity but an unchanged tree: kill", () => {
  const decision = decideProgressExtension(
    input({ treeState: "unchanged" }),
    POLICY,
  );
  assertEquals(decision.action, "kill");
  assert(
    decision.reason.includes("unchanged"),
    `the reason must name the tree signal: ${decision.reason}`,
  );
});

Deno.test("decideProgressExtension - activity but an unknown tree probe: kill on schedule", () => {
  const decision = decideProgressExtension(
    input({ treeState: "unknown" }),
    POLICY,
  );
  assertEquals(
    decision.action,
    "kill",
    "a broken probe must not extend the run forever",
  );
  assert(decision.reason.includes("unknown"), decision.reason);
});

Deno.test("decideProgressExtension - stale tool activity with an advanced tree: kill", () => {
  const decision = decideProgressExtension(
    input({
      lastToolCallAtMs: NOW - (POLICY.activityStallSeconds + 1) * 1000,
    }),
    POLICY,
  );
  assertEquals(decision.action, "kill");
  assert(decision.reason.includes("stale"), decision.reason);
});

Deno.test("decideProgressExtension - a tool call exactly on the stall boundary still counts", () => {
  const decision = decideProgressExtension(
    input({ lastToolCallAtMs: NOW - POLICY.activityStallSeconds * 1000 }),
    POLICY,
  );
  assertEquals(decision.action, "extend");
});

Deno.test("decideProgressExtension - no tool call at all: kill", () => {
  const bare = input();
  delete bare.lastToolCallAtMs;
  const decision = decideProgressExtension(bare, POLICY);
  assertEquals(decision.action, "kill");
  assert(decision.reason.includes("no tool activity"), decision.reason);
});

Deno.test("decideProgressExtension - both signals stale: kill", () => {
  const bare = input({ treeState: "unchanged" });
  delete bare.lastToolCallAtMs;
  assertEquals(decideProgressExtension(bare, POLICY).action, "kill");
});

Deno.test("decideProgressExtension - the disabled flag short-circuits to kill", () => {
  const decision = decideProgressExtension(input(), {
    ...POLICY,
    enabled: false,
  });
  assertEquals(decision.action, "kill");
  assert(decision.reason.includes("disabled"), decision.reason);
});
