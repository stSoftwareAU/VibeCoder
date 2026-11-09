import { assert, assertEquals, assertRejects } from "@std/assert";
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

  await waitForSettledOrphan(1234, {
    expectedCommand: "sleep 300",
    maxAttempts: 4,
    observe: async () => observations.shift(),
    sleep: async (milliseconds) => {
      assertEquals(milliseconds, 100);
      sleeps++;
    },
  });

  assertEquals(sleeps, 2);
  assertEquals(observations.length, 0);
});

Deno.test("waitForSettledOrphan reports when the process never appears", async () => {
  let observations = 0;
  let sleeps = 0;

  const error = await assertRejects(
    () =>
      waitForSettledOrphan(4321, {
        expectedCommand: "sleep 300",
        maxAttempts: 3,
        observe: async () => {
          observations++;
          return undefined;
        },
        sleep: async () => {
          sleeps++;
        },
      }),
    Error,
    "last observed state=null",
  );

  assert(error.message.includes("orphan 4321"));
  assertEquals(observations, 3);
  assertEquals(sleeps, 2);
});

Deno.test("waitForSettledOrphan requires the expected command", async () => {
  const error = await assertRejects(
    () =>
      waitForSettledOrphan(5678, {
        expectedCommand: "sleep 300",
        maxAttempts: 2,
        observe: async () => ({ command: "sleep 301", parentPid: 1 }),
        sleep: async () => {},
      }),
    Error,
    '"command":"sleep 301"',
  );

  assert(error.message.includes("did not settle"));
});

Deno.test("waitForSettledOrphan requires adoption by PID 1", async () => {
  const error = await assertRejects(
    () =>
      waitForSettledOrphan(8765, {
        expectedCommand: "sleep 300",
        maxAttempts: 2,
        observe: async () => ({ command: "sleep 300", parentPid: 4321 }),
        sleep: async () => {},
      }),
    Error,
    '"parentPid":4321',
  );

  assert(error.message.includes("did not settle"));
});
