/**
 * Tests for the drain's fairness and visibility (Issue #1111).
 *
 * The lease, the deadline and the cap each drop a due PR. `findNext` is
 * re-consulted from scratch every pass with the same ordering, so the PR that
 * loses once loses forever and nothing is written on the PR — the #1076
 * symptom without a launcher outage or a gate bug.
 *
 * Every test here drives **two consecutive** `drainConflictingPrs` calls over
 * a fixed fleet, with a fresh tracking object each pass reading a shared
 * in-memory volume: that is the simulated restart, so nothing can pass on
 * run-local state. Each fairness test carries a control pass with no cursor,
 * which is what today's code does — it takes the same PR first both times.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ConflictDeferralTracking,
  type ConflictDrainOptions,
  drainConflictingPrs,
} from "../lib/merge_conflict_drain.ts";
import {
  announceDeferralStreak,
  CONFLICT_DEFERRAL_FILE,
  type ConflictDeferralIo,
  readConflictDeferrals,
  writeConflictDeferrals,
} from "../lib/merge_conflict_deferrals.ts";
import { orderByPreference } from "../lib/conflict_queue_order.ts";
import {
  type ConflictingPr,
  conflictPrKey,
  DEFAULT_MAX_CONFLICT_ATTEMPTS,
  hasExhaustedConflictAttempts,
  parseConflictAttempts,
} from "../lib/pr_merge_conflict_scan.ts";
import type { LogContext, Logger } from "../types.ts";

const WORK_DIR = "/work";
const HOUR = 3600_000;
const START = 1_700_000_000_000;
/** The worker's own login — the only author the notice dedup trusts. */
const FLEET = "vibe-bot";

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

interface RecordingLogger extends Logger {
  entries: { message: string; context?: LogContext }[];
}

function makeRecordingLogger(): RecordingLogger {
  const entries: { message: string; context?: LogContext }[] = [];
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

/** The work volume, shared across passes so a restart keeps the cursor. */
function fakeVolume(): { files: Map<string, string>; io: ConflictDeferralIo } {
  const files = new Map<string, string>();
  return {
    files,
    io: {
      readTextFile: (path) => {
        const data = files.get(path);
        return data === undefined
          ? Promise.reject(new Deno.errors.NotFound(path))
          : Promise.resolve(data);
      },
      writeTextFile: (path, data) => {
        files.set(path, data);
        return Promise.resolve();
      },
    },
  };
}

/**
 * A queue that honours both seams the way `findConflictingPr` does: it skips
 * what this cycle already handled, and offers the cursor's PRs first.
 */
function queueFinder(
  queue: readonly ConflictingPr[],
): ConflictDrainOptions["findNext"] {
  return (exclude, prefer) =>
    Promise.resolve(
      orderByPreference(
        queue,
        (p) => conflictPrKey(p.repo, p.prNumber),
        prefer,
      ).find((p) => !exclude.has(conflictPrKey(p.repo, p.prNumber))) ?? null,
    );
}

/** A PR comment thread every simulated host reads and writes. */
function fakeThread() {
  const comments = new Map<
    string,
    { body: string; user: { login: string } }[]
  >();
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      const path = args[1] ?? "";
      const match = /repos\/(.+)\/issues\/(\d+)\/comments/.exec(path);
      assert(match, `unexpected api path: ${path}`);
      const key = `${match[1]}#${match[2]}`;
      const page = path.includes("page=1") ? comments.get(key) ?? [] : [];
      return Promise.resolve(JSON.stringify(page));
    }
    if (args[0] === "pr" && args[1] === "comment") {
      const key = `${args[4]}#${args[2]}`;
      const thread = comments.get(key) ?? [];
      thread.push({ body: args[6] ?? "", user: { login: FLEET } });
      comments.set(key, thread);
      return Promise.resolve("");
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return {
    ghCommandFn,
    bodiesFor: (repo: string, prNumber: number) =>
      comments.get(`${repo}#${prNumber}`) ?? [],
  };
}

/**
 * One host's tracking seams, built fresh for every pass — nothing survives in
 * process memory, only on the volume.
 */
function tracking(
  volume: { io: ConflictDeferralIo },
  now: () => number,
  extra: Partial<ConflictDeferralTracking> = {},
): ConflictDeferralTracking {
  return {
    load: () => readConflictDeferrals(WORK_DIR, volume.io, now()),
    save: (state) => writeConflictDeferrals(WORK_DIR, state, volume.io, now()),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Fairness: one test per bound, two consecutive passes each
// ---------------------------------------------------------------------------

Deno.test("drain fairness - a PR the lease deferred leads the next pass", async () => {
  const volume = fakeVolume();
  const nowMs = START;
  const held = pr("org/held", 1);

  // Pass one: an issue slot holds org/held, so PR 1 is deferred untouched.
  const firstResolved: number[] = [];
  const first = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([held, pr("org/free", 2)]),
    acquireLease: (conflict) =>
      conflict.repo === "org/held" ? null : { release: () => {} },
    resolve: (conflict) => {
      firstResolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => nowMs,
    deferrals: tracking(volume, () => nowMs),
  });

  assertEquals(firstResolved, [2]);
  assertEquals(first.deferred, 1);
  assertEquals(first.maxDeferralStreak, 1);

  // Pass two, on a queue where PR 1 is now last: without the cursor the same
  // ordering puts it last again, for ever.
  const queue = [pr("org/free", 3), pr("org/free", 4), held];
  const secondResolved: number[] = [];
  await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder(queue),
    acquireLease: () => ({ release: () => {} }),
    resolve: (conflict) => {
      secondResolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => nowMs + HOUR,
    deferrals: tracking(volume, () => nowMs + HOUR),
  });

  assertEquals(secondResolved[0], 1, "the deferred PR must lead the next pass");

  // The control: the same second pass with no cursor at all — today's code.
  const control: number[] = [];
  await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder(queue),
    acquireLease: () => ({ release: () => {} }),
    resolve: (conflict) => {
      control.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
  });
  assertEquals(
    control[0],
    3,
    "without the cursor the queue order is unchanged",
  );
});

