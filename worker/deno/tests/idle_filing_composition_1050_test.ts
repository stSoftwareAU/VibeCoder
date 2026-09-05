/**
 * The composed idle-filing stack against a realistic fleet (Issue #1050).
 *
 * Every suppression test in this repository proves that its own gate
 * suppresses, and the one positive test — "run_core - idle pass invokes
 * runIdleTaskFiler (Issue #2005)" — passes because it supplies *no* audit and
 * *no* census: both suppressors are absent, not passing. Nothing asserted
 * that the stack as a whole still lets an idle task through, and it did not:
 * no idle task was filed anywhere in the fleet between 2026-08-26 and
 * 2026-09-05 while two slots sat at ~10% occupancy.
 *
 * These tests run the real `auditClaimableState`, the real
 * `buildIdleDecisionCensus` and the real `anyRepoHasUnblockedRealWork`
 * against one gh fixture, through the real `runCoreLoop` gate, and assert on
 * the only outcome that matters: was an idle task filed?
 *
 * The fixture is the observed fleet shape. One repository holds a large
 * backlog of `work-on` issues in the default-branch work stream; that stream
 * already holds an issue assigned to a trusted account, so the claim scan
 * refuses every one of them as `milestone-occupied` and can claim nothing.
 * The other seventeen repositories are empty. An idle slot must be given an
 * idle task.
 *
 * Both directions are pinned. Remove the occupying assignment and the same
 * backlog becomes genuinely claimable, at which point nothing may be filed —
 * or the fix trades the starved fleet of #1050 for the wrapper flooding of
 * #2106 and the priority inversion of #2806.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { auditClaimableState } from "../lib/idle_detect_diagnostics.ts";
import {
  buildIdleDecisionCensus,
  type CensusIssue,
} from "../lib/idle_decision_census.ts";
import { anyRepoHasUnblockedRealWork } from "../lib/repo_busy_for_idle_task.ts";

// ---------------------------------------------------------------------------
// Fleet fixture
// ---------------------------------------------------------------------------

const WORKER_USER = "worker-bot";
/** The `.config.json` `allowed_authors` set the claim scan honours. */
const ALLOWED_AUTHORS = ["colleague", WORKER_USER];

const BACKLOG_REPO = "org/backlog";
/** The seventeen quiet repositories an idle task belongs in. */
const QUIET_REPOS = Array.from(
  { length: 17 },
  (_, i) => `org/quiet-${i + 1}`,
);
const FLEET_REPOS = [BACKLOG_REPO, ...QUIET_REPOS];

interface FixtureIssue {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  milestone: string;
}

/**
 * The observed shape: 24 unassigned `work-on` issues in the default-branch
 * stream. `withOccupyingAssignment` adds the issue that occupies that stream
 * — unlabelled, exactly as the live one was — which is what makes all 24
 * unclaimable to the scan.
 */
function backlogIssues(withOccupyingAssignment: boolean): FixtureIssue[] {
  const issues: FixtureIssue[] = [];
  for (let n = 100; n < 124; n++) {
    issues.push({
      number: n,
      title: `Backlog item ${n}`,
      labels: ["work-on"],
      assignees: [],
      milestone: "",
    });
  }
  if (withOccupyingAssignment) {
    issues.push({
      number: 99,
      title: "Something a colleague is already doing",
      labels: [],
      assignees: ["colleague"],
      milestone: "",
    });
  }
  return issues;
}

function fleetFixture(
  withOccupyingAssignment: boolean,
): Map<string, FixtureIssue[]> {
  const fleet = new Map<string, FixtureIssue[]>();
  fleet.set(BACKLOG_REPO, backlogIssues(withOccupyingAssignment));
  for (const repo of QUIET_REPOS) fleet.set(repo, []);
  return fleet;
}

/** `gh issue list --repo <r> --state open --json ...` over the fixture. */
function makeGh(
  fleet: Map<string, FixtureIssue[]>,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";
    const rows = (fleet.get(repo) ?? []).map((i) => ({
      number: i.number,
      title: i.title,
      labels: i.labels.map((name) => ({ name })),
      assignees: i.assignees.map((login) => ({ login })),
      milestone: i.milestone === "" ? null : { title: i.milestone },
      body: "",
    }));
    return Promise.resolve(JSON.stringify(rows));
  };
}

function censusIssues(issues: FixtureIssue[]): CensusIssue[] {
  return issues.map((i) => ({
    number: i.number,
    labels: i.labels,
    assignees: i.assignees,
    milestone: i.milestone,
    body: "",
  }));
}

// ---------------------------------------------------------------------------
// run_core deps
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
    now: () => Date.now(),

    ...overrides,
  };
}

interface CompositionOutcome {
  /** True when the filer got as far as creating an idle task. */
  filed: boolean;
  /** The audit's fleet-wide claimable total for the cycle. */
  auditTotal: number;
  /** True when the census reported a priority inversion. */
  inversion: boolean;
  /** Everything the loop and the three suppressors logged. */
  logs: string[];
}

/**
 * Run one idle cycle of `runCoreLoop` with all three real suppressors wired
 * to `fleet`, and report what the composed stack decided.
 */
