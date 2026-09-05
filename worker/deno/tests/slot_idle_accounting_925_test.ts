/**
 * Per-slot idle accounting and the per-slot idle-task filer (Issue #925).
 *
 * What broke: every idle instrument — the idle-detect audit, the
 * idle-decision census and the idle-task filer — was gated on one per-cycle,
 * fleet-wide flag, `tracker.foundClaimableIssue`. A cycle does not end until
 * every lane settles, so when `s1` claimed an issue and worked it for 47
 * minutes the flag stayed true for the whole 47 minutes, and `s2` — which
 * re-scanned every 30 seconds and found nothing, 74 times over — was never
 * counted as idle, never audited, and never triggered the filer. The run
 * recorded zero idle seconds, logged not one `idle-hooks` / `idle-census` /
 * `idle-detect` line, and filed zero idle-tasks.
 *
 * The gate asked "did the fleet claim anything?" when idle accounting needs
 * "is any slot doing nothing?". With more than one slot those differ.
 *
 * These tests cover the three things #925 asks for, and the two things that
 * must not regress with them:
 *
 *   - a slot with no claimable work is recorded as idle even while a sibling
 *     works, and runs the idle hooks (the exact 47-minute scenario);
 *   - the filer does not multiply — N slots idling together, or one slot
 *     re-scanning N times, file at most once per idle episode;
 *   - fleet utilisation reports occupied slot-seconds against available
 *     slot-seconds, so `1 of 2 slots busy` reads as 50%;
 *   - quota waits are booked as blocked, never as idle (Issue #855's
 *     vocabulary, reused);
 *   - the gate is NOT widened back to `scanHadSuccess` (Issue #2048,
 *     symptom in #2046), and the audit runs wherever the filer runs so
 *     `mis_classification` (Issue #898) does not start firing every cycle.
 *
 * A minimal RunCoreDeps mock is rebuilt locally, matching the convention in
 * the other run_core test files. No sleeps, no processes, no network: the
 * clock is injected and the busy slot is held by a promise the test resolves.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import {
  formatSlotUtilisation,
  IdleFilerLatch,
  SlotIdleLedger,
} from "../lib/slot_idle_accounting.ts";

// ---------------------------------------------------------------------------
// Helpers
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

function issue(repo: string, n: number): DiscoveredIssue {
  return { repo, issueNumber: n, issueTitle: `t${n}`, milestoneTitle: "" };
}

/** A promise the test resolves by hand, so nothing has to sleep. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * A fleet where `busyRepos.length` issues exist and everything else scans
 * empty, so the remaining slots idle beside busy siblings.
 *
 * The busy slots park in `processIssue` until `release()` is called, which
 * is how one slot is held occupied while its sibling re-scans — no timers,
 * no sleeps. Every injected `sleep` advances the injected clock, so an idle
 * slot's re-scan wait is real elapsed time to the accounting under test.
 */
async function runFleet(opts: {
  slots: number;
  busyRepos: string[];
  /** Empty scans (across all idle slots) to observe before releasing. */
  emptyScansBeforeRelease: number;
  overrides?: Partial<RunCoreDeps>;
}): Promise<{ logs: string[]; filerCalls: number; audits: unknown[] }> {
  const logs: string[] = [];
  const audits: {
    scanFoundClaimable: boolean;
    scanExcludedRepos: readonly string[];
  }[] = [];
  let filerCalls = 0;
  let emptyScans = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  config.maxConcurrentIssues = opts.slots;
  config.runDurationSeconds = 600;
  const endTime = config.runDurationSeconds * 1000;
  const busy = gate();
  // Opened once every busy slot is actually inside `processIssue`. An idle
  // slot's scan waits on it, so "no eligible work while a sibling works" is
  // deterministic rather than a race against the sibling's acquire.
  const busyStarted = gate();
  let started = 0;
  const pending = opts.busyRepos.map((repo, i) => issue(repo, i + 1));

  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    log: (m: string) => logs.push(m),
    findNextIssue: async (options?: { excludeRepos?: ReadonlySet<string> }) => {
      const idx = pending.findIndex((i) => !options?.excludeRepos?.has(i.repo));
      if (idx >= 0) {
        const [next] = pending.splice(idx, 1);
        return { ok: true as const, value: next! };
      }
      await busyStarted.promise;
      emptyScans++;
      if (emptyScans === opts.emptyScansBeforeRelease) {
        // The busy slot finishes and the cycle deadline passes, so the run
        // ends without any test-side timer.
        now = endTime + 1;
        busy.open();
      }
      return { ok: true as const, value: null };
    },
    processIssue: async () => {
      started++;
      if (started === opts.busyRepos.length) busyStarted.open();
      await busy.promise;
      return { ok: true as const, value: { success: true } };
    },
    runIdleTaskFiler: () => {
      filerCalls++;
      return Promise.resolve();
    },
    runIdleDetectAudit: (info) => {
      audits.push({
        scanFoundClaimable: info.scanFoundClaimable,
        scanExcludedRepos: [...info.scanExcludedRepos],
      });
      return Promise.resolve({ claimableTotal: 0 });
    },
    ...opts.overrides,
  });

  await runCoreLoop(config, deps);
  return { logs, filerCalls, audits };
}

