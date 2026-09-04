/**
 * End-to-end test for the multi-Vibe-Coder idle-task scenario (Issue #2049).
 *
 * Locks in the behaviour fixed by Issue #2048 with a regression test that
 * mirrors the operator-visible scenario from Issue #2046: one Vibe Coder
 * is busy in a "claimed" repo, another Vibe Coder finds no claimable
 * work and is expected to raise an `idle-task` issue against a different
 * monitored repo.
 *
 * Two repos are configured (`org/repo-a`, `org/repo-b`). `findNextIssue`
 * returns `null` for Worker B (Priority 2 found nothing across both
 * repos because Worker A holds the claim on `org/repo-a`). A Priority 1
 * handler returns `processed: true` so the broad `scanHadSuccess` flag
 * is `true` even though no claimable issue exists — exactly the
 * combination that suppressed the filer before the #2048 fix. The new
 * gate (`foundClaimableIssue`) keeps the filer firing.
 *
 * Iteration 1 — the filer fires and chooses `org/repo-b` because we
 * pin the shuffle order. Iteration 2 — the filed issue from iteration 1
 * is still open, so label-only dedup (#1984) skips `org/repo-b` and the
 * filer picks `org/repo-a` instead.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { maybeFileIdleTaskCommand } from "../commands/maybe_file_idle_task.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  findExistingIdleTaskIssue,
  IDLE_TASK_LABEL,
} from "../lib/idle_task_issue.ts";
import type { IdleTaskTemplate } from "../lib/idle_task_template.ts";
import type { WorkerConfig } from "../types.ts";
import { REPO_ROOT } from "./support/repo_root.ts";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const REPO_A = "org/repo-a"; // busy — Worker A holds the claim
const REPO_B = "org/repo-b"; // free
const WORKER_USER = "bot";
const SECURITY_SCAN = "security-scan";
const IDLE_TASK_MILESTONE_TITLE = `idle-task: ${SECURITY_SCAN}`;
const MILESTONE_NUMBER = 17;

interface FiledIssue {
  number: number;
  body: string;
}

interface GhState {
  /** Open idle-task issues per repo, keyed by `owner/repo`. */
  issues: Map<string, FiledIssue[]>;
  /** Monotonic issue number generator for `gh issue create`. */
  nextIssueNumber: number;
}

function makeWorkerConfig(): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    repos: [REPO_A, REPO_B],
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
    workDir: Deno.makeTempDirSync({ prefix: "idle-multi-e2e-" }),
  };
}

interface GhCall {
  args: string[];
}

/**
 * Scripted gh stub that captures every call and threads idle-task list
 * / create state through `GhState`, so a `create` in iteration 1
 * becomes visible to a `list` in iteration 2.
 */
function createGhStub(state: GhState): {
  fn: (args: string[]) => Promise<string>;
  calls: GhCall[];
} {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";

    // Match on the actual `gh issue <subcommand>` positional args rather
    // than `args.join(" ").includes(...)` — Issue #2097's v5 prompt
    // legitimately mentions `gh issue list` / `gh issue create` inside
    // the wrapper body, so a substring scan over the joined arg list
    // false-matches when the body is passed via `--body`.
    const subcommand = args[0] === "issue" ? args[1] : "";
    if (subcommand === "list" && args.includes("idle-task")) {
      const list = state.issues.get(repo) ?? [];
      return Promise.resolve(
        JSON.stringify(
          list.map((i) => ({
            number: i.number,
            url: `https://github.com/${repo}/issues/${i.number}`,
            body: i.body,
          })),
        ),
      );
    }

    if (subcommand === "create") {
      const bodyIdx = args.indexOf("--body");
      const body = bodyIdx >= 0 ? args[bodyIdx + 1] ?? "" : "";
      state.nextIssueNumber += 1;
      const number = state.nextIssueNumber;
      const existing = state.issues.get(repo) ?? [];
      existing.push({ number, body });
      state.issues.set(repo, existing);
      return Promise.resolve(
        `https://github.com/${repo}/issues/${number}`,
      );
    }

    return Promise.resolve("");
  };
  return { fn, calls };
}

