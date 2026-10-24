/**
 * Tests for the merge-conflict drain's run-target start-gate (Issue #4243).
 *
 * Once the run's target has passed, no new conflict resolution may start: the
 * drain refuses before the next PR is even listed, logs one line saying why,
 * and reports a deadline stop. A resolution already under way is not
 * interrupted. Before the target, and with no timeline set, the drain behaves
 * exactly as it did before.
 *
 * The clock is injected and the process-wide timeline is set and cleared
 * around each test, so nothing reads the real clock, the environment or sleeps.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  type ConflictDrainOptions,
  drainConflictingPrs,
} from "../lib/merge_conflict_drain.ts";
import type { ConflictingPr } from "../lib/pr_merge_conflict_scan.ts";
import {
  resetRunTimelineForTests,
  resolveRunTimeline,
  setRunTimeline,
} from "../lib/run_timeline.ts";
import type { LogContext, Logger } from "../types.ts";

const HOUR_MS = 3600_000;
const START = 1_700_000_000_000;
const TARGET_MARK = "run target has passed";
const STOP_PREFIX = "Merge-conflict drain stopping";

interface LogEntry {
  message: string;
  context?: LogContext;
}

interface RecordingLogger extends Logger {
  entries: LogEntry[];
}

/** A logger that keeps what it was told, so the refusal line can be counted. */
function makeRecordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  const capture = (message: string, context?: LogContext) => {
    entries.push({ message, ...(context ? { context } : {}) });
  };
  return {
    entries,
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

function pr(repo: string, prNumber: number): ConflictingPr {
  return {
    repo,
    prNumber,
    branchName: `issue-${prNumber}-branch`,
    baseBranch: "main",
    attemptCount: 0,
    disruptedCount: 0,
  };
}

/**
 * A queue that honours the exclusion set, the way `findConflictingPr` does:
 * it hands back the first PR the cycle has not already taken.
 */
function queueFinder(
  queue: readonly ConflictingPr[],
): ConflictDrainOptions["findNext"] {
  return (exclude) =>
    Promise.resolve(
      queue.find((p) => !exclude.has(`${p.repo}#${p.prNumber}`)) ?? null,
    );
}

const alwaysLease = () => ({ release: () => {} });

/** The run's timeline, with its target one hour after {@link START}. */
function oneHourTimeline() {
  return resolveRunTimeline({
    startedMs: START,
    runDurationSeconds: 3600,
    runFinishSeconds: 7200,
    env: () => undefined,
    killAfterSeconds: 30,
    warn: () => {},
  });
}

Deno.test("merge-conflict drain after target - a clock past the target at drain start starts nothing", async () => {
  setRunTimeline(oneHourTimeline());
  try {
    const log = makeRecordingLogger();
    let findNextCalls = 0;
    let leaseCalls = 0;
    let resolveCalls = 0;
    const nowMs = START + HOUR_MS;
    const finder = queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]);

    const result = await drainConflictingPrs({
      // Issue #1774: this PR is still open at the claim point.
      prLiveState: () =>
        Promise.resolve({ open: true, mergeable: "CONFLICTING" }),
      logger: log,
      findNext: (exclude, prefer) => {
        findNextCalls++;
        return finder(exclude, prefer);
      },
      acquireLease: () => {
        leaseCalls++;
        return alwaysLease();
      },
      resolve: () => {
        resolveCalls++;
        return Promise.resolve({ processed: true, merged: true });
      },
      now: () => nowMs,
    });

    assertEquals(
      findNextCalls,
      0,
      "no PR is listed once the target has passed",
    );
    assertEquals(leaseCalls, 0, "no repo lease is taken");
    assertEquals(resolveCalls, 0, "no resolution starts");
    assertEquals(result.stopReason, "deadline");
    assertEquals(result.taken, 0);

    const refusals = log.entries.filter((e) => e.message.includes(TARGET_MARK));
    assertEquals(refusals.length, 1, "exactly one refusal line");
    assertEquals(
      log.entries.filter((e) => e.message.includes(STOP_PREFIX)).length,
      1,
      "the only stop line is the target refusal",
    );
    assertEquals(refusals[0]?.context?.taken, 0);
    assertEquals(refusals[0]?.context?.merged, 0);
  } finally {
    resetRunTimelineForTests();
  }
});

Deno.test("merge-conflict drain after target - a resolution in flight completes, and the next PR is not started", async () => {
  setRunTimeline(oneHourTimeline());
  try {
    const log = makeRecordingLogger();
    let nowMs = START + HOUR_MS - 1000;
    const resolved: number[] = [];

    const result = await drainConflictingPrs({
      // Issue #1774: this PR is still open at the claim point.
      prLiveState: () =>
        Promise.resolve({ open: true, mergeable: "CONFLICTING" }),
      logger: log,
      findNext: queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]),
      acquireLease: alwaysLease,
      resolve: (conflict) => {
        resolved.push(conflict.prNumber);
        // The run's target passes while the first resolution is under way.
        nowMs = START + HOUR_MS + 10_000;
        return Promise.resolve({ processed: true, merged: true });
      },
      now: () => nowMs,
    });

    assertEquals(resolved, [1], "the second due PR must not be started");
    assertEquals(
      result.merged,
      1,
      "the in-flight resolution completed and its merge was counted",
    );
    assertEquals(result.processed, true);
    assertEquals(result.taken, 1);
    assertEquals(result.stopReason, "deadline");

    const refusals = log.entries.filter((e) => e.message.includes(TARGET_MARK));
    assertEquals(refusals.length, 1, "exactly one refusal line");
  } finally {
    resetRunTimelineForTests();
  }
});

Deno.test("merge-conflict drain after target - before the target both PRs are resolved (control)", async () => {
  setRunTimeline(oneHourTimeline());
  try {
    const log = makeRecordingLogger();
    let nowMs = START;
    const resolved: number[] = [];

    const result = await drainConflictingPrs({
      // Issue #1774: this PR is still open at the claim point.
      prLiveState: () =>
        Promise.resolve({ open: true, mergeable: "CONFLICTING" }),
      logger: log,
      findNext: queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]),
      acquireLease: alwaysLease,
      resolve: (conflict) => {
        resolved.push(conflict.prNumber);
        // Still well short of the target after each resolution.
        nowMs += 60 * 1000;
        return Promise.resolve({ processed: true, merged: true });
      },
      now: () => nowMs,
    });

    assertEquals(resolved, [1, 2]);
    assertEquals(result.merged, 2);
    assertEquals(result.stopReason, "queue-empty");
    assertEquals(
      log.entries.filter((e) => e.message.includes(TARGET_MARK)).length,
      0,
      "no refusal line before the target",
    );
  } finally {
    resetRunTimelineForTests();
  }
});

Deno.test("merge-conflict drain after target - with no timeline set the drain is unchanged (control)", async () => {
  resetRunTimelineForTests();
  const log = makeRecordingLogger();
  // Well past where a one-hour target would sit: with no timeline nothing
  // refuses.
  const nowMs = START + 2 * HOUR_MS;
  const resolved: number[] = [];

  const result = await drainConflictingPrs({
    // Issue #1774: this PR is still open at the claim point.
    prLiveState: () =>
      Promise.resolve({ open: true, mergeable: "CONFLICTING" }),
    logger: log,
    findNext: queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]),
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => nowMs,
  });

  assertEquals(resolved, [1, 2]);
  assertEquals(result.merged, 2);
  assertEquals(result.stopReason, "queue-empty");
  assertEquals(
    log.entries.filter((e) => e.message.includes(TARGET_MARK)).length,
    0,
    "no refusal line without a timeline",
  );
});
