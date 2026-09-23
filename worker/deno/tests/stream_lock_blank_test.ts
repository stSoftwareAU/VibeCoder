/**
 * Tests for the host-local blank-stream lock (Issue #2335).
 *
 * The blank stream — a repository's issues carrying no milestone — owns one
 * conversation **per host**, so the lock is in-process and consults no GitHub
 * state: a host's slots never run two of that repository's non-milestone
 * issues at once, and two hosts may hold the same blank stream in parallel,
 * each with its own conversation.
 *
 * Every test drives the real registry, the real refusal wording, and the real
 * `runCoreLoop` slot pool. Nothing greps source text.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type BlankStreamHold,
  BlankStreamLockRegistry,
  type BlankStreamLockResult,
  checkMilestoneStreamBusy,
  formatBlankStreamBusy,
} from "../lib/stream_lock.ts";
import { streamKey } from "../lib/stream_identity.ts";
import {
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreDeps,
  runCoreLoop,
  scanExcludedIssues,
} from "../lib/run_core.ts";
import { InFlightRepoRegistry } from "../lib/in_flight_repos.ts";
import { waitUntil } from "./support/rendezvous.ts";

const REPO = "stSoftwareAU/VibeCoder";
const OTHER = "stSoftwareAU/Graft";
const MILESTONE = "#2319 session resume on by default";

/** The hold behind a refusal — fails the test when the call was allowed. */
function refusedBy(result: BlankStreamLockResult): BlankStreamHold {
  if (result.acquired) {
    throw new Error(
      "expected the blank stream to be refused, but the slot took it",
    );
  }
  return result.holder;
}

// ---------------------------------------------------------------------------
// The registry: one blank stream per host, keyed by the conversation's key
// ---------------------------------------------------------------------------

Deno.test("blank stream lock - a sibling slot cannot take a blank stream this host already holds", () => {
  const locks = new BlankStreamLockRegistry(() => 1_000);
  const first = locks.tryAcquire({
    repo: REPO,
    issueNumber: 900,
    slotId: "s0",
  });
  assertEquals(first, { acquired: true, locked: true });

  const holder = refusedBy(locks.tryAcquire({
    repo: REPO,
    issueNumber: 901,
    slotId: "s1",
  }));
  assertEquals(holder.slotId, "s0");
  assertEquals(holder.issueNumber, 900);
  assertEquals(holder.streamKey, streamKey({ repo: REPO }));
  assertEquals(holder.sinceMs, 1_000);
  assertEquals(locks.size, 1);
});

Deno.test("blank stream lock - the refusal line names the stream and the holding slot", () => {
  const locks = new BlankStreamLockRegistry();
  locks.tryAcquire({ repo: REPO, issueNumber: 900, slotId: "s0" });
  const holder = refusedBy(locks.tryAcquire({
    repo: REPO,
    issueNumber: 901,
    slotId: "s1",
  }));
  assertEquals(
    formatBlankStreamBusy(holder),
    `stream busy: ${REPO} (blank) held by slot s0 on #900`,
  );
});

Deno.test("blank stream lock - blank streams of two repositories are held at once", () => {
  const locks = new BlankStreamLockRegistry();
  assertEquals(
    locks.tryAcquire({ repo: REPO, issueNumber: 900, slotId: "s0" }).acquired,
    true,
  );
  assertEquals(
    locks.tryAcquire({ repo: OTHER, issueNumber: 12, slotId: "s1" }).acquired,
    true,
    "a different repository is a different blank stream",
  );
  assertEquals(locks.size, 2);
});