Deno.test("drain fairness - a PR the deadline left behind leads the next pass", async () => {
  const volume = fakeVolume();
  let nowMs = START;
  const left = pr("org/alpha", 2);

  const first = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/alpha", 1), left]),
    acquireLease: () => ({ release: () => {} }),
    resolve: () => {
      // The first resolution eats most of the cycle.
      nowMs += 9 * 60 * 1000;
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => nowMs,
    deadlineEpochMs: START + 10 * 60 * 1000,
    minMsPerAttempt: 5 * 60 * 1000,
    deferrals: tracking(volume, () => nowMs),
  });

  assertEquals(first.stopReason, "deadline");
  assertEquals(first.leftBehind, 1, "the PR the deadline dropped is named");
  assertEquals(first.decisions.at(-1), {
    repo: "org/alpha",
    prNumber: 2,
    outcome: "skipped",
    reason: { kind: "deferred-bound", bound: "deadline", deferralStreak: 1 },
  });

  const resolved: number[] = [];
  await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/beta", 7), pr("org/alpha", 8), left]),
    acquireLease: () => ({ release: () => {} }),
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
    now: () => nowMs + HOUR,
    deferrals: tracking(volume, () => nowMs + HOUR),
  });

  assertEquals(resolved[0], 2);
});

Deno.test("drain fairness - a PR the cap left behind leads the next pass", async () => {
  const volume = fakeVolume();
  const nowMs = START;
  const left = pr("org/busy", 3);

  const first = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/busy", 1), pr("org/busy", 2), left]),
    acquireLease: () => ({ release: () => {} }),
    resolve: () => Promise.resolve({ processed: true, merged: true }),
    maxPerCycle: 2,
    now: () => nowMs,
    deferrals: tracking(volume, () => nowMs),
  });

  assertEquals(first.stopReason, "cap");
  assertEquals(first.leftBehind, 1);
  assertEquals(first.decisions.at(-1), {
    repo: "org/busy",
    prNumber: 3,
    outcome: "skipped",
    reason: { kind: "deferred-bound", bound: "cap", deferralStreak: 1 },
  });

  const resolved: number[] = [];
  await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/busy", 4), pr("org/busy", 5), left]),
    acquireLease: () => ({ release: () => {} }),
    resolve: (conflict) => {
      resolved.push(conflict.prNumber);
      return Promise.resolve({ processed: true, merged: true });
    },
    maxPerCycle: 2,
    now: () => nowMs + HOUR,
    deferrals: tracking(volume, () => nowMs + HOUR),
  });

  assertEquals(resolved[0], 3);
});