/**
 * Minimal `RunCoreDeps` factory — mirrors the helper in the sibling
 * `idle_task_end_to_end_test.ts` so a refactor there cannot silently
 * weaken this test.
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

    ...overrides,
  };
}

/**
 * Build a runIdleTaskFiler hook that invokes the real
 * `maybeFileIdleTaskCommand` against the shared gh stub. The shuffle
 * order is pinned via `randomFn` so the filer's repo choice is
 * deterministic — `rand()=0` makes the 2-element Fisher-Yates pass
 * swap positions 0 and 1, producing `[REPO_B, REPO_A]` from input
 * `[REPO_A, REPO_B]`. The hook records every command outcome so the
 * test can assert which repo was filed against on each invocation.
 */
function makeFilerHook(
  _state: GhState,
  ghFn: (args: string[]) => Promise<string>,
  config: WorkerConfig,
  outcomes: Array<{ action?: string; repo?: string; reason?: string }>,
  progressLogs: string[],
): () => Promise<void> {
  return async () => {
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": [REPO_A, REPO_B].join(","),
        "github-user": WORKER_USER,
        "worker-user": WORKER_USER,
        "__testDeps": {
          // Real dedup against the shared gh state — iteration 2 sees
          // iteration 1's filed issue and skips the duplicate repo.
          findExistingFn: (opts: { repo: string }) =>
            findExistingIdleTaskIssue({
              repo: opts.repo,
              ghCommandFn: ghFn,
            }),
          ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
          ensureMilestoneFn: () =>
            Promise.resolve({
              number: MILESTONE_NUMBER,
              title: IDLE_TASK_MILESTONE_TITLE,
            }),
          ghCommandFn: ghFn,
          log: (line: string) => progressLogs.push(line),
          nowFn: () => new Date("2026-05-16T10:00:00.000Z"),
          rootDir: REPO_ROOT,
          // Pin shuffle order to [REPO_B, REPO_A].
          randomFn: () => 0,
          // Pin the template too (Issue #3938). The subject here is the repo
          // choice and the security-scan wrapper's own rules (#2055, #2067),
          // not the draw — and `randomFn: () => 0` picked security-scan only
          // because it happened to register first, which is an emergent
          // property of the module graph that any new import can flip.
          pickTemplateFn: (templates: IdleTaskTemplate[]) =>
            templates.find((t) => t.name === SECURITY_SCAN) ?? null,
          // Pin the cadence bias out too (Issue #4009): the subject here is
          // the *random* repo walk, and the stubbed gh history would read as
          // "never scanned", which legitimately makes every important
          // template overdue and overrides the pinned pick.
          dueScansFn: () => Promise.resolve([]),
        },
      } as Record<string, unknown>,
      config,
    );
    const data = result.data as
      | { action?: string; repo?: string; reason?: string }
      | undefined;
    outcomes.push({
      action: data?.action,
      repo: data?.repo,
      reason: data?.reason,
    });
  };
}

// ---------------------------------------------------------------------------
// Iteration 1 — filer fires in repo-b when repo-a is busy with Worker A
// ---------------------------------------------------------------------------

