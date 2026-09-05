/**
 * The composed idle-filing stack against a realistic fleet (Issue #1050).
 *
 * The operator's requirement is one sentence: **if no work can be started
 * right now, raise an idle task in one of the monitored repositories.** Every
 * suppression test in this repository proves that its own gate suppresses,
 * and the one positive test — "run_core - idle pass invokes runIdleTaskFiler
 * (Issue #2005)" — passes because it supplies *no* audit and *no* census:
 * both suppressors are absent, not passing. Nothing asserted that the stack
 * as a whole still lets an idle task through, and it did not. No idle task
 * was filed anywhere in the fleet between 2026-08-26 and 2026-09-05 while two
 * slots sat at roughly 10% occupancy.
 *
 * These tests run the real `auditClaimableState`, the real
 * `buildIdleDecisionCensus` and the real `anyRepoHasUnblockedRealWork`
 * against one fixture, through the real `runCoreLoop` gate, and assert on the
 * only outcome that matters: was an idle task filed?
 *
 * The fixture is the observed fleet shape — one repository holding a backlog
 * of `work-on` issues that cannot be started, seventeen empty repositories —
 * and it is replayed once per *reason* the backlog cannot be started, because
 * both field incidents were the same fault reached by different gates:
 *
 *   - a work stream held by a sibling Vibe Coder (`stSoftwareAU/VibeCoder`,
 *     2026-08-26 — 24 issues, `milestone-occupied`),
 *   - an open fleet PR in the work stream (`stSoftwareAU/NEAT-AI-Ockham`,
 *     2026-09-05 — #104-#110 behind PR #116, `pr-blocked`),
 *   - an assignee, and
 *   - this run's own cooldown.
 *
 * The inverse is pinned just as hard: one genuinely startable issue anywhere
 * in the fleet and **nothing** may be filed, or the fix becomes "always file"
 * and re-introduces the #2106 wrapper flooding and the #2806 inversion.
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
import type { OpenPR } from "../lib/issue_query.ts";

// ---------------------------------------------------------------------------
// Fleet fixture
// ---------------------------------------------------------------------------

const WORKER_USER = "worker-bot";
/** A sibling Vibe Coder — `fleet_pr_authors`, so its work occupies a stream. */
const SIBLING = "sibling-bot";
/**
 * The occupancy and PR-blocking set every instrument must use (Issues #1050,
 * #1064): the accounts the fleet operates, never the `allowed_authors`
 * permission list, which holds humans.
 */
const PUSH_CAPABLE_AUTHORS = [SIBLING, WORKER_USER];

const BACKLOG_REPO = "org/backlog";
/** The seventeen quiet repositories an idle task belongs in. */
const QUIET_REPOS = Array.from({ length: 17 }, (_, i) => `org/quiet-${i + 1}`);
const FLEET_REPOS = [BACKLOG_REPO, ...QUIET_REPOS];

/** How many `work-on` issues the one busy repository holds. */
const BACKLOG_SIZE = 24;

/**
 * Why the backlog cannot be started this cycle — one per gate the claim scan
 * applies and the suppressors used to ignore. `none` is the control: the same
 * backlog, genuinely startable.
 */
type Blocker =
  | "sibling_occupied"
  | "pr_blocked"
  | "assigned"
  | "cooled_down"
  | "none";

interface FixtureIssue {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  milestone: string;
}

function backlogIssues(blocker: Blocker): FixtureIssue[] {
  const issues: FixtureIssue[] = [];
  for (let n = 100; n < 100 + BACKLOG_SIZE; n++) {
    issues.push({
      number: n,
      title: `Backlog item ${n}`,
      labels: ["work-on"],
      assignees: blocker === "assigned" ? ["someone"] : [],
      milestone: "",
    });
  }
  if (blocker === "sibling_occupied") {
    // Unlabelled, exactly as the live one was: the issue that occupies the
    // stream need carry no discovery label at all.
    issues.push({
      number: 99,
      title: "Something a sibling worker is already doing",
      labels: [],
      assignees: [SIBLING],
      milestone: "",
    });
  }
  return issues;
}

/** One startable `work-on` issue, for the fleet that must file nothing. */
function startableIssue(number: number): FixtureIssue {
  return {
    number,
    title: `Startable item ${number}`,
    labels: ["work-on"],
    assignees: [],
    milestone: "",
  };
}