async function runComposedIdleCycle(
  fleet: Map<string, FixtureIssue[]>,
): Promise<CompositionOutcome> {
  const gh = makeGh(fleet);
  const logs: string[] = [];
  const outcome: CompositionOutcome = {
    filed: false,
    auditTotal: -1,
    inversion: false,
    logs,
  };

  let cycleCount = 0;
  let nowValue = 0;
  const deps = createMockDeps({
    log: (message: string) => logs.push(message),
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) nowValue += 4000 * 1000;
      return Promise.resolve();
    },

    // Suppressor 1 — the idle-detect audit (#2106, #2475).
    runIdleDetectAudit: async ({ tick, scanFoundClaimable }) => {
      const result = await auditClaimableState({
        repos: FLEET_REPOS,
        workerUser: WORKER_USER,
        allowedAuthors: ALLOWED_AUTHORS,
        tick,
        scanFoundClaimable,
        ghCommandFn: gh,
        log: (line) => logs.push(line),
      });
      outcome.auditTotal = result.claimableTotal;
      return { claimableTotal: result.claimableTotal };
    },

    // Suppressor 2 — the idle-decision census (#2811, #2813, #753).
    runIdleDecisionCensus: ({ decisionPoint, claimScanCompleted }) => {
      const census = buildIdleDecisionCensus({
        decisionPoint,
        workerUser: WORKER_USER,
        allowedAuthors: ALLOWED_AUTHORS,
        repos: FLEET_REPOS.map((repo) => ({
          repo,
          monitored: true,
          scannedThisCycle: claimScanCompleted,
          nice: 0,
          issues: censusIssues(fleet.get(repo) ?? []),
        })),
      });
      outcome.inversion = census.inversionDetected;
      return Promise.resolve({ inversionDetected: census.inversionDetected });
    },

    // Suppressor 3 — the filer's own fleet-global existence gate (#2813),
    // which stands between run_core's decision to file and an issue being
    // created. Filing happens only when it, too, sees nothing claimable.
    runIdleTaskFiler: async () => {
      const fleetHasWork = await anyRepoHasUnblockedRealWork({
        repos: FLEET_REPOS,
        workerUser: WORKER_USER,
        allowedAuthors: ALLOWED_AUTHORS,
        ghCommandFn: gh,
        logFn: (line) => logs.push(line),
      });
      if (!fleetHasWork) outcome.filed = true;
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;
  await runCoreLoop(config, deps);
  return outcome;
}

// ---------------------------------------------------------------------------
// The case that was broken for ten days
// ---------------------------------------------------------------------------

Deno.test(
  "idle filing - a backlog no slot can claim still lets an idle task through (Issue #1050)",
  async () => {
    const outcome = await runComposedIdleCycle(fleetFixture(true));

    assertEquals(
      outcome.auditTotal,
      0,
      "the audit must not count work the scan refuses as milestone-occupied",
    );
    assertEquals(
      outcome.inversion,
      false,
      "the census already models the occupied stream and must agree",
    );
    assert(
      outcome.filed,
      "an idle task must be filed when the whole fleet backlog is unclaimable; " +
        `logs:\n${outcome.logs.join("\n")}`,
    );
    assert(
      outcome.logs.some((l) => l.includes("invoking=idle-task-filer")),
      "the filer must be invoked, not skipped",
    );
    assert(
      !outcome.logs.some((l) => l.includes("reason=audit_found_claimable")),
      "the audit must not suppress filing on unclaimable work",
    );
  },
);

// ---------------------------------------------------------------------------
// The opposite direction — #2106 wrapper flooding / #2806 inversion
// ---------------------------------------------------------------------------

Deno.test(
  "idle filing - the same backlog, genuinely claimable, files nothing (Issue #2106 / #2806)",
  async () => {
    const outcome = await runComposedIdleCycle(fleetFixture(false));

    assertEquals(
      outcome.auditTotal,
      24,
      "with the stream free, all 24 backlog issues are claimable",
    );
    assertEquals(
      outcome.inversion,
      true,
      "the census must report the inversion the filer is being asked to make",
    );
    assertEquals(
      outcome.filed,
      false,
      "no idle task may be filed while the fleet holds claimable work",
    );
  },
);

// ---------------------------------------------------------------------------
// Neither suppressor may be load-bearing on its own
// ---------------------------------------------------------------------------

Deno.test(
  "idle filing - the filer's own fleet gate agrees with the audit on both fleets (Issue #1050)",
  async () => {
    const unclaimable = await anyRepoHasUnblockedRealWork({
      repos: FLEET_REPOS,
      workerUser: WORKER_USER,
      allowedAuthors: ALLOWED_AUTHORS,
      ghCommandFn: makeGh(fleetFixture(true)),
      logFn: () => {},
    });
    assertEquals(
      unclaimable,
      false,
      "a backlog in an occupied stream is not work the fleet can claim",
    );

    const claimable = await anyRepoHasUnblockedRealWork({
      repos: FLEET_REPOS,
      workerUser: WORKER_USER,
      allowedAuthors: ALLOWED_AUTHORS,
      ghCommandFn: makeGh(fleetFixture(false)),
      logFn: () => {},
    });
    assertEquals(
      claimable,
      true,
      "the same backlog in a free stream is exactly the work #2813 protects",
    );
  },
);