Deno.test("drain fairness - the cursor is on the volume, not in the process", async () => {
  const volume = fakeVolume();
  const nowMs = START;

  await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([pr("org/held", 1)]),
    acquireLease: () => null,
    resolve: () => {
      throw new Error("a deferred PR must never be resolved");
    },
    now: () => nowMs,
    deferrals: tracking(volume, () => nowMs),
  });

  // What a restarted process would read: the file, and nothing else.
  const path = `${WORK_DIR}/${CONFLICT_DEFERRAL_FILE}`;
  assert(volume.files.has(path));
  const reread = await readConflictDeferrals(WORK_DIR, volume.io, nowMs + HOUR);
  assertEquals(reread.get("org/held#1")?.streak, 1);
  assertEquals(reread.get("org/held#1")?.bound, "repo-leased");
});

Deno.test("drain fairness - an attempt clears the streak", async () => {
  const volume = fakeVolume();
  const nowMs = START;
  const target = pr("org/held", 1);

  for (let pass = 0; pass < 2; pass++) {
    await drainConflictingPrs({
      logger: makeSilentLogger(),
      findNext: queueFinder([target]),
      acquireLease: () => null,
      resolve: () => Promise.resolve({ processed: true, merged: false }),
      now: () => nowMs,
      deferrals: tracking(volume, () => nowMs),
    });
  }
  assertEquals(
    (await readConflictDeferrals(WORK_DIR, volume.io, nowMs)).get("org/held#1")
      ?.streak,
    2,
  );

  // The lease frees up and the PR is finally attempted.
  const attempted = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([target]),
    acquireLease: () => ({ release: () => {} }),
    resolve: () => Promise.resolve({ processed: true, merged: true }),
    now: () => nowMs,
    deferrals: tracking(volume, () => nowMs),
  });

  assertEquals(attempted.merged, 1);
  assertEquals(
    (await readConflictDeferrals(WORK_DIR, volume.io, nowMs)).has("org/held#1"),
    false,
    "an attempted PR is not a starved one",
  );
});

// ---------------------------------------------------------------------------
// Visibility: one comment per streak, and never a spent budget
// ---------------------------------------------------------------------------

Deno.test("drain fairness - an attempt that never ran leaves the streak standing", async () => {
  // `resolve` returning null is an attempt that never got off the ground — a
  // clone that would not set up, a branch that is gone. Nothing was tried, so
  // the PR is still waiting and must keep its place at the head of the queue.
  const volume = fakeVolume();
  const nowMs = START;
  const target = pr("org/held", 1);

  await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([target]),
    acquireLease: () => null,
    resolve: () => Promise.resolve(null),
    now: () => nowMs,
    deferrals: tracking(volume, () => nowMs),
  });

  const stillborn = await drainConflictingPrs({
    logger: makeSilentLogger(),
    findNext: queueFinder([target]),
    acquireLease: () => ({ release: () => {} }),
    resolve: () => Promise.resolve(null),
    now: () => nowMs,
    deferrals: tracking(volume, () => nowMs),
  });

  assertEquals(stillborn.merged, 0);
  assertEquals(
    (await readConflictDeferrals(WORK_DIR, volume.io, nowMs)).get("org/held#1")
      ?.streak,
    1,
  );
});

