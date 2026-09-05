/**
 * Tests for the concurrency-test rendezvous (Issue #1098).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { createRendezvous, waitUntil } from "./support/rendezvous.ts";

Deno.test("waitUntil - returns true as soon as the condition holds", async () => {
  let ready = false;
  setTimeout(() => ready = true, 5);

  assertEquals(await waitUntil(() => ready), true);
});

Deno.test("waitUntil - a condition that never holds ends at the bound", async () => {
  assertEquals(await waitUntil(() => false, 5), false);
});

Deno.test("waitUntil - an already-true condition does not wait at all", async () => {
  assertEquals(await waitUntil(() => true, 0), true);
});

Deno.test("rendezvous - nobody leaves until every participant has arrived", async () => {
  const meeting = createRendezvous(3);
  let inFlight = 0;
  let high = 0;
  const participant = async () => {
    inFlight++;
    high = Math.max(high, inFlight);
    await meeting.arrive();
    inFlight--;
  };
  // Started one after another with the event loop free in between, which is
  // the interleaving a loaded host produces and a fixed sleep cannot survive.
  const running = [participant(), participant()];
  await new Promise((resolve) => setTimeout(resolve, 5));
  running.push(participant());
  await Promise.all(running);

  assertEquals(high, 3, "all three were in flight together");
  assertEquals(meeting.arrived, 3);
});

Deno.test("rendezvous - a participant that never arrives ends the wait with the shortfall", async () => {
  // The bound is what keeps a regression a failed assertion rather than a
  // hung suite: two of three arrive, and the wait reports two.
  const meeting = createRendezvous(3, 5);
  const counts = await Promise.all([meeting.arrive(), meeting.arrive()]);

  assertEquals(counts, [2, 2]);
  assertEquals(meeting.arrived, 2);
});

Deno.test("rendezvous - a met rendezvous never blocks a later arrival", async () => {
  // Slots claim repeatedly: once the meeting is satisfied, later runs must
  // not wait for participants that will never come.
  const meeting = createRendezvous(2);
  await Promise.all([meeting.arrive(), meeting.arrive()]);

  assertEquals(await meeting.arrive(), 3);
});
