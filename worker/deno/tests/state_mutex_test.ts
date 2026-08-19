/**
 * Tests for the keyed in-process state mutex (Issue #4180).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { _stateLockKeys, withStateLock } from "../lib/state_mutex.ts";

Deno.test("state_mutex - same key serialises: three concurrent read-modify-writes yield 3, never fewer", async () => {
  let stored = 0;
  const rmw = () =>
    withStateLock("counter", async () => {
      const read = stored;
      await new Promise((r) => setTimeout(r, 2)); // the await between load and write
      stored = read + 1;
    });
  await Promise.all([rmw(), rmw(), rmw()]);
  assertEquals(stored, 3);
});

Deno.test("state_mutex - different keys run concurrently", async () => {
  let peak = 0, inFlight = 0;
  const task = (key: string) =>
    withStateLock(key, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
  await Promise.all([task("a"), task("b"), task("c")]);
  assertEquals(peak, 3);
});

Deno.test("state_mutex - a rejection propagates and does not poison the queue; keys are released", async () => {
  await assertRejects(() =>
    withStateLock("k", () => Promise.reject(new Error("boom")))
  );
  const after = await withStateLock("k", () => Promise.resolve("ok"));
  assertEquals(after, "ok");
  await new Promise((r) => setTimeout(r, 1));
  assertEquals(_stateLockKeys(), 0);
});
