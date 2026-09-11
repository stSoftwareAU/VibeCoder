/**
 * Recognising GitHub's secondary (content-creation) rate limit, and planning
 * the minute-scale wait it needs (Issue #1951).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  isSecondaryOnlyRateLimitMessage,
  isSecondaryRateLimitMessage,
  MAX_RETRY_AFTER_SECONDS,
  parseRetryAfterSeconds,
  planSecondaryLimitWait,
  SECONDARY_RATE_LIMIT_DELAYS_MS,
} from "../lib/secondary_rate_limit.ts";
import { isPrimaryRateLimitMessage } from "../lib/primary_quota_latch.ts";

Deno.test("secondary limit - recognises GitHub's content-creation refusals", () => {
  const refusals = [
    "HTTP 403: You have exceeded a secondary rate limit and have been " +
    "temporarily blocked from content creation.",
    "You have triggered an abuse detection mechanism.",
    "gh command skipped: GitHub secondary rate limit cool-down (API rate " +
    "limit already exceeded on a burst, hourly quota still available)",
    "Your request was submitted too quickly, please wait a moment.",
  ];
  for (const refusal of refusals) {
    assertEquals(isSecondaryRateLimitMessage(refusal), true, refusal);
  }
});

Deno.test("secondary limit - the primary quota is NOT a secondary limit", () => {
  // The primary quota has a REST way round it; this one does not, so the two
  // must never be confused.
  const primary = [
    "GraphQL: API rate limit already exceeded for user ID 23146043.",
    "API rate limit exceeded for 10.0.0.1",
    "gh command skipped: GraphQL primary quota exhausted (API rate limit " +
    "already exceeded) — reset at 11:35Z",
    "HTTP 500: server error",
    "",
  ];
  for (const message of primary) {
    assertEquals(isSecondaryRateLimitMessage(message), false, message);
  }
});

Deno.test("secondary limit - Retry-After is read, clamped and validated", () => {
  assertEquals(parseRetryAfterSeconds("Retry-After: 90"), 90);
  assertEquals(parseRetryAfterSeconds("retry-after 45\nHTTP 403"), 45);
  assertEquals(parseRetryAfterSeconds("retry after=120"), 120);
  assertEquals(
    parseRetryAfterSeconds("Retry-After: 99999"),
    MAX_RETRY_AFTER_SECONDS,
  );
  assertEquals(parseRetryAfterSeconds("Retry-After: 0"), null);
  assertEquals(parseRetryAfterSeconds("no header here"), null);
});

Deno.test("secondary limit - the default schedule steps in minutes", () => {
  const now = 1_000_000;
  const steps = SECONDARY_RATE_LIMIT_DELAYS_MS.map((_, index) =>
    planSecondaryLimitWait({
      attempt: index + 1,
      message: "secondary rate limit",
      nowMs: now,
    })
  );
  assertEquals(
    steps.map((s) => (s.wait ? s.delayMs : -1)),
    [60_000, 120_000, 240_000],
  );
  assertEquals(steps.every((s) => s.wait && s.source === "backoff"), true);
});

Deno.test("secondary limit - Retry-After overrides the schedule step", () => {
  const plan = planSecondaryLimitWait({
    attempt: 1,
    message: "secondary rate limit. Retry-After: 150",
    nowMs: 0,
  });
  assertEquals(plan.wait && plan.delayMs, 150_000);
  assertEquals(plan.wait && plan.source, "retry-after");
});

Deno.test("secondary limit - the coordinated floor can only lengthen a wait", () => {
  const longer = planSecondaryLimitWait({
    attempt: 1,
    message: "secondary rate limit",
    nowMs: 0,
    coordinatedFloorMs: 300_000,
  });
  assertEquals(longer.wait && longer.delayMs, 300_000);

  const shorter = planSecondaryLimitWait({
    attempt: 1,
    message: "secondary rate limit",
    nowMs: 0,
    coordinatedFloorMs: 5_000,
  });
  assertEquals(shorter.wait && shorter.delayMs, 60_000);
});

Deno.test("secondary limit - a wait that would outlast the run is refused", () => {
  const now = 5_000_000;
  const plan = planSecondaryLimitWait({
    attempt: 1,
    message: "secondary rate limit",
    nowMs: now,
    // 70s of runway cannot hold a 60s wait plus the post-create work.
    deadlineMs: now + 70_000,
  });
  assertEquals(plan.wait, false);
  assertEquals(
    plan.wait === false && plan.why.includes("does not fit"),
    true,
    plan.wait === false ? plan.why : "waited",
  );
});

Deno.test("secondary limit - a wait that fits inside the run is allowed", () => {
  const now = 5_000_000;
  const plan = planSecondaryLimitWait({
    attempt: 1,
    message: "secondary rate limit",
    nowMs: now,
    deadlineMs: now + 600_000,
  });
  assertEquals(plan.wait && plan.delayMs, 60_000);
});

Deno.test("secondary limit - the schedule is exhausted after its last step", () => {
  const plan = planSecondaryLimitWait({
    attempt: SECONDARY_RATE_LIMIT_DELAYS_MS.length + 1,
    message: "secondary rate limit",
    nowMs: 0,
  });
  assertEquals(plan.wait, false);
  assertEquals(
    plan.wait === false && plan.why.includes("exhausted"),
    true,
    plan.wait === false ? plan.why : "waited",
  );
});

Deno.test("secondary limit - the latch's own cool-down is left to the primary path (Issue #1951)", () => {
  // `primaryQuotaSkipMessage()` names both limits. It has a REST answer
  // already, so the minute-scale wait must stand aside for it.
  const latched =
    "gh command skipped: GitHub secondary rate limit cool-down (API rate " +
    "limit already exceeded on a burst, hourly quota still available)";
  assertEquals(isSecondaryRateLimitMessage(latched), true);
  assertEquals(
    isSecondaryOnlyRateLimitMessage(latched, isPrimaryRateLimitMessage),
    false,
  );

  const pure = "You have exceeded a secondary rate limit.";
  assertEquals(
    isSecondaryOnlyRateLimitMessage(pure, isPrimaryRateLimitMessage),
    true,
  );
});
