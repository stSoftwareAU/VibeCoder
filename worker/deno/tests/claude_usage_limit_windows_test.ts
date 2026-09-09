/**
 * Tests for the two usage-limit helpers `claude_runner.ts` exports for the
 * credential pool (Issue #1669, parent #1653).
 *
 * `usageLimitWaitSeconds` is the one figure both refusals report — the
 * spawned one and the pre-spawn one — so they cannot drift apart.
 * `usageLimitExhaustedWindows` decides **which** windows a refusal marks
 * spent, and that decision is what a wrong answer would strand a credential
 * on: marking a healthy week spent because the five hours ran out takes a
 * subscription out of the pool for days.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  USAGE_LIMIT_DEFAULT_WAIT_SECONDS,
  USAGE_LIMIT_MAX_WAIT_SECONDS,
  usageLimitExhaustedWindows,
  usageLimitSecondsUntilReset,
  usageLimitWaitSeconds,
} from "../lib/claude_runner.ts";
import type { ClaudeRateLimitEvent } from "../lib/claude_rate_limit_event.ts";

/** A fixed "now" — 2026-09-09T00:00:00Z. */
const NOW = Date.UTC(2026, 8, 9, 0, 0, 0);

/** One hour, in milliseconds. */
const HOUR = 3_600_000;

Deno.test("usageLimitWaitSeconds - a near reset is reported, a distant one is capped", () => {
  // Happy path: a window reopening inside the cap is waited on as stated.
  assertEquals(usageLimitWaitSeconds(NOW + 20 * 60_000, NOW), 1200);
  // Issue #333: a weekly window two days out is still re-probed hourly, so
  // an extended quota is picked up rather than slept through.
  assertEquals(
    usageLimitWaitSeconds(NOW + 48 * HOUR, NOW),
    USAGE_LIMIT_MAX_WAIT_SECONDS,
  );
  // No time in the refusal: the default hour.
  assertEquals(usageLimitWaitSeconds(null, NOW), USAGE_LIMIT_DEFAULT_WAIT_SECONDS);
  // A reset already behind us floors at a minute rather than going negative.
  assertEquals(usageLimitWaitSeconds(NOW - 10 * HOUR, NOW), 60);
});

Deno.test("usageLimitSecondsUntilReset - the operator's figure is uncapped", () => {
  // What the log tells an operator is the true wait, not the cadence.
  assertEquals(usageLimitSecondsUntilReset(NOW + 48 * HOUR, NOW), 48 * 3600);
  assertEquals(usageLimitSecondsUntilReset(NOW - HOUR, NOW), 60);
  assertEquals(
    usageLimitSecondsUntilReset(null, NOW),
    USAGE_LIMIT_DEFAULT_WAIT_SECONDS,
  );
});

/** A `rate_limit_event` with the windows a real refusal carries. */
function event(
  overrides: Partial<ClaudeRateLimitEvent> = {},
): ClaudeRateLimitEvent {
  return {
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAtEpochMs: NOW + 2 * HOUR,
    windows: [
      { window: "five_hour", remainingFraction: 0, resetAt: NOW + 2 * HOUR },
      {
        window: "seven_day",
        remainingFraction: 0.62,
        resetAt: NOW + 100 * HOUR,
      },
    ],
    ...overrides,
  };
}

Deno.test("usageLimitExhaustedWindows - only the spent windows of the event are recorded", () => {
  // The whole point: a spent five hours must not take a 62% week with it.
  assertEquals(usageLimitExhaustedWindows(event(), null, NOW), [
    { window: "five_hour", resetAt: NOW + 2 * HOUR },
  ]);
});

Deno.test("usageLimitExhaustedWindows - both windows spent are both recorded", () => {
  const both = event({
    rateLimitType: "seven_day",
    windows: [
      { window: "five_hour", remainingFraction: 0, resetAt: NOW + HOUR },
      { window: "seven_day", remainingFraction: 0, resetAt: NOW + 90 * HOUR },
    ],
  });
  assertEquals(usageLimitExhaustedWindows(both, null, NOW), [
    { window: "five_hour", resetAt: NOW + HOUR },
    { window: "seven_day", resetAt: NOW + 90 * HOUR },
  ]);
});

Deno.test("usageLimitExhaustedWindows - an event with no figures falls back to the window it rejected", () => {
  // `unifiedWindows` is optional on the event; the rejection itself still
  // names which window refused, and its own reset.
  const bare = event({ rateLimitType: "seven_day", windows: [] });
  assertEquals(usageLimitExhaustedWindows(bare, null, NOW), [
    { window: "seven_day", resetAt: NOW + 2 * HOUR },
  ]);
});

Deno.test("usageLimitExhaustedWindows - a rejection type this module does not know is not invented", () => {
  // A tokens-per-minute rejection is not a subscription window; the parsed
  // prose reset is what the record falls back to.
  const other = event({ rateLimitType: "tokens_per_minute", windows: [] });
  assertEquals(usageLimitExhaustedWindows(other, NOW + 5 * HOUR, NOW), [
    { window: "five_hour", resetAt: NOW + 5 * HOUR },
  ]);
});

Deno.test("usageLimitExhaustedWindows - prose-only refusals record the five-hour window", () => {
  // With a parsed reset, that instant; with none, the default hour ahead —
  // never an empty list, which the pool refuses as an exhaustion that
  // records nothing.
  assertEquals(usageLimitExhaustedWindows(undefined, NOW + 3 * HOUR, NOW), [
    { window: "five_hour", resetAt: NOW + 3 * HOUR },
  ]);
  assertEquals(usageLimitExhaustedWindows(undefined, null, NOW), [
    {
      window: "five_hour",
      resetAt: NOW + USAGE_LIMIT_DEFAULT_WAIT_SECONDS * 1000,
    },
  ]);
});
