/**
 * End-to-end test for idle-task framework wiring (Issue #2007).
 *
 * Regression guard for the idle-task pipeline that closes the loop:
 *   - Gap A (#2005): `runIdleTaskFiler` must be invoked from `run_core.ts`
 *     after a fully-idle scan pass. Without the wiring no idle-task
 *     issue is ever filed.
 *   - Gap B (#2006): `collectIdleTaskCandidates` must populate
 *     `idleTaskCandidates` on the `SelectionResult` passed to
 *     `selectHighestPriority`, so a filed idle-task issue is claimable
 *     on the next iteration.
 *   - Claim routing (#1965): `handleIdleTaskIssue` must route an
 *     idle-task issue body to the registered template's `runTask`.
 *   - Label-only dedup (#1984): a second idle pass against the same
 *     repo set must not file a duplicate idle-task issue.
 *
 * Drives the production code paths with stubbed `gh` and stubbed
 * template `runTask` so no real network or scanner calls escape. The
 * test fails closed when any of the four guard points regresses.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { maybeFileIdleTaskCommand } from "../commands/maybe_file_idle_task.ts";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  findExistingIdleTaskIssue,
  IDLE_TASK_LABEL,
} from "../lib/idle_task_issue.ts";
import { SECURITY_SCAN_ISSUE_TITLE } from "../lib/idle_task_templates/security_scan_template.ts";
import { handleIdleTaskIssue } from "../lib/idle_task_claim_handler.ts";
import {
  type IdleTaskRunResult,
  type IdleTaskTemplate,
} from "../lib/idle_task_template.ts";
import type { Logger, WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const REPO = "owner/widget";
const WORKER_USER = "bot";
const SECURITY_SCAN = "security-scan";
const IDLE_TASK_MILESTONE_TITLE = `idle-task: ${SECURITY_SCAN}`;
const NEW_ISSUE_NUMBER = 701;
const MILESTONE_NUMBER = 11;

function makeWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    repos: [REPO],
    issueLabels: ["help-wanted"],
    allowedAuthors: [WORKER_USER],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    failedLabel: "failed",
    failedOnceLabel: "failed-once",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
    needsRevisionLabel: "needs-revision",
    needsHumanLabel: "needs-human",
    shuffleRepos: false,
    workDir: Deno.makeTempDirSync({ prefix: "idle-task-e2e-" }),
    ...overrides,
  };
}

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "idle-task-e2e-cache-" });
  return new IssueCache(dir, 600);
}

interface GhCall {
  args: string[];
}

/**
 * Stubbed gh runner with a tiny scripted shape. Captures every call for
 * later assertion. `state.filedIssues` lets the dedup check observe
 * an issue created in an earlier invocation.
 */
function createGhStub(state: {
  filedIssues: Array<{ number: number; body: string }>;
}): {
  fn: (args: string[]) => Promise<string>;
  calls: GhCall[];
} {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    // Match on the actual `gh issue <subcommand>` positional args rather
    // than `args.join(" ").includes(...)` — Issue #2097's v5 prompt
    // legitimately mentions `gh issue list` / `gh issue create` inside
    // the wrapper body, so a substring scan over the joined arg list
    // false-matches when the body is passed via `--body`.
    const subcommand = args[0] === "issue" ? args[1] : "";
    if (subcommand === "list" && args.includes(IDLE_TASK_LABEL)) {
      const payload = state.filedIssues.map((i) => ({
        number: i.number,
        url: `https://github.com/${REPO}/issues/${i.number}`,
        body: i.body,
      }));
      return Promise.resolve(JSON.stringify(payload));
    }
    if (subcommand === "create") {
      const bodyIndex = args.indexOf("--body");
      const body = bodyIndex >= 0 ? args[bodyIndex + 1] ?? "" : "";
      state.filedIssues.push({ number: NEW_ISSUE_NUMBER, body });
      return Promise.resolve(
        `https://github.com/${REPO}/issues/${NEW_ISSUE_NUMBER}`,
      );
    }
    return Promise.resolve("");
  };
  return { fn, calls };
}

