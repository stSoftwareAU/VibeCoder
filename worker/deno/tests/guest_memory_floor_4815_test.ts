/** The guest memory floor and its watch (Issue #4815). */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  armGuestMemoryFloor,
  GUEST_MEMORY_FLOOR_MARKER,
  GUEST_MEMORY_FLOOR_MIN_BYTES,
  guestMemoryFloorArmed,
  guestMemoryFloorBytes,
  GuestMemoryFloorError,
  GuestMemoryFloorWatch,
} from "../lib/guest_memory_floor.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

Deno.test("guestMemoryFloorBytes - 512 MiB minimum, 5% on large guests", () => {
  assertEquals(guestMemoryFloorBytes(4 * GIB), 512 * MIB);
  assertEquals(guestMemoryFloorBytes(8 * GIB), 512 * MIB);
  assertEquals(guestMemoryFloorBytes(16 * GIB), 858993459);
  assertEquals(guestMemoryFloorBytes(0), GUEST_MEMORY_FLOOR_MIN_BYTES);
  assertEquals(guestMemoryFloorBytes(NaN), GUEST_MEMORY_FLOOR_MIN_BYTES);
  assertEquals(guestMemoryFloorBytes(-1), GUEST_MEMORY_FLOOR_MIN_BYTES);
});

const low = {
  level: "high" as const,
  totalBytes: 8 * GIB,
  availableBytes: 100 * MIB,
};
const fine = {
  level: "ok" as const,
  totalBytes: 8 * GIB,
  availableBytes: 4 * GIB,
};

Deno.test("GuestMemoryFloorWatch - trips on the second consecutive low reading", () => {
  const watch = new GuestMemoryFloorWatch();
  assertEquals(watch.observe(low), null);
  const reason = watch.observe(low);
  assert(reason !== null);
  assertEquals(
    reason,
    `${GUEST_MEMORY_FLOOR_MARKER} guest memory stayed below its floor (100 MiB available, floor 512 MiB) for 2 readings in a row: the agent run was stopped so the guest keeps answering (Issue #4815)`,
  );
});

Deno.test("GuestMemoryFloorWatch - low, ok, low does not trip", () => {
  const watch = new GuestMemoryFloorWatch();
  assertEquals(watch.observe(low), null);
  assertEquals(watch.observe(fine), null);
  assertEquals(watch.observe(low), null);
});

Deno.test("GuestMemoryFloorWatch - a reading without numbers resets and never trips", () => {
  const watch = new GuestMemoryFloorWatch();
  assertEquals(watch.observe(low), null);
  assertEquals(watch.observe({ level: "unknown" }), null);
  assertEquals(watch.observe(low), null);
  for (let i = 0; i < 5; i++) {
    assertEquals(watch.observe({ level: "high" }), null);
    assertEquals(watch.observe({ level: "unknown" }), null);
  }
});

Deno.test("GuestMemoryFloorWatch - exactly the floor does not trip", () => {
  const watch = new GuestMemoryFloorWatch();
  const atFloor = {
    level: "high" as const,
    totalBytes: 8 * GIB,
    availableBytes: 512 * MIB,
  };
  for (let i = 0; i < 4; i++) assertEquals(watch.observe(atFloor), null);
});

Deno.test("GuestMemoryFloorWatch - latches after the first reason", () => {
  const watch = new GuestMemoryFloorWatch();
  watch.observe(low);
  assertStringIncludes(watch.observe(low) ?? "", GUEST_MEMORY_FLOOR_MARKER);
  assertEquals(watch.observe(low), null);
  assertEquals(watch.observe(low), null);
});

Deno.test("guest memory floor - arming is off by default and toggles", () => {
  assertEquals(guestMemoryFloorArmed(), false);
  armGuestMemoryFloor(true);
  assertEquals(guestMemoryFloorArmed(), true);
  armGuestMemoryFloor(false);
  assertEquals(new GuestMemoryFloorError("x").name, "GuestMemoryFloorError");
});
