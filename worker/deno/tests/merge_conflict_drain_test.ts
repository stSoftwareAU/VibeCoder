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

// ---------------------------------------------------------------------------
// The budget one resolution is actually given (Issue #1693)
// ---------------------------------------------------------------------------

Deno.test("drainConflictingPrs - refuses to start a resolution the cycle cannot cover", async () => {
  // GRQ-25 on NEAT-AI-core#637: the handler had 736s left, the drain started a
  // six-file AI-fallback resolution anyway, and the watchdog SIGTERMed the
  // agent at 11m13s — charged to the PR as a failed attempt.
  let asked = 0;
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: () => {
      asked += 1;
      return Promise.resolve(pr("org/alpha", 1));
    },
    acquireLease: alwaysLease,
    resolve: () => {
      throw new Error("must not start a resolution the cycle cannot finish");
    },
    now: () => 1_000_000,
    deadlineEpochMs: 1_000_000 + 736 * 1000,
    agentTimeoutMs: 60 * 60 * 1000,
  });

  assertEquals(asked, 0);
  assertEquals(result.taken, 0);
  assertEquals(result.stopReason, "deadline");
});

Deno.test("drainConflictingPrs - never grants an agent more time than the budget left", async () => {
  const granted: (number | undefined)[] = [];
  const remainingMs = 30 * 60 * 1000;
  await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/alpha", 1)]),
    acquireLease: alwaysLease,
    resolve: (_conflict, budget) => {
      granted.push(budget?.agentTimeoutSeconds);
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => 1_000_000,
    deadlineEpochMs: 1_000_000 + remainingMs,
    // The configured timeout is twice what the cycle has left.
    agentTimeoutMs: 60 * 60 * 1000,
  });

  assertEquals(granted.length, 1);
  const seconds = granted[0];
  assert(seconds !== undefined, "the resolution was given no budget");
  // Strictly inside the handler budget, with the attempt's non-agent work
  // (clone, merge, conclusion) reserved out of it.
  assert(
    seconds * 1000 < remainingMs,
    `granted ${seconds}s of a ${remainingMs / 1000}s budget`,
  );
  assertEquals(seconds, (30 - 4) * 60);
});

Deno.test("drainConflictingPrs - grants the configured agent timeout when it fits", async () => {
  const granted: (number | undefined)[] = [];
  await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/alpha", 1)]),
    acquireLease: alwaysLease,
    resolve: (_conflict, budget) => {
      granted.push(budget?.agentTimeoutSeconds);
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => 1_000_000,
    deadlineEpochMs: 1_000_000 + 90 * 60 * 1000,
    agentTimeoutMs: 30 * 60 * 1000,
  });

  assertEquals(granted, [30 * 60]);
});

Deno.test("drainConflictingPrs - a pass that declares no agent timeout grants none", async () => {
  const granted: (number | undefined)[] = [];
  await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/alpha", 1)]),
    acquireLease: alwaysLease,
    resolve: (_conflict, budget) => {
      granted.push(budget?.agentTimeoutSeconds);
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => 1_000_000,
    deadlineEpochMs: 1_000_000 + 90 * 60 * 1000,
  });

  assertEquals(granted, [undefined]);
});

Deno.test("drainConflictingPrs - an attempt the run ended stops the pass", async () => {
  // The withdrawal means the run itself is ending (Issue #1693). Taking the
  // next PR would open an attempt marker and immediately withdraw it too.
  const resolved: number[] = [];
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]),
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({
        processed: false,
        merged: false,
        attemptCharged: false,
        runEnded: true,
      });
    },
    now: () => 1_000_000,
    deadlineEpochMs: 1_000_000 + 90 * 60 * 1000,
    agentTimeoutMs: 30 * 60 * 1000,
  });

  assertEquals(resolved, [1]);
  assertEquals(result.stopReason, "deadline");
  assertEquals(result.merged, 0);
});