/**
 * Build a minimal RunCoreDeps with overrides. Mirrors the helper in
 * `run_core_idle_task_filer_test.ts` so the contract here cannot be
 * silently altered by a refactor in that file.
 */
function makeMockDeps(overrides?: Partial<RunCoreDeps>): RunCoreDeps {
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

    reportFleetHealthHeartbeat: () => Promise.resolve(),

    ...overrides,
  };
}

function makeLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (message) => warns.push(message),
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, warns };
}

// ---------------------------------------------------------------------------
// Iteration 1 — Gap A: runCoreLoop must invoke runIdleTaskFiler on idle
// ---------------------------------------------------------------------------

Deno.test(
  "idle-task end-to-end - iteration 1: idle pass files an idle-task issue (Issue #2007)",
  async () => {
    const state = {
      filedIssues: [] as Array<{ number: number; body: string }>,
    };
    const { fn: ghFn, calls } = createGhStub(state);
    const progressLogs: string[] = [];

    let filerInvocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const config = makeWorkerConfig();

    const deps = makeMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          // Advance the clock past `endTime` after one cycle so the
          // run loop exits cleanly instead of spinning.
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      runIdleTaskFiler: async () => {
        filerInvocations++;
        // Wire the production command through stubbed gh + decision
        // hooks. If `runIdleTaskFiler` is removed from `run_core.ts`
        // (Gap A regression), `filerInvocations` stays at 0 and the
        // subsequent assertions fail.
        await maybeFileIdleTaskCommand.execute(
          {
            "monitored-repos": REPO,
            "github-user": WORKER_USER,
            "worker-user": WORKER_USER,
            "__testDeps": {
              findExistingFn: () => Promise.resolve(null),
              ensureLabelFn: () =>
                Promise.resolve({ ok: true, value: undefined }),
              ensureMilestoneFn: () =>
                Promise.resolve({
                  number: MILESTONE_NUMBER,
                  title: IDLE_TASK_MILESTONE_TITLE,
                }),
              ghCommandFn: ghFn,
              log: (line: string) => progressLogs.push(line),
              nowFn: () => new Date("2026-05-15T10:00:00.000Z"),
              // Pin to security-scan so the 50/50 dispatcher (Issue #2149)
              // does not randomly pick best-practices, whose buildIssueBody
              // makes real network calls the test stub cannot satisfy.
              pickTemplateFn: (templates: IdleTaskTemplate[]) =>
                templates.find((t) => t.name === SECURITY_SCAN) ?? null,
              // Pin the cadence bias out too (Issue #4009): the stubbed gh
              // history reads as "never scanned", which legitimately makes every
              // important template overdue and would override the pinned pick.
              dueScansFn: () => Promise.resolve([]),
            },
          } as Record<string, unknown>,
          config,
        );
      },
    });

    const runCoreCfg = createDefaultRunCoreConfig();
    runCoreCfg.runDurationSeconds = 3600;

    await runCoreLoop(runCoreCfg, deps);

    // Gap A regression guard — the filer hook is invoked on idle pass.
    assert(
      filerInvocations >= 1,
      `expected runIdleTaskFiler invocations >= 1, got ${filerInvocations}`,
    );

    // Issue #2077: `gh issue create` carries the `idle-task` label —
    // the `idle-task-pending` approval gate has been retired. Issue
    // #2067: security-scan opts out of the per-template milestone, so
    // the `--milestone` flag is omitted entirely.
    const createCalls = calls.filter((c) => c.args.includes("create"));
    assertEquals(createCalls.length, 1);
    const createArgs = createCalls[0]!.args;
    const labelIdx = createArgs.indexOf("--label");
    assert(labelIdx >= 0);
    assertEquals(createArgs[labelIdx + 1], IDLE_TASK_LABEL);
    assertEquals(
      createArgs.indexOf("--milestone"),
      -1,
      "security-scan wrapper issue must not carry a milestone (Issue #2067)",
    );

    // Structured progress log line emitted with template, repo, and the
    // newly-created issue number.
    const filedLog = progressLogs.find((l) =>
      l.includes(`[idle-task] template=${SECURITY_SCAN}`) &&
      l.includes(`repo=${REPO}`) &&
      l.includes("action=filed") &&
      l.includes(`issue=${NEW_ISSUE_NUMBER}`)
    );
    assert(
      filedLog !== undefined,
      `expected a [idle-task] action=filed progress log; saw ${
        JSON.stringify(progressLogs)
      }`,
    );

    // Issue #2077: the persisted body is the substituted prompt — no
    // hidden marker. The claim handler routes by title now.
    // Issue #2135 (v6): the repo placeholder was retired; the
    // substituted prompt no longer embeds the repo name, so assert on
    // the prompt's canonical heading instead.
    assertEquals(state.filedIssues.length, 1);
    assert(
      !state.filedIssues[0]!.body.includes("<!-- idle-task:"),
      "human-style wrapper must not embed the legacy idle-task marker",
    );
    assertStringIncludes(
      state.filedIssues[0]!.body,
      "MythOS-style Security Audit",
    );
  },
);