/** The last `slot-utilisation:` line the run emitted. */
function utilisationLine(logs: string[]): string {
  const lines = logs.filter((m) => m.startsWith("slot-utilisation:"));
  assert(lines.length > 0, "expected a slot-utilisation line");
  return lines[lines.length - 1]!;
}

/**
 * Read `key=<n>s` (or `key=<n>`) out of a structured summary line.
 *
 * Split rather than a constructed `RegExp`: the fields are space-separated,
 * so a plain scan reads them without building a pattern from a variable —
 * which is what semgrep's `detect-non-literal-regexp` rule flags.
 */
function field(line: string, key: string): string {
  const prefix = `${key}=`;
  const token = line.split(" ").find((part) => part.startsWith(prefix));
  assert(token !== undefined, `no ${key} in: ${line}`);
  return token.slice(prefix.length);
}

// ---------------------------------------------------------------------------
// The 47-minute scenario
// ---------------------------------------------------------------------------

Deno.test(
  "one slot busy, one slot with no claimable work: the idle slot is recorded idle and the filer runs (Issue #925)",
  async () => {
    const { logs, filerCalls, audits } = await runFleet({
      slots: 2,
      busyRepos: ["o/busy"],
      emptyScansBeforeRelease: 4,
    });

    // The failure this issue was filed for: zero lines, zero idle-tasks.
    const idleHookLines = logs.filter((m) => m.includes("[idle-hooks]"));
    assert(
      idleHookLines.some((m) => m.includes("invoking=idle-task-filer")),
      `expected an [idle-hooks] invoking line from the idle slot; got ${
        JSON.stringify(idleHookLines)
      }`,
    );
    assertEquals(filerCalls, 1, "the idle slot filed exactly one idle-task");

    // The line is attributed to the slot that had nothing to do, and reports
    // that slot's own observation — not the fleet's.
    const slotLine = idleHookLines.find((m) =>
      /^\[s\d+] \[idle-hooks]/.test(m)
    );
    assert(
      slotLine !== undefined,
      `expected a slot-attributed [idle-hooks] line; got ${
        JSON.stringify(idleHookLines)
      }`,
    );
    assertStringIncludes(slotLine, "foundClaimableIssue=false");

    // Its idle seconds are recorded as idle, by slot name.
    const line = utilisationLine(logs);
    assert(
      Number(field(line, "idle").replace("s", "")) > 0,
      `expected idle slot-seconds > 0 in: ${line}`,
    );
    assert(
      Number(field(line, "occupied").replace("s", "")) > 0,
      `expected occupied slot-seconds > 0 in: ${line}`,
    );
    assert(
      /idle_by_slot=s\d+=\d+s/.test(line),
      `expected a named idle slot in: ${line}`,
    );
    assert(
      /occupied_by_slot=s\d+=\d+s/.test(line),
      `expected a named occupied slot in: ${line}`,
    );

    // The audit ran wherever the filer ran and told the truth about this slot.
    //
    // Issue #1091: the sibling's repository is deliberately **not** excluded
    // any more. Issue #898 excluded it because the scan skipped the whole
    // repository unseen, so the two instruments had never disagreed about it;
    // a slot's hold now occupies one work stream, the scan evaluates every
    // other stream of that repository, and a disagreement about them is real
    // evidence rather than an artefact of the hold. Only the maintenance
    // lane's whole-repository lease still reaches this set.
    assert(audits.length > 0, "the audit ran at the slot's gate");
    const slotAudit = audits[0] as {
      scanFoundClaimable: boolean;
      scanExcludedRepos: readonly string[];
    };
    assertEquals(slotAudit.scanFoundClaimable, false);
    assertEquals(
      [...slotAudit.scanExcludedRepos],
      [],
      `a sibling slot's hold must not hide its repository from the audit; got ${
        JSON.stringify(slotAudit.scanExcludedRepos)
      }`,
    );
  },
);

