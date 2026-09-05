/**
 * The slot exclusion is keyed by work stream, not by repository (Issue
 * #1091).
 *
 * Measured on `vibe-coder-37405:50` at 2026-09-05T03:36:02Z, with `s1`
 * working `VibeCoder#1082` and 29 unassigned issues across 8 milestones
 * claimable in the same repository:
 *
 * ```text
 * [s2] no eligible work: considered=5 eligible=0 skipped=5
 *   top-skips=milestone-occupied=3,filtered-out=1,dependency-blocked=1
 *   — re-scanning in 30s while 1 sibling slot(s) work (Issue #219).
 * [idle-census] NOTE inversion_repo_held repos=stSoftwareAU/VibeCoder
 * ```
 *
 * `considered=5`, not 29: `excludeRepos` (Issue #4176) removed the whole
 * repository from `s2`'s scan, in front of the per-stream check. Seventy-four
 * consecutive scans, all correct, all useless — an N-slot host doing the work
 * of one.
 *
 * Issue #4176 keyed by repository because every slot checked out into the one
 * clone. Both prerequisites `lane_scoped_worktree_test.ts` named have since
 * landed: a slot works in its own lane worktree (`setup_branch_phase.ts:153`
 * → `setupRepo(repo, workDir, ctx.laneId)`) and the Claude session store is
 * scoped per work stream (`session_manager.ts:78`,
 * `.claude-sessions/<owner>/<repo>/{default,milestone-N}`). So the unit of
 * exclusion becomes the work stream — `(repo, milestone)`, the default branch
 * for an issue with none.
 *
 * What must not move: stream exclusivity still comes from
 * `isMilestoneOccupied` (`issue_filter.ts`), told the truth about this host's
 * live claims rather than reimplemented beside it. Two mechanisms that can
 * disagree about whether a stream is free eventually will, and the cost is
 * two slots on one branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { InFlightRepoRegistry } from "../lib/in_flight_repos.ts";
import {
  applyInFlightClaims,
  DEFAULT_BRANCH_STREAM,
  describeWorkStream,
  type InFlightClaim,
  workStreamKey,
} from "../lib/work_stream.ts";
import {
  type FilterableIssue,
  isMilestoneOccupied,
} from "../lib/issue_filter.ts";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import {
  buildIdleDecisionCensus,
  formatIdleDecisionCensus,
  resolveRepoScanState,
} from "../lib/idle_decision_census.ts";
import { MAINTENANCE_LANE_SLOT_ID } from "../lib/maintenance_lane.ts";
import {
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";

const REPO = "stSoftwareAU/VibeCoder";
const WORKER = "vibe-worker";
const ALICE = { login: "alice" };

// ---------------------------------------------------------------------------
// A minimal RunCoreDeps mock, rebuilt locally as the other run_core test
// files do.
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

// ---------------------------------------------------------------------------
// The registry: two slots never hold one stream, and always may hold two
// ---------------------------------------------------------------------------

Deno.test("stream exclusion - two slots never hold the same milestone of one repository (Issue #1091)", () => {
  const registry = new InFlightRepoRegistry();
  assertEquals(
    registry.tryAcquire(REPO, 1082, "s1", { milestone: "Fleet Logs" }),
    true,
  );
  assertEquals(
    registry.tryAcquire(REPO, 1083, "s2", { milestone: "Fleet Logs" }),
    false,
    "a sibling must not take a stream another slot holds",
  );
  assertEquals(registry.size, 1);
});

Deno.test("stream exclusion - two slots never both hold a repository's default branch (Issue #1091)", () => {
  // The stream an issue with no milestone belongs to. It is one stream like
  // any other — `""` is not "no stream", and treating it as one would put two
  // slots on the default branch, which is the failure the exclusion exists
  // to prevent.
  const registry = new InFlightRepoRegistry();
  assertEquals(registry.tryAcquire(REPO, 900, "s1"), true);
  assertEquals(
    registry.tryAcquire(REPO, 901, "s2", {
      milestone: DEFAULT_BRANCH_STREAM,
    }),
    false,
    "the default branch is a work stream, and only one slot may hold it",
  );
  assertEquals(registry.size, 1);
});

Deno.test("stream exclusion - two slots hold two milestones of one repository at once (Issue #1091)", () => {
  const registry = new InFlightRepoRegistry();
  assertEquals(
    registry.tryAcquire(REPO, 1082, "s1", { milestone: "Fleet Logs" }),
    true,
  );
  assertEquals(
    registry.tryAcquire(REPO, 964, "s2", { milestone: "Env Injection" }),
    true,
    "different milestones of one repository are parallel work streams",
  );
  assertEquals(registry.size, 2);
  assertEquals(registry.isStreamHeld(REPO, "Fleet Logs"), true);
  assertEquals(registry.isStreamHeld(REPO, "Idle Detection"), false);
  // Each releases its own stream, and only its own.
  registry.release(REPO, "Fleet Logs");
  assertEquals(registry.isStreamHeld(REPO, "Fleet Logs"), false);
  assertEquals(registry.isStreamHeld(REPO, "Env Injection"), true);
});

Deno.test("stream exclusion - the maintenance lane still leases the whole repository (Issue #213)", () => {
  // The lane services a PR and may touch any branch of the clone, so its
  // lease is not a stream and must keep excluding every stream in the repo.
  const registry = new InFlightRepoRegistry();
  assertEquals(
    registry.tryAcquire(REPO, 4408, MAINTENANCE_LANE_SLOT_ID, {
      maintenance: true,
    }),
    true,
  );
  assertEquals(
    registry.tryAcquire(REPO, 964, "s1", { milestone: "Env Injection" }),
    false,
    "a lane lease excludes every stream of the repository",
  );
  assertEquals([...registry.leasedRepos()], [REPO]);
  // …and the reverse: a slot's stream refuses the lane's whole-repo lease.
  registry.releaseRepoLease(REPO);
  assertEquals(
    registry.tryAcquire(REPO, 964, "s1", { milestone: "Env Injection" }),
    true,
  );
  assertEquals(
    registry.tryAcquire(REPO, 4408, MAINTENANCE_LANE_SLOT_ID, {
      maintenance: true,
    }),
    false,
  );
  assertEquals(
    [...registry.leasedRepos()],
    [],
    "a slot's hold is not a whole-repository lease, so the scan still sees the repo",
  );
});

// ---------------------------------------------------------------------------
// Exclusivity still comes from `isMilestoneOccupied`
// ---------------------------------------------------------------------------

function openIssue(
  number: number,
  milestone: string,
  assignees: string[] = [],
): FilterableIssue {
  return {
    number,
    title: `#${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    author: "alice",
    assignees,
    labels: ["top-priority"],
    createdAt: "2026-09-01T00:00:00Z",
    milestone,
  };
}

Deno.test("stream exclusion - a live claim reaches the scan through isMilestoneOccupied, not beside it (Issue #1091)", () => {
  // The claim path assigns on GitHub before working, but the scan reads a
  // 600 s iteration cache: a sibling that claimed after the cache was filled
  // is invisible in the issue data. Overlaying the host's live claims is what
  // closes that window — and it closes it inside the check the selector
  // already uses, so there is no second answer to disagree with.
  const issues = [
    openIssue(1082, "Fleet Logs"),
    openIssue(964, "Env Injection"),
  ];
  const claims: InFlightClaim[] = [
    { repo: REPO, issueNumber: 1082, milestone: "Fleet Logs" },
  ];

  assertEquals(
    isMilestoneOccupied(issues, "Fleet Logs", WORKER, []),
    false,
    "the stale cache shows the held stream as free — the bug the overlay fixes",
  );

  const overlaid = applyInFlightClaims(REPO, issues, claims, WORKER);
  assertEquals(isMilestoneOccupied(overlaid, "Fleet Logs", WORKER, []), true);
  assertEquals(
    isMilestoneOccupied(overlaid, "Env Injection", WORKER, []),
    false,
    "a sibling stream in the same repository stays claimable",
  );
  // The cached list itself is never rewritten underneath its other readers.
  assertEquals(issues[0]!.assignees, []);
  // Another repository's claim never occupies this one's streams.
  assertEquals(
    applyInFlightClaims("owner/other", issues, claims, WORKER),
    issues,
  );
});

Deno.test("stream exclusion - stream keys and descriptions separate the default branch from a milestone (Issue #1091)", () => {
  assert(
    workStreamKey(REPO, "Fleet Logs") !==
      workStreamKey(REPO, DEFAULT_BRANCH_STREAM),
  );
  assertEquals(
    describeWorkStream({ repo: REPO, milestone: DEFAULT_BRANCH_STREAM }),
    `${REPO} (default branch)`,
  );
  assertEquals(
    describeWorkStream({ repo: REPO, milestone: "Fleet Logs" }),
    `${REPO} (milestone "Fleet Logs")`,
  );
});

// ---------------------------------------------------------------------------
// The claim scan: the production measurement
// ---------------------------------------------------------------------------

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    // Issue #3874: the content-approval store resolves from workDir, or the
    // integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "issue1091-workdir-" }),
    repos: [REPO],
    issueLabels: ["top-priority"],
    allowedAuthors: ["alice"],
    shuffleRepos: false,
  };
}

function createTestCache(): IssueCache {
  return new IssueCache(
    Deno.makeTempDirSync({ prefix: "issue1091-cache-" }),
    600,
  );
}

/** One `top-priority` issue per milestone, exactly as the census counted. */
function backlogAcrossMilestones(): Record<string, unknown>[] {
  const streams: Array<[number, string]> = [
    [1082, "PR Auto-merge"],
    [964, "Env Injection"],
    [1083, "Idle Detection"],
    [1004, "Fleet Logs"],
  ];
  return streams.map(([number, milestone]) => ({
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    assignees: [],
    labels: [{ name: "top-priority" }],
    createdAt: `2026-09-0${
      streams.findIndex(([n]) => n === number) + 1
    }T00:00:00Z`,
    author: ALICE,
    milestone: { title: milestone },
  }));
}

