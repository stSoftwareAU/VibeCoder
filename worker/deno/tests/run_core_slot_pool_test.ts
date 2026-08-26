/**
 * Tests for the concurrent issue-slot pool (Issue #4177, part of #4168).
 *
 * A minimal RunCoreDeps mock is rebuilt locally, matching the convention in
 * the other run_core test files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { InFlightRepoRegistry } from "../lib/in_flight_repos.ts";
import { reportRunDeadline } from "../lib/slot_context.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  currentWriteRepoAllowlistContext,
  enforceGhWriteAllowlist,
  isWriteRepoAllowed,
  listAllowedWriteRepos,
  pinWriteRepo,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  unpinWriteRepo,
  WriteRepoBlockedError,
} from "../lib/write_repo_allowlist.ts";
import type { DiagnosticSummary } from "../lib/issue_finder_logger.ts";

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

/** A queue of issues across distinct repos, honouring the exclusion set. */
function issueQueue(issues: DiscoveredIssue[]) {
  const pending = [...issues];
  return (options?: { excludeRepos?: ReadonlySet<string> }) => {
    const idx = pending.findIndex((i) => !options?.excludeRepos?.has(i.repo));
    if (idx < 0) return Promise.resolve({ ok: true as const, value: null });
    const [next] = pending.splice(idx, 1);
    return Promise.resolve({ ok: true as const, value: next! });
  };
}

function issue(repo: string, n: number): DiscoveredIssue {
  return { repo, issueNumber: n, issueTitle: `t${n}`, milestoneTitle: "" };
}

/** Run one cycle: the loop ends when the clock passes the deadline. */
async function runOneCycle(deps: RunCoreDeps, maxConcurrentIssues: number) {
  const config = { ...createDefaultRunCoreConfig(), maxConcurrentIssues };
  await runCoreLoop(config, deps);
}

Deno.test("slot pool - maxConcurrentIssues 1: high-water mark 1 and today's serial sequence (Issue #4177)", async () => {
  let inFlight = 0, high = 0;
  const calls: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([
      issue("o/a", 1),
      issue("o/b", 2),
      issue("o/c", 3),
    ]),
    processIssue: async (i) => {
      inFlight++;
      high = Math.max(high, inFlight);
      calls.push(`start ${i.repo}`);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      now += config.runDurationSeconds * 400; // each takes 40% of the cycle
      return { ok: true, value: { success: true } };
    },
  });
  await runOneCycle(deps, 1);
  assertEquals(high, 1);
  assert(calls.length >= 1);
});

Deno.test("slot pool - maxConcurrentIssues 3 with three repos: three processIssue calls in flight at once (Issue #4177)", async () => {
  let inFlight = 0, high = 0;
  const seen: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([
      issue("o/a", 1),
      issue("o/b", 2),
      issue("o/c", 3),
    ]),
    processIssue: async (i) => {
      inFlight++;
      high = Math.max(high, inFlight);
      seen.push(i.repo);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });
  await runOneCycle(deps, 3);
  assertEquals(high, 3, `expected 3 concurrent, saw ${high}`);
  assertEquals(new Set(seen).size, 3, "three distinct repos");
});

Deno.test("slot pool - the exclusion set keeps two slots out of the same repo (Issue #4176/#4177)", async () => {
  const seenRepos: string[] = [];
  const inFlightByRepo = new Map<string, number>();
  let clash = false;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    // Two issues in the SAME repo, one in another: at most one slot may be
    // in o/a at any moment.
    findNextIssue: issueQueue([
      issue("o/a", 1),
      issue("o/a", 2),
      issue("o/b", 3),
    ]),
    processIssue: async (i) => {
      const n = (inFlightByRepo.get(i.repo) ?? 0) + 1;
      inFlightByRepo.set(i.repo, n);
      if (n > 1) clash = true;
      seenRepos.push(i.repo);
      await new Promise((r) => setTimeout(r, 15));
      inFlightByRepo.set(i.repo, n - 1);
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });
  await runOneCycle(deps, 3);
  assertEquals(clash, false, "two slots must never share a repo");
});

Deno.test("slot pool - deadline reached mid-run: no slot starts a new claim (Issue #4177)", async () => {
  let finds = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const cycleMs = config.runDurationSeconds * 1000;
  const many = Array.from({ length: 12 }, (_, i) => issue(`o/r${i}`, i));
  const inner = issueQueue(many);
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: (o) => {
      finds++;
      return inner(o);
    },
    processIssue: async () => {
      await new Promise((r) => setTimeout(r, 5));
      now = cycleMs + 1; // the first completions push past the deadline
      return { ok: true, value: { success: false } };
    },
  });
  await runOneCycle(deps, 3);
  const findsAtDeadline = finds;
  // The 3 initial claims plus at most nothing after: once past the
  // deadline no slot calls findNextIssue again.
  assert(findsAtDeadline <= 3, `finds after deadline: ${findsAtDeadline}`);
});

Deno.test("slot pool - shouldExitOnFailures true in one slot: pool drains, exitOuterLoop, in-flight claims released (Issue #4177)", async () => {
  const released: string[] = [];
  let processed = 0;
  let now = 0;
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 9 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    processIssue: async () => {
      processed++;
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, value: { success: false } };
    },
    shouldExitOnFailures: () => Promise.resolve(true),
    releaseClaim: (repo, n) => {
      released.push(`${repo}#${n}`);
      return Promise.resolve();
    },
  });
  await runOneCycle(deps, 3);
  // Three slots start three issues; the exit verdict drains the pool — no
  // further claims beyond the initial ones.
  assert(processed <= 3, `processed ${processed}`);
  assertEquals(released.length, processed, "every in-flight claim released");
});

