/**
 * Tests for the deadline-aware timeout rule (Issue #4254, proposal 1).
 *
 * Issue work no longer applies it — a claim keeps its full budget (Issue
 * #420) — but an idle-task **scan** still does (Issue #186), so the rule and
 * its only caller are covered together below: a tidy-up that deletes
 * `resolveExecuteTimeoutSeconds` as "dead" must break the build rather than
 * silently unbound every scan.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildFailureMessage } from "../lib/execute_claude_phase.ts";
import {
  buildExtensionTelemetry,
  buildTimeoutFailureReason,
} from "../lib/timeout_extension_telemetry.ts";
import {
  EXECUTE_TIMEOUT_FLOOR_SECONDS,
  resolveExecuteTimeoutSeconds,
} from "../lib/execute_timeout.ts";
import {
  IDLE_TASK_TIMEOUT_SECONDS,
  resolveIdleTaskBudget,
  withIdleTaskRunContext,
} from "../lib/idle_task_claude_budget.ts";

const NOW = 1_000_000_000_000;

Deno.test("execute timeout - no deadline leaves the configured timeout (Issue #4254)", () => {
  const r = resolveExecuteTimeoutSeconds(3600, 30, undefined, NOW);
  assertEquals(r.timeoutSeconds, 3600);
  assertEquals(r.deadlineBound, false);
});

Deno.test("execute timeout - a distant deadline leaves the configured timeout (Issue #4254)", () => {
  // Deadline two hours away — more than the 3600s budget, so the budget binds.
  const r = resolveExecuteTimeoutSeconds(3600, 30, NOW + 7200_000, NOW);
  assertEquals(r.timeoutSeconds, 3600);
  assertEquals(r.deadlineBound, false);
});

Deno.test("execute timeout - a near deadline binds the timeout (Issue #4254)", () => {
  // Deadline 600s away; +30s grace → 630s, well under the 3600s budget.
  const r = resolveExecuteTimeoutSeconds(3600, 30, NOW + 600_000, NOW);
  assertEquals(r.timeoutSeconds, 630);
  assertEquals(r.deadlineBound, true);
});

Deno.test("execute timeout - never drops below the floor (Issue #4254)", () => {
  // Deadline already passed — bound would be negative, floored instead.
  const r = resolveExecuteTimeoutSeconds(3600, 30, NOW - 10_000, NOW);
  assertEquals(r.timeoutSeconds, EXECUTE_TIMEOUT_FLOOR_SECONDS);
  assertEquals(r.deadlineBound, true);
});

Deno.test("execute timeout - the kill grace extends the deadline slightly (Issue #4254)", () => {
  // Deadline exactly now; the grace alone (30s) is below the floor, so floored.
  const r = resolveExecuteTimeoutSeconds(3600, 30, NOW, NOW);
  assertEquals(r.timeoutSeconds, EXECUTE_TIMEOUT_FLOOR_SECONDS);
});

// ---------------------------------------------------------------------------
// The surviving caller: an idle-task scan is still bounded (Issues #186, #420)
// ---------------------------------------------------------------------------

Deno.test("execute timeout - an idle-task scan is still bounded to its cycle runway (Issues #186, #420)", async () => {
  // Sixteen minutes of runway — the very shape that no longer truncates an
  // issue claim. A scan holds no WIP and is discretionary, so it stays bound.
  await withIdleTaskRunContext({ cycleDeadlineEpochMs: NOW + 960_000 }, () => {
    const budget = resolveIdleTaskBudget({ prompt: "scan" }, NOW);
    assertEquals(budget.deadlineBound, true);
    assert(
      (budget.options.timeoutSeconds ?? 0) < IDLE_TASK_TIMEOUT_SECONDS,
      `the scan must not outlive the cycle: ${budget.options.timeoutSeconds}s`,
    );
    return Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// Issue-facing failure text after a re-armable-deadline run (Issue #4298)
// ---------------------------------------------------------------------------

/** Telemetry for a four-extension run of a 3600 s budget. */
const EXTENDED_RUN = buildExtensionTelemetry({
  baseTimeoutSeconds: 3600,
  startMs: 0,
  deadlineMs: 5_640_000,
  nowMs: 5_640_000,
  granted: 4,
  refusalReason: "working tree unchanged despite tool activity 31s ago",
});

Deno.test("execute timeout - the issue-facing failure message names the extensions, the elapsed time and the stall (Issue #4298)", () => {
  const message = buildFailureMessage({
    failureType: "timeout",
    failureReason: buildTimeoutFailureReason(3600, EXTENDED_RUN),
    failureOutput: "partial work",
    timeoutFailureSummary: "",
    diagnosticContent: "",
  });

  assertStringIncludes(message, "Claude timed out after 5640 seconds");
  assertStringIncludes(message, "extended 4× by 2040s");
  assertStringIncludes(
    message,
    "last extension refused: working tree unchanged despite tool activity 31s ago",
  );
  assertEquals(message.includes("timed out after 3600 seconds"), false);
});

Deno.test("execute timeout - with the feature disabled the failure message is byte-identical to today's (Issue #4298)", () => {
  const legacy = buildFailureMessage({
    failureType: "timeout",
    failureReason: "timed out after 3600 seconds (60 minutes)",
    failureOutput: "partial work",
    timeoutFailureSummary: "",
    diagnosticContent: "",
  });
  const built = buildFailureMessage({
    failureType: "timeout",
    failureReason: buildTimeoutFailureReason(3600),
    failureOutput: "partial work",
    timeoutFailureSummary: "",
    diagnosticContent: "",
  });

  assertEquals(built, legacy);
});
