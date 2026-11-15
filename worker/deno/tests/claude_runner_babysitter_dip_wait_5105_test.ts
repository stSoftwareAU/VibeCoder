/**
 * The agent step is the one production caller that waits out a
 * babysitter-driven host-disk dip (Issue #5105): `runClaudeWithTimeout`
 * passes `babysitterDipWaitWithin` to `parkInFlightBuild`.
 *
 * The stub agent records that it ran, so a run that spawned is told from one
 * that was parked. The fake clock drives the wait, so nothing here sleeps.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  enableInFlightHostDiskGate,
  type HeavyBuildDiskReading,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import type { HostDiskReservation } from "../lib/host_disk_reservations.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const GB = 1_073_741_824;
const FLOOR = 46 * GB;
const NOW = Date.now();
const MARKER = "ran.marker";
/** The default poll of the production wait. */
const POLL_MS = 60_000;

const STUB = [
  `echo ran > "$(dirname "$0")/${MARKER}"`,
  `printf '{"type":"result","result":"ran"}\\n'`,
  "exit 0",
].join("\n");

/** 40 GB free against a 46 GB floor; the repair consumed 12 of its 16 GB. */
const EXPLAINING: HostDiskReservation[] = [{
  holder: "babysitter",
  id: "repair-1",
  bytes: 16 * GB,
  availableAtAdmission: 52 * GB,
  admittedAt: NOW - 60_000,
  expiresAt: NOW + 3_600_000,
}];

function reading(
  level: "ok" | "low",
  free: number,
  reservations: readonly HostDiskReservation[],
): HeavyBuildDiskReading {
  return {
    status: {
      level,
      availableBytes: free,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail: `host ${free} bytes free, floor ${FLOOR}`,
    },
    floorBytes: FLOOR,
    trimRefused: true,
    hostDiskReservations: reservations,
    workerGrowthSinceReservationBytes: 0,
  };
}

/** Registers a probe that answers from `next`, and counts its calls. */
async function withGate<T>(
  next: (call: number) => HeavyBuildDiskReading,
  fn: (calls: () => number) => Promise<T>,
): Promise<T> {
  let calls = 0;
  enableInFlightHostDiskGate(true);
  registerHeavyBuildDiskProbe(() => Promise.resolve(next(calls++)));
  try {
    return await fn(() => calls);
  } finally {
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
  }
}

/** Fails, rather than hangs, when the run settles without arming the wait. */
async function armedBeforeSettling(
  clock: { armedFor(ms: number): Promise<void> },
  run: Promise<unknown>,
): Promise<void> {
  const first = await Promise.race([
    clock.armedFor(POLL_MS).then(() => "armed"),
    run.then(() => "settled"),
  ]);
  assertEquals(first, "armed", "the run never waited on the dip");
}

const ran = async (dir: string): Promise<boolean> => {
  try {
    await Deno.stat(`${dir}/${MARKER}`);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};

const permissions = { run: true, read: true, write: true, env: true };

Deno.test({
  name:
    "runClaudeWithTimeout - waits out an explained dip, then spawns once the reading recovers (Issue #5105)",
  permissions,
  ignore: Deno.build.os === "windows",
  async fn() {
    await withAgentStub(STUB, async (stub) => {
      const cwd = await Deno.makeTempDir();
      try {
        await withGate(
          (call) =>
            call === 0
              ? reading("low", 40 * GB, EXPLAINING)
              : reading("ok", 120 * GB, []),
          async (calls) => {
            const clock = fakeClock();
            const run = runClaudeWithTimeout({
              prompt: "test",
              agentBinaryPath: stub.path,
              timeoutSeconds: 3_600,
              killAfterSeconds: 2,
              cwd,
              clock,
            });
            await armedBeforeSettling(clock, run);
            assertEquals(calls(), 1, "one reading before the wait");
            assertEquals(await ran(stub.dir), false, "spawned during the wait");
            await clock.advance(POLL_MS);
            const result = await run;
            assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
            assertEquals(calls(), 2);
            assert(await ran(stub.dir), "never spawned after the recovery");
          },
        );
      } finally {
        await Deno.remove(cwd, { recursive: true });
      }
    });
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - an unexplained dip parks at once without waiting (Issue #5105)",
  permissions,
  ignore: Deno.build.os === "windows",
  async fn() {
    await withAgentStub(STUB, async (stub) => {
      const cwd = await Deno.makeTempDir();
      try {
        await withGate(() => reading("low", 40 * GB, []), async (calls) => {
          const clock = fakeClock();
          const result = await runClaudeWithTimeout({
            prompt: "test",
            agentBinaryPath: stub.path,
            timeoutSeconds: 3_600,
            killAfterSeconds: 2,
            cwd,
            clock,
          });
          assert(!result.ok);
          assertStringIncludes(
            result.error.message,
            "Parked as infrastructure",
          );
          assertEquals(calls(), 1);
          assertEquals(clock.armed, 0, "a wait was armed");
          assertEquals(await ran(stub.dir), false);
        });
      } finally {
        await Deno.remove(cwd, { recursive: true });
      }
    });
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a discussion-only run never waits on the dip (Issue #5105)",
  permissions,
  ignore: Deno.build.os === "windows",
  async fn() {
    await withAgentStub(STUB, async (stub) => {
      const cwd = await Deno.makeTempDir();
      try {
        // Still low and explained on every reading: a wait would sleep.
        await withGate(
          () => reading("low", 40 * GB, EXPLAINING),
          async (calls) => {
            const clock = fakeClock();
            const result = await runClaudeWithTimeout({
              prompt: "test",
              agentBinaryPath: stub.path,
              timeoutSeconds: 3_600,
              killAfterSeconds: 2,
              cwd,
              clock,
              discussionOnly: true,
            });
            assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
            assertEquals(calls(), 1);
            assert(await ran(stub.dir));
          },
        );
      } finally {
        await Deno.remove(cwd, { recursive: true });
      }
    });
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - the wait never outlasts the session budget it leaves (Issue #5105)",
  permissions,
  ignore: Deno.build.os === "windows",
  async fn() {
    await withAgentStub(STUB, async (stub) => {
      const cwd = await Deno.makeTempDir();
      try {
        // 180 s requested, 120 s kept for the session: one 60 s poll fits.
        await withGate(
          () => reading("low", 40 * GB, EXPLAINING),
          async (calls) => {
            const clock = fakeClock();
            const run = runClaudeWithTimeout({
              prompt: "test",
              agentBinaryPath: stub.path,
              timeoutSeconds: 180,
              killAfterSeconds: 2,
              cwd,
              clock,
            });
            await armedBeforeSettling(clock, run);
            await clock.advance(POLL_MS);
            const result = await run;
            assert(!result.ok);
            assertStringIncludes(
              result.error.message,
              "Parked as infrastructure",
            );
            assertEquals(calls(), 2, "one poll, then the bound");
            assertEquals(await ran(stub.dir), false);
          },
        );
        // Control: a budget with nothing to spare does not wait at all.
        await withGate(
          () => reading("low", 40 * GB, EXPLAINING),
          async (calls) => {
            const clock = fakeClock();
            const result = await runClaudeWithTimeout({
              prompt: "test",
              agentBinaryPath: stub.path,
              timeoutSeconds: 120,
              killAfterSeconds: 2,
              cwd,
              clock,
            });
            assert(!result.ok);
            assertEquals(calls(), 1);
            assertEquals(clock.armed, 0, "a wait was armed");
          },
        );
      } finally {
        await Deno.remove(cwd, { recursive: true });
      }
    });
  },
});