Deno.test("slot pool - a slot that throws does not kill siblings and does not leak its claim (Issue #4177)", async () => {
  const released: string[] = [];
  const done: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([
      issue("o/a", 1),
      issue("o/b", 2),
      issue("o/c", 3),
    ]),
    processIssue: async (i) => {
      await new Promise((r) => setTimeout(r, 5));
      if (i.repo === "o/b") throw new Error("boom in slot");
      done.push(i.repo);
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
    releaseClaim: (repo, n) => {
      released.push(`${repo}#${n}`);
      return Promise.resolve();
    },
  });
  await runOneCycle(deps, 3);
  assertEquals(done.sort(), ["o/a", "o/c"], "siblings finished");
  assert(released.includes("o/b#2"), "the thrown slot's claim was released");
});

Deno.test("slot pool - every terminal path releases the claim exactly once: success / skip / failure / throw (Issue #4178)", async () => {
  const releases = new Map<string, number>();
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([
      issue("o/success", 1),
      issue("o/skip", 2),
      issue("o/failure", 3),
      issue("o/throw", 4),
    ]),
    processIssue: async (i) => {
      await new Promise((r) => setTimeout(r, 5));
      switch (i.repo) {
        case "o/success":
          now += config.runDurationSeconds * 400;
          return { ok: true, value: { success: true } };
        case "o/skip":
          return { ok: true, value: { success: false, skipped: true } };
        case "o/failure":
          return { ok: true, value: { success: false } };
        default:
          throw new Error("boom");
      }
    },
    releaseClaim: (repo, n) => {
      const k = `${repo}#${n}`;
      releases.set(k, (releases.get(k) ?? 0) + 1);
      return Promise.resolve();
    },
  });
  await runOneCycle(deps, 4);
  for (const k of ["o/success#1", "o/skip#2", "o/failure#3", "o/throw#4"]) {
    assertEquals(
      releases.get(k),
      1,
      `${k} released exactly once, got ${releases.get(k)}`,
    );
  }
});

Deno.test("slot pool - the pool calls the slot-aware sweep with the live holds, never the whole-process sweep (Issue #4178)", async () => {
  let wholeProcessSweeps = 0;
  const liveSets: number[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1), issue("o/b", 2)]),
    processIssue: async () => {
      await new Promise((r) => setTimeout(r, 10));
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
    sweepLeakedHeartbeats: () => {
      wholeProcessSweeps++;
      return Promise.resolve();
    },
    sweepLeakedHeartbeatsExcept: (live) => {
      liveSets.push(live.length);
      return Promise.resolve();
    },
  });
  await runOneCycle(deps, 2);
  assertEquals(
    wholeProcessSweeps,
    0,
    "the pool must never stop every heartbeat",
  );
  assert(
    liveSets.length >= 2 && liveSets.every((n) => n >= 1),
    `live sets: ${liveSets}`,
  );
});

Deno.test("slot pool - the live set handed to the sweep names a live maintenance hold, so its heartbeat is never swept (Issue #391)", async () => {
  const registry = new InFlightRepoRegistry();
  // The maintenance lane is mid-run on a PR in its own repository.
  registry.tryAcquire("o/grq", 4408, "m1", { maintenance: true });
  const liveSets: string[][] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    inFlightRepos: registry,
    findNextIssue: issueQueue([issue("o/a", 1), issue("o/b", 2)]),
    processIssue: async () => {
      await new Promise((r) => setTimeout(r, 10));
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
    sweepLeakedHeartbeatsExcept: (live) => {
      liveSets.push(
        live.map((l) => `${l.repo}#${l.issueNumber}:${l.kind ?? "issue"}`),
      );
      return Promise.resolve();
    },
  });
  await runOneCycle(deps, 2);
  assert(liveSets.length >= 1, "the pool swept at least once");
  assert(
    liveSets.every((set) => set.includes("o/grq#4408:pr")),
    `every sweep must protect the maintenance hold: ${
      JSON.stringify(liveSets)
    }`,
  );
});

// ============================================================================
// Host-wide guards across slots (Issue #4180)
// ============================================================================

Deno.test("slot pool - spend ceiling reached during slot A's run: slot B's next claim is refused, the pool drains and the cycle ends on the ceiling (Issue #4180)", async () => {
  let ceilingHit = false;
  let processed = 0;
  let now = 0;
  const errors: string[] = [];
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    logError: (m) => {
      errors.push(m);
    },
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 9 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    checkSpendCeiling: () =>
      Promise.resolve(
        ceilingHit
          ? { exceeded: true, message: "Daily spend $50.00 ≥ ceiling $50.00" }
          : { exceeded: false },
      ),
    processIssue: async () => {
      processed++;
      // The first run to finish trips the ceiling; siblings mid-run finish.
      await new Promise((r) => setTimeout(r, 5));
      ceilingHit = true;
      // A failed run keeps the slot looking for more — which the guard
      // must now refuse.
      return { ok: true, value: { success: false } };
    },
  });
  const result = await runCoreLoop({ ...config, maxConcurrentIssues: 3 }, deps);
  assert(
    processed <= 3,
    `processed ${processed} — a slot claimed past the ceiling`,
  );
  assertEquals(result.exitReason, "Daily spend ceiling reached");
  assertEquals(
    errors.filter((m) => m.startsWith("[SPEND_CEILING]")).length,
    1,
    "the ceiling is reported once, not once per slot",
  );
});

Deno.test("slot pool - rate-limit signal active between claims: no slot claims again this cycle (Issue #4180)", async () => {
  let limited = false;
  let processed = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 9 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    isRateLimitActive: () => Promise.resolve(limited),
    processIssue: async () => {
      processed++;
      await new Promise((r) => setTimeout(r, 5));
      limited = true;
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: false } };
    },
  });
  await runOneCycle(deps, 3);
  assert(
    processed <= 3,
    `processed ${processed} — a slot claimed under an active rate limit`,
  );
});