// ---------------------------------------------------------------------------
// Iteration 2 — Gap B: findOldestIssue surfaces the filed candidate
// ---------------------------------------------------------------------------

Deno.test(
  "idle-task end-to-end - iteration 2: findOldestIssue surfaces the filed idle-task candidate (Issue #2007)",
  async () => {
    const config = makeWorkerConfig();

    // Iteration-2 fixture — the just-filed idle-task issue, plus the
    // timeline event proving the worker user applied the label.
    const ghFn = (args: string[]): Promise<string> => {
      const cmd = args.join(" ");
      if (cmd.includes("issue list")) {
        return Promise.resolve(
          JSON.stringify([
            {
              number: NEW_ISSUE_NUMBER,
              title: SECURITY_SCAN_ISSUE_TITLE,
              url: `https://github.com/${REPO}/issues/${NEW_ISSUE_NUMBER}`,
              assignees: [],
              labels: [{ name: IDLE_TASK_LABEL }],
              createdAt: "2026-05-15T10:00:00Z",
              author: { login: WORKER_USER },
              milestone: { title: IDLE_TASK_MILESTONE_TITLE },
            },
          ]),
        );
      }
      if (cmd.includes("timeline")) {
        return Promise.resolve(
          JSON.stringify([
            {
              event: "labeled",
              label: { name: IDLE_TASK_LABEL },
              actor: { login: WORKER_USER },
              created_at: "2026-05-15T10:00:00Z",
            },
          ]),
        );
      }
      if (cmd.includes("issue view") && cmd.includes("title,body")) {
        return Promise.resolve(
          JSON.stringify({
            title: SECURITY_SCAN_ISSUE_TITLE,
            body: `stub prompt body for ${REPO}`,
          }),
        );
      }
      if (cmd.includes("pr list")) return Promise.resolve("[]");
      return Promise.resolve("[]");
    };

    const result = await findOldestIssue(config, {
      githubUser: WORKER_USER,
      ghCommandFn: ghFn,
      cache: createTestCache(),
      isIssueInCooldown: () => false,
    });

    // Gap B regression guard — if `collectIdleTaskCandidates` is removed
    // from `findOldestIssue`, the candidate is never surfaced and
    // `result.found` is false.
    assertEquals(result.found, true);
    assertStringIncludes(result.output, `|${NEW_ISSUE_NUMBER}|`);
    assertStringIncludes(result.output, REPO);
  },
);

// ---------------------------------------------------------------------------
// Claim handler routes the idle-task body to securityScanTemplate.runTask
// ---------------------------------------------------------------------------