Deno.test("drain visibility - a starved PR gets exactly one comment per streak", async () => {
  const volume = fakeVolume();
  const thread = fakeThread();
  const target = pr("org/held", 1);
  let nowMs = START;

  const runPass = () =>
    drainConflictingPrs({
      logger: makeSilentLogger(),
      findNext: queueFinder([target]),
      acquireLease: () => null,
      resolve: () => {
        throw new Error("a deferred PR must never be resolved");
      },
      now: () => nowMs,
      deferrals: tracking(volume, () => nowMs, {
        announce: (notice) =>
          announceDeferralStreak(notice, {
            ghCommandFn: thread.ghCommandFn,
            isTrustedAuthor: (login) => login === FLEET,
          }),
      }),
    });

  // Two passes inside one cooldown window: deferred, but not yet starved.
  await runPass();
  nowMs += HOUR;
  await runPass();
  assertEquals(thread.bodiesFor("org/held", 1).length, 0);

  // The third, five hours after the first: the streak has earned its comment.
  nowMs += 4 * HOUR;
  const third = await runPass();
  assertEquals(third.deferralNotices, 1);
  const bodies = thread.bodiesFor("org/held", 1);
  assertEquals(bodies.length, 1);
  assert(bodies[0]?.body.includes('n="3"'));
  assert(bodies[0]?.body.includes('bound="repo-leased"'));

  // A fourth deferral in the same streak adds nothing.
  nowMs += HOUR;
  const fourth = await runPass();
  assertEquals(fourth.deferralNotices, 0);
  assertEquals(thread.bodiesFor("org/held", 1).length, 1);

  // A second host, with its own volume and its own streak, finds the marker
  // on the PR and stays quiet — a per-process guard would post again here.
  const otherHost = fakeVolume();
  let hostBNow = START;
  for (let pass = 0; pass < 3; pass++) {
    await drainConflictingPrs({
      logger: makeSilentLogger(),
      findNext: queueFinder([target]),
      acquireLease: () => null,
      resolve: () => Promise.resolve({ processed: false, merged: false }),
      now: () => hostBNow,
      deferrals: tracking(otherHost, () => hostBNow, {
        announce: (notice) =>
          announceDeferralStreak(notice, {
            ghCommandFn: thread.ghCommandFn,
            isTrustedAuthor: (login) => login === FLEET,
          }),
      }),
    });
    hostBNow += 3 * HOUR;
  }
  assertEquals(thread.bodiesFor("org/held", 1).length, 1);
});

Deno.test("drain visibility - five deferrals spend neither budget", async () => {
  const volume = fakeVolume();
  const thread = fakeThread();
  const target = pr("org/held", 1);
  let nowMs = START;

  for (let pass = 0; pass < 5; pass++) {
    const result = await drainConflictingPrs({
      logger: makeSilentLogger(),
      findNext: queueFinder([target]),
      acquireLease: () => null,
      resolve: () => {
        throw new Error("nothing may be started for a deferred PR");
      },
      now: () => nowMs,
      deferrals: tracking(volume, () => nowMs, {
        announce: (notice) =>
          announceDeferralStreak(notice, {
            ghCommandFn: thread.ghCommandFn,
            isTrustedAuthor: (login) => login === FLEET,
          }),
      }),
    });
    assertEquals(result.taken, 1);
    assertEquals(result.deferred, 1);
    nowMs += 5 * HOUR;
  }

  assertEquals(
    (await readConflictDeferrals(WORK_DIR, volume.io, nowMs)).get("org/held#1")
      ?.streak,
    5,
  );

  // The scan's own parser, over the thread the drain wrote: a deferral must
  // read as no attempt at all — not as a concluded one, not as a disrupted
  // one. Reusing the disruption counter here would escalate this PR to a
  // human for a bound it never hit, which is the opposite of #1076's goal.
  const history = parseConflictAttempts(thread.bodiesFor("org/held", 1));
  assertEquals(history.count, 0);
  assertEquals(history.disruptedCount, 0);
  assertEquals(history.pendingAttempt, false);
  assertEquals(target.attemptCount, 0);
  assertEquals(target.disruptedCount, 0);
  assertEquals(
    hasExhaustedConflictAttempts(history.count, DEFAULT_MAX_CONFLICT_ATTEMPTS),
    false,
    "both attempts must still be available after five deferrals",
  );
});