Deno.test("blank stream lock - a milestone issue takes no host-local lock", () => {
  // The two locks never both apply to one issue: a milestone issue is gated
  // by the fleet-wide check of Issue #2334 and by nothing here, so two
  // sub-issues of one milestone are never refused by this registry.
  const locks = new BlankStreamLockRegistry();
  assertEquals(
    locks.tryAcquire({
      repo: REPO,
      milestoneTitle: MILESTONE,
      issueNumber: 2335,
      slotId: "s0",
    }),
    { acquired: true, locked: false },
  );
  assertEquals(
    locks.tryAcquire({
      repo: REPO,
      milestoneTitle: MILESTONE,
      issueNumber: 2336,
      slotId: "s1",
    }),
    { acquired: true, locked: false },
  );
  assertEquals(locks.size, 0, "a milestone issue must store no hold");
  // …and it leaves the repository's blank stream free.
  assertEquals(
    locks.tryAcquire({ repo: REPO, issueNumber: 900, slotId: "s2" }).acquired,
    true,
  );
});

Deno.test("blank stream lock - release frees the stream and is idempotent", () => {
  const locks = new BlankStreamLockRegistry();
  locks.tryAcquire({ repo: REPO, issueNumber: 900, slotId: "s0" });
  locks.release({ repo: REPO });
  assertEquals(locks.size, 0);
  // Releasing a stream nobody holds is a no-op, not a throw — the run-end
  // `finally` must be safe to call on every path.
  locks.release({ repo: REPO });
  locks.release({ repo: REPO, milestoneTitle: MILESTONE });
  assertEquals(
    locks.tryAcquire({ repo: REPO, issueNumber: 901, slotId: "s1" }).acquired,
    true,
  );
});

Deno.test("blank stream lock - a whitespace-only milestone title is the same blank stream", () => {
  // The conversation is keyed by `streamKey`, which trims, so `" "` and an
  // absent title are one stream. Keying the lock any other way would let two
  // slots into one conversation — the exact failure this lock prevents.
  const locks = new BlankStreamLockRegistry();
  assertEquals(
    locks.tryAcquire({ repo: REPO, issueNumber: 900, slotId: "s0" }).acquired,
    true,
  );
  const holder = refusedBy(locks.tryAcquire({
    repo: REPO,
    milestoneTitle: "   ",
    issueNumber: 901,
    slotId: "s1",
  }));
  assertEquals(
    holder.slotId,
    "s0",
    "a whitespace-only title resolves to the blank stream",
  );
});

Deno.test("blank stream lock - a repository that is not owner/name fails open, loudly", () => {
  const locks = new BlankStreamLockRegistry();
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    assertEquals(
      locks.tryAcquire({ repo: "not-a-repo", issueNumber: 1, slotId: "s0" }),
      { acquired: true, locked: false },
    );
    locks.release({ repo: "not-a-repo" });
  } finally {
    console.warn = original;
  }
  assertEquals(locks.size, 0);
  assert(
    warnings.some((line) => line.includes("stream_unresolved")),
    `the refusal must be reported, not swallowed: ${warnings.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// The blank path makes no `gh` call for locking
// ---------------------------------------------------------------------------

Deno.test("blank stream lock - locking a blank stream makes no gh call at all", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("[]");
  };
  // The fleet-wide milestone check is skipped entirely for a blank stream…
  const fleet = await checkMilestoneStreamBusy({
    repo: REPO,
    issueNumber: 900,
    ghCommandFn,
  });
  assertEquals(fleet, { busy: false });
  // …and the host-local lock has no `gh` runner to call in the first place.
  const locks = new BlankStreamLockRegistry();
  locks.tryAcquire({ repo: REPO, issueNumber: 900, slotId: "s0" });
  locks.tryAcquire({ repo: REPO, issueNumber: 901, slotId: "s1" });
  locks.release({ repo: REPO });
  assertEquals(
    calls,
    [],
    `no gh call may be made for locking: ${JSON.stringify(calls)}`,
  );
});

// ---------------------------------------------------------------------------
// The refusal holds the issue out of the next scan only while the stream is
// busy — the next scan after the holder releases can claim it
// ---------------------------------------------------------------------------

Deno.test("blank stream lock - the refused issue leaves the scan's exclusion set the moment the holder releases", () => {
  const locks = new BlankStreamLockRegistry();
  locks.tryAcquire({ repo: REPO, issueNumber: 900, slotId: "s1" });
  // What the refusing slot records: the issue it could not take, and the
  // stream to re-check.
  const streamBusy = new Map([[
    `${REPO}#901`,
    { repo: REPO, milestoneTitle: "" },
  ]]);
  const deferred = new Set([`${OTHER}#7`]);

  // While the sibling holds the stream, the issue stays out of the scan so
  // the slot is offered a different candidate instead.
  assertEquals(
    [...scanExcludedIssues(deferred, locks, streamBusy)].sort(),
    [`${OTHER}#7`, `${REPO}#901`],
  );

  // Once the run ends the exclusion lifts on the very next scan — a
  // cycle-scoped deferral would have stranded #901 for the rest of the run.
  locks.release({ repo: REPO });
  assertEquals(
    [...scanExcludedIssues(deferred, locks, streamBusy)],
    [`${OTHER}#7`],
    "the issue must be claimable again as soon as the stream frees",
  );
  assertEquals(streamBusy.size, 0, "the stale entry must be pruned, not kept");
  // The pool's own deferrals are never mutated by the pruning.
  assertEquals([...deferred], [`${OTHER}#7`]);
});

