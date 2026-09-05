/**
 * Tests for merge_conflict_drain.ts — emptying the conflict queue within one
 * cycle (Issue #561).
 *
 * The pass used to take one PR per cycle, so a second conflicting PR waited
 * most of an hour behind the first while the open-PR gate held new issue
 * claims behind both. These tests pin the drain and, just as importantly, the
 * three bounds that stop it becoming a monopoly.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ConflictDrainOptions,
  DEFAULT_MAX_CONFLICTS_PER_CYCLE,
  drainConflictingPrs,
} from "../lib/merge_conflict_drain.ts";
import type { ConflictingPr } from "../lib/pr_merge_conflict_scan.ts";
import type { LogContext, Logger } from "../types.ts";

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** Message prefix of a per-PR decision record (Issue #1109). */
const DECISION_PREFIX = "merge_conflict_decision=";
/** Message prefix of the pass-level summary record (Issue #1109). */
const SUMMARY_PREFIX = "merge_conflict_pass=";

interface LogEntry {
  message: string;
  context?: LogContext;
}

interface RecordingLogger extends Logger {
  entries: LogEntry[];
}

/** A logger that keeps what it was told, so the records can be asserted. */
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

/** The pass-level summary the drain closes with. */
function summaryOf(log: RecordingLogger): LogEntry {
  const entry = log.entries.find((e) => e.message.startsWith(SUMMARY_PREFIX));
  assert(entry, "the drain emitted no summary record");
  return entry;
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

Deno.test("drainConflictingPrs - takes every due PR, not one per cycle", async () => {
  const resolved: number[] = [];
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([
      pr("org/alpha", 1),
      pr("org/beta", 2),
      pr("org/gamma", 3),
    ]),
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
  });

  assertEquals(resolved, [1, 2, 3]);
  assertEquals(result.taken, 3);
  assertEquals(result.merged, 3);
  assertEquals(result.processed, true);
  assertEquals(result.stopReason, "queue-empty");
});

Deno.test("drainConflictingPrs - an empty queue does nothing and says so", async () => {
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: () => Promise.resolve(null),
    acquireLease: alwaysLease,
    resolve: () => {
      throw new Error("must not resolve anything");
    },
  });

  assertEquals(result.taken, 0);
  assertEquals(result.processed, false);
  assertEquals(result.stopReason, "queue-empty");
});

Deno.test("drainConflictingPrs - a leased-out repo is skipped, never re-selected", async () => {
  // The bug this guards: the scan would keep returning the PR whose repo an
  // issue slot holds, and the drain would spin on it for the whole cycle.
  const resolved: number[] = [];
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/held", 1), pr("org/free", 2)]),
    acquireLease: (conflict) =>
      conflict.repo === "org/held" ? null : { release: () => {} },
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
  });

  assertEquals(resolved, [2]);
  assertEquals(result.deferred, 1);
  assertEquals(result.taken, 2);
  assertEquals(result.stopReason, "queue-empty");
});

Deno.test("drainConflictingPrs - a failed resolution does not stall the queue", async () => {
  // A null outcome is a loud failure the wiring already logged. The PR keeps
  // its own attempt budget; the drain moves on to the next one.
  const attempted: number[] = [];
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]),
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      attempted.push(conflict.prNumber);
      return Promise.resolve(
        conflict.prNumber === 1 ? null : { processed: true, merged: true },
      );
    },
  });

  assertEquals(attempted, [1, 2]);
  assertEquals(result.merged, 1);
  assertEquals(result.taken, 2);
});

Deno.test("drainConflictingPrs - the lease is released even when the attempt throws", async () => {
  const released: string[] = [];
  let thrown: unknown = null;
  try {
    await drainConflictingPrs({
      logger: makeSilentLogger(),
      findNext: queueFinder([pr("org/alpha", 1)]),
      acquireLease: (conflict) => ({
        release: () => released.push(conflict.repo),
      }),
      resolve: () => Promise.reject(new Error("agent exploded")),
    });
  } catch (err) {
    thrown = err;
  }

  assertEquals(released, ["org/alpha"]);
  assertEquals((thrown as Error).message, "agent exploded");
});

Deno.test("drainConflictingPrs - stops when too little of the cycle remains", async () => {
  // Starting an agent run that the deadline will abandon spends a third of
  // the PR's disrupted-attempt budget for nothing (Issue #395).
  const resolved: number[] = [];
  let nowMs = 1_000_000;
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]),
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      // The first resolution eats most of the cycle.
      nowMs += 9 * 60 * 1000;
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => nowMs,
    deadlineEpochMs: 1_000_000 + 10 * 60 * 1000,
    minMsPerAttempt: 5 * 60 * 1000,
  });

  assertEquals(resolved, [1]);
  assertEquals(result.stopReason, "deadline");
});