function mockGh(): (args: string[]) => Promise<string> {
  const issues = backlogAcrossMilestones();
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(issues));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(
        JSON.stringify([
          { event: "labeled", label: { name: "top-priority" }, actor: ALICE },
        ]),
      );
    }
    return Promise.resolve("[]");
  };
}

/** Exactly what `run_core.ts` hands a slot's scan. */
function scanExclusions(registry: InFlightRepoRegistry) {
  return {
    excludeRepos: registry.leasedRepos(),
    inFlightClaims: registry.heldIssues(),
  };
}

Deno.test("stream exclusion - a sibling holding one milestone leaves the rest of the repository claimable (Issue #1091)", async () => {
  // The 2026-09-05 measurement: `s1` holds VibeCoder#1082, and every other
  // claimable issue in that repository sits in a different milestone. Before
  // this change the repository left `s2`'s scan entirely — `considered=5
  // eligible=0` against a 29-issue backlog — and the slot idled for 14
  // minutes re-scanning nothing.
  const registry = new InFlightRepoRegistry();
  assertEquals(
    registry.tryAcquire(REPO, 1082, "s1", { milestone: "PR Auto-merge" }),
    true,
  );

  const result = await findOldestIssue(makeConfig(), {
    githubUser: WORKER,
    ghCommandFn: mockGh(),
    cache: createTestCache(),
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    ...scanExclusions(registry),
  });

  assertEquals(
    result.found,
    true,
    `the free slot must find work: ${result.summary}`,
  );
  assertStringIncludes(result.output, REPO);
  assert(
    !result.output.includes("|1082|"),
    `the scan must not re-offer the issue the sibling holds: ${result.output}`,
  );
  assert(
    (result.diagnosticSummary?.totalConsidered ?? 0) > 1,
    `the scan must consider the repository's other streams, not skip the ` +
      `repository: considered=${result.diagnosticSummary?.totalConsidered}`,
  );
  assert(
    (result.diagnosticSummary?.totalEligible ?? 0) > 0,
    `the scan must find something eligible: eligible=${result.diagnosticSummary?.totalEligible}`,
  );
});