Deno.test("drain visibility - the summary carries the streak, not just the stop", async () => {
  const volume = fakeVolume();
  let nowMs = START;
  const target = pr("org/held", 1);

  for (let pass = 0; pass < 2; pass++) {
    await drainConflictingPrs({
      logger: makeSilentLogger(),
      findNext: queueFinder([target]),
      acquireLease: () => null,
      resolve: () => Promise.resolve({ processed: false, merged: false }),
      now: () => nowMs,
      deferrals: tracking(volume, () => nowMs),
    });
    nowMs += HOUR;
  }

  const log = makeRecordingLogger();
  const result = await drainConflictingPrs({
    logger: log,
    findNext: queueFinder([target]),
    acquireLease: () => null,
    resolve: () => Promise.resolve({ processed: false, merged: false }),
    now: () => nowMs,
    deferrals: tracking(volume, () => nowMs),
  });

  assertEquals(result.maxDeferralStreak, 3);
  const decision = log.entries.find((e) =>
    e.message.startsWith("merge_conflict_decision=")
  );
  assertEquals(decision?.context?.reason, "repo-leased");
  assertEquals(decision?.context?.deferralStreak, 3);

  const summary = log.entries.find((e) =>
    e.message.startsWith("merge_conflict_pass=")
  );
  assertEquals(summary?.context?.maxDeferralStreak, 3);
  assertEquals(summary?.context?.deferralNotices, 0);
});

Deno.test("drain fairness - a broken volume costs fairness, never the pass", async () => {
  const log = makeRecordingLogger();
  // Both ends of the cursor are broken, not just the write: a load that
  // throws must degrade to "no cursor this cycle" exactly as a save does.
  const broken: ConflictDeferralTracking = {
    load: () => Promise.reject(new Error("volume gone")),
    save: () => Promise.reject(new Error("volume gone")),
  };

  const failed = await drainConflictingPrs({
    logger: log,
    findNext: queueFinder([pr("org/alpha", 1)]),
    acquireLease: () => ({ release: () => {} }),
    resolve: () => Promise.resolve({ processed: true, merged: true }),
    deferrals: broken,
  }).catch((error: Error) => error);

  assert(
    !(failed instanceof Error),
    "an unreadable or unwritable cursor must not fail the pass",
  );
  assertEquals(failed.merged, 1);
  for (const said of ["could not read the deferral", "could not persist the"]) {
    assert(
      log.entries.some((e) => e.message.includes(said)),
      `a broken cursor must be said out loud: ${said}`,
    );
  }
});

Deno.test("drain visibility - a notice that cannot be posted warns and is retried", async () => {
  const volume = fakeVolume();
  const log = makeRecordingLogger();
  const nowMs = START;
  const target = pr("org/held", 1);
  const state = new Map();
  // Two deferrals already banked, five hours apart: the next one earns the
  // notice.
  state.set("org/held#1", {
    streak: 2,
    bound: "repo-leased" as const,
    firstDeferredAtMs: nowMs - 5 * HOUR,
    lastDeferredAtMs: nowMs - HOUR,
  });
  await writeConflictDeferrals(WORK_DIR, state, volume.io, nowMs);

  const result = await drainConflictingPrs({
    logger: log,
    findNext: queueFinder([target]),
    acquireLease: () => null,
    resolve: () => Promise.resolve(null),
    now: () => nowMs,
    deferrals: tracking(volume, () => nowMs, {
      announce: () => Promise.reject(new Error("gh comment exploded")),
    }),
  });

  assertEquals(result.deferralNotices, 0);
  assert(
    log.entries.some((e) => e.message.includes("could not post the deferral")),
    "a notice that could not be posted must never be silent",
  );
  // Unmarked, so the next pass tries again rather than assuming it landed.
  assertEquals(
    (await readConflictDeferrals(WORK_DIR, volume.io, nowMs)).get("org/held#1")
      ?.notifiedAtStreak,
    undefined,
  );
});
