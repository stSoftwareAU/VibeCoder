import { assert, assertEquals } from "@std/assert";
import {
  type ProcessObservation,
  waitForSettledOrphan,
} from "./support/process_settlement.ts";

const settled: ProcessObservation = { command: "sleep 300", parentPid: 1 };

Deno.test("waitForSettledOrphan waits for a late adopted process", async () => {
  const observations: (ProcessObservation | undefined)[] = [
    undefined,
    { command: "bash -c sleep 300", parentPid: 2718 },
    settled,
  ];
  let sleeps = 0;

  const result = await waitForSettledOrphan({
    expectedCommand: "sleep 300",
    maxAttempts: 4,
    observe: async () => observations.shift(),
    sleep: async (milliseconds) => {
      assertEquals(milliseconds, 100);
      sleeps++;
    },
  });

  assert(result.settled);
  assertEquals(result.lastObservedState, settled);
  assertEquals(sleeps, 2);
  assertEquals(observations.length, 0);
});

Deno.test("waitForSettledOrphan reports when the process never appears", async () => {
  let observations = 0;
  let sleeps = 0;

  const result = await waitForSettledOrphan({
    expectedCommand: "sleep 300",
    maxAttempts: 3,
    observe: async () => {
      observations++;
      return undefined;
    },
    sleep: async () => {
      sleeps++;
    },
  });

  assert(!result.settled);
  assertEquals(result.lastObservedState, undefined);
  assertEquals(observations, 3);
  assertEquals(sleeps, 2);
});

Deno.test("waitForSettledOrphan requires the expected command", async () => {
  const result = await waitForSettledOrphan({
    expectedCommand: "sleep 300",
    maxAttempts: 2,
    observe: async () => ({ command: "sleep 301", parentPid: 1 }),
    sleep: async () => {},
  });

  assert(!result.settled);
  assertEquals(result.lastObservedState, {
    command: "sleep 301",
    parentPid: 1,
  });
});

Deno.test("waitForSettledOrphan requires adoption by PID 1", async () => {
  const result = await waitForSettledOrphan({
    expectedCommand: "sleep 300",
    maxAttempts: 2,
    observe: async () => ({ command: "sleep 300", parentPid: 4321 }),
    sleep: async () => {},
  });

  assert(!result.settled);
  assertEquals(result.lastObservedState, {
    command: "sleep 300",
    parentPid: 4321,
  });
});
