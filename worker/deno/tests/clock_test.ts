/**
 * Tests for the clock seam and the fake clock tests drive it with.
 *
 * `lib/clock.ts` is what `runClaudeWithTimeout` reads time and arms every
 * watchdog through, so two things have to hold. Production must be unchanged:
 * {@link systemClock} is `Date.now()` and the runtime's own timers, and a
 * handle it hands back must still cancel. And the fake must be a faithful
 * stand-in: time moves only when the test says so, timers fire in due order,
 * a repeating timer keeps repeating, and a zero delay is not a wait.
 *
 * Nothing here asserts on a duration. The system-clock cases compare two
 * readings of the same clock for order, which is true at any speed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Clock, systemClock } from "../lib/clock.ts";
import { FAKE_CLOCK_EPOCH_MS, fakeClock } from "./support/fake_clock.ts";

Deno.test("systemClock - now() reads the real clock", () => {
  const before = Date.now();
  const reading = systemClock.now();
  const after = Date.now();
  assert(
    reading >= before && reading <= after,
    `${reading} must fall between ${before} and ${after}`,
  );
});

Deno.test("systemClock - a one-shot timer fires, and its handle cancels it", async () => {
  const fired: string[] = [];
  const kept = Promise.withResolvers<void>();
  const cancelled = systemClock.setTimeout(() => fired.push("cancelled"), 0);
  systemClock.clearTimeout(cancelled);
  systemClock.setTimeout(() => {
    fired.push("kept");
    kept.resolve();
  }, 0);
  await kept.promise;
  assertEquals(fired, ["kept"], "a cleared timer must not fire");
});

Deno.test("systemClock - a repeating timer repeats until it is cleared", async () => {
  const twice = Promise.withResolvers<void>();
  let ticks = 0;
  const handle = systemClock.setInterval(() => {
    ticks++;
    if (ticks === 2) twice.resolve();
  }, 1);
  await twice.promise;
  systemClock.clearInterval(handle);
  const settled = ticks;
  await systemClock.sleep(0);
  assertEquals(ticks, settled, "a cleared interval must stop ticking");
});

Deno.test("systemClock - clearing nothing is a no-op, as with the globals", () => {
  systemClock.clearTimeout(undefined);
  systemClock.clearInterval(undefined);
});

Deno.test("systemClock - satisfies the Clock interface production depends on", () => {
  // The default every production call site gets, by omitting the option.
  const clock: Clock = systemClock;
  assertEquals(typeof clock.now(), "number");
});

Deno.test("fakeClock - time does not move on its own", async () => {
  const clock = fakeClock();
  assertEquals(clock.now(), FAKE_CLOCK_EPOCH_MS);
  // A real turn of the event loop passes; the fake clock does not notice.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(clock.now(), FAKE_CLOCK_EPOCH_MS);
});

Deno.test("fakeClock - advance moves the clock and fires what falls due", async () => {
  const clock = fakeClock();
  const fired: string[] = [];
  clock.setTimeout(() => fired.push("late"), 300);
  clock.setTimeout(() => fired.push("early"), 100);
  await clock.advance(50);
  assertEquals(fired, [], "nothing is due yet");
  await clock.advance(100);
  assertEquals(fired, ["early"], "only the timer that came due has fired");
  assertEquals(clock.now(), FAKE_CLOCK_EPOCH_MS + 150);
  await clock.advance(1_000);
  assertEquals(fired, ["early", "late"]);
});

Deno.test("fakeClock - timers due at the same instant fire in the order they were armed", async () => {
  const clock = fakeClock();
  const fired: string[] = [];
  clock.setTimeout(() => fired.push("first"), 100);
  clock.setTimeout(() => fired.push("second"), 100);
  await clock.advance(100);
  assertEquals(fired, ["first", "second"]);
});

Deno.test("fakeClock - the clock reads the due time inside a handler, not the target", async () => {
  // What makes a re-armed watchdog land where the code under test expects:
  // a handler arming its next wake reads the instant it was woken.
  const clock = fakeClock();
  const readings: number[] = [];
  clock.setTimeout(() => readings.push(clock.now() - FAKE_CLOCK_EPOCH_MS), 100);
  await clock.advance(5_000);
  assertEquals(readings, [100]);
  assertEquals(clock.now(), FAKE_CLOCK_EPOCH_MS + 5_000);
});

Deno.test("fakeClock - a cleared timer never fires", async () => {
  const clock = fakeClock();
  const fired: string[] = [];
  const handle = clock.setTimeout(() => fired.push("gone"), 100);
  clock.clearTimeout(handle);
  await clock.advance(1_000);
  assertEquals(fired, []);
  assertEquals(clock.armed, 0);
});

Deno.test("fakeClock - an interval re-arms itself until it is cleared", async () => {
  const clock = fakeClock();
  let ticks = 0;
  const handle = clock.setInterval(() => ticks++, 100);
  await clock.advance(250);
  assertEquals(ticks, 2, "two ticks fit in 250ms");
  clock.clearInterval(handle);
  await clock.advance(1_000);
  assertEquals(ticks, 2, "a cleared interval stops");
});

Deno.test("fakeClock - a zero delay fires on its own, without the clock moving", async () => {
  // `runClaudeWithRetry` with `initialWaitInterval: 0` means "walk the ladder
  // without sleeping"; a fake clock that held that sleep would wedge the test.
  const clock = fakeClock();
  const slept = Promise.withResolvers<void>();
  clock.setTimeout(() => slept.resolve(), 0);
  await slept.promise;
  assertEquals(clock.now(), FAKE_CLOCK_EPOCH_MS, "no time passed");
});

Deno.test("fakeClock - sleep resolves when the clock is advanced past it", async () => {
  const clock = fakeClock();
  const done: string[] = [];
  const sleeping = clock.sleep(500).then(() => done.push("woke"));
  await clock.advance(499);
  assertEquals(done, [], "still sleeping");
  await clock.advance(1);
  await sleeping;
  assertEquals(done, ["woke"]);
});

Deno.test("fakeClock - a negative delay is clamped, as the globals clamp it", async () => {
  // `armHardWatchdog` computes a negative delay whenever the deadline has
  // already passed, and the real `setTimeout` fires such a timer at once.
  const clock = fakeClock();
  const fired: string[] = [];
  clock.setTimeout(() => fired.push("overdue"), -5_000);
  await clock.advance(0);
  assertEquals(fired, ["overdue"]);
});

Deno.test("fakeClock - nextArm resolves on the next timer armed", async () => {
  const clock = fakeClock();
  const armed = clock.nextArm();
  let resolved = false;
  const watching = armed.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assertEquals(resolved, false, "nothing armed yet");
  clock.setTimeout(() => {}, 100);
  await watching;
  assertEquals(resolved, true);
});

Deno.test("fakeClock - armedFor names a watchdog by its delay, before or after it is armed", async () => {
  const clock = fakeClock();
  // Asked for before it exists.
  const waiting = clock.armedFor(2_000);
  clock.setTimeout(() => {}, 2_000);
  await waiting;
  // And asked for after: an already-armed delay resolves immediately, so the
  // order of the wait and the arming cannot decide the test.
  await clock.armedFor(2_000);
});

Deno.test("fakeClock - advance refuses a negative delta", async () => {
  const clock = fakeClock();
  await assertRejects(
    () => clock.advance(-1),
    RangeError,
    "non-negative",
  );
});

Deno.test("fakeClock - a spinning repeat fails loudly rather than hanging the suite", async () => {
  const clock = fakeClock();
  clock.setInterval(() => {}, 1);
  let message = "";
  try {
    await clock.advance(20_000);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert(
    message.includes("a repeating timer is spinning"),
    `the runaway must name itself, got: ${message}`,
  );
});