Deno.test("slot pool - a primary rate limit thrown in one slot drains the pool and reaches the cycle's pause path; siblings' claims are released (Issue #4180)", async () => {
  const released: string[] = [];
  const logs: string[] = [];
  let processed = 0;
  let now = 0;
  const deps = createMockDeps({
    now: () => now,
    log: (m) => {
      logs.push(m);
    },
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 9 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    processIssue: async (i) => {
      processed++;
      await new Promise((r) => setTimeout(r, 5));
      if (i.issueNumber === 0) {
        throw new Error("API rate limit exceeded for user ID 1");
      }
      return { ok: true, value: { success: false } };
    },
    releaseClaim: (repo, n) => {
      released.push(`${repo}#${n}`);
      return Promise.resolve();
    },
    getRateLimitReset: () => {
      // The pause path consulted the reset epoch: that IS the serial
      // loop's behaviour, now reached from the pool.
      logs.push("getRateLimitReset consulted");
      // Far enough that the run duration expires while pausing.
      return Promise.resolve(Math.floor(now / 1000) + 3600);
    },
  });
  await runOneCycle(deps, 3);
  assert(
    processed <= 3,
    `processed ${processed} — a slot claimed after the rate limit`,
  );
  assert(
    logs.includes("getRateLimitReset consulted"),
    `pool did not surface the rate limit to the cycle pause path; logs: ${
      logs.join(" | ")
    }`,
  );
  assert(
    released.some((r) => r === "o/r0#0"),
    "the throwing slot released its claim",
  );
});

// ============================================================================
// Memory-pressure slot ceiling (Issue #4179)
// ============================================================================

Deno.test("slot pool - simulated high pressure with maxConcurrentIssues 4: fewer than 4 slots start; the ceiling never exceeds configured (Issue #4179)", async () => {
  let inFlight = 0, high = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const asked: number[] = [];
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 6 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    slotCeiling: {
      effectiveSlots: (configured) => {
        asked.push(configured);
        // A reading that "would imply 6 slots" — the pool clamps to
        // configured on its side too.
        return Promise.resolve(2);
      },
    },
    processIssue: async () => {
      inFlight++;
      high = Math.max(high, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });
  await runOneCycle(deps, 4);
  assertEquals(
    high,
    2,
    `expected at most 2 concurrent under pressure, saw ${high}`,
  );
  assert(
    asked.every((c) => c === 4),
    "the governor is asked with the configured count",
  );
});

Deno.test("slot pool - a ceiling above configured is clamped: configured 2 stays 2 (Issue #4179)", async () => {
  let inFlight = 0, high = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 6 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    slotCeiling: { effectiveSlots: () => Promise.resolve(6) },
    processIssue: async () => {
      inFlight++;
      high = Math.max(high, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });
  await runOneCycle(deps, 2);
  assertEquals(high, 2);
});

Deno.test("slot pool - pressure spike while 3 slots run: 0 cancellations, 0 new starts (Issue #4179)", async () => {
  let ceiling = 3;
  let inFlight = 0, high = 0, started = 0, completed = 0;
  let postSpikeInFlight = 0, postSpikeHigh = 0;
  let now = 0;
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 9 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    slotCeiling: { effectiveSlots: () => Promise.resolve(ceiling) },
    processIssue: async () => {
      started++;
      inFlight++;
      high = Math.max(high, inFlight);
      const postSpike = started > 3;
      if (postSpike) {
        postSpikeInFlight++;
        postSpikeHigh = Math.max(postSpikeHigh, postSpikeInFlight);
      }
      await new Promise((r) => setTimeout(r, 10));
      // Spike lands while all three are mid-run.
      ceiling = 1;
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      if (postSpike) postSpikeInFlight--;
      completed++;
      // A failed run keeps the slot looking — which the ceiling must stop.
      return { ok: true, value: { success: false } };
    },
    // Keep the loop from finding "no work" for other reasons.
    shouldExitOnFailures: () => Promise.resolve(false),
  });
  await runOneCycle(deps, 3);
  assertEquals(high, 3, "three ran concurrently before the spike");
  assertEquals(completed, started, "no run was cancelled by the spike");
  // After the spike only slot s1 may claim again; s2/s3 stop before their
  // next claim, so nothing started after the spike ever overlaps.
  assertEquals(postSpikeHigh, 1, `post-spike concurrency ${postSpikeHigh}`);
});

Deno.test("slot pool - a slot ceiling that throws → configured count runs (Issue #4179)", async () => {
  let inFlight = 0, high = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 6 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    slotCeiling: { effectiveSlots: () => Promise.reject(new Error("boom")) },
    processIssue: async () => {
      inFlight++;
      high = Math.max(high, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });
  await runOneCycle(deps, 3);
  assertEquals(high, 3);
});

// ============================================================================
// Slot-attributed lines and aggregate status (Issue #4181)
// ============================================================================