Deno.test("slot registry - a milestone issue a sibling slot holds is kept out of the next scan (Issue #2532)", () => {
  // Since Issue #2532 the scan offers a `top-priority`/`work-on` issue in a
  // milestone stream a sibling slot on this host holds, and
  // `InFlightRepoRegistry.tryAcquire` then refuses it. Without the exclusion
  // the slot would invalidate the repo's cache and re-scan onto the same
  // refused issue for as long as the sibling's run lasted.
  const registry = new InFlightRepoRegistry();
  assertEquals(
    registry.tryAcquire(REPO, 837, "s1", { milestone: "Priority streams" }),
    true,
  );
  const locks = new BlankStreamLockRegistry();
  const streamBusy = new Map([[
    `${REPO}#843`,
    { repo: REPO, milestoneTitle: "Priority streams" },
  ]]);
  const deferred = new Set<string>();

  assertEquals(
    [...scanExcludedIssues(deferred, locks, streamBusy, registry)],
    [`${REPO}#843`],
  );

  // And it frees the moment the sibling run ends — the same self-healing the
  // blank-stream refusal has.
  registry.release(REPO, "Priority streams");
  assertEquals(
    [...scanExcludedIssues(deferred, locks, streamBusy, registry)],
    [],
  );
  assertEquals(streamBusy.size, 0);
});

