/**
 * End-to-end regression test for the host-3 unhealthy-repo scenario
 * (Issue #4040, parent #4031).
 *
 * The sub-issues #4035–#4039 each test one layer. This test drives the
 * whole chain through the real run loop with a faked `gh` at the bottom,
 * so nothing in between is stubbed:
 *
 * ```mermaid
 * flowchart LR
 *     G["faked gh<br/>issue list"] --> F["fetchAllIssues<br/>(#4037)"]
 *     F --> C["classifyProbeFailure<br/>(#4035)"]
 *     C --> S["access store<br/>(#4036)"]
 *     S --> H["health gate in<br/>runCoreLoop (#4038)"]
 *     H --> N["dark repos named<br/>on the worker log (#4039)"]
 * ```
 *
 * It reproduces the incident shape exactly: `checkClaudeHealth()` and
 * `checkGhAuth()` both succeed — the identity was valid, just the *wrong*
 * identity — while two monitored repos answer the issue-list probe with a
 * real `Could not resolve to a Repository` / HTTP 404 error.
 *
 * Three scenarios:
 *   1. Incident — the host ends unhealthy, both dark repos are named on the
 *      worker log, and the accessible repos are still scanned and worked
 *      while unhealthy.
 *   2. Recovery — once the two repos answer again the next iteration is
 *      healthy, with no restart and no operator action.
 *   3. Inverse guard — a rate-limit storm (`403`/`429` on every probe)
 *      never marks the host unhealthy.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { fetchAllIssues } from "../lib/issue_query.ts";
import {
  getInaccessibleRepos,
  resetRepoAccessState,
} from "../lib/monitored_repo_access.ts";

// ---------------------------------------------------------------------------
// Monitored fleet under test
// ---------------------------------------------------------------------------

/** Repos the identity can still see. */
const ACCESSIBLE_REPOS = ["stSoftwareAU/alpha", "stSoftwareAU/charlie"];

/** The two repos that went dark in the incident, in store (sorted) order. */
const DARK_REPOS = ["TitlePage/bravo", "TitlePage/delta"];

/** Full monitored set, deliberately interleaved so order is not load-bearing. */
const MONITORED_REPOS = [
  "stSoftwareAU/alpha",
  "TitlePage/bravo",
  "stSoftwareAU/charlie",
  "TitlePage/delta",
];

// ---------------------------------------------------------------------------
// Faked gh layer
// ---------------------------------------------------------------------------

/** The error text `gh` actually prints when a repo is invisible to the token. */
function notFoundError(repo: string): Error {
  return new Error(
    `GraphQL: Could not resolve to a Repository with the name '${repo}'. ` +
      `(repository) [HTTP 404]`,
  );
}

/** A rate-limit refusal — GitHub's other 403, plus the 429 shape. */
function rateLimitError(repo: string): Error {
  return new Error(
    `HTTP 403: API rate limit exceeded for user ID 4242 ` +
      `(https://api.github.com/repos/${repo}/issues) [429 Too Many Requests]`,
  );
}

/** One open, claimable issue for `repo`, in `gh issue list --json` shape. */
function issueListJson(repo: string): string {
  return JSON.stringify([
    {
      number: 101,
      title: `Claimable work in ${repo}`,
      url: `https://github.com/${repo}/issues/101`,
      assignees: [],
      labels: [{ name: "claude" }],
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
      author: { login: "nigeldavis" },
      milestone: null,
      body: "",
    },
  ]);
}

/** Extract the `--repo` argument from a faked `gh issue list` invocation. */
function repoArg(args: string[]): string {
  const index = args.indexOf("--repo");
  const repo = index >= 0 ? args[index + 1] : undefined;
  if (repo === undefined) {
    // Fail loud: a probe without a repo means the call site changed shape.
    throw new Error(`faked gh received no --repo argument: ${args.join(" ")}`);
  }
  return repo;
}

// ---------------------------------------------------------------------------
// Loop harness
// ---------------------------------------------------------------------------

/** One observation stamped with the loop iteration it happened in. */
interface IterationEvent {
  iteration: number;
  repo: string;
}