Deno.test("drainConflictingPrs - an uncharged attempt that reached an answer does not stop the pass (Issue #1772)", async () => {
  // A push a ruleset refused is uncharged too, but it says nothing about the
  // run's remaining time. Stopping there would starve every other conflicting
  // PR in the cycle under a log line naming the wrong cause.
  const resolved: number[] = [];
  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]),
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({
        processed: false,
        merged: false,
        attemptCharged: false,
      });
    },
    now: () => 1_000_000,
    deadlineEpochMs: 1_000_000 + 90 * 60 * 1000,
    agentTimeoutMs: 30 * 60 * 1000,
  });

  assertEquals(resolved, [1, 2], "the queue is drained, not abandoned");
  assertEquals(result.stopReason, "queue-empty");
});

// ---------------------------------------------------------------------------
// Issue #1774 — the queue's listing is up to ten minutes old
// ---------------------------------------------------------------------------

Deno.test("drainConflictingPrs - a PR closed since the listing is skipped, not resolved", async () => {
  const log = makeRecordingLogger();
  const resolved: number[] = [];
  const leased: number[] = [];

  const result = await drainConflictingPrs({
    logger: log,
    findNext: queueFinder([pr("org/alpha", 1732), pr("org/beta", 2)]),
    prLiveState: (conflict) =>
      Promise.resolve(
        conflict.prNumber === 1732
          ? { open: false, state: "CLOSED" }
          : { open: true },
      ),
    acquireLease: (conflict) => {
      leased.push(conflict.prNumber);
      return { release: () => {} };
    },
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
  });

  assertEquals(resolved, [2], "the closed PR must never reach the resolution");
  assertEquals(leased, [2], "and must not even take the repo lease");
  assertEquals(result.merged, 1);
  assert(
    log.entries.some((e) => e.message.includes("skipped: PR closed")),
    "the skip line must be logged",
  );
  const decision = log.entries.find((e) =>
    e.message === `${DECISION_PREFIX}pr-not-open org/alpha pr=1732` ||
    (e.message.startsWith(DECISION_PREFIX) &&
      e.context?.reason === "pr-not-open")
  );
  assert(decision, "the skip must be recorded as a decision");
  assertEquals(decision.context?.state, "CLOSED");
  assertEquals(decision.context?.prNumber, 1732);
});

Deno.test("drainConflictingPrs - a PR merged since the listing is skipped", async () => {
  const log = makeRecordingLogger();
  const resolved: number[] = [];

  await drainConflictingPrs({
    logger: log,
    findNext: queueFinder([pr("org/alpha", 7)]),
    prLiveState: () => Promise.resolve({ open: false, state: "MERGED" }),
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
  });

  assertEquals(resolved, []);
  assert(log.entries.some((e) => e.message.includes("skipped: PR merged")));
});

Deno.test("drainConflictingPrs - an unreadable state skips the PR without an attempt", async () => {
  const log = makeRecordingLogger();
  const resolved: number[] = [];

  const result = await drainConflictingPrs({
    logger: log,
    findNext: queueFinder([pr("org/alpha", 5)]),
    prLiveState: () =>
      Promise.resolve({ unknown: true, error: "gh: timed out" }),
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
  });

  assertEquals(resolved, [], "unknown must never be treated as open");
  assertEquals(result.merged, 0);
  assertEquals(result.processed, false);
  // No attempt was opened, so nothing was charged against the PR's budget.
  assertEquals(
    result.decisions.filter((d) => d.outcome === "attempted").length,
    0,
  );
  const decision = result.decisions.find((d) =>
    d.outcome === "skipped" && d.reason.kind === "pr-not-open"
  );
  assert(decision && decision.outcome === "skipped");
  assertEquals(
    decision.reason.kind === "pr-not-open" ? decision.reason.state : undefined,
    "UNKNOWN",
  );
  assert(
    log.entries.some((e) => e.message.includes("skipped: PR state unknown")),
  );
});

Deno.test("drainConflictingPrs - an open PR is resolved exactly as before", async () => {
  const resolved: number[] = [];
  const reads: number[] = [];

  const result = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/alpha", 1), pr("org/beta", 2)]),
    prLiveState: (conflict) => {
      reads.push(conflict.prNumber);
      return Promise.resolve({ open: true });
    },
    acquireLease: alwaysLease,
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
  });

  assertEquals(reads, [1, 2], "one live read per claim");
  assertEquals(resolved, [1, 2]);
  assertEquals(result.merged, 2);
  assertEquals(result.stopReason, "queue-empty");
});