// ---------------------------------------------------------------------------
// The slot pool: two slots, one blank stream
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<RunCoreDeps>): RunCoreDeps {
  return {
    log: () => {},
    logError: () => {},
    logTiming: () => {},
    logWorkerSummary: () => {},
    checkPidFile: () => Promise.resolve({ canProceed: true, message: "OK" }),
    claimPidFile: () => Promise.resolve(),
    releasePidFile: () => Promise.resolve(),
    gitResetToOrigin: () => Promise.resolve({ ok: true, value: undefined }),
    setupLogging: () => Promise.resolve(),
    loadAndValidateConfig: () =>
      Promise.resolve({ ok: true, value: createDefaultRunCoreConfig() }),
    checkDependencies: () => Promise.resolve({ ok: true, value: undefined }),
    checkSoftwareUpdates: () => Promise.resolve(),
    checkDiskSpace: () => Promise.resolve({ ok: true, value: undefined }),
    rotateLogFiles: () => Promise.resolve(),
    cleanupStaleTempFiles: () => Promise.resolve(),
    recoverStuckIssues: () => Promise.resolve(),
    cleanupStaleBranches: () => Promise.resolve(),
    checkFeatureAvailability: () => Promise.resolve(),
    checkClaudeHealth: () =>
      Promise.resolve({ ok: true, value: { healthy: true } }),
    checkGhAuth: () => Promise.resolve({ ok: true, value: { valid: true } }),
    findAndProcessPrFeedback: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessSpellingFailure: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessCiFailure: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    updateOpenPrBranches: () => Promise.resolve({ ok: true, value: undefined }),
    nudgeStalledCi: () => Promise.resolve({ ok: true, value: undefined }),
    ensureAutoMerge: () => Promise.resolve({ ok: true, value: undefined }),
    cleanupMergedBranches: () =>
      Promise.resolve({ ok: true, value: undefined }),
    closeIssuesForMergedPrs: () =>
      Promise.resolve({ ok: true, value: undefined }),
    recoverAssignedWithClosedPr: () =>
      Promise.resolve({ ok: true, value: undefined }),
    syncMilestoneBranches: () =>
      Promise.resolve({ ok: true, value: undefined }),
    checkMilestoneCompletions: () =>
      Promise.resolve({ ok: true, value: undefined }),
    findAndProcessRefinement: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessGrillMe: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessQuestion: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessPlanning: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    scanStaleWorkflowIssues: () =>
      Promise.resolve({ ok: true, value: undefined }),
    findNextIssue: () => Promise.resolve({ ok: true, value: null }),
    processIssue: () => Promise.resolve({ ok: true, value: { success: true } }),
    trackFailure: () => Promise.resolve(),
    resetFailures: () => Promise.resolve(),
    shouldExitOnFailures: () => Promise.resolve(false),
    recordIssueCooldown: () => Promise.resolve(),
    circuitBreakerReset: () => Promise.resolve(),
    circuitBreakerRecordZeroProgress: () => Promise.resolve(),
    circuitBreakerGetSleepInterval: () => Promise.resolve(30),
    isRateLimitActive: () => Promise.resolve(false),
    getRateLimitRemainingSeconds: () => Promise.resolve(0),
    getRateLimitReset: () =>
      Promise.resolve(Math.floor(Date.now() / 1000) + 3600),
    preflightGitHubRateLimit: () =>
      Promise.resolve({
        rateLimited: false,
        remainingSeconds: 0,
        message: "ok",
      }),
    resetRepoFailures: () => Promise.resolve(),
    recordRepoFailure: () => Promise.resolve(),
    recordRepoSuccess: () => Promise.resolve(),
    sendCrashNotification: () => Promise.resolve(),
    clearHeartbeat: () => Promise.resolve(),
    cleanupInProgressIssue: () => Promise.resolve(),
    setStatusIdle: () => Promise.resolve(),
    setStatusWorking: () => Promise.resolve(),
    setStatusSuccess: () => Promise.resolve(),
    setStatusFailure: () => Promise.resolve(),
    resetWindowTitle: () => {},
    addSignalListener: () => {},
    removeSignalListener: () => {},
    writeFaultToleranceSummary: () => Promise.resolve(),
    touchPidFile: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
    now: () => 0,
    ...overrides,
  };
}

function discovered(
  repo: string,
  issueNumber: number,
  milestoneTitle: string,
): DiscoveredIssue {
  return { repo, issueNumber, issueTitle: `t${issueNumber}`, milestoneTitle };
}

/**
 * Drive the two-slot pool over `backlog` and report what each slot did.
 *
 * `findNextIssue` deliberately hides **nothing**: the production scan's own
 * occupancy overlay is not modelled here, so every refusal in the result comes
 * from the locks under test rather than from the mock. `excludeIssues` is
 * honoured because that is how a slot's refusal reaches the next scan.
 */