Deno.test("drainConflictingPrs - a pass with no room starts nothing", async () => {
  let asked = 0;
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: () => {
      asked += 1;
      return Promise.resolve(pr("org/alpha", 1));
    },
    acquireLease: alwaysLease,
    resolve: () => {
      throw new Error("must not start a resolution with no room");
    },
    now: () => 1_000_000,
    deadlineEpochMs: 1_000_060,
  });

  assertEquals(asked, 0);
  assertEquals(result.taken, 0);
  assertEquals(result.stopReason, "deadline");
});

Deno.test("drainConflictingPrs - one repo's backlog cannot take the whole run", async () => {
  const queue = Array.from(
    { length: DEFAULT_MAX_CONFLICTS_PER_CYCLE + 3 },
    (_, i) => pr("org/busy", i + 1),
  );
  const resolved: number[] = [];
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder(queue),
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
  });

  assertEquals(resolved.length, DEFAULT_MAX_CONFLICTS_PER_CYCLE);
  assertEquals(result.stopReason, "cap");
});

// ---------------------------------------------------------------------------
// Decision records (Issue #1109)
//
// The drain adds three exits of its own to the scan's — the deadline, the cap
// and a repository an issue slot holds — and each must leave a reason behind.
// ---------------------------------------------------------------------------

Deno.test("drainConflictingPrs - a deferred PR records repo-leased", async () => {
  const log = makeRecordingLogger();
  const result = await drainConflictingPrs({
    logger: log,
    findNext: queueFinder([pr("org/held", 1), pr("org/free", 2)]),
    acquireLease: (conflict) =>
      conflict.repo === "org/held" ? null : { release: () => {} },
    resolve: () => Promise.resolve({ processed: true, merged: true }),
  });

  assertEquals(result.decisions, [
    {
      repo: "org/held",
      prNumber: 1,
      outcome: "skipped",
      reason: { kind: "repo-leased" },
    },
    { repo: "org/free", prNumber: 2, outcome: "attempted" },
  ]);

  const record = log.entries.find((e) => e.message.startsWith(DECISION_PREFIX));
  assertEquals(record?.context?.reason, "repo-leased");
  assertEquals(record?.context?.repo, "org/held");
  assertEquals(record?.context?.prNumber, 1);

  const summary = summaryOf(log);
  assertEquals(summary.context?.labelled, 2);
  assertEquals(summary.context?.attempted, 1);
  assertEquals(summary.context?.byReason, { "repo-leased": 1 });
  assertEquals(summary.context?.stopReason, "queue-empty");
});

Deno.test("drainConflictingPrs - the summary names the cap and its bound", async () => {
  const log = makeRecordingLogger();
  const queue = Array.from(
    { length: DEFAULT_MAX_CONFLICTS_PER_CYCLE + 1 },
    (_, i) => pr("org/busy", i + 1),
  );

  const result = await drainConflictingPrs({
    logger: log,
    findNext: queueFinder(queue),
    acquireLease: alwaysLease,
    resolve: () => Promise.resolve({ processed: true, merged: true }),
  });

  assertEquals(result.stopReason, "cap");
  const summary = summaryOf(log);
  assertEquals(summary.context?.stopReason, "cap");
  assertEquals(summary.context?.maxPerCycle, DEFAULT_MAX_CONFLICTS_PER_CYCLE);
  assertEquals(summary.context?.attempted, DEFAULT_MAX_CONFLICTS_PER_CYCLE);
});

Deno.test("drainConflictingPrs - the summary names the deadline and what was left", async () => {
  const log = makeRecordingLogger();
  let nowMs = 1_000_000;

  const result = await drainConflictingPrs({
    logger: log,
    findNext: queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]),
    acquireLease: alwaysLease,
    resolve: () => {
      nowMs += 9 * 60 * 1000;
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => nowMs,
    deadlineEpochMs: 1_000_000 + 10 * 60 * 1000,
    minMsPerAttempt: 5 * 60 * 1000,
  });

  assertEquals(result.stopReason, "deadline");
  const summary = summaryOf(log);
  assertEquals(summary.context?.stopReason, "deadline");
  assertEquals(summary.context?.remainingMs, 60 * 1000);
});

Deno.test("drainConflictingPrs - an empty queue still says why it stopped", async () => {
  const log = makeRecordingLogger();

  const result = await drainConflictingPrs({
    logger: log,
    findNext: () => Promise.resolve(null),
    acquireLease: alwaysLease,
    resolve: () => {
      throw new Error("must not resolve anything");
    },
  });

  assertEquals(result.decisions, []);
  const summary = summaryOf(log);
  assertEquals(summary.context?.stopReason, "queue-empty");
  assertEquals(summary.context?.labelled, 0);
});
