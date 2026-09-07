/**
 * The telemetry lines survive the secret redactor intact.
 *
 * Every worker log line goes through `redactSecrets` at the patched console.
 * The `secret-assignment` rule masks the value of any `key=value` whose key
 * contains TOKEN / SECRET / PASSWORD / API_KEY / …, which is correct and
 * deliberately blunt — `PASSWORD=12345` must stay masked.
 *
 * A metric named `token_blocked` collided with it, so the fleet summary was
 * published as `token_blocked=***REDACTED*** token_blocked_waits=***REDACTED***`
 * and the single number that answers "is a subscription being drained, and
 * how long did a slot wait on it?" was unreadable in every log. The metric
 * was renamed rather than the rule loosened.
 *
 * These are composition tests: they assert the *emitted* line against the
 * *real* redactor rather than checking either in isolation, because neither
 * component was wrong on its own — the formatter test passed, and the
 * redaction tests passed, while the two together destroyed the telemetry.
 * Any future metric name that trips a rule fails here.
 *
 * Australian English spelling throughout (behaviour, utilisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatFleetSummary,
  recordBlockedSeconds,
  recordClaim,
  recordOutcome,
  resetFleetTelemetry,
  startFleetCycle,
  startFleetTelemetry,
} from "../lib/fleet_telemetry.ts";
import { formatSlotUtilisation } from "../lib/slot_idle_accounting.ts";
import { redactSecrets } from "../lib/secret_redaction.ts";

/** A cycle with both block kinds non-zero, so neither value can hide. */
function blockedCycle(): string {
  resetFleetTelemetry();
  startFleetTelemetry(0);
  startFleetCycle(0);
  recordClaim();
  recordOutcome("success");
  recordBlockedSeconds("usage_blocked", 3418);
  recordBlockedSeconds("rate_limited", 600);
  return formatFleetSummary(100_000);
}

Deno.test("fleet summary - passes through the secret redactor unchanged", () => {
  const line = blockedCycle();
  assertEquals(redactSecrets(line), line, line);
});

Deno.test("fleet summary - the usage-block metrics keep their values, not just their keys", () => {
  const redacted = redactSecrets(blockedCycle());
  // The values, not just the keys: a masked value is the whole defect.
  assertStringIncludes(redacted, "usage_blocked=3418s");
  assertStringIncludes(redacted, "rate_limited=600s");
  assertEquals(redacted.includes("***REDACTED***"), false, redacted);
});

Deno.test("slot utilisation - passes through the secret redactor unchanged", () => {
  const line = formatSlotUtilisation({
    host: "GRQ-23",
    slots: 2,
    wallSeconds: 1242,
    availableSlotSeconds: 2484,
    occupiedSlotSeconds: 695,
    idleSlotSeconds: 547,
    blockedSlotSeconds: 1242,
    blockedByReason: { usage_blocked: 1242 },
    blockedStops: { usage_blocked: 4 },
    unstaffedSlotSeconds: 0,
    occupiedBySlot: { s1: 300, s2: 395 },
    idleBySlot: { s1: 270, s2: 277 },
    utilisation: 0.28,
  });
  assertEquals(redactSecrets(line), line, line);
});