Deno.test("slot pool - every pool line for a claim carries [sN repo#issue]; slot A finishing leaves slot B's status intact (Issue #4181)", async () => {
  const logs: string[] = [];
  const status: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  let finished = 0;
  const deps = createMockDeps({
    now: () => now,
    log: (m) => {
      logs.push(m);
    },
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1), issue("o/b", 2)]),
    setStatusWorking: (d) => {
      status.push(`working:${d}`);
      return Promise.resolve();
    },
    setStatusSuccess: () => {
      status.push("success");
      return Promise.resolve();
    },
    setStatusIdle: () => {
      status.push("idle");
      return Promise.resolve();
    },
    processIssue: async (i) => {
      // A finishes well before B.
      await new Promise((r) => setTimeout(r, i.repo === "o/a" ? 5 : 40));
      finished++;
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });
  await runOneCycle(deps, 2);
  assertEquals(finished, 2);

  // Attribution: every claim-scoped line names its slot and work item.
  const claimLines = logs.filter((l) =>
    /Processing issue|Successfully processed/.test(l)
  );
  assertEquals(claimLines.length, 4, logs.join("\n"));
  const groups = new Set(
    claimLines.map((l) =>
      /^\[(s\d+ [^\]]+)\]/.exec(l)?.[1] ?? `UNATTRIBUTED: ${l}`
    ),
  );
  assertEquals([...groups].sort(), ["s1 o/a#1", "s2 o/b#2"]);

  // Status: while both run the line shows both; when A finishes the line
  // still reports B, and only B's finish settles to success.
  assert(
    status.some((s) => s === "working:s1 o/a#1 | s2 o/b#2"),
    status.join(" ; "),
  );
  const afterA = status.indexOf("working:o/b#2");
  assert(afterA >= 0, `A's finish did not re-render B: ${status.join(" ; ")}`);
  assert(
    !status.slice(0, afterA + 1).includes("success"),
    `status settled while B was still working: ${status.join(" ; ")}`,
  );
  assertEquals(status.filter((s) => s === "success").length, 1);
});

// ============================================================================
// Shutdown / deadline / drain across slots (Issue #4182)
// ============================================================================

Deno.test("slot pool - deadline with 3 slots of staggered durations: all three complete (none truncated), 3 releases, no new claims (Issue #4182)", async () => {
  const released: string[] = [];
  let started = 0, completed = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 9 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    releaseClaim: (repo, n) => {
      released.push(`${repo}#${n}`);
      return Promise.resolve();
    },
    processIssue: async (i) => {
      started++;
      // Slot ages differ: 5 ms, 25 ms, 60 ms. The deadline passes while
      // the slowest is still running.
      await new Promise((r) => setTimeout(r, 5 + i.issueNumber * 25));
      now += config.runDurationSeconds * 1000; // past the deadline
      completed++;
      return { ok: true, value: { success: false } };
    },
  });
  await runOneCycle(deps, 3);
  assertEquals(started, 3, "no slot claimed again past the deadline");
  assertEquals(completed, 3, "every slot completed — none truncated");
  assertEquals(released.length, 3);
});