Deno.test(
  "a busy sibling no longer hides the idle slot from fleet utilisation (Issue #925)",
  async () => {
    const { logs } = await runFleet({
      slots: 2,
      busyRepos: ["o/busy"],
      emptyScansBeforeRelease: 4,
    });
    const line = utilisationLine(logs);
    assertStringIncludes(line, "slots=2");
    const occupiedPct = Number(field(line, "occupied_pct"));
    assert(
      occupiedPct > 0 && occupiedPct < 100,
      `1 of 2 slots busy must not read as 100% utilisation: ${line}`,
    );
    // The other half of the same claim: the slot that was doing nothing has
    // to appear, by name, with seconds against it. Before Issue #925 its
    // time was simply absent from every instrument.
    const idlePct = Number(field(line, "idle_pct"));
    assert(idlePct > 0, `the idle slot's share must be visible: ${line}`);
    assert(
      /idle_by_slot=s\d+=[1-9]\d*s/.test(line),
      `expected a named idle slot with non-zero seconds in: ${line}`,
    );
  },
);

Deno.test(
  "two slots idling beside a busy one file two idle-tasks, one each (Issues #925, #1083)",
  async () => {
    // Documented business-logic change (Issue #1083). This test used to
    // assert one filing for the whole host, which is what held four Vibe
    // Coders with eight slots at a single idle task. An idle slot is a
    // fault, not a resting state, so each idle slot may raise one idle task
    // — and no more: the bound is the fleet's idle capacity, here three
    // configured slots less the one holding a claim. Eight empty scans by
    // those two slots are still one episode, so eight filings would be the
    // #925 defect and are what the count below rules out.
    const { filerCalls } = await runFleet({
      slots: 3,
      busyRepos: ["o/busy"],
      emptyScansBeforeRelease: 8,
    });
    assertEquals(
      filerCalls,
      2,
      "two idle slots may each file once; re-scans must not multiply it",
    );
  },
);

Deno.test(
  "a slot re-scanning many times files once, not once per scan (Issue #925)",
  async () => {
    const { filerCalls, audits } = await runFleet({
      slots: 2,
      busyRepos: ["o/busy"],
      emptyScansBeforeRelease: 12,
    });
    assertEquals(filerCalls, 1, "one idle episode, one idle-task");
    assertEquals(
      audits.length,
      1,
      "and one audit — 74 empty scans must not become 74 probes",
    );
  },
);