async function runPool(options: {
  backlog: DiscoveredIssue[];
  enableSessionResume: boolean;
  /** Issues whose run throws instead of succeeding. */
  throwOn?: ReadonlySet<number>;
  locks?: BlankStreamLockRegistry;
}): Promise<{ claimed: string[]; logs: string[] }> {
  const config = {
    ...createDefaultRunCoreConfig(),
    maxConcurrentIssues: 2,
    enableSessionResume: options.enableSessionResume,
  };
  const cycleMs = config.runDurationSeconds * 1000;
  let now = 0;
  const logs: string[] = [];
  const claimed: string[] = [];
  const remaining = [...options.backlog];
  const inFlightRepos = new InFlightRepoRegistry();
  const locks = options.locks ?? new BlankStreamLockRegistry();

  const deps = createMockDeps({
    now: () => now,
    inFlightRepos,
    blankStreamLocks: locks,
    log: (message: string) => logs.push(message),
    logError: (message: string) => logs.push(message),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: (scanOptions) =>
      Promise.resolve({
        ok: true,
        value: remaining.find((issue) =>
          !scanOptions?.excludeIssues?.has(
            `${issue.repo}#${issue.issueNumber}`,
          )
        ) ?? null,
      }),
    processIssue: async (issue) => {
      remaining.splice(remaining.indexOf(issue), 1);
      claimed.push(`${issue.repo}#${issue.issueNumber}`);
      // Hold the claim until the sibling has resolved its own scan, so the
      // assertions are about concurrency rather than about sequencing. A
      // condition rather than a fixed sleep (Issue #1098): a loaded host only
      // makes the wait longer, never the answer different, and the bound means
      // a regression fails an assertion instead of hanging.
      await waitUntil(() => remaining.length === 0);
      now = cycleMs + 1;
      if (options.throwOn?.has(issue.issueNumber)) {
        throw new Error(`run for #${issue.issueNumber} aborted`);
      }
      return { ok: true, value: { success: true } };
    },
  });

  await runCoreLoop(config, deps);
  return { claimed, logs };
}

Deno.test("blank stream lock - the blocked slot logs stream busy and picks a different eligible issue", async () => {
  // Two non-milestone issues of one repository, two slots. One slot must take
  // the repository's blank stream; the other must say so and move on to the
  // eligible issue in another repository rather than idling the scan.
  const { claimed, logs } = await runPool({
    enableSessionResume: true,
    backlog: [
      discovered(REPO, 900, ""),
      discovered(REPO, 901, ""),
      discovered(OTHER, 12, ""),
    ],
  });

  const busy = logs.filter((line) => line.includes("stream busy:"));
  assert(
    busy.some((line) => line.includes(`${REPO} (blank) held by slot`)),
    `the blocked slot must name the busy stream: ${logs.join(" | ")}`,
  );
  assert(
    claimed.includes(`${OTHER}#12`),
    `the blocked slot must move on to other eligible work, not idle: ${
      JSON.stringify(claimed)
    }`,
  );
  // …and never two of the one repository's non-milestone issues at once.
  assert(
    !(claimed.includes(`${REPO}#900`) && claimed.includes(`${REPO}#901`)),
    `one blank stream per host: ${JSON.stringify(claimed)}`,
  );
});

Deno.test("blank stream lock - non-milestone issues of two repositories both run", async () => {
  const { claimed } = await runPool({
    enableSessionResume: true,
    backlog: [discovered(REPO, 900, ""), discovered(OTHER, 12, "")],
  });
  assertEquals(
    claimed.sort(),
    [`${OTHER}#12`, `${REPO}#900`],
    "two repositories' blank streams are independent conversations",
  );
});

Deno.test("blank stream lock - a run that throws releases the host-local lock", async () => {
  const locks = new BlankStreamLockRegistry();
  const { claimed } = await runPool({
    enableSessionResume: true,
    backlog: [discovered(REPO, 900, "")],
    throwOn: new Set([900]),
    locks,
  });
  assertEquals(claimed, [`${REPO}#900`]);
  assertEquals(
    locks.size,
    0,
    "an aborted run must not leak the lock — the next scan could never claim",
  );
  // The stream is genuinely claimable again, not merely absent from the map.
  assertEquals(
    locks.tryAcquire({ repo: REPO, issueNumber: 901, slotId: "s0" }).acquired,
    true,
  );
});

Deno.test("blank stream lock - enable_session_resume off takes no host-local lock", async () => {
  const locks = new BlankStreamLockRegistry();
  const { claimed, logs } = await runPool({
    enableSessionResume: false,
    backlog: [discovered(REPO, 900, "")],
    locks,
  });
  assertEquals(claimed, [`${REPO}#900`]);
  assertEquals(
    locks.size,
    0,
    "with no shared conversation there is no stream to lock",
  );
  assert(
    !logs.some((line) => line.includes("stream busy:")),
    `no stream-busy refusal may be reported with the flag off: ${
      logs.join(" | ")
    }`,
  );
});