Deno.test("slot pool - SIGTERM mid-run: no new claims, in-flight slots finish, every claim released (Issue #4182)", async () => {
  const released: string[] = [];
  const handlers: Record<string, () => void> = {};
  let started = 0, completed = 0;
  let now = 0;
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    addSignalListener: (signal, handler) => {
      handlers[signal] = handler;
    },
    findNextIssue: issueQueue(
      Array.from({ length: 9 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    releaseClaim: (repo, n) => {
      released.push(`${repo}#${n}`);
      return Promise.resolve();
    },
    processIssue: async () => {
      started++;
      await new Promise((r) => setTimeout(r, 10));
      // The signal lands while all three are mid-run.
      handlers["SIGTERM"]?.();
      await new Promise((r) => setTimeout(r, 10));
      completed++;
      return { ok: true, value: { success: false } };
    },
  });
  await runOneCycle(deps, 3);
  assertEquals(started, 3, "a slot claimed after SIGTERM");
  assertEquals(completed, 3, "in-flight slots were allowed to finish");
  assertEquals(released.sort(), ["o/r0#0", "o/r1#1", "o/r2#2"]);
});

Deno.test("slot pool - a slot that hangs past the shutdown grace is abandoned and its claim is still released (Issue #4182)", async () => {
  const released: string[] = [];
  const errors: string[] = [];
  const handlers: Record<string, () => void> = {};
  let now = 0;
  let clock: ReturnType<typeof setInterval> | undefined;
  let hangResolve: (() => void) | undefined;
  const deps = createMockDeps({
    now: () => now,
    logError: (m) => {
      errors.push(m);
    },
    slotDrainGraceSeconds: 30,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    addSignalListener: (signal, handler) => {
      handlers[signal] = handler;
    },
    findNextIssue: issueQueue([issue("o/fast", 1), issue("o/hang", 2)]),
    releaseClaim: (repo, n) => {
      released.push(`${repo}#${n}`);
      return Promise.resolve();
    },
    processIssue: async (i) => {
      if (i.repo === "o/fast") {
        await new Promise((r) => setTimeout(r, 5));
        handlers["SIGTERM"]?.();
        // Let the grace elapse on the injected clock while o/hang hangs:
        // keep advancing so the watcher's first observation of the
        // shutdown (real-timer cadence) is followed by ≥ 30 s more.
        clock = setInterval(() => {
          now += 31_000;
        }, 20);
        return { ok: true, value: { success: true } };
      }
      await new Promise<void>((r) => {
        hangResolve = r;
      });
      return { ok: true, value: { success: true } };
    },
  });
  await runOneCycle(deps, 2);
  if (clock !== undefined) clearInterval(clock);
  assert(
    released.includes("o/hang#2"),
    `hung slot's claim not released: ${released}`,
  );
  assert(released.includes("o/fast#1"));
  assert(
    errors.some((e) =>
      e.includes("Shutdown grace elapsed") && e.includes("o/hang#2")
    ),
    errors.join("\n"),
  );
  hangResolve?.(); // let the abandoned promise settle so nothing dangles
  await new Promise((r) => setTimeout(r, 5));
});

// ============================================================================
// Run outcome reaches the claim release (Issue #4325, part of #4291)
// ============================================================================

Deno.test("run outcome - success and failure releases pass the run's outcome; a skip-after-claim release passes none (Issue #4325)", async () => {
  const released: { key: string; outcome: unknown }[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const prOutcome = {
    kind: "pr" as const,
    prUrl: "https://github.com/o/a/pull/1",
    prNumber: 1,
  };
  const failOutcome = {
    kind: "no_pr" as const,
    category: "timeout" as const,
    phase: "execute",
    elapsedSeconds: 3600,
    message: "Claude timed out after 3600s",
  };
  const runAt = async (concurrency: number) => {
    released.length = 0;
    now = 0;
    const deps = createMockDeps({
      now: () => now,
      sleep: (ms?: number) => {
        now += ms ?? 30_000;
        return Promise.resolve();
      },
      findNextIssue: issueQueue([
        issue("o/a", 1),
        issue("o/b", 2),
        issue("o/c", 3),
      ]),
      releaseClaim: (repo, n, outcome) => {
        released.push({ key: `${repo}#${n}`, outcome });
        return Promise.resolve();
      },
      processIssue: (i) => {
        if (i.repo === "o/a") {
          now += config.runDurationSeconds * 400;
          return Promise.resolve({
            ok: true,
            value: { success: true, outcome: prOutcome },
          });
        }
        if (i.repo === "o/b") {
          return Promise.resolve({
            ok: true,
            value: { success: false, skipped: true },
          });
        }
        return Promise.resolve({
          ok: true,
          value: { success: false, outcome: failOutcome },
        });
      },
    });
    await runOneCycle(deps, concurrency);
  };
  for (const concurrency of [1, 3]) {
    await runAt(concurrency);
    const byKey = new Map(released.map((r) => [r.key, r.outcome]));
    assertEquals(byKey.get("o/a#1"), prOutcome, `c=${concurrency} success`);
    assertEquals(byKey.get("o/c#3"), failOutcome, `c=${concurrency} failure`);
    assert(byKey.has("o/b#2"), `c=${concurrency} skip released`);
    assertEquals(
      byKey.get("o/b#2"),
      undefined,
      `c=${concurrency} skip must carry no outcome`,
    );
  }
});

// ============================================================================
// A progress-extended run is in-flight to the drain path (Issue #4297)
// ============================================================================

Deno.test("slot pool - a run extended past its original budget is drained as in-flight, named with its extension count, and released exactly once (Issue #4297)", async () => {
  const released: string[] = [];
  const logs: string[] = [];
  const handlers: Record<string, () => void> = {};
  let now = 0;
  const deps = createMockDeps({
    now: () => now,
    log: (m) => {
      logs.push(m);
    },
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    addSignalListener: (signal, handler) => {
      handlers[signal] = handler;
    },
    findNextIssue: issueQueue([issue("o/long", 7)]),
    releaseClaim: (repo, n) => {
      released.push(`${repo}#${n}`);
      return Promise.resolve();
    },
    processIssue: async () => {
      // What the execute phase does: publish the deadline at run start,
      // then again on every progress extension (Issue #4297).
      reportRunDeadline({ deadlineMs: now + 3600_000, extensionsGranted: 0 });
      reportRunDeadline({ deadlineMs: now + 4500_000, extensionsGranted: 1 });
      reportRunDeadline({ deadlineMs: now + 5400_000, extensionsGranted: 2 });
      // The run is now past the hour the drain path was written against.
      now += 3900_000;
      handlers["SIGTERM"]?.();
      // Long enough for the drain watcher (50 ms real-timer cadence) to
      // observe the shutdown while this run is still in flight.
      await new Promise((r) => setTimeout(r, 150));
      return { ok: true, value: { success: true } };
    },
  });

  await runOneCycle(deps, 2);

  const drainLine = logs.find((l) => l.includes("Shutdown requested"));
  assert(drainLine !== undefined, `no drain line logged: ${logs.join("\n")}`);
  assert(
    drainLine.includes("draining 1 in-flight slot(s)"),
    `the extended run must count as in-flight: ${drainLine}`,
  );
  assert(
    drainLine.includes("o/long#7") && drainLine.includes("extended 2×"),
    `the drain line must name the extended run: ${drainLine}`,
  );
  assertEquals(
    released,
    ["o/long#7"],
    "the extended run's slot must be released exactly once",
  );
  assert(
    !logs.some((l) => l.includes("Shutdown grace elapsed")),
    "an extended run must be drained, not abandoned",
  );
});

// ============================================================================
// A slot keeps claiming after a success (Issue #178)
// ============================================================================

Deno.test("slot pool - a success is followed by the normal sleep and another claim in the SAME slot, not a pool drain (Issue #178)", async () => {
  const config = createDefaultRunCoreConfig();
  const cycleMs = config.runDurationSeconds * 1000;
  let now = 0;
  /** Ordered trace of everything the slot did, so the sleep's position is checked too. */
  const events: string[] = [];
  const unclaimed = [issue("o/a", 1), issue("o/a", 2)];
  let poolEntries = 0;
  const deps = createMockDeps({
    now: () => now,
    log: (m) => {
      if (m.includes("Issue scan pool:")) poolEntries++;
    },
    sleep: (ms?: number) => {
      events.push(`sleep:${ms ?? 0}`);
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    // Both issues live in one repo, so only one slot can ever hold it: the
    // second claim can only come from the slot that just succeeded. An
    // issue stays findable until it is actually processed, as in production
    // — a slot that loses the acquire race must not consume it.
    findNextIssue: (options) =>
      Promise.resolve({
        ok: true,
        value: unclaimed.find((i) => !options?.excludeRepos?.has(i.repo)) ??
          null,
      }),
    processIssue: (i) => {
      unclaimed.splice(unclaimed.indexOf(i), 1);
      events.push(`process:${i.repo}#${i.issueNumber}`);
      // End the cycle once both are done so the outer loop cannot supply
      // the second claim from a fresh pool.
      if (events.filter((e) => e.startsWith("process:")).length >= 2) {
        now = cycleMs + 1;
      }
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runOneCycle(deps, 2);

  assertEquals(
    events.slice(0, 3),
    [
      "process:o/a#1",
      `sleep:${config.sleepInterval * 1000}`,
      "process:o/a#2",
    ],
    `a slot must sleep the normal interval and claim again: ${
      events.join(", ")
    }`,
  );
  assertEquals(
    poolEntries,
    1,
    "both claims must come from one pool invocation — the slot must not drain after its first success",
  );
});

Deno.test("slot pool - two slots, one long execute: the other slot completes issue after issue throughout (Issue #178)", async () => {
  const config = createDefaultRunCoreConfig();
  const cycleMs = config.runDurationSeconds * 1000;
  let now = 0;
  const shortDone: number[] = [];
  let longFinished = false;
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([
      issue("o/long", 1),
      issue("o/short", 2),
      issue("o/short", 3),
      issue("o/short", 4),
      issue("o/short", 5),
    ]),
    processIssue: async (i) => {
      if (i.repo === "o/long") {
        // One long execute holding its slot while the sibling works.
        // Bounded so a regression fails the assertion instead of hanging.
        for (let tick = 0; tick < 500 && shortDone.length < 4; tick++) {
          await new Promise((r) => setTimeout(r, 1));
        }
        longFinished = true;
        now = cycleMs + 1; // the long run's return ends the cycle
        return { ok: true, value: { success: true } };
      }
      await new Promise((r) => setTimeout(r, 1));
      shortDone.push(i.issueNumber);
      return { ok: true, value: { success: true } };
    },
  });

  await runOneCycle(deps, 2);

  assertEquals(
    shortDone,
    [2, 3, 4, 5],
    "the free slot must keep claiming for the whole of the sibling's long execute",
  );
  assert(longFinished, "the long execute must run to completion");
});

/** A scan that considered work and skipped all of it (Issue #219). */
function emptyScanSummary(
  skippedByReason: DiagnosticSummary["skippedByReason"],
  totalConsidered: number,
): DiagnosticSummary {
  return {
    totalConsidered,
    totalEligible: 0,
    skippedByReason,
    claimRaceWins: 0,
    claimRaceLosses: 0,
  };
}

Deno.test("slot pool - a slot that finds nothing while a sibling works states why and re-scans instead of retiring (Issue #219)", async () => {
  const config = createDefaultRunCoreConfig();
  const cycleMs = config.runDurationSeconds * 1000;
  let now = 0;
  const logs: string[] = [];
  let emptyScans = 0;
  let lateProcessed = false;
  const available: DiscoveredIssue[] = [issue("o/long", 1)];
  const deps = createMockDeps({
    now: () => now,
    log: (m) => logs.push(m),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: (options) => {
      const found = available.find((i) =>
        !options?.excludeRepos?.has(i.repo)
      ) ?? null;
      if (found === null) {
        emptyScans++;
        options?.onScanSummary?.(
          emptyScanSummary({ cooldown: 8, "repo-busy": 4 }, 12),
        );
        // Eligible work reappears a couple of scans later — the state the
        // #219 log shows while the second slot sat silent for an hour.
        if (emptyScans === 3) available.push(issue("o/late", 2));
      }
      return Promise.resolve({ ok: true as const, value: found });
    },
    processIssue: async (i) => {
      if (i.repo === "o/long") {
        // Hold this slot until the idle sibling has claimed the late issue.
        // Bounded so a regression fails the assertion instead of hanging.
        for (let tick = 0; tick < 2000 && !lateProcessed; tick++) {
          await new Promise((r) => setTimeout(r, 1));
        }
        now = cycleMs + 1; // the long run's return ends the cycle
        return { ok: true, value: { success: true } };
      }
      available.splice(available.findIndex((x) => x.repo === i.repo), 1);
      lateProcessed = true;
      return { ok: true, value: { success: true } };
    },
  });

  await runOneCycle(deps, 2);

  assert(
    lateProcessed,
    "a slot that finds nothing must re-scan and claim the work that appears next, not retire",
  );
  const idleLines = logs.filter((m) => m.includes("no eligible work:"));
  assert(
    idleLines.length > 0,
    `an empty scan must log its reason: ${logs.join(" | ")}`,
  );
  assertStringIncludes(idleLines[0]!, "considered=12 eligible=0 skipped=12");
  assertStringIncludes(idleLines[0]!, "top-skips=cooldown=8,repo-busy=4");
  assertStringIncludes(
    idleLines[0]!,
    `re-scanning in ${config.sleepInterval}s`,
  );
});

Deno.test("slot pool - a slot that finds nothing with no sibling running retires with a stated reason (Issue #219)", async () => {
  const config = createDefaultRunCoreConfig();
  const cycleMs = config.runDurationSeconds * 1000;
  let now = 0;
  let scans = 0;
  const logs: string[] = [];
  const deps = createMockDeps({
    now: () => now,
    log: (m) => logs.push(m),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: (options) => {
      scans++;
      options?.onScanSummary?.(emptyScanSummary({ cooldown: 7 }, 7));
      // Both slots have scanned once — end the cycle so the assertion sees
      // exactly one pool's worth of exits.
      if (scans >= 2) now = cycleMs + 1;
      return Promise.resolve({ ok: true as const, value: null });
    },
  });

  await runOneCycle(deps, 2);

  const stops = logs.filter((m) => m.includes("stop reason=no-work"));
  assertEquals(
    stops.length,
    2,
    `every slot must state why it stopped: ${logs.join(" | ")}`,
  );
  assertStringIncludes(
    stops[0]!,
    "no eligible work: considered=7 eligible=0 skipped=7 top-skips=cooldown=7",
  );
});

Deno.test("slot pool - a slot that loses the acquire race drops that repo's cached issue list before re-scanning (Issue #219)", async () => {
  const config = createDefaultRunCoreConfig();
  const cycleMs = config.runDurationSeconds * 1000;
  let now = 0;
  const invalidated: string[] = [];
  // One issue in one repo: the slot that loses the acquire race must clear
  // the repo's cached list so its next scan is not served the same ranking.
  const unclaimed = [issue("o/a", 1)];
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    invalidateRepoIssueCache: (repo: string) => {
      invalidated.push(repo);
      return Promise.resolve();
    },
    findNextIssue: (options) =>
      Promise.resolve({
        ok: true,
        value: unclaimed.find((i) => !options?.excludeRepos?.has(i.repo)) ??
          null,
      }),
    processIssue: (i) => {
      unclaimed.splice(unclaimed.indexOf(i), 1);
      now = cycleMs + 1; // one claim is enough; end the cycle
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runOneCycle(deps, 2);

  assertEquals(
    invalidated[0],
    "o/a",
    "the slot that lost the race must invalidate the winner's cached issue list",
  );
});

// ============================================================================
// Host disk guard (Issue #226)
// ============================================================================

Deno.test("slot pool - host disk drops low during slot A's run: no slot claims again, the pool drains, running work finishes (Issue #226)", async () => {
  let low = false;
  let processed = 0;
  let now = 0;
  const errors: string[] = [];
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    logError: (m) => {
      errors.push(m);
    },
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 9 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    checkHostDisk: () =>
      Promise.resolve(
        low
          ? {
            level: "low" as const,
            detail:
              "18.0 GB free (3.9%) of 460.0 GB, floor 46.0 GB — below the floor",
          }
          : { level: "ok" as const, detail: "200 GB free" },
      ),
    processIssue: async () => {
      processed++;
      await new Promise((r) => setTimeout(r, 5));
      // The host fills while the first run is in flight.
      low = true;
      return { ok: true, value: { success: false } };
    },
  });
  await runCoreLoop({ ...config, maxConcurrentIssues: 3 }, deps);
  assert(
    processed <= 3,
    `processed ${processed} — a slot claimed with the host disk low`,
  );
  assertEquals(
    errors.filter((m) => m.startsWith("[HOST_DISK_LOW]")).length,
    1,
    "the low disk is reported once, not once per slot",
  );
});

// ============================================================================
// Disposable-tier reclaim before the disk gate (Issue #242)
// ============================================================================

Deno.test("host disk low - the disposable tier is reclaimed first, and a healed host keeps claiming (Issue #242)", async () => {
  let now = 0;
  let reclaims = 0;
  let processed = 0;
  const logs: string[] = [];
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    log: (m) => logs.push(m),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1)]),
    checkHostDisk: () =>
      Promise.resolve({
        level: "low" as const,
        detail: "18.0 GB free (3.9%) of 460.0 GB — below the floor",
      }),
    reclaimDiskSpace: () => {
      reclaims++;
      return Promise.resolve({
        bytesReclaimed: 11_811_160_064,
        detail: "side/data 4.2 GB in 3 dirs — host disk now ok",
        healed: true,
      });
    },
    processIssue: () => {
      processed++;
      now += config.runDurationSeconds * 400;
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runOneCycle(deps, 1);

  assert(reclaims >= 1, "the reclaim must run before the gate stops claiming");
  assertEquals(processed, 1, "a healed host claims normally");
  assert(
    logs.some((m) => m.includes("reclaimed") && m.includes("Issue #242")),
    logs.join("\n"),
  );
});

Deno.test("host disk low - a reclaim that frees nothing still stops the cycle claiming (Issue #242)", async () => {
  let now = 0;
  let processed = 0;
  const errors: string[] = [];
  const deps = createMockDeps({
    now: () => now,
    logError: (m) => errors.push(m),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1)]),
    checkHostDisk: () =>
      Promise.resolve({
        level: "low" as const,
        detail: "18.0 GB free — below the floor",
      }),
    reclaimDiskSpace: () =>
      Promise.resolve({
        bytesReclaimed: 0,
        detail: "nothing disposable remains",
        healed: false,
      }),
    processIssue: () => {
      processed++;
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runOneCycle(deps, 1);

  assertEquals(processed, 0, "a host still short must claim nothing");
  assertEquals(
    errors.filter((m) => m.startsWith("[HOST_DISK_LOW]")).length,
    1,
    "the low disk is reported once per cycle",
  );
});

Deno.test("host disk low - a reclaim that throws is loud and the disk gate still holds (Issue #242)", async () => {
  let now = 0;
  let processed = 0;
  const errors: string[] = [];
  const deps = createMockDeps({
    now: () => now,
    logError: (m) => errors.push(m),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1)]),
    checkHostDisk: () =>
      Promise.resolve({
        level: "low" as const,
        detail: "18.0 GB free — below the floor",
      }),
    reclaimDiskSpace: () => Promise.reject(new Error("du timed out")),
    processIssue: () => {
      processed++;
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runOneCycle(deps, 1);

  assertEquals(processed, 0);
  assert(
    errors.some((m) =>
      m.includes("reclaim failed") && m.includes("du timed out")
    ),
    errors.join("\n"),
  );
});

Deno.test("slot pool - a work-volume fault surfaced during slot A's run stops every further claim (Issue #229)", async () => {
  let faulted = false;
  let processed = 0;
  let now = 0;
  const errors: string[] = [];
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    logError: (m) => {
      errors.push(m);
    },
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue(
      Array.from({ length: 9 }, (_, i) => issue(`o/r${i}`, i)),
    ),
    checkWorkVolumeFault: () =>
      faulted
        ? {
          faulted: true,
          detail: "fatal: Structure needs cleaning (git fetch)",
        }
        : { faulted: false, detail: "" },
    processIssue: async () => {
      processed++;
      await new Promise((r) => setTimeout(r, 5));
      faulted = true;
      return { ok: true, value: { success: false } };
    },
  });
  await runCoreLoop({ ...config, maxConcurrentIssues: 3 }, deps);
  assert(
    processed <= 3,
    `processed ${processed} — a slot claimed on a faulted volume`,
  );
  assertEquals(
    errors.filter((m) => m.startsWith("[WORK_VOLUME_FAULT]")).length,
    1,
  );
});

