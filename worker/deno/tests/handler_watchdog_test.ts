/**
 * Tests for the per-iteration handler watchdog (Issue #2473).
 *
 * Exercises real behaviour of `runWithWatchdog` with an injected clock and an
 * injected timer — no real sleep — covering: hard-timeout abandonment of a
 * never-resolving task, the soft-warning threshold (just-under vs just-over),
 * rejection propagation, and the disabled-timeout path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { runWithWatchdog } from "../lib/handler_watchdog.ts";

Deno.test("runWithWatchdog - abandons a never-resolving task on hard timeout", async () => {
  let now = 0;
  let timedOut = false;
  // Injected timer fires immediately and advances the clock past the timeout.
  const result = await runWithWatchdog<string>(
    () => new Promise<string>(() => {}), // never resolves
    {
      hardTimeoutMs: 5000,
      softTimeoutMs: 1000,
      now: () => now,
      delay: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      onTimeout: () => {
        timedOut = true;
      },
    },
  );

  assertEquals(result.outcome, "timedout");
  assertEquals(result.value, undefined);
  assertEquals(result.durationMs, 5000);
  assert(timedOut, "onTimeout callback must fire");
});

Deno.test("runWithWatchdog - a task just under the soft threshold logs no warning", async () => {
  let now = 0;
  let warned = false;

  const result = await runWithWatchdog<string>(
    () => {
      now += 999; // elapsed 999ms < soft 1000ms
      return Promise.resolve("done");
    },
    {
      hardTimeoutMs: 5000,
      softTimeoutMs: 1000,
      now: () => now,
      delay: () => new Promise<void>(() => {}), // timer never fires
      onSoftWarning: () => {
        warned = true;
      },
    },
  );

  assertEquals(result.outcome, "completed");
  assertEquals(result.value, "done");
  assert(!warned, "soft warning must not fire just under the threshold");
});

Deno.test("runWithWatchdog - a task at the soft threshold logs a warning", async () => {
  let now = 0;
  let warnedMs = -1;

  const result = await runWithWatchdog<string>(
    () => {
      now += 1500; // elapsed 1500ms >= soft 1000ms
      return Promise.resolve("done");
    },
    {
      hardTimeoutMs: 5000,
      softTimeoutMs: 1000,
      now: () => now,
      delay: () => new Promise<void>(() => {}),
      onSoftWarning: (ms) => {
        warnedMs = ms;
      },
    },
  );

  assertEquals(result.outcome, "completed");
  assertEquals(result.value, "done");
  assertEquals(warnedMs, 1500);
});

Deno.test("runWithWatchdog - propagates a task rejection unchanged", async () => {
  await assertRejects(
    () =>
      runWithWatchdog<string>(
        () => Promise.reject(new Error("boom")),
        {
          hardTimeoutMs: 5000,
          softTimeoutMs: 1000,
          now: () => 0,
          delay: () => new Promise<void>(() => {}),
        },
      ),
    Error,
    "boom",
  );
});

Deno.test("runWithWatchdog - hardTimeoutMs <= 0 disables the timeout", async () => {
  let now = 0;
  let delayCalled = false;

  const result = await runWithWatchdog<number>(
    () => {
      now += 10;
      return Promise.resolve(42);
    },
    {
      hardTimeoutMs: 0,
      softTimeoutMs: 0,
      now: () => now,
      delay: () => {
        delayCalled = true;
        return Promise.resolve();
      },
    },
  );

  assertEquals(result.outcome, "completed");
  assertEquals(result.value, 42);
  assert(!delayCalled, "timer must not be armed when the timeout is disabled");
});
