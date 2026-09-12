/**
 * The minute-scale retry around `gh pr create` for GitHub's secondary
 * (content-creation) rate limit (Issue #1951).
 *
 * Sleeps are injected, so the suite measures the schedule rather than waiting
 * it out.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { createPrWithSecondaryLimitBackoff } from "../lib/pr_creation_retry.ts";

const SECONDARY =
  "HTTP 403: You have exceeded a secondary rate limit and have been " +
  "temporarily blocked from content creation.";

/** A clock that advances by exactly what the loop sleeps. */
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  const slept: number[] = [];
  return {
    slept,
    nowMs: () => nowMs,
    sleepFn: (ms: number) => {
      slept.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
  };
}

Deno.test("pr creation - a secondary-limit refusal is retried in minutes, not seconds", async () => {
  const clock = fakeClock();
  let calls = 0;
  const attempt = await createPrWithSecondaryLimitBackoff({
    createPr: () => {
      calls++;
      if (calls < 3) return Promise.reject(new Error(SECONDARY));
      return Promise.resolve("https://github.com/o/r/pull/7\n");
    },
    sleepFn: clock.sleepFn,
    nowMs: clock.nowMs,
  });

  assertEquals(attempt.kind, "created");
  assertEquals(
    attempt.kind === "created" ? attempt.prUrl : "",
    "https://github.com/o/r/pull/7",
  );
  assertEquals(clock.slept, [60_000, 120_000]);
});

Deno.test("pr creation - Retry-After is honoured over the default step", async () => {
  const clock = fakeClock();
  let calls = 0;
  await createPrWithSecondaryLimitBackoff({
    createPr: () => {
      calls++;
      if (calls === 1) {
        return Promise.reject(
          new Error(`${SECONDARY} Retry-After: 180`),
        );
      }
      return Promise.resolve("https://github.com/o/r/pull/8");
    },
    sleepFn: clock.sleepFn,
    nowMs: clock.nowMs,
  });
  assertEquals(clock.slept, [180_000]);
});

Deno.test("pr creation - the breaker's interval can only lengthen the wait", async () => {
  const clock = fakeClock();
  const refusals: number[] = [];
  let calls = 0;
  await createPrWithSecondaryLimitBackoff({
    createPr: () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error(SECONDARY));
      return Promise.resolve("https://github.com/o/r/pull/9");
    },
    sleepFn: clock.sleepFn,
    nowMs: clock.nowMs,
    onRefusal: (attempt) => {
      refusals.push(attempt);
      return Promise.resolve(300_000);
    },
  });
  assertEquals(refusals, [1]);
  assertEquals(clock.slept, [300_000]);
});

Deno.test("pr creation - the breaker is reset once the create succeeds", async () => {
  let reset = 0;
  await createPrWithSecondaryLimitBackoff({
    createPr: () => Promise.resolve("https://github.com/o/r/pull/10"),
    onSuccess: () => {
      reset++;
      return Promise.resolve();
    },
  });
  assertEquals(reset, 1);
});

Deno.test("pr creation - a limit that outlasts the schedule defers the PR", async () => {
  const clock = fakeClock();
  let calls = 0;
  const attempt = await createPrWithSecondaryLimitBackoff({
    createPr: () => {
      calls++;
      return Promise.reject(new Error(SECONDARY));
    },
    sleepFn: clock.sleepFn,
    nowMs: clock.nowMs,
  });

  assertEquals(attempt.kind, "deferred");
  assertEquals(calls, 4, "three waits, four attempts");
  assertEquals(clock.slept, [60_000, 120_000, 240_000]);
  assertEquals(
    attempt.kind === "deferred" ? attempt.waitedMs : 0,
    420_000,
  );
});

Deno.test("pr creation - a deadline the wait cannot fit defers without sleeping", async () => {
  const clock = fakeClock();
  const attempt = await createPrWithSecondaryLimitBackoff({
    createPr: () => Promise.reject(new Error(SECONDARY)),
    sleepFn: clock.sleepFn,
    nowMs: clock.nowMs,
    deadlineMs: clock.nowMs() + 10_000,
  });
  assertEquals(attempt.kind, "deferred");
  assertEquals(attempt.kind === "deferred" ? attempt.attempts : 0, 1);
  assertEquals(clock.slept, []);
});

Deno.test("pr creation - any other failure is returned untouched, unretried", async () => {
  const clock = fakeClock();
  let calls = 0;
  const attempt = await createPrWithSecondaryLimitBackoff({
    createPr: () => {
      calls++;
      return Promise.reject(new Error("No commits between main and branch"));
    },
    sleepFn: clock.sleepFn,
    nowMs: clock.nowMs,
  });
  assertEquals(attempt.kind, "failed");
  assertEquals(calls, 1);
  assertEquals(clock.slept, []);
  assertEquals(
    attempt.kind === "failed" ? attempt.error.message : "",
    "No commits between main and branch",
  );
});

Deno.test("pr creation - the latch's cool-down is handed back for the REST fallback, not waited on (Issue #1951)", async () => {
  const clock = fakeClock();
  const attempt = await createPrWithSecondaryLimitBackoff({
    createPr: () =>
      Promise.reject(
        new Error(
          "gh command skipped: GitHub secondary rate limit cool-down (API " +
            "rate limit already exceeded on a burst, hourly quota still " +
            "available)",
        ),
      ),
    sleepFn: clock.sleepFn,
    nowMs: clock.nowMs,
  });
  assertEquals(attempt.kind, "failed");
  assertEquals(clock.slept, [], "the REST fallback must not wait minutes");
});
