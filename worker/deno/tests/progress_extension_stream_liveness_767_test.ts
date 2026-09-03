/**
 * Tests for the stream-liveness half of the progress-extension gate
 * (Issue #767, part of #764).
 *
 * The refusal that killed the #732 claim, from `~/logs`:
 *
 *   [progress-extension] not extending after 3600s (extensions granted 0):
 *   tool activity stale (last tool call 483s ago, window 300s)
 *
 * and one minute earlier, from the same run:
 *
 *   [agent-progress] issue: 58m57s elapsed · 287 tool calls
 *   (last: TaskOutput, 7m0s ago)
 *
 * The agent was inside one long tool call — `TaskOutput`, polling a background
 * task it had started — so no *new* `tool_use` event appeared for eight
 * minutes while stdout chunks kept arriving every minute. The gate read that
 * as a stall and killed a run that was demonstrably alive.
 *
 * These tests pin the corrected rule: the liveness question is "is the agent
 * still producing anything?", answered by the fresher of the tool-call and
 * stream clocks, while the *progress* question is unchanged — the tree must
 * have advanced or a descendant must be doing work, and `unknown` never
 * counts.
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

const NOW = 1_000_000_000;
const START = NOW - 3_600_000;

/** The #732 shape: the last `tool_use` was 483 s ago, well past the window. */
const STALE_TOOL_CALL_MS = NOW - 483_000;

function input(
  overrides: Partial<ProgressExtensionInput> = {},
): ProgressExtensionInput {
  return {
    nowMs: NOW,
    startMs: START,
    deadlineMs: NOW,
    lastToolCallAtMs: STALE_TOOL_CALL_MS,
    // Chunks were still arriving while the agent waited on its long tool call.
    lastChunkAtMs: NOW - 4_000,
    treeState: "advanced",
    externalState: "idle",
    extensionsGranted: 0,
    ...overrides,
  };
}

Deno.test("decideProgressExtension - #732: a long tool call still streaming with an advancing tree extends", () => {
  const decision = decideProgressExtension(input(), POLICY);
  assertEquals(
    decision.action,
    "extend",
    "an agent streaming inside one long tool call is alive, not stalled",
  );
  if (decision.action !== "extend") return;
  assertEquals(decision.newDeadlineMs, NOW + POLICY.grantSeconds * 1000);
  assert(
    decision.reason.includes("agent output 4s ago"),
    `the reason must name the signal that decided it: ${decision.reason}`,
  );
  assert(
    decision.reason.includes("483s"),
    `the reason must still report the stale tool clock: ${decision.reason}`,
  );
});

Deno.test("decideProgressExtension - #732: a long tool call still streaming with descendant CPU extends", () => {
  const decision = decideProgressExtension(
    input({ treeState: "unchanged", externalState: "active" }),
    POLICY,
  );
  assertEquals(decision.action, "extend");
});

Deno.test("decideProgressExtension - stream liveness alone never earns an extension", () => {
  const decision = decideProgressExtension(
    input({ treeState: "unchanged", externalState: "idle" }),
    POLICY,
  );
  assertEquals(
    decision.action,
    "kill",
    "a chatty agent that changes nothing anywhere is still a stall",
  );
  assert(decision.reason.includes("unchanged"), decision.reason);
});

Deno.test("decideProgressExtension - a genuinely stalled run is still killed at its deadline", () => {
  const decision = decideProgressExtension(
    input({
      lastChunkAtMs: NOW - 483_000,
      treeState: "unchanged",
      externalState: "idle",
    }),
    POLICY,
  );
  assertEquals(decision.action, "kill");
  assert(
    decision.reason.includes("stale") &&
      decision.reason.includes("last agent output 483s ago"),
    `both clocks must be named once both are stale: ${decision.reason}`,
  );
});

Deno.test("decideProgressExtension - silence past the window kills even with an advancing tree", () => {
  const decision = decideProgressExtension(
    input({ lastChunkAtMs: NOW - 400_000 }),
    POLICY,
  );
  assertEquals(
    decision.action,
    "kill",
    "an agent producing nothing at all is not alive, whatever the tree says",
  );
});

Deno.test("decideProgressExtension - a fresh stream never rescues an unknown tree probe", () => {
  const decision = decideProgressExtension(
    input({ treeState: "unknown" }),
    POLICY,
  );
  assertEquals(decision.action, "kill");
  assert(decision.reason.includes("unknown"), decision.reason);
});

Deno.test("decideProgressExtension - a fresh stream never rescues an unknown descendant probe", () => {
  const decision = decideProgressExtension(
    input({ treeState: "unchanged", externalState: "unknown" }),
    POLICY,
  );
  assertEquals(
    decision.action,
    "kill",
    "an unmeasured probe must never become a way to buy time",
  );
});

Deno.test("decideProgressExtension - a stream clock is never counted as a tool call", () => {
  const bare = input();
  delete bare.lastToolCallAtMs;
  const decision = decideProgressExtension(bare, POLICY);
  assertEquals(
    decision.action,
    "kill",
    "a run that never called a single tool has not started working",
  );
  assert(decision.reason.includes("no tool activity"), decision.reason);
});

Deno.test("decideProgressExtension - the stream clock on the stall boundary still counts", () => {
  const decision = decideProgressExtension(
    input({ lastChunkAtMs: NOW - POLICY.activityStallSeconds * 1000 }),
    POLICY,
  );
  assertEquals(decision.action, "extend");
});
