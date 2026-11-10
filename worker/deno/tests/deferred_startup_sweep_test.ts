/**
 * Tests for lib/deferred_startup_sweep.ts — startup sweeps run in the
 * background and are settled against a bounded grace (Issue #4822).
 *
 * Covers: start returning before a gated run resolves (with the run begun
 * synchronously), a rejecting or throwing run being logged rather than
 * propagated, settle returning [] and cancelling its timer when every sweep
 * finishes, settle abandoning a sweep that never finishes once the grace
 * expires (naming only that sweep), and empty input starting no timer.
 *
 * No test sleeps: sweeps are gated on controllable promises and the grace is
 * a fake timer whose expiry the test triggers by hand.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFERRED_SWEEP_GRACE_MS,
  type DeferredSweepSink,
  settleDeferredSweeps,
  startDeferredSweep,
  type SweepTimer,
} from "../lib/deferred_startup_sweep.ts";

/** A sink that records every log and error line. */
function recordingSink(): DeferredSweepSink & {
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (message: string) => {
      logs.push(message);
    },
    logError: (message: string) => {
      errors.push(message);
    },
  };
}

/** A fake timer: records each start and cancel, and expires only when told. */
class FakeSweepTimer implements SweepTimer {
  readonly startedMs: number[] = [];
  cancelCount = 0;
  private expireNow: () => void = () => {};

  start(ms: number): { expired: Promise<void>; cancel(): void } {
    this.startedMs.push(ms);
    const expired = new Promise<void>((resolve) => {
      this.expireNow = resolve;
    });
    return {
      expired,
      cancel: () => {
        this.cancelCount++;
      },
    };
  }

  /** Expire the most recently started timer. */
  expire(): void {
    this.expireNow();
  }
}

/** A promise plus the function that resolves it, for gating a sweep. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

Deno.test("startDeferredSweep returns before a gated run resolves, with the run already begun", async () => {
  const sink = recordingSink();
  const blocker = gate();
  let began = false;
  const sweep = startDeferredSweep("gated", () => {
    began = true;
    return blocker.promise;
  }, sink);

  assert(began, "run must be invoked synchronously");
  let finished = false;
  sweep.done.then(() => {
    finished = true;
  });
  assertEquals(finished, false);
  assertEquals(sweep.name, "gated");

  blocker.release();
  await sweep.done;
  assertEquals(finished, true);
  assertEquals(sink.errors, []);
});

Deno.test("startDeferredSweep logs a rejecting run with its message and resolves done", async () => {
  const sink = recordingSink();
  const sweep = startDeferredSweep(
    "branch-cleanup",
    () => Promise.reject(new Error("gh unavailable")),
    sink,
  );

  await sweep.done;
  assertEquals(sink.errors, [
    "[deferred-sweep] branch-cleanup failed (continuing): gh unavailable",
  ]);
});

Deno.test("startDeferredSweep logs a synchronously throwing run and resolves done", async () => {
  const sink = recordingSink();
  const sweep = startDeferredSweep("sync-throw", () => {
    throw new Error("boom before any await");
  }, sink);

  await sweep.done;
  assertEquals(sink.errors, [
    "[deferred-sweep] sync-throw failed (continuing): boom before any await",
  ]);
});

Deno.test("settleDeferredSweeps returns [] when every sweep finishes and cancels its timer", async () => {
  const sink = recordingSink();
  const timer = new FakeSweepTimer();
  const blocker = gate();
  const sweep = startDeferredSweep("finishes", () => blocker.promise, sink);

  const pending = settleDeferredSweeps([sweep], sink, { timer });
  assertEquals(timer.startedMs.length, 1);
  blocker.release();

  assertEquals(await pending, []);
  assertEquals(timer.cancelCount, 1);
  assertEquals(sink.errors, []);
});

Deno.test("settleDeferredSweeps abandons a never-finishing sweep at grace expiry and names only it", async () => {
  const sink = recordingSink();
  const timer = new FakeSweepTimer();
  const stuck = startDeferredSweep(
    "stuck-sweep",
    () => new Promise<unknown>(() => {}),
    sink,
  );
  const quick = startDeferredSweep(
    "quick-sweep",
    () => Promise.resolve(),
    sink,
  );
  await quick.done;

  const pending = settleDeferredSweeps([stuck, quick], sink, { timer });
  timer.expire();
  const abandoned = await pending;

  assertEquals(timer.startedMs, [DEFERRED_SWEEP_GRACE_MS]);
  assertEquals(timer.cancelCount, 1);
  assertEquals(abandoned, ["stuck-sweep"]);
  assertEquals(sink.errors.length, 1);
  assertStringIncludes(sink.errors[0] ?? "", "stuck-sweep");
  assertStringIncludes(sink.errors[0] ?? "", "left unfinished");
  assertEquals((sink.errors[0] ?? "").includes("quick-sweep"), false);
});

Deno.test("settleDeferredSweeps with empty input returns [] and starts no timer", async () => {
  const sink = recordingSink();
  const timer = new FakeSweepTimer();

  assertEquals(await settleDeferredSweeps([], sink, { timer }), []);
  assertEquals(timer.startedMs, []);
  assertEquals(timer.cancelCount, 0);
  assertEquals(sink.errors, []);
});
