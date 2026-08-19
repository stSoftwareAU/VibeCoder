/**
 * Tests for waitUntilRateLimitReset (Issue #1779).
 *
 * Covers:
 *   - Reset already past returns immediately without sleeping.
 *   - Normal wait completes after the reset epoch (with grace pad applied).
 *   - Shutdown during wait returns aborted="shutdown".
 *   - Cap enforced when the reset is far in the future returns aborted="cap".
 *   - Grace pad keeps the wait running past the reset epoch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  formatRemainingDuration,
  waitUntilRateLimitReset,
} from "../lib/rate_limit_wait.ts";

Deno.test("waitUntilRateLimitReset - returns immediately when reset is already past", async () => {
  const nowVal = 1000;
  let sleepCalls = 0;
  const result = await waitUntilRateLimitReset(
    { resetEpoch: 500 },
    {
      now: () => nowVal,
      sleep: () => {
        sleepCalls++;
        return Promise.resolve();
      },
      shouldShutdown: () => false,
    },
  );
  assert(result.ok);
  assertEquals(result.value.waited, 0);
  assertEquals(result.value.aborted, null);
  assertEquals(sleepCalls, 0);
});

Deno.test("waitUntilRateLimitReset - normal wait completes after reset with grace pad", async () => {
  let nowVal = 1000;
  const sleepCalls: number[] = [];
  const result = await waitUntilRateLimitReset(
    {
      resetEpoch: 1100,
      incrementSeconds: 30,
      graceSeconds: 30,
      capSeconds: 3600,
    },
    {
      now: () => nowVal,
      sleep: (ms: number) => {
        sleepCalls.push(ms);
        nowVal += ms / 1000;
        return Promise.resolve();
      },
      shouldShutdown: () => false,
    },
  );
  assert(result.ok);
  assertEquals(result.value.aborted, null);
  // Reset is 100s ahead, grace pad adds 30s → at least 130s waited.
  assert(
    result.value.waited >= 130,
    `expected >= 130, got ${result.value.waited}`,
  );
  assert(sleepCalls.length > 0, "expected at least one sleep call");
  // Every sleep call must be in milliseconds (≥1000ms for a 1s+ increment).
  for (const ms of sleepCalls) {
    assert(ms > 0, `sleep duration must be positive, got ${ms}`);
  }
});

Deno.test("waitUntilRateLimitReset - shutdown during wait returns aborted=shutdown", async () => {
  let nowVal = 1000;
  let polls = 0;
  const result = await waitUntilRateLimitReset(
    { resetEpoch: 1100 },
    {
      now: () => nowVal,
      sleep: (ms: number) => {
        nowVal += ms / 1000;
        return Promise.resolve();
      },
      shouldShutdown: () => {
        polls++;
        return polls >= 3;
      },
    },
  );
  assert(result.ok);
  assertEquals(result.value.aborted, "shutdown");
  // Two sleeps fired before the third poll signalled shutdown.
  assert(
    result.value.waited > 0,
    `expected positive waited, got ${result.value.waited}`,
  );
});

Deno.test("waitUntilRateLimitReset - cap enforced when reset is far in the future", async () => {
  let nowVal = 1000;
  const result = await waitUntilRateLimitReset(
    {
      resetEpoch: 1000 + 7200, // 2 hours away
      capSeconds: 60,
      incrementSeconds: 30,
      graceSeconds: 30,
    },
    {
      now: () => nowVal,
      sleep: (ms: number) => {
        nowVal += ms / 1000;
        return Promise.resolve();
      },
      shouldShutdown: () => false,
    },
  );
  assert(result.ok);
  assertEquals(result.value.aborted, "cap");
  assert(
    result.value.waited >= 60,
    `expected >= 60, got ${result.value.waited}`,
  );
  // Cap must not be exceeded by more than one increment.
  assert(
    result.value.waited <= 60 + 30,
    `expected <= 90, got ${result.value.waited}`,
  );
});

Deno.test("waitUntilRateLimitReset - default cap (3600s) applied when capSeconds omitted", async () => {
  // Guards the internal DEFAULT_CAP_SECONDS default (Issue #2954). With no
  // capSeconds and a reset far enough away to trip the cap, the wait must
  // abort with "cap" at ~3600s.
  let nowVal = 1000;
  const result = await waitUntilRateLimitReset(
    {
      resetEpoch: 1000 + 100_000, // well beyond the 1h default cap
      incrementSeconds: 600,
    },
    {
      now: () => nowVal,
      sleep: (ms: number) => {
        nowVal += ms / 1000;
        return Promise.resolve();
      },
      shouldShutdown: () => false,
    },
  );
  assert(result.ok);
  assertEquals(result.value.aborted, "cap");
  assert(
    result.value.waited >= 3600,
    `expected >= 3600, got ${result.value.waited}`,
  );
  assert(
    result.value.waited <= 3600 + 600,
    `expected <= 4200, got ${result.value.waited}`,
  );
});

Deno.test("waitUntilRateLimitReset - grace pad delays return past reset epoch", async () => {
  let nowVal = 1000;
  const result = await waitUntilRateLimitReset(
    { resetEpoch: 1010, graceSeconds: 50, incrementSeconds: 5 },
    {
      now: () => nowVal,
      sleep: (ms: number) => {
        nowVal += ms / 1000;
        return Promise.resolve();
      },
      shouldShutdown: () => false,
    },
  );
  assert(result.ok);
  assertEquals(result.value.aborted, null);
  // Reset 10s ahead + 50s grace = at least 60s waited.
  assert(
    result.value.waited >= 60,
    `expected >= 60, got ${result.value.waited}`,
  );
});

Deno.test("waitUntilRateLimitReset - rejects non-finite reset epoch", async () => {
  const result = await waitUntilRateLimitReset(
    { resetEpoch: Number.NaN },
    {
      now: () => 1000,
      sleep: () => Promise.resolve(),
      shouldShutdown: () => false,
    },
  );
  assert(!result.ok);
});

Deno.test("waitUntilRateLimitReset - emits heartbeats at the configured cadence (Issue #1903)", async () => {
  let nowVal = 1000;
  const logs: string[] = [];
  const result = await waitUntilRateLimitReset(
    {
      resetEpoch: 1000 + 300, // 5 minutes away
      incrementSeconds: 30,
      graceSeconds: 0,
      heartbeatSeconds: 60,
    },
    {
      now: () => nowVal,
      sleep: (ms: number) => {
        nowVal += ms / 1000;
        return Promise.resolve();
      },
      shouldShutdown: () => false,
      log: (msg: string) => logs.push(msg),
    },
  );
  assert(result.ok);
  assertEquals(result.value.aborted, null);
  // Expect a heartbeat at ~60s, 120s, 180s, 240s; at 300s the loop
  // returns before firing another. Allow ±1 to absorb rounding.
  assert(
    logs.length >= 4 && logs.length <= 5,
    `expected 4–5 heartbeats, got ${logs.length}: ${JSON.stringify(logs)}`,
  );
  for (const msg of logs) {
    assert(
      /^Rate-limit wait: \d+m \d{2}s remaining until reset at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
        .test(msg),
      `heartbeat format mismatch: ${msg}`,
    );
  }
});

Deno.test("waitUntilRateLimitReset - no heartbeat when wait is shorter than interval (Issue #1903)", async () => {
  let nowVal = 1000;
  const logs: string[] = [];
  const result = await waitUntilRateLimitReset(
    {
      resetEpoch: 1030, // 30s away — shorter than the 60s heartbeat
      incrementSeconds: 5,
      graceSeconds: 0,
      heartbeatSeconds: 60,
    },
    {
      now: () => nowVal,
      sleep: (ms: number) => {
        nowVal += ms / 1000;
        return Promise.resolve();
      },
      shouldShutdown: () => false,
      log: (msg: string) => logs.push(msg),
    },
  );
  assert(result.ok);
  assertEquals(result.value.aborted, null);
  assertEquals(logs.length, 0, `expected no heartbeats, got ${logs.length}`);
});

Deno.test("waitUntilRateLimitReset - heartbeats disabled when no logger dep is provided (Issue #1903)", async () => {
  let nowVal = 1000;
  // No log dep — no heartbeat output channel; the wait must complete
  // cleanly without anything being printed.
  const result = await waitUntilRateLimitReset(
    {
      resetEpoch: 1000 + 200,
      incrementSeconds: 30,
      graceSeconds: 0,
      heartbeatSeconds: 60,
    },
    {
      now: () => nowVal,
      sleep: (ms: number) => {
        nowVal += ms / 1000;
        return Promise.resolve();
      },
      shouldShutdown: () => false,
    },
  );
  assert(result.ok);
  assertEquals(result.value.aborted, null);
});

Deno.test("waitUntilRateLimitReset - rejects non-positive heartbeat interval (Issue #1903)", async () => {
  const result = await waitUntilRateLimitReset(
    { resetEpoch: 2000, heartbeatSeconds: 0 },
    {
      now: () => 1000,
      sleep: () => Promise.resolve(),
      shouldShutdown: () => false,
      log: () => {},
    },
  );
  assert(!result.ok);
});

Deno.test("formatRemainingDuration - pads seconds to two digits", () => {
  assertEquals(formatRemainingDuration(0), "0m 00s");
  assertEquals(formatRemainingDuration(5), "0m 05s");
  assertEquals(formatRemainingDuration(65), "1m 05s");
  assertEquals(formatRemainingDuration(3002), "50m 02s");
  assertEquals(formatRemainingDuration(-10), "0m 00s");
});

Deno.test("waitUntilRateLimitReset - rejects non-positive cap", async () => {
  const result = await waitUntilRateLimitReset(
    { resetEpoch: 2000, capSeconds: 0 },
    {
      now: () => 1000,
      sleep: () => Promise.resolve(),
      shouldShutdown: () => false,
    },
  );
  assert(!result.ok);
});