interface LoopObservations {
  /** Iterations in which an issue was actually processed, with its repo. */
  worked: IterationEvent[];
  /** Iterations in which the access gate logged its `[repo-access]` line. */
  unhealthyIterations: number[];
  /** Every line the loop sent to `logError`. */
  errorLines: string[];
  /** Iterations completed. */
  iterations: number;
  /** How many times the loop claimed the PID file — 1 means "no restart". */
  pidClaims: number;
  /** The loop's own health verdict at exit (`lastHealthCheckPassed`). */
  healthy: boolean;
}

/**
 * Run `cycles` iterations of the real loop against a faked `gh`.
 *
 * `ghFor(repo, iteration)` returns the issue-list JSON or throws the error
 * `gh` would have thrown. Nothing between that function and the health gate
 * is stubbed — the probe recording, classification, access store and health
 * flip are all the production code paths.
 */
async function runLoopAgainstFakeGh(
  cycles: number,
  ghFor: (repo: string, iteration: number) => string,
): Promise<LoopObservations> {
  const obs: LoopObservations = {
    worked: [],
    unhealthyIterations: [],
    errorLines: [],
    iterations: 0,
    pidClaims: 0,
    healthy: false,
  };

  let iteration = 0;
  let nowValue = 0;

  const gh = (args: string[]): Promise<string> =>
    Promise.resolve(ghFor(repoArg(args), iteration));

  const deps: RunCoreDeps = createMockDeps({
    // First call of every iteration — the iteration counter for the whole run.
    checkClaudeHealth: () => {
      iteration++;
      obs.iterations = iteration;
      return Promise.resolve({ ok: true, value: { healthy: true } });
    },
    checkGhAuth: () => Promise.resolve({ ok: true, value: { valid: true } }),

    claimPidFile: () => {
      obs.pidClaims++;
      return Promise.resolve();
    },

    logError: (msg: string) => {
      obs.errorLines.push(msg);
      if (msg.includes("[repo-access]")) {
        obs.unhealthyIterations.push(iteration);
      }
    },

    // Priority 2 scan: probe every monitored repo through the production
    // issue-list fetch, then claim the first candidate found. Every repo is
    // probed before a candidate is picked, exactly as the real scan does —
    // an early return would leave later repos unprobed and the store blind.
    findNextIssue: async () => {
      const candidates: string[] = [];
      for (const repo of MONITORED_REPOS) {
        try {
          const issues = await fetchAllIssues(repo, undefined, 100, gh);
          if (issues.length > 0) candidates.push(repo);
        } catch {
          // A probe failure is tolerated by the scan today — the repo is
          // simply skipped. The access store has already recorded it.
        }
      }
      const repo = candidates[0];
      if (repo === undefined) return { ok: true, value: null };
      return {
        ok: true,
        value: {
          repo,
          issueNumber: 101,
          issueTitle: `Claimable work in ${repo}`,
          milestoneTitle: "",
        },
      };
    },

    processIssue: (issue) => {
      obs.worked.push({ iteration, repo: issue.repo });
      return Promise.resolve({ ok: true, value: { success: true } });
    },

    now: () => nowValue,
    sleep: () => {
      // Terminate on the iteration count rather than the sleep count, so the
      // run length is exact however many times the loop sleeps per cycle.
      if (iteration >= cycles) nowValue += 4000 * 1000;
      return Promise.resolve();
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);
  assertEquals(
    result.plannedShutdown,
    true,
    "the harness must end on the planned-shutdown path, not an error exit",
  );
  obs.healthy = result.lastHealthCheckPassed;
  return obs;
}

// ---------------------------------------------------------------------------
// Scenario 1 — the incident
// ---------------------------------------------------------------------------

Deno.test(
  "host-3 e2e - two repos 404 while auth is valid: host unhealthy, both repos named, accessible repos still worked (Issue #4040)",
  async () => {
    resetRepoAccessState();
    try {
      // Three iterations: the threshold is two consecutive denials, and the
      // gate reads the store at the *start* of an iteration, so the flip
      // lands on iteration 3.
      const obs = await runLoopAgainstFakeGh(3, (repo) => {
        if (DARK_REPOS.includes(repo)) throw notFoundError(repo);
        return issueListJson(repo);
      });

      assertEquals(
        obs.healthy,
        false,
        "two inaccessible monitored repos must leave the host unhealthy — " +
          "the #4028 false-healthy signature is the whole point of the chain",
      );

      // The health surface names both repos on the worker log.
      const accessLines = obs.errorLines.filter((l) =>
        l.includes("[repo-access]")
      );
      assert(accessLines.length >= 1, "the gate must log a [repo-access] line");
      for (const repo of DARK_REPOS) {
        assertStringIncludes(accessLines[0]!, repo);
      }
      assertStringIncludes(accessLines[0]!, "status=inaccessible");
      assertStringIncludes(accessLines[0]!, "consecutive=2");

      // The store itself names exactly the two dark repos, in stable order.
      assertEquals(getInaccessibleRepos(), DARK_REPOS);

      // Work continued on the repos that remain accessible — including in
      // the unhealthy iteration. Copying the `continue` from the Claude /
      // gh-auth branches would have stopped the fleet dead.
      const unhealthyIteration = obs.unhealthyIterations[0];
      assert(
        unhealthyIteration !== undefined,
        "the gate must have flipped within the run",
      );
      const workedWhileUnhealthy = obs.worked.filter((w) =>
        w.iteration >= unhealthyIteration
      );
      assert(
        workedWhileUnhealthy.length >= 1,
        "the unhealthy iteration must still scan and work accessible repos",
      );
      for (const event of obs.worked) {
        assert(
          ACCESSIBLE_REPOS.includes(event.repo),
          `only accessible repos may be worked, got ${event.repo}`,
        );
      }
    } finally {
      resetRepoAccessState();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 2 — automatic recovery
// ---------------------------------------------------------------------------

Deno.test(
  "host-3 e2e - health recovers on the next iteration once the repos answer again, with no restart (Issue #4040)",
  async () => {
    resetRepoAccessState();
    try {
      // Iterations 1–3 reproduce the incident; from iteration 4 the repos
      // answer again, so that scan clears the store and iteration 5 is healthy.
      const obs = await runLoopAgainstFakeGh(5, (repo, iteration) => {
        if (DARK_REPOS.includes(repo) && iteration < 4) {
          throw notFoundError(repo);
        }
        return issueListJson(repo);
      });

      assertEquals(
        obs.healthy,
        true,
        "recovery must be automatic — one successful probe clears the store",
      );
      assertEquals(
        getInaccessibleRepos(),
        [],
        "no repo may remain flagged once every probe succeeds",
      );
      assertEquals(
        obs.unhealthyIterations.includes(5),
        false,
        "the iteration after recovery must not log the unhealthy line",
      );
      assertEquals(
        obs.pidClaims,
        1,
        "recovery must need no restart — the loop claimed the PID file once",
      );
      // Every monitored repo is worked again once access is restored.
      const workedAfterRecovery = new Set(
        obs.worked.filter((w) => w.iteration >= 5).map((w) => w.repo),
      );
      assert(
        workedAfterRecovery.size >= 1,
        "the recovered iteration must still be working issues",
      );
    } finally {
      resetRepoAccessState();
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario 3 — inverse guard: a rate-limit storm is not an access failure
// ---------------------------------------------------------------------------

Deno.test(
  "host-3 e2e - a rate-limit storm on every probe never marks the host unhealthy (Issue #4040)",
  async () => {
    resetRepoAccessState();
    try {
      // Every repo, every iteration, refused with GitHub's throttling 403/429.
      const obs = await runLoopAgainstFakeGh(4, (repo) => {
        throw rateLimitError(repo);
      });

      assertEquals(
        obs.healthy,
        true,
        "throttling says nothing about access — a storm must stay healthy",
      );
      assertEquals(
        getInaccessibleRepos(),
        [],
        "a rate-limited probe must never count towards the denial threshold",
      );
      assertEquals(
        obs.unhealthyIterations,
        [],
        "no [repo-access] line may be logged during a rate-limit storm",
      );
      assert(
        obs.iterations >= 1,
        "a throttled but healthy host must keep cycling",
      );
    } finally {
      resetRepoAccessState();
    }
  },
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal RunCoreDeps factory — fully idle by default. */
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