Deno.test(
  "a whole-fleet idle cycle still files exactly once from the cycle gate (Issue #925)",
  async () => {
    // No claimable work anywhere: every slot stops with no sibling running,
    // which is the pre-#925 path. It must behave exactly as it did — one
    // idle-task per cycle — and must not double-file with the slot path.
    let filerCalls = 0;
    let now = 0;
    const logs: string[] = [];
    const config = createDefaultRunCoreConfig();
    config.maxConcurrentIssues = 2;
    config.runDurationSeconds = 60;
    const deps = createMockDeps({
      now: () => now,
      sleep: (ms?: number) => {
        now += ms ?? 30_000;
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      runIdleTaskFiler: () => {
        filerCalls++;
        return Promise.resolve();
      },
    });
    await runCoreLoop(config, deps);
    const invoking = logs.filter((m) =>
      m.includes("[idle-hooks]") && m.includes("invoking=idle-task-filer")
    );
    assert(invoking.length >= 1, "the cycle gate still logs its decision");
    assertEquals(
      filerCalls,
      invoking.length,
      "one idle-task per idle cycle, exactly as before Issue #925",
    );
    assert(
      invoking.every((m) => !m.startsWith("[s")),
      "with no sibling running, the cycle gate files — not a slot",
    );
    assert(
      !logs.some((m) => m.includes("reason=slot_already_filed")),
      "nothing to suppress: no slot filed this cycle",
    );
  },
);

Deno.test(
  "an adjacent repo's priority work does not open the gate: scanHadSuccess stays out of it (Issue #925, guarding Issue #2048)",
  async () => {
    // Issue #2048 narrowed the gate from `scanHadSuccess` to
    // `foundClaimableIssue` because a PR-feedback pass in an adjacent repo
    // was suppressing the filer (#2046). Widening it back would undo that,
    // so a cycle whose only work was PR feedback must still file.
    const logs: string[] = [];
    let now = 0;
    let feedbackDone = false;
    const config = createDefaultRunCoreConfig();
    config.maxConcurrentIssues = 2;
    config.runDurationSeconds = 60;
    const deps = createMockDeps({
      now: () => now,
      sleep: (ms?: number) => {
        now += ms ?? 30_000;
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      findAndProcessPrFeedback: () => {
        if (feedbackDone) {
          return Promise.resolve({ ok: true, value: { processed: false } });
        }
        feedbackDone = true;
        return Promise.resolve({ ok: true, value: { processed: true } });
      },
      runIdleTaskFiler: () => Promise.resolve(),
    });
    await runCoreLoop(config, deps);
    // The cycle whose only work was the PR-feedback pass: `scanHadSuccess`
    // is true, `foundClaimableIssue` is false, and the filer must still run.
    assert(
      logs.some((m) =>
        m.includes("[idle-hooks]") &&
        m.includes("scanHadSuccess=true") &&
        m.includes("foundClaimableIssue=false") &&
        m.includes("invoking=idle-task-filer")
      ),
      `a claimless cycle must still file even though scanHadSuccess is true; got ${
        JSON.stringify(logs.filter((m) => m.includes("[idle-hooks]")))
      }`,
    );
  },
);

// ---------------------------------------------------------------------------
// The ledger itself
// ---------------------------------------------------------------------------

Deno.test(
  "SlotIdleLedger - one of two slots busy for the whole window is 50% utilisation (Issue #925)",
  () => {
    const ledger = new SlotIdleLedger();
    ledger.start(0, 2);
    ledger.setSlotActivity("s1", "claim", 0);
    ledger.setSlotActivity("s2", "idle", 0);
    const snapshot = ledger.snapshot(100_000);

    assertEquals(snapshot.slots, 2);
    assertEquals(snapshot.wallSeconds, 100);
    assertEquals(snapshot.availableSlotSeconds, 200);
    assertEquals(snapshot.occupiedSlotSeconds, 100);
    assertEquals(snapshot.idleSlotSeconds, 100);
    assertEquals(snapshot.utilisation, 0.5);
    assertEquals(snapshot.idleBySlot, { s2: 100 });
    assertEquals(snapshot.occupiedBySlot, { s1: 100 });
    assertEquals(snapshot.unstaffedSlotSeconds, 0);
  },
);

Deno.test(
  "SlotIdleLedger - a slot idling beside a busy sibling accrues idle seconds under its own name (Issue #925)",
  () => {
    const ledger = new SlotIdleLedger();
    ledger.start(0, 2);
    ledger.setSlotActivity("s1", "claim", 0);
    ledger.setSlotActivity("s2", "idle", 0);
    // s2 re-scans repeatedly: one continuous idle span, not a fragment each.
    for (let t = 30_000; t <= 120_000; t += 30_000) {
      ledger.setSlotActivity("s2", "idle", t);
    }
    ledger.retireSlot("s2", 120_000);
    assertEquals(ledger.snapshot(120_000).idleBySlot, { s2: 120 });
  },
);

Deno.test(
  "SlotIdleLedger - everything a claim does is occupied, including its tests (Issue #925)",
  () => {
    const ledger = new SlotIdleLedger();
    ledger.start(0, 1);
    ledger.setSlotActivity("s1", "idle", 0);
    ledger.setSlotActivity("s1", "claim", 10_000);
    // The claim runs setup, the agent, the test suite and the quality gate.
    ledger.setSlotActivity("s1", "idle", 90_000);
    const snapshot = ledger.snapshot(100_000);
    assertEquals(snapshot.occupiedSlotSeconds, 80);
    assertEquals(snapshot.idleSlotSeconds, 20);
  },
);

Deno.test(
  "SlotIdleLedger - a quota wait is blocked slot-seconds, never idle (Issue #925)",
  () => {
    const ledger = new SlotIdleLedger();
    ledger.start(0, 2);
    // No slot exists while the loop waits for the quota to refresh.
    ledger.recordBlockedSlotSeconds("token_blocked", 30);
    ledger.recordBlockedSlotSeconds("rate_limited", 20);
    const snapshot = ledger.snapshot(100_000);
    assertEquals(snapshot.idleSlotSeconds, 0);
    assertEquals(snapshot.blockedSlotSeconds, 100);
    assertEquals(snapshot.blockedByReason, {
      token_blocked: 60,
      rate_limited: 40,
    });
    // The remainder is capacity with no slot running — reported, not idle.
    assertEquals(snapshot.unstaffedSlotSeconds, 100);
  },
);

Deno.test(
  "SlotIdleLedger - a slot stopped by a quota is counted under that quota's reason (Issue #925)",
  () => {
    const ledger = new SlotIdleLedger();
    ledger.start(0, 2);
    ledger.recordBlockedStop("rate_limited");
    ledger.recordBlockedStop("rate_limited");
    ledger.recordBlockedStop("token_blocked");
    assertEquals(ledger.snapshot(1000).blockedStops, {
      rate_limited: 2,
      token_blocked: 1,
    });
  },
);

Deno.test(
  "formatSlotUtilisation - one machine-readable line naming occupied against available (Issue #925)",
  () => {
    const ledger = new SlotIdleLedger();
    ledger.start(0, 2);
    ledger.setSlotActivity("s1", "claim", 0);
    ledger.setSlotActivity("s2", "idle", 0);
    const line = formatSlotUtilisation(ledger.snapshot(100_000));
    assertStringIncludes(line, "slot-utilisation:");
    assertStringIncludes(line, "slots=2");
    assertStringIncludes(line, "available=200s");
    assertStringIncludes(line, "occupied=100s");
    assertStringIncludes(line, "occupied_pct=50.0");
    assertStringIncludes(line, "idle=100s");
    assertStringIncludes(line, "idle_pct=50.0");
    assertStringIncludes(line, "occupied_by_slot=s1=100s");
    assertStringIncludes(line, "idle_by_slot=s2=100s");
    assertStringIncludes(line, "blocked_by_reason=none");
  },
);

// ---------------------------------------------------------------------------
// The latch
// ---------------------------------------------------------------------------

// Documented business-logic change (Issue #1083): the latch no longer refuses
// every observer after the first. A second *slot* going idle is exactly what
// the operator wants filled, so the bound is the fleet's idle capacity, not
// one. What #925 was really protecting — one slot re-scanning 74 times must
// not file 74 issues — is unchanged, and is what these two tests now pin. The
// capacity case lives in `idle_task_capacity_1083_test.ts`.

Deno.test(
  "IdleFilerLatch - a one-slot fleet files once per episode however often it re-scans (Issues #925, #1083)",
  () => {
    // Default capacity is one slot, so the second observer is refused for
    // want of capacity rather than on principle.
    const latch = new IdleFilerLatch();
    assertEquals(latch.tryConsume("s1"), true, "s1 observes an empty scan");
    assertEquals(
      latch.tryConsume("s1"),
      false,
      "s1 re-scans and observes again",
    );
    assertEquals(
      latch.tryConsume("s2"),
      false,
      "one idle slot grants one permit",
    );
    assertEquals(latch.fired, true);
    assertEquals(latch.filedCount, 1);
  },
);

Deno.test(
  "IdleFilerLatch - a claim ends the episode, so a later idle stretch may file again (Issue #925)",
  () => {
    const latch = new IdleFilerLatch();
    assertEquals(latch.tryConsume("s1"), true);
    latch.release(); // a slot took a claim — the fleet has work again
    assertEquals(latch.fired, false);
    assertEquals(latch.tryConsume("s1"), true);
  },
);