Deno.test(
  "multi-worker end-to-end - filer fires in a non-busy repo when Priority 1 worked but Priority 2 found nothing (Issue #2049)",
  async () => {
    const state: GhState = {
      issues: new Map(),
      nextIssueNumber: 900,
    };
    const { fn: ghFn, calls } = createGhStub(state);
    const config = makeWorkerConfig();
    const outcomes: Array<{ action?: string; repo?: string; reason?: string }> =
      [];
    const progressLogs: string[] = [];
    const idleHookLogs: string[] = [];

    let filerInvocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const filerHook = makeFilerHook(
      state,
      ghFn,
      config,
      outcomes,
      progressLogs,
    );

    const deps = makeMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount += 1;
        if (cycleCount >= 1) {
          // Advance past `endTime` so the loop exits after one cycle.
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      log: (m: string) => {
        if (m.includes("[idle-hooks]")) idleHookLogs.push(m);
      },
      // Priority 1 (PR feedback) "processed" something — flips
      // `scanHadSuccess` but not the new `foundClaimableIssue` gate.
      findAndProcessPrFeedback: () =>
        Promise.resolve({ ok: true, value: { processed: true } }),
      // Priority 2: Worker A holds the claim on repo-a, so the scan
      // returns null for the whole monitored-repo set.
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleTaskFiler: async () => {
        filerInvocations += 1;
        await filerHook();
      },
    });

    const runCoreCfg = createDefaultRunCoreConfig();
    runCoreCfg.runDurationSeconds = 3600;

    await runCoreLoop(runCoreCfg, deps);

    // (1) Filer was invoked exactly once during the cycle.
    assertEquals(
      filerInvocations,
      1,
      `expected the filer to be invoked once; was invoked ${filerInvocations} time(s)`,
    );

    // (2) The filed repo is REPO_B — not the busy repo REPO_A.
    assertEquals(outcomes.length, 1);
    assertEquals(outcomes[0]!.action, "filed");
    assertEquals(
      outcomes[0]!.repo,
      REPO_B,
      `expected the filer to choose ${REPO_B} (free); got ${outcomes[0]!.repo}`,
    );
    assert(
      outcomes[0]!.repo !== REPO_A,
      `expected the filed repo to differ from the busy repo ${REPO_A}`,
    );

    // (3) The `[idle-hooks]` invoking line shows the new gate fired —
    // `foundClaimableIssue=false` even though `scanHadSuccess=true`
    // (Priority 1 processed work this cycle).
    const invokingLine = idleHookLogs.find((m) =>
      m.includes("invoking=idle-task-filer") &&
      m.includes("foundClaimableIssue=false") &&
      m.includes("scanHadSuccess=true")
    );
    assert(
      invokingLine !== undefined,
      `expected an [idle-hooks] invoking line with foundClaimableIssue=false scanHadSuccess=true; got ${
        JSON.stringify(idleHookLogs)
      }`,
    );

    // Sanity: a single `gh issue create` was issued, targeting REPO_B
    // with the pending-approval idle-task label (Issue #2055 — the
    // security-scan template requires human approval). Issue #2067:
    // security-scan opts out of the per-template milestone, so the
    // `--milestone` flag must NOT be present on the create call.
    const createCalls = calls.filter((c) => c.args.includes("create"));
    assertEquals(createCalls.length, 1);
    const createArgs = createCalls[0]!.args;
    const repoArgIdx = createArgs.indexOf("--repo");
    assertEquals(createArgs[repoArgIdx + 1], REPO_B);
    const labelIdx = createArgs.indexOf("--label");
    assertEquals(createArgs[labelIdx + 1], IDLE_TASK_LABEL);
    assertEquals(
      createArgs.indexOf("--milestone"),
      -1,
      "security-scan wrapper issue must not carry a milestone (Issue #2067)",
    );

    // Sanity: a structured `[idle-task] action=filed` progress line was
    // emitted for the chosen repo.
    const filedProgress = progressLogs.find((l) =>
      l.includes(`[idle-task] template=${SECURITY_SCAN}`) &&
      l.includes(`repo=${REPO_B}`) &&
      l.includes("action=filed")
    );
    assert(
      filedProgress !== undefined,
      `expected an [idle-task] action=filed progress log for ${REPO_B}; saw ${
        JSON.stringify(progressLogs)
      }`,
    );

    // Sanity: gh state now holds exactly one open idle-task issue, in
    // REPO_B — REPO_A still has none.
    assertEquals((state.issues.get(REPO_B) ?? []).length, 1);
    assertEquals((state.issues.get(REPO_A) ?? []).length, 0);
    assert(
      !state.issues.get(REPO_B)![0]!.body.includes("<!-- idle-task:"),
      "filed wrapper body must not include the legacy idle-task marker",
    );
  },
);

// ---------------------------------------------------------------------------
// Iteration 2 — dedup skips REPO_B and the filer picks REPO_A
// ---------------------------------------------------------------------------