Deno.test("stream exclusion - the exact issue a sibling holds is never re-considered (Issue #4176 behaviour that survives)", async () => {
  // Narrowing the exclusion must not widen what a slot may take. The held
  // issue is refused because the overlay marks it assigned, which is the
  // same gate that refuses any issue the fleet already owns.
  const registry = new InFlightRepoRegistry();
  registry.tryAcquire(REPO, 1082, "s1", { milestone: "PR Auto-merge" });

  const result = await findOldestIssue(makeConfig(), {
    githubUser: WORKER,
    ghCommandFn: mockGh(),
    cache: createTestCache(),
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    ...scanExclusions(registry),
  });
  assert(!result.output.includes("|1082|"), result.output);

  // And with every stream held, the scan comes up empty rather than handing
  // out a stream a sibling is working.
  for (
    const [number, milestone] of [
      [964, "Env Injection"],
      [1083, "Idle Detection"],
      [1004, "Fleet Logs"],
    ] as Array<[number, string]>
  ) {
    registry.tryAcquire(REPO, number, "s2", { milestone });
  }
  const exhausted = await findOldestIssue(makeConfig(), {
    githubUser: WORKER,
    ghCommandFn: mockGh(),
    cache: createTestCache(),
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    ...scanExclusions(registry),
  });
  assertEquals(exhausted.found, false, exhausted.output);
});