/** The open fleet PR that defers the whole default-branch stream. */
const BLOCKING_PR: OpenPR = {
  number: 116,
  title: "Fix the thing",
  baseRefName: "main",
  headRefName: "issue-104-fix",
  author: SIBLING,
};

interface Fleet {
  issues: Map<string, FixtureIssue[]>;
  openPRs: Map<string, readonly OpenPR[]>;
  holds: Set<number>;
}

/**
 * The observed shape: one repository holding a backlog nothing can start,
 * every other repository empty. `extra` adds issues to a named repo, which
 * the inverse test uses to plant one genuinely startable issue.
 */
function fleetFixture(
  blocker: Blocker,
  extra?: { repo: string; issues: FixtureIssue[] },
): Fleet {
  const issues = new Map<string, FixtureIssue[]>();
  issues.set(BACKLOG_REPO, backlogIssues(blocker));
  for (const repo of QUIET_REPOS) issues.set(repo, []);
  if (extra) {
    issues.set(extra.repo, [
      ...(issues.get(extra.repo) ?? []),
      ...extra.issues,
    ]);
  }
  const openPRs = new Map<string, readonly OpenPR[]>();
  if (blocker === "pr_blocked") openPRs.set(BACKLOG_REPO, [BLOCKING_PR]);
  const holds = new Set<number>();
  if (blocker === "cooled_down") {
    for (const i of issues.get(BACKLOG_REPO) ?? []) holds.add(i.number);
  }
  return { issues, openPRs, holds };
}