/**
 * Per-claim write-repo allowlist wiring (Issue #183).
 *
 * `withWriteRepoAllowlistContext` existed (Issue #4175) but nothing in
 * production called it, so every slot fell through to the process-wide
 * default context and the claim that seeded second clobbered its sibling's
 * allowlist. These tests drive the real pool and let each claim seed the
 * allowlist exactly as `issue_worker.ts` does.
 */

/** Silence the security log and the audit journal for a test body. */
function withSilentAllowlistSinks(): void {
  _setWriteRepoAllowlistSinks({
    record: () => Promise.resolve({ ok: true, value: undefined as never }),
    log: () => undefined,
  });
}

/** Wait (bounded) until every concurrent claim has reached the barrier. */
async function awaitClaims(count: () => number, want: number): Promise<void> {
  for (let n = 0; n < 500 && count() < want; n++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

Deno.test("slot pool - two concurrent claims each seed their own write-repo allowlist (Issue #183)", async () => {
  withSilentAllowlistSinks();
  const allowedSeen = new Map<string, string[]>();
  const siblingRefused = new Map<string, boolean>();
  let seeded = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1), issue("o/b", 2)]),
    processIssue: async (i) => {
      // What issue_worker.ts does on every claim.
      seedWriteRepoAllowlist(i.repo);
      seeded++;
      // Interleave: neither claim inspects its allowlist until the sibling
      // has seeded, which is exactly when a shared context clobbers.
      await awaitClaims(() => seeded, 2);
      allowedSeen.set(i.repo, listAllowedWriteRepos());
      const sibling = i.repo === "o/a" ? "o/b" : "o/a";
      let refused = false;
      try {
        await enforceGhWriteAllowlist([
          "issue",
          "comment",
          "1",
          "--repo",
          sibling,
          "--body",
          "x",
        ]);
      } catch (err) {
        refused = err instanceof WriteRepoBlockedError;
      }
      siblingRefused.set(i.repo, refused);
      resetWriteRepoAllowlist(); // issue_worker.ts's finally
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });
  try {
    await runOneCycle(deps, 2);
  } finally {
    _resetWriteRepoAllowlistSinks();
    resetWriteRepoAllowlist();
  }
  // Each claim sees ITS repo — the list the gh guard shim bakes into that
  // claim's agent — never the sibling's and never the union.
  assertEquals(allowedSeen.get("o/a"), ["o/a"]);
  assertEquals(allowedSeen.get("o/b"), ["o/b"]);
  assertEquals(siblingRefused.get("o/a"), true, "o/a may not write to o/b");
  assertEquals(siblingRefused.get("o/b"), true, "o/b may not write to o/a");
  // No claim seeded the process-wide default context.
  assertEquals(currentWriteRepoAllowlistContext().active, false);
  assertEquals(listAllowedWriteRepos(), []);
});