Deno.test("stream exclusion - a maintenance lease still hides the whole repository from the scan (Issue #213)", async () => {
  const registry = new InFlightRepoRegistry();
  registry.tryAcquire(REPO, 4408, MAINTENANCE_LANE_SLOT_ID, {
    maintenance: true,
  });
  const result = await findOldestIssue(makeConfig(), {
    githubUser: WORKER,
    ghCommandFn: mockGh(),
    cache: createTestCache(),
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    ...scanExclusions(registry),
  });
  assertEquals(result.found, false, result.output);
});

// ---------------------------------------------------------------------------
// The slot pool: a free slot claims a different milestone of a busy repo
// ---------------------------------------------------------------------------

function discovered(
  repo: string,
  n: number,
  milestoneTitle: string,
): DiscoveredIssue {
  return { repo, issueNumber: n, issueTitle: `t${n}`, milestoneTitle };
}

/**
 * What the production scan refuses, modelled for the pool's mock: a
 * repository leased wholesale, and any issue in a stream this host holds.
 */
function visibleToScan(
  i: DiscoveredIssue,
  options?: {
    excludeRepos?: ReadonlySet<string>;
    inFlightClaims?: readonly InFlightClaim[];
  },
): boolean {
  if (options?.excludeRepos?.has(i.repo)) return false;
  return !(options?.inFlightClaims ?? []).some((claim) =>
    claim.repo === i.repo && claim.milestone === i.milestoneTitle
  );
}

Deno.test("stream exclusion - a slot whose sibling holds repo#A in milestone X claims repo#B in milestone Y (Issue #1091)", async () => {
  const config = createDefaultRunCoreConfig();
  const cycleMs = config.runDurationSeconds * 1000;
  let now = 0;
  const logs: string[] = [];
  const claimed: string[] = [];
  const unclaimed = [
    discovered(REPO, 1082, "PR Auto-merge"),
    discovered(REPO, 964, "Env Injection"),
  ];
  let firstStarted = false;

  const deps = createMockDeps({
    now: () => now,
    log: (m: string) => logs.push(m),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: (options) =>
      Promise.resolve({
        ok: true,
        value: unclaimed.find((i) => visibleToScan(i, options)) ?? null,
      }),
    processIssue: async (i) => {
      unclaimed.splice(unclaimed.indexOf(i), 1);
      claimed.push(`${i.repo}#${i.issueNumber}`);
      if (i.issueNumber === 1082) {
        firstStarted = true;
        // Hold the first stream until the sibling has claimed the second,
        // so the assertion is about concurrency and not about sequencing.
        // Bounded, so a regression fails the assertion instead of hanging.
        for (let tick = 0; tick < 2000 && claimed.length < 2; tick++) {
          await new Promise((r) => setTimeout(r, 1));
        }
        now = cycleMs + 1;
      } else {
        // Do not end the cycle here: the first slot is still holding.
        assert(firstStarted);
      }
      return { ok: true, value: { success: true } };
    },
  });

  await runCoreLoop({ ...config, maxConcurrentIssues: 2 }, deps);

  assertEquals(
    claimed.sort(),
    [`${REPO}#1082`, `${REPO}#964`],
    `both milestones of one repository must be worked at once; got ${
      JSON.stringify(claimed)
    } — idle lines: ${
      JSON.stringify(logs.filter((m) => m.includes("no eligible work")))
    }`,
  );
});