/** `gh issue list --repo <r> --state open --json ...` over the fixture. */
function makeGh(fleet: Fleet): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";
    const rows = (fleet.issues.get(repo) ?? []).map((i) => ({
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
  /** True when the filer got past every gate and would create an issue. */
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
  fleet: Fleet,
): Promise<CompositionOutcome> {
  const gh = makeGh(fleet);
  const logs: string[] = [];
  const outcome: CompositionOutcome = {
    filed: false,
    auditTotal: -1,
    inversion: false,
    logs,
  };
  const openPRsFn = (repo: string) =>
    Promise.resolve(fleet.openPRs.get(repo) ?? []);
  const runLocalHoldFn = (_repo: string, issueNumber: number) =>
    fleet.holds.has(issueNumber);

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
        pushCapableAuthors: PUSH_CAPABLE_AUTHORS,
        tick,
        scanFoundClaimable,
        ghCommandFn: gh,
        openPRsFn,
        runLocalHoldFn,
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
        pushCapableAuthors: PUSH_CAPABLE_AUTHORS,
        repos: FLEET_REPOS.map((repo) => ({
          repo,
          monitored: true,
          scannedThisCycle: claimScanCompleted,
          nice: 0,
          issues: censusIssues(fleet.issues.get(repo) ?? []),
          openPRs: [...(fleet.openPRs.get(repo) ?? [])],
          runLocalHolds: fleet.holds,
        })),
      });
      outcome.inversion = census.inversionDetected;
      return Promise.resolve({ inversionDetected: census.inversionDetected });
    },

    // Suppressor 3 — the filer's own fleet-global startable-work gate
    // (#2813, #1050), which stands between run_core's decision to file and
    // an issue being created. Filing happens only when it, too, finds
    // nothing a slot could start.
    runIdleTaskFiler: async () => {
      const fleetHasWork = await anyRepoHasUnblockedRealWork({
        repos: FLEET_REPOS,
        workerUser: WORKER_USER,
        pushCapableAuthors: PUSH_CAPABLE_AUTHORS,
        openPRsFn,
        runLocalHoldFn,
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

/**
 * Assert the composed stack files an idle task against a fleet whose only
 * backlog is blocked by `blocker`, and that no suppressor claimed otherwise.
 */
async function assertFilesIdleTask(blocker: Blocker): Promise<void> {
  const outcome = await runComposedIdleCycle(fleetFixture(blocker));
  assertEquals(
    outcome.auditTotal,
    0,
    `the audit must not count ${blocker} work as claimable`,
  );
  assertEquals(
    outcome.inversion,
    false,
    `the census must not report an inversion over ${blocker} work`,
  );
  assert(
    outcome.filed,
    `an idle task must be filed when the fleet's only backlog is ${blocker}; ` +
      `logs:\n${outcome.logs.join("\n")}`,
  );
  assert(
    outcome.logs.some((l) => l.includes("invoking=idle-task-filer")),
    "the filer must be invoked, not skipped",
  );
}

// ---------------------------------------------------------------------------
// If no work can be started, an idle task is filed — one test per reason
// ---------------------------------------------------------------------------

Deno.test(
  "idle filing - a backlog behind one open fleet PR still files an idle task (Issue #1050)",
  async () => {
    // The 2026-09-05 shape: NEAT-AI-Ockham #104-#110 behind PR #116. The
    // scan refuses all six as `pr-blocked`; the fleet gate counted all six
    // and suppressed filing across all eighteen repositories.
    await assertFilesIdleTask("pr_blocked");
  },
);

Deno.test(
  "idle filing - a backlog in a stream a sibling holds still files an idle task (Issue #1050)",
  async () => {
    // The 2026-08-26 shape: 24 issues behind one assignment in the same
    // work stream, every one of them `milestone-occupied` to the scan.
    await assertFilesIdleTask("sibling_occupied");
  },
);

Deno.test(
  "idle filing - a backlog that is entirely assigned still files an idle task (Issue #2751)",
  async () => {
    await assertFilesIdleTask("assigned");
  },
);

Deno.test(
  "idle filing - a backlog this run is holding back still files an idle task (Issue #655)",
  async () => {
    await assertFilesIdleTask("cooled_down");
  },
);

// ---------------------------------------------------------------------------
// The opposite direction — #2106 wrapper flooding / #2806 inversion
// ---------------------------------------------------------------------------

Deno.test(
  "idle filing - the same backlog, genuinely startable, files nothing (Issue #2106 / #2806)",
  async () => {
    const outcome = await runComposedIdleCycle(fleetFixture("none"));

    assertEquals(
      outcome.auditTotal,
      BACKLOG_SIZE,
      "with nothing blocking it, the whole backlog is claimable",
    );
    assertEquals(
      outcome.inversion,
      true,
      "the census must report the inversion the filer is being asked to make",
    );
    assertEquals(
      outcome.filed,
      false,
      "no idle task may be filed while the fleet holds startable work",
    );
  },
);

Deno.test(
  "idle filing - one startable issue anywhere in the fleet suppresses filing (Issue #2813)",
  async () => {
    // Repo A's backlog is PR-blocked, but one quiet repo holds a single
    // startable issue. The fleet is not idle, so nothing may be filed — the
    // guard against the fix degrading into "always file".
    const outcome = await runComposedIdleCycle(
      fleetFixture("pr_blocked", {
        repo: QUIET_REPOS[0]!,
        issues: [startableIssue(7)],
      }),
    );

    assertEquals(outcome.auditTotal, 1);
    assertEquals(outcome.filed, false);
  },
);

// ---------------------------------------------------------------------------
// Neither suppressor may be load-bearing on its own
// ---------------------------------------------------------------------------

Deno.test(
  "idle filing - the filer's own fleet gate agrees with the audit on every fleet (Issue #1050)",
  async () => {
    const blockers: Blocker[] = [
      "pr_blocked",
      "sibling_occupied",
      "assigned",
      "cooled_down",
    ];
    for (const blocker of blockers) {
      const fleet = fleetFixture(blocker);
      const hasWork = await anyRepoHasUnblockedRealWork({
        repos: FLEET_REPOS,
        workerUser: WORKER_USER,
        pushCapableAuthors: PUSH_CAPABLE_AUTHORS,
        openPRsFn: (repo) => Promise.resolve(fleet.openPRs.get(repo) ?? []),
        runLocalHoldFn: (_repo, n) => fleet.holds.has(n),
        ghCommandFn: makeGh(fleet),
        logFn: () => {},
      });
      assertEquals(
        hasWork,
        false,
        `a ${blocker} backlog is not work the fleet can start`,
      );
    }

    const free = fleetFixture("none");
    assertEquals(
      await anyRepoHasUnblockedRealWork({
        repos: FLEET_REPOS,
        workerUser: WORKER_USER,
        pushCapableAuthors: PUSH_CAPABLE_AUTHORS,
        openPRsFn: (repo) => Promise.resolve(free.openPRs.get(repo) ?? []),
        runLocalHoldFn: (_repo, n) => free.holds.has(n),
        ghCommandFn: makeGh(free),
        logFn: () => {},
      }),
      true,
      "the same backlog with nothing blocking it is exactly what #2813 protects",
    );
  },
);