Deno.test("slot pool - a claim's heartbeat pin stays inside its own allowlist context (Issue #183/#3760)", async () => {
  withSilentAllowlistSinks();
  const pinVisibleToSibling = new Map<string, boolean>();
  const snapshot = new Map<string, string[]>();
  const ownRepoWritable = new Map<string, boolean>();
  let pinned = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1), issue("o/b", 2)]),
    processIssue: async (i) => {
      seedWriteRepoAllowlist(i.repo);
      pinWriteRepo(i.repo); // what startHeartbeat does
      pinned++;
      await awaitClaims(() => pinned, 2);
      const sibling = i.repo === "o/a" ? "o/b" : "o/a";
      pinVisibleToSibling.set(i.repo, isWriteRepoAllowed(sibling));
      // A reseed inside the claim clears `allowed`; the pin keeps the
      // claim's own repo writable for the heartbeat (Issue #3760).
      seedWriteRepoAllowlist("o/reseeded");
      ownRepoWritable.set(i.repo, isWriteRepoAllowed(i.repo));
      // What prepareGhGuardShim bakes for this claim's agent: the seeded
      // set only. Pins are worker-side by design, so a background writer's
      // repo never widens the agent's boundary.
      snapshot.set(i.repo, listAllowedWriteRepos());
      unpinWriteRepo(i.repo); // what stopHeartbeat does
      resetWriteRepoAllowlist();
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });
  try {
    await runOneCycle(deps, 2);
  } finally {
    _resetWriteRepoAllowlistSinks();
    resetWriteRepoAllowlist();
  }
  assertEquals(pinVisibleToSibling.get("o/a"), false, "o/b's pin leaked");
  assertEquals(pinVisibleToSibling.get("o/b"), false, "o/a's pin leaked");
  assertEquals(ownRepoWritable.get("o/a"), true, "o/a's pin was lost");
  assertEquals(ownRepoWritable.get("o/b"), true, "o/b's pin was lost");
  assertEquals(snapshot.get("o/a"), ["o/reseeded"]);
  assertEquals(snapshot.get("o/b"), ["o/reseeded"]);
});
