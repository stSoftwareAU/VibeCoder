/**
 * How a stopped call storm is reported (Issue #2230).
 *
 * The guard ends the agent with the same SIGTERM the other watchdogs use, so
 * two things have to hold for the run to be diagnosed honestly:
 *
 * - `watchdogFiredIn` must recognise `Watchdog: call-storm`, or the SIGTERM in
 *   the diagnostics reads as an *external* kill — infrastructure — and the
 *   run is retried in process (VibeCoder#174's exact failure mode);
 * - the failure reason must say the run was stopped as stalled and name the
 *   loop, rather than claim a timeout the run never reached, while still
 *   classifying as a timeout: a stalled agent is the issue's to answer for,
 *   not the host's.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  detectFailureCategory,
  isInfrastructureFailure,
  isTimeoutClassFailureReason,
  watchdogFiredIn,
} from "../lib/failure_diagnosis.ts";
import { formatDetailedFailureMessage } from "../lib/failure_message.ts";

/** What the execute phase builds for a stopped call storm. */
const CALL_STORM_REASON = formatDetailedFailureMessage(
  "Claude was stopped as stalled before its timeout — call storm: 372 calls " +
    "in 5m, tree unchanged; last: Bash echo w252",
  {
    elapsedSeconds: 900,
    timedOut: true,
    outputSize: 4_200,
    timeoutSeconds: 3600,
    timeoutReason: "call-storm",
    rawExitCode: 143,
  },
);

Deno.test("call storm reporting - the guard's own watchdog line is recognised (Issue #2230)", () => {
  assert(
    CALL_STORM_REASON.includes("Watchdog: call-storm"),
    `the diagnostics must name the guard: ${CALL_STORM_REASON}`,
  );
  assertEquals(
    watchdogFiredIn(CALL_STORM_REASON),
    true,
    "the worker stopped this run, so the SIGTERM is its own doing",
  );
});

Deno.test("call storm reporting - a stopped storm is a timeout, never an external kill (Issue #2230)", () => {
  assertEquals(
    detectFailureCategory(CALL_STORM_REASON),
    "timeout",
    "a stalled agent is the issue's to answer for",
  );
  assertEquals(
    isInfrastructureFailure(detectFailureCategory(CALL_STORM_REASON)),
    false,
    "a polling loop is not a transient host fault and must not be retried",
  );
  assertEquals(isTimeoutClassFailureReason(CALL_STORM_REASON), true);
});

Deno.test("call storm reporting - the reason names the loop and does not claim a timeout (Issue #2230)", () => {
  assert(
    CALL_STORM_REASON.startsWith("Claude was stopped as stalled"),
    `the reason must say what happened: ${CALL_STORM_REASON}`,
  );
  assert(
    CALL_STORM_REASON.includes("call storm: 372 calls in 5m"),
    "the rate must survive into the issue comment",
  );
  assert(
    CALL_STORM_REASON.includes("echo w252"),
    "the loop's last call must survive into the issue comment",
  );
  assert(
    !CALL_STORM_REASON.includes("Claude timed out"),
    "the run was stopped inside its budget, so it did not time out",
  );
});