// ---------------------------------------------------------------------------
// The census note names a held stream, never a held repository
// ---------------------------------------------------------------------------

/**
 * One census repo input: a held stream carrying the sibling's claim and a
 * second issue behind it, plus a free stream with claimable work.
 *
 * @param scanState - What the scan did with the repository this cycle
 * @param heldBy - Assignees of `#1082` — the sibling's claim, or nobody
 */
function censusInput(
  scanState: { scannedThisCycle: boolean; skipReason?: string },
  heldBy: string[],
) {
  return {
    repo: REPO,
    monitored: true,
    nice: 0,
    ...scanState,
    issues: [
      {
        number: 1082,
        labels: ["top-priority"],
        assignees: heldBy,
        milestone: "PR Auto-merge",
      },
      {
        // Behind the sibling's claim in the same stream: refused, and the
        // refusal is recorded against the stream rather than lost.
        number: 1090,
        labels: ["top-priority"],
        assignees: [],
        milestone: "PR Auto-merge",
      },
      {
        number: 964,
        labels: ["top-priority"],
        assignees: [],
        milestone: "Env Injection",
      },
    ],
  } as Parameters<typeof buildIdleDecisionCensus>[0]["repos"][number];
}

Deno.test("stream exclusion - a sibling's held stream does not report the repository as never scanned (Issue #1091)", () => {
  // `inversion_repo_held` says "this work was never evaluated". After #1091
  // that is false of a slot's hold: the scan looks at the repository, refuses
  // the held stream as `milestone-occupied` and evaluates the rest. Only a
  // whole-repository hold still earns the note.
  const held = new InFlightRepoRegistry();
  held.tryAcquire(REPO, 1082, "s1", { milestone: "PR Auto-merge" });
  const slotHold = resolveRepoScanState({
    repo: REPO,
    claimScanCompleted: true,
    scanExcludedRepos: held.leasedRepos(),
    claimGateReason: () => "cycle_deadline",
  });
  assertEquals(slotHold, { scannedThisCycle: true });

  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: WORKER,
    // The held stream is occupied by this host's own assignment, which is
    // what the census reads.
    repos: [censusInput(slotHold, [WORKER])],
  });
  assertEquals(census.heldInversionRepos, []);
  const lines = formatIdleDecisionCensus(census);
  assert(
    !lines.some((l) => l.includes("inversion_repo_held")),
    `a held stream must not be reported as a held repository: ${
      lines.join(" | ")
    }`,
  );
  const repoLine = lines.find((l) => l.includes(`repo=${REPO}`))!;
  assertStringIncludes(repoLine, "skip_reason=scanned");
  // The refusal is recorded against the *stream*: the issue behind the
  // sibling's claim counts as `stream_occupied`, while the free milestone's
  // issue stays claimable. That is the difference from a held repository,
  // which recorded nothing about a single one of its issues.
  assertStringIncludes(repoLine, "stream_occupied=1");
  assertStringIncludes(repoLine, "top_priority=1");
});

Deno.test("stream exclusion - a whole-repository lease still reports inversion_repo_held (Issue #898)", () => {
  const leased = new InFlightRepoRegistry();
  leased.tryAcquire(REPO, 4408, MAINTENANCE_LANE_SLOT_ID, {
    maintenance: true,
  });
  const state = resolveRepoScanState({
    repo: REPO,
    claimScanCompleted: true,
    scanExcludedRepos: leased.leasedRepos(),
    claimGateReason: () => "cycle_deadline",
  });
  assertEquals(state, {
    scannedThisCycle: false,
    skipReason: "repo_held_in_flight",
  });

  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: WORKER,
    repos: [censusInput(state, [])],
  });
  assertEquals(census.heldInversionRepos, [REPO]);
  assert(
    formatIdleDecisionCensus(census).some((l) =>
      l.includes("inversion_repo_held")
    ),
  );
});