Deno.test(
  "multi-worker end-to-end - second cycle skips entirely when any repo already has a wrapper (Issue #2092)",
  async () => {
    // Pre-seed state with an open idle-task issue in REPO_B, mirroring
    // the post-condition of the iteration-1 test above.
    //
    // Issue #2092 behaviour change: previously this test asserted that
    // the scheduler dedup'd REPO_B and filed a fresh wrapper into REPO_A.
    // Under the new cross-repo gate, **any** open `idle-task` wrapper
    // anywhere in the monitored set blocks further filing for the entire
    // round — so the filer now skips with `reason=existing_wrapper_open`
    // and waits for the next iteration of the main loop to claim the
    // existing REPO_B wrapper through normal priority dispatch. This
    // prevents the multi-repo fan-out observed in #2089.
    const seededIssue: FiledIssue = {
      number: 901,
      body:
        `<!-- idle-task: template=${SECURITY_SCAN} repo=${REPO_B} picked-at=2026-05-16T10:00:00.000Z -->\n\nseeded`,
    };
    const state: GhState = {
      issues: new Map([[REPO_B, [seededIssue]]]),
      nextIssueNumber: 901,
    };
    const { fn: ghFn, calls } = createGhStub(state);
    const config = makeWorkerConfig();
    const outcomes: Array<{ action?: string; repo?: string; reason?: string }> =
      [];
    const progressLogs: string[] = [];

    let filerInvocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const filerHook = makeFilerHook(
      state,
      ghFn,
      config,
      outcomes,
      progressLogs,
    );

    const deps = makeMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount += 1;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleTaskFiler: async () => {
        filerInvocations += 1;
        await filerHook();
      },
    });

    const runCoreCfg = createDefaultRunCoreConfig();
    runCoreCfg.runDurationSeconds = 3600;

    await runCoreLoop(runCoreCfg, deps);

    assertEquals(filerInvocations, 1);
    assertEquals(outcomes.length, 1);

    // Issue #2092: the cross-repo gate fires and the filer skips
    // entirely, naming the repo that holds the existing wrapper.
    assertEquals(outcomes[0]!.action, "skipped");
    assertEquals(outcomes[0]!.reason, "existing_wrapper_open");
    assertEquals(outcomes[0]!.repo, REPO_B);

    // Both repos remain in the pre-filer state: REPO_B holds the seeded
    // wrapper; REPO_A has nothing.
    assertEquals((state.issues.get(REPO_B) ?? []).length, 1);
    assertEquals((state.issues.get(REPO_A) ?? []).length, 0);

    // No `gh issue create` calls — the cross-repo gate short-circuits.
    const createCalls = calls.filter((c) => c.args.includes("create"));
    assertEquals(createCalls.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Property — when every repo already holds an idle-task, the filer skips
// with reason=duplicate instead of filing
// ---------------------------------------------------------------------------

Deno.test(
  "multi-worker end-to-end - all repos already have an open idle-task → action=skipped reason=existing_wrapper_open (Issue #2049, updated for #2092)",
  async () => {
    const seed = (repo: string, n: number): FiledIssue => ({
      number: n,
      body:
        `<!-- idle-task: template=${SECURITY_SCAN} repo=${repo} picked-at=2026-05-16T10:00:00.000Z -->\n\nseeded`,
    });
    const state: GhState = {
      issues: new Map([
        [REPO_A, [seed(REPO_A, 950)]],
        [REPO_B, [seed(REPO_B, 951)]],
      ]),
      nextIssueNumber: 951,
    };
    const { fn: ghFn, calls } = createGhStub(state);
    const config = makeWorkerConfig();
    const outcomes: Array<{ action?: string; repo?: string; reason?: string }> =
      [];
    const progressLogs: string[] = [];

    let cycleCount = 0;
    let nowValue = 0;
    const filerHook = makeFilerHook(
      state,
      ghFn,
      config,
      outcomes,
      progressLogs,
    );

    const deps = makeMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount += 1;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleTaskFiler: async () => {
        await filerHook();
      },
    });

    const runCoreCfg = createDefaultRunCoreConfig();
    runCoreCfg.runDurationSeconds = 3600;

    await runCoreLoop(runCoreCfg, deps);

    assertEquals(outcomes.length, 1);
    assertEquals(outcomes[0]!.action, "skipped");
    // Issue #2092: the cross-repo gate fires first and reports
    // `existing_wrapper_open`, replacing the previous per-repo
    // `duplicate` reason that this test originally asserted.
    assertEquals(outcomes[0]!.reason, "existing_wrapper_open");

    // No new `gh issue create` calls — the cross-repo gate short-circuits.
    const createCalls = calls.filter((c) => c.args.includes("create"));
    assertEquals(createCalls.length, 0);

    // The structured progress log reflects the cross-repo skip.
    const skipped = progressLogs.find((l) =>
      l.includes("[idle-task]") &&
      l.includes("action=skipped") &&
      l.includes("reason=existing_wrapper_open")
    );
    assert(
      skipped !== undefined,
      `expected an [idle-task] action=skipped reason=existing_wrapper_open log; saw ${
        JSON.stringify(progressLogs)
      }`,
    );
  },
);