Deno.test(
  "idle-task end-to-end - claim handler dispatches by title to securityScanTemplate.runTask (Issues #2007, #2077)",
  async () => {
    let runTaskCalls = 0;
    const stubbedTemplate: IdleTaskTemplate = {
      name: SECURITY_SCAN,
      description: "stub",
      buildIssueTitle: () => SECURITY_SCAN_ISSUE_TITLE,
      buildIssueBody: () => "stub",
      runTask: (opts): Promise<IdleTaskRunResult> => {
        runTaskCalls++;
        assertEquals(opts.repo, REPO);
        assertEquals(opts.idleTaskIssueNumber, NEW_ISSUE_NUMBER);
        return Promise.resolve({ ok: true, summary: "test" });
      },
    };

    const { logger } = makeLogger();
    const result = await handleIdleTaskIssue(
      {
        repo: REPO,
        issueNumber: NEW_ISSUE_NUMBER,
        issueTitle: SECURITY_SCAN_ISSUE_TITLE,
        issueLabels: [IDLE_TASK_LABEL],
        issueBody: "the substituted security-scan prompt would live here",
        workDir: "/tmp/widget",
      },
      {
        logger,
        listTemplatesFn: () => [stubbedTemplate],
      },
    );

    assertEquals(result.handled, true);
    assertEquals(result.ok, true);
    assertEquals(result.summary, "test");
    assertEquals(runTaskCalls, 1);
  },
);

// ---------------------------------------------------------------------------
// Property check — label-only dedup blocks a duplicate filing
// ---------------------------------------------------------------------------

Deno.test(
  "idle-task end-to-end - two idle iterations file at most one idle-task issue (Issue #2007)",
  async () => {
    const state = {
      filedIssues: [] as Array<{ number: number; body: string }>,
    };
    const { fn: ghFn, calls } = createGhStub(state);
    const config = makeWorkerConfig();

    const runFiler = (): Promise<unknown> =>
      maybeFileIdleTaskCommand.execute(
        {
          "monitored-repos": REPO,
          "github-user": WORKER_USER,
          "worker-user": WORKER_USER,
          "__testDeps": {
            // Defer to the real label-only dedup helper but pin it to
            // the stubbed gh — it queries the gh stub for any open
            // `idle-task` issue and so observes the issue filed during
            // the first invocation (#1984).
            findExistingFn: (opts: { repo: string }) =>
              findExistingIdleTaskIssue({
                repo: opts.repo,
                ghCommandFn: ghFn,
              }),
            ensureLabelFn: () =>
              Promise.resolve({ ok: true, value: undefined }),
            ensureMilestoneFn: () =>
              Promise.resolve({
                number: MILESTONE_NUMBER,
                title: IDLE_TASK_MILESTONE_TITLE,
              }),
            ghCommandFn: ghFn,
            log: () => {},
            nowFn: () => new Date("2026-05-15T10:00:00.000Z"),
            // Pin to security-scan so the 50/50 dispatcher (Issue #2149)
            // does not randomly pick best-practices, whose buildIssueBody
            // makes real network calls the test stub cannot satisfy.
            pickTemplateFn: (templates: IdleTaskTemplate[]) =>
              templates.find((t) => t.name === SECURITY_SCAN) ?? null,
            // Pin the cadence bias out too (Issue #4009): the stubbed gh
            // history reads as "never scanned", which legitimately makes every
            // important template overdue and would override the pinned pick.
            dueScansFn: () => Promise.resolve([]),
          },
        } as Record<string, unknown>,
        config,
      );

    // First idle iteration — files an issue.
    await runFiler();
    // Second idle iteration — the just-filed issue is now visible via
    // gh, so label-only dedup (#1984) must short-circuit the filer.
    await runFiler();

    const createCalls = calls.filter((c) => c.args.includes("create"));
    assertEquals(
      createCalls.length,
      1,
      `expected exactly one issue create call across two idle iterations; ` +
        `saw ${createCalls.length}`,
    );
    assertEquals(state.filedIssues.length, 1);
  },
);
