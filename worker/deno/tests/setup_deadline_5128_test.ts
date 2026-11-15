/**
 * Tests for the setup-phase deadline (Issue #5128).
 *
 * A container on `GRQ-25` sat in setup for over two hours holding its claim
 * until the launcher's watchdog reaped it, so the run never released the
 * claim. The setup phase now runs under a deadline: a wedged step ends the run
 * with a `timeout` failure, which the run's failure path releases, but only a
 * claim the run holds, and the abandoned setup does no further work.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ownClaimCommentPresent,
  runSetupWithDeadline,
  SETUP_ABANDONED_LOG_LINE,
  SETUP_FIXED_ALLOWANCE_SECONDS,
  SETUP_MIN_DEADLINE_SECONDS,
  setupDeadlineMs,
  setupStepStartLine,
} from "../lib/setup_steps.ts";
import type { SetupStep } from "../lib/setup_steps.ts";
import { saveStreamSession } from "../lib/resume_state_store.ts";
import { resolveStreamId } from "../lib/stream_identity.ts";
import { anticipatedProviderId } from "../lib/stream_session.ts";
import { fakeClock } from "./support/fake_clock.ts";
import type { FakeClock } from "./support/fake_clock.ts";
import { workOnIssue } from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { DEFAULT_GH_CLONE_TIMEOUT } from "../lib/gh_timeout.ts";
import { isHeartbeatRunning } from "../lib/heartbeat.ts";
import type { IssueDeps, WorkerDeps } from "../lib/issue_worker_wiring.ts";

const CLAIMED = {
  ok: true as const,
  value: { claimed: true as const, winnerId: "w", competingWorkerCount: 0 },
};

/** A promise that never settles — a setup step that wedged. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** A promise settled from outside, for a step that returns late. */
function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function issueContext(
  issueNumber: number,
  overrides: Partial<IssueContext> = {},
): IssueContext {
  return {
    repo: "org/repo",
    issueNumber,
    issueTitle: "Wedged setup",
    issueBody: "A setup step never returns.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

/** The deadline the `workOnIssue` tests arm; the fake clock moves past it. */
const DEADLINE_MS = 3_600_000;

/** The test's view of one run: its fake clock, log lines and stall points. */
interface Harness {
  clock: FakeClock;
  lines: string[];
  unassigns: unknown[][];
  /** How many `gh` commands the run has issued so far. */
  ghCalls: { count: number };
  /** Resolves once the abandoned setup logs that it stopped at a boundary. */
  stopped: Promise<void>;
  /** Resolves when a stalled mock is entered; open it from inside the mock. */
  entered: { promise: Promise<void>; open: () => void };
  deps: WorkerDeps;
}

/**
 * Mock deps whose setup deadline is armed on a fake clock and whose unassigns
 * are recorded. The deadline only moves when the test advances the clock,
 * after the stalled mock has been entered.
 */
function harness(
  overrides: Parameters<typeof createMockDeps>[0] = {},
  options: { ghComments?: string; onLine?: (message: string) => void } = {},
): Harness {
  const { ghComments = "", onLine } = options;
  const clock = fakeClock();
  const lines: string[] = [];
  const unassigns: unknown[][] = [];
  const ghCalls = { count: 0 };
  const stopped = gate<void>();
  const entered = gate<void>();
  const base = createMockDeps();
  const deps = createMockDeps({
    ...overrides,
    github: {
      createClient: (logger) => ({
        ...base.github.createClient(logger),
        unassignIssue: (...args: unknown[]) => {
          unassigns.push(args);
          return Promise.resolve();
        },
      }),
      runGhCommand: () => {
        ghCalls.count++;
        return Promise.resolve(ghComments);
      },
      ...overrides.github,
    },
    infrastructure: {
      setupDeadlineMs: () => DEADLINE_MS,
      setupClock: clock,
      ...overrides.infrastructure,
    },
    logger: {
      info: (message: string) => {
        lines.push(message);
        if (message === SETUP_ABANDONED_LOG_LINE) stopped.open();
        onLine?.(message);
      },
      ...overrides.logger,
    },
  });
  return {
    clock,
    lines,
    unassigns,
    ghCalls,
    stopped: stopped.promise,
    entered: { promise: entered.promise, open: () => entered.open() },
    deps,
  };
}

/**
 * Run `workOnIssue`, advance the clock past the deadline once the stalled
 * mock has been entered, and return the run's result. The deadline therefore
 * falls in the step the test named, never an earlier one.
 */
async function runUntilAbandoned(
  h: Harness,
  issueNumber: number,
  ctxOverrides: Partial<IssueContext> = {},
) {
  const ctx = issueContext(issueNumber, ctxOverrides);
  const run = workOnIssue(ctx, h.deps);
  await h.entered.promise;
  await h.clock.advance(DEADLINE_MS);
  return await run;
}

/**
 * Wait for the abandoned setup to stop at a boundary. The wait ends on that
 * setup's own log line; the timer only fails the test if the line never comes.
 */
async function abandonedSetupStopped(h: Harness): Promise<void> {
  let failsafe: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    failsafe = setTimeout(
      () => reject(new Error("the abandoned setup never stopped")),
      30_000,
    );
  });
  try {
    await Promise.race([h.stopped, timedOut]);
  } finally {
    clearTimeout(failsafe);
  }
}

function started(h: Harness, step: SetupStep): boolean {
  return h.lines.includes(setupStepStartLine(step));
}

/** A supervisor cap published `elapsedSeconds` ago, for the cap tests. */
function cappedEnv(
  maxSeconds: number,
  elapsedSeconds: number,
  nowMs: number,
): (name: string) => string | undefined {
  const values: Record<string, string> = {
    VIBE_RUN_MAX_SECONDS: String(maxSeconds),
    VIBE_RUN_STARTED_EPOCH: String(Math.floor(nowMs / 1000) - elapsedSeconds),
  };
  return (name) => values[name];
}

const NOW_MS = 1_760_000_000_000;
const KILL_AFTER = 30;
/** The hard cap's ceiling sits this far inside the supervisor's deadline. */
const RESERVE_SECONDS = KILL_AFTER + 120;

Deno.test("setupDeadlineMs covers two agent budgets plus the clone and pre-setup bounds for a milestone when no cap is published (Issue #5128)", () => {
  const none = () => undefined;
  const hour = setupDeadlineMs(
    { claudeTimeout: 3600, claudeKillAfter: KILL_AFTER },
    { env: none, nowMs: NOW_MS, milestone: true },
  );
  // The milestone pre-sync agent runs for up to `claudeTimeout`, and a repair
  // run may follow, so one agent budget plus the clone and the 300s default
  // pre-setup command must still fit.
  assertEquals(
    hour > (3600 + DEFAULT_GH_CLONE_TIMEOUT + 300) * 1000,
    true,
  );
  // It tracks the configured agent budget: two more hours of agent time grant
  // exactly two agent budgets more.
  assertEquals(
    setupDeadlineMs(
      { claudeTimeout: 7200, claudeKillAfter: KILL_AFTER },
      { env: none, nowMs: NOW_MS, milestone: true },
    ) - hour,
    2 * 3600 * 1000,
  );
  // A supervisor cap of 0 is the documented "disabled": the budget stands.
  assertEquals(
    setupDeadlineMs(
      { claudeTimeout: 3600, claudeKillAfter: KILL_AFTER },
      { env: cappedEnv(0, 0, NOW_MS), nowMs: NOW_MS, milestone: true },
    ),
    hour,
  );
});

Deno.test("setupDeadlineMs leaves the budget alone when it fits inside the run's hard cap (Issue #5128)", () => {
  // Setup starts at launch with the default 3600s agent budget: 9000s of
  // budget against 10650s of runway.
  assertEquals(
    setupDeadlineMs(
      { claudeTimeout: 3600, claudeKillAfter: KILL_AFTER },
      { env: cappedEnv(10_800, 0, NOW_MS), nowMs: NOW_MS, milestone: true },
    ),
    9_000_000,
  );
});

Deno.test("setupDeadlineMs is capped by the runway left before the worker's own stop when setup starts late (Issue #5128)", () => {
  // Setup starts 9000s into a 10800s run, 1650s before the ceiling: the
  // 9000s budget would have fallen after the watchdog.
  assertEquals(
    setupDeadlineMs(
      { claudeTimeout: 3600, claudeKillAfter: KILL_AFTER },
      { env: cappedEnv(10_800, 9_000, NOW_MS), nowMs: NOW_MS, milestone: true },
    ),
    (10_800 - RESERVE_SECONDS - 9_000) * 1000,
  );
});

Deno.test("setupDeadlineMs is capped for a large claude_timeout, so it falls before the launcher watchdog (Issue #5128)", () => {
  const deadline = setupDeadlineMs(
    { claudeTimeout: 7200, claudeKillAfter: KILL_AFTER },
    { env: cappedEnv(10_800, 0, NOW_MS), nowMs: NOW_MS, milestone: true },
  );
  // 16200s of budget, but only 10650s to the ceiling; the launcher's watchdog
  // is 10800 + 600 = 11400s from launch.
  assertEquals(deadline, (10_800 - RESERVE_SECONDS) * 1000);
  assertEquals(deadline < (10_800 + 600) * 1000, true);
});

Deno.test("setupDeadlineMs never drops below its floor when the cap has already passed (Issue #5128)", () => {
  assertEquals(
    setupDeadlineMs(
      { claudeTimeout: 3600, claudeKillAfter: KILL_AFTER },
      {
        env: cappedEnv(10_800, 12_000, NOW_MS),
        nowMs: NOW_MS,
        milestone: true,
      },
    ),
    SETUP_MIN_DEADLINE_SECONDS * 1000,
  );
});

Deno.test("setupDeadlineMs grants a non-milestone setup the fixed allowance alone, so the GRQ-25 wedge is abandoned before its guest stopped (Issue #5128)", () => {
  const config = { claudeTimeout: 3600, claudeKillAfter: KILL_AFTER };
  const env = cappedEnv(10_800, 993, NOW_MS);
  const guestLastLogMs = 7843 * 1000;
  const plain = setupDeadlineMs(config, {
    env,
    nowMs: NOW_MS,
    milestone: false,
  });
  assertEquals(plain, 1_800_000);
  assertEquals(plain < guestLastLogMs, true);
  // The milestone budget with the same input is the one that held the claim.
  const milestone = setupDeadlineMs(config, {
    env,
    nowMs: NOW_MS,
    milestone: true,
  });
  assertEquals(milestone, 9_000_000);
  assertEquals(milestone > guestLastLogMs, true);
  // With no cap the agent budget still does not touch a non-milestone setup.
  const none = () => undefined;
  for (const claudeTimeout of [3600, 7200]) {
    assertEquals(
      setupDeadlineMs(
        { claudeTimeout, claudeKillAfter: KILL_AFTER },
        { env: none, nowMs: NOW_MS, milestone: false },
      ),
      1_800_000,
    );
  }
});

Deno.test("runSetupWithDeadline returns the setup result and never abandons when setup settles first (Issue #5128)", async () => {
  const clock = fakeClock();
  let abandoned = 0;
  const result = await runSetupWithDeadline(
    () => Promise.resolve({ status: "continue" as const }),
    { deadlineMs: 5_000, onAbandon: () => abandoned++, clock },
  );
  assertEquals(result, { status: "continue" });
  // The deadline timer was disarmed: advancing past it abandons nothing.
  assertEquals(clock.armed, 0);
  await clock.advance(10_000);
  assertEquals(abandoned, 0);
});

Deno.test("runSetupWithDeadline abandons a wedged setup once and returns a timeout failure (Issue #5128)", async () => {
  const clock = fakeClock();
  let abandoned = 0;
  const run = runSetupWithDeadline(
    () => never<{ status: "continue" }>(),
    { deadlineMs: 20, onAbandon: () => abandoned++, clock },
  );
  await clock.advance(19);
  assertEquals(abandoned, 0);
  await clock.advance(1);
  const result = await run;
  assertEquals(result.status, "failure");
  if (result.status !== "failure") return;
  assertEquals(result.category, "timeout");
  assertStringIncludes(result.reason, "abandoned it");
  assertEquals(abandoned, 1);
});

/** The pages returned by `gh api --paginate --slurp`. */
function claimComments(workerId: string, author = "testbot"): string {
  return JSON.stringify([[{
    body: `<!-- CLAIM_LOCK:${workerId} -->\nClaimed`,
    user: { login: author },
  }]]);
}

Deno.test("ownClaimCommentPresent requires this run's marker and authenticated author (PR #5130 review)", async () => {
  const marker = "<!-- CLAIM_LOCK:testbot-123 -->";
  for (
    const [response, expected] of [
      [claimComments("testbot-123"), true],
      [claimComments("testbot-123", "TestBot"), true],
      [claimComments("testbot-123", "outsider"), false],
      [claimComments("testbot-other"), false],
      [JSON.stringify([[{ body: marker }]]), false],
      [
        JSON.stringify([[{
          body: `Quoted: ${marker}`,
          user: { login: "testbot" },
        }]]),
        false,
      ],
      [
        JSON.stringify([[{
          body: `${marker}-extra`,
          user: { login: "testbot" },
        }]]),
        false,
      ],
      ["[]", false],
      [JSON.stringify([[], JSON.parse(claimComments("testbot-123"))[0]]), true],
      [
        JSON.stringify([{}, JSON.parse(claimComments("testbot-123"))[0]]),
        false,
      ],
      ["null", false],
      ["not JSON", false],
    ] as const
  ) {
    assertEquals(
      await ownClaimCommentPresent(
        () => Promise.resolve(response),
        "org/repo",
        5,
        "testbot-123",
        "testbot",
      ),
      expected,
      response,
    );
  }
  assertEquals(
    await ownClaimCommentPresent(
      () => Promise.reject(new Error("rate limited")),
      "org/repo",
      5,
      "testbot-123",
      "testbot",
    ),
    false,
  );
  assertEquals(
    await ownClaimCommentPresent(
      () => Promise.resolve(claimComments('x") | .id #')),
      "org/repo",
      5,
      'x") | .id #',
      "testbot",
    ),
    false,
  );
});

Deno.test("workOnIssue: a wedge inside claimIssue with no claim of its own does not unassign (Issue #5128)", async () => {
  const late = gate<Awaited<ReturnType<IssueDeps["claimIssue"]>>>();
  let churnChecks = 0;
  const h = harness({
    issues: {
      claimIssue: () => {
        h.entered.open();
        return late.promise;
      },
      checkClaimChurn: () => {
        churnChecks++;
        return Promise.resolve({
          ok: true,
          value: { escalated: false },
        } as Awaited<ReturnType<IssueDeps["checkClaimChurn"]>>);
      },
    },
  });
  const result = await runUntilAbandoned(h, 5601);

  assertEquals(result.phase, "setup");
  assertEquals(result.category, "timeout");
  assertEquals(started(h, "issue claim"), true);
  // A claim never taken is not released: the shared login may now be another
  // host's live claim.
  assertEquals(result.claimNotHeld, true);

  // The claim comes back after the run ended: it is released, once, and the
  // abandoned setup goes no further.
  late.open(CLAIMED);
  await abandonedSetupStopped(h);
  assertEquals(h.unassigns.length, 1);
  assertEquals(churnChecks, 0);
  assertEquals(started(h, "claim churn check"), false);
});

Deno.test("workOnIssue: a non-milestone setup is abandoned at the fixed allowance, a milestone setup keeps its agent budgets (Issue #5128)", async () => {
  const fixedMs = SETUP_FIXED_ALLOWANCE_SECONDS * 1000;
  const agentMs = 2 * buildDefaultWorkerConfig().claudeTimeout * 1000;
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const start = (issueNumber: number, ctxOverrides: Partial<IssueContext>) => {
    const late = gate<Awaited<ReturnType<IssueDeps["claimIssue"]>>>();
    const h = harness({
      issues: {
        claimIssue: () => {
          h.entered.open();
          return late.promise;
        },
      },
      infrastructure: {
        setupDeadlineMs: (config, input) =>
          setupDeadlineMs(config, {
            ...input,
            env: () => undefined,
            nowMs: NOW_MS,
          }),
      },
    });
    const run = workOnIssue(issueContext(issueNumber, ctxOverrides), h.deps);
    const state = { settled: false };
    run.then(() => {
      state.settled = true;
    });
    return { h, late, run, state };
  };

  // Positive control: no milestone, abandoned at the fixed allowance.
  const plain = start(5701, {});
  await plain.h.entered.promise;
  await plain.h.clock.advance(fixedMs);
  await flush();
  assertEquals(plain.state.settled, true);
  const plainResult = await plain.run;
  assertEquals(plainResult.phase, "setup");
  assertEquals(plainResult.category, "timeout");
  plain.late.open(CLAIMED);
  await abandonedSetupStopped(plain.h);

  // A milestone setup is still running after the same advance and flush.
  const milestone = start(5702, { milestoneTitle: "M1" });
  await milestone.h.entered.promise;
  await milestone.h.clock.advance(fixedMs);
  await flush();
  assertEquals(milestone.state.settled, false);
  await milestone.h.clock.advance(agentMs);
  await flush();
  assertEquals(milestone.state.settled, true);
  const milestoneResult = await milestone.run;
  assertEquals(milestoneResult.phase, "setup");
  assertEquals(milestoneResult.category, "timeout");
  milestone.late.open(CLAIMED);
  await abandonedSetupStopped(milestone.h);
});

for (const author of ["testbot", "outsider"]) {
  Deno.test(`workOnIssue: a wedged claim reads a marker from ${author} and releases only its own (PR #5130 review)`, async () => {
    const late = gate<Awaited<ReturnType<IssueDeps["claimIssue"]>>>();
    let workerId = "";
    const h = harness({
      issues: {
        claimIssue: (options) => {
          workerId = options.workerId;
          h.entered.open();
          return late.promise;
        },
      },
      github: {
        runGhCommand: () => Promise.resolve(claimComments(workerId, author)),
      },
    });

    const result = await runUntilAbandoned(h, 5602);

    assertEquals(result.category, "timeout");
    assertEquals(started(h, "issue claim"), true);
    // Only the authenticated own comment lets run_core release now.
    assertEquals(result.claimNotHeld, author === "testbot" ? undefined : true);
    // Otherwise release only after claimIssue confirms a win; never twice.
    late.open(CLAIMED);
    await abandonedSetupStopped(h);
    assertEquals(h.unassigns.length, author === "testbot" ? 0 : 1);
  });
}

for (const ownCommentPresent of [true, false]) {
  Deno.test(
    `workOnIssue: a wedge after a won claim whose own comment is ${
      ownCommentPresent ? "present" : "gone"
    } ${
      ownCommentPresent ? "releases it once" : "releases nothing"
    } and does no later setup work (Issue #5128, PR #5130 review)`,
    async () => {
      const repoSetup = gate<
        Awaited<ReturnType<WorkerDeps["git"]["setupRepo"]>>
      >();
      let heartbeats = 0;
      let workerId = "";
      const base = createMockDeps();
      const h = harness({
        issues: {
          claimIssue: (options) => {
            workerId = options.workerId;
            return Promise.resolve(CLAIMED);
          },
        },
        git: {
          setupRepo: () => {
            h.entered.open();
            return repoSetup.promise;
          },
        },
        crashHandling: {
          recordHeartbeat: (...args) => {
            heartbeats++;
            return base.crashHandling.recordHeartbeat(...args);
          },
        },
        // The comments the run reads at the deadline. After the fleet's recovery
        // freed the issue, a host that re-claims deletes this run's comment.
        github: {
          runGhCommand: () =>
            Promise.resolve(
              ownCommentPresent
                ? claimComments(workerId)
                : JSON.stringify([[]]),
            ),
        },
      });

      const result = await runUntilAbandoned(h, 5603);

      assertEquals(result.phase, "setup");
      assertEquals(result.category, "timeout");
      assertEquals(started(h, "repository setup"), true);
      // The claim was won before the wedge. The run releases it only while its
      // own comment is still on the issue; otherwise the assignment is another
      // host's and run_core leaves it alone.
      assertEquals(result.claimNotHeld, ownCommentPresent ? undefined : true);

      // The clone returns after the run ended: no heartbeat starts and nothing
      // releases the claim a second time.
      repoSetup.open({ ok: true, value: "/tmp/repo" });
      await abandonedSetupStopped(h);
      assertEquals(started(h, "heartbeat start"), false);
      assertEquals(heartbeats, 0);
      assertEquals(h.unassigns.length, 0);
    },
  );
}

Deno.test("workOnIssue: a heartbeat that starts after the deadline is stopped (Issue #5128)", async () => {
  const recorded = gate<{ ok: true; value: undefined }>();
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    crashHandling: {
      recordHeartbeat: () => {
        h.entered.open();
        return recorded.promise;
      },
    },
  });

  const result = await runUntilAbandoned(h, 5604);
  assertEquals(result.category, "timeout");
  assertEquals(started(h, "heartbeat start"), true);

  recorded.open({ ok: true, value: undefined });
  await abandonedSetupStopped(h);
  assertEquals(isHeartbeatRunning("org/repo", 5604), false);
  assertEquals(h.unassigns.length, 0);
  assertEquals(started(h, "default branch sync"), false);
});

for (
  const wedge of [
    { step: "checkClaimChurn", at: "claim churn check", issue: 5605 },
    {
      step: "createFeatureBranchFromBase",
      at: "feature branch",
      issue: 5607,
    },
  ] as const
) {
  const next = wedge.step === "checkClaimChurn"
    ? "repository setup"
    : "pre-setup command";
  Deno.test(`workOnIssue: setup abandoned during ${wedge.step} never starts the ${next} step (Issue #5128)`, async () => {
    const late = gate<unknown>();
    const stall = (): never =>
      (() => {
        h.entered.open();
        return late.promise;
      }) as never;
    const h = harness({
      issues: {
        claimIssue: () => Promise.resolve(CLAIMED),
        ...(wedge.step === "checkClaimChurn"
          ? { checkClaimChurn: stall() }
          : {}),
      },
      git: wedge.step === "checkClaimChurn" ? {} : { [wedge.step]: stall() },
    });

    const result = await runUntilAbandoned(h, wedge.issue);
    assertEquals(result.category, "timeout");
    // Positive control: the step holding the wedge is the one that started.
    assertEquals(started(h, wedge.at), true);
    assertEquals(started(h, next), false);
    const ghAtDeadline = h.ghCalls.count;

    late.open(
      wedge.step === "checkClaimChurn"
        ? { ok: true, value: { escalated: false } }
        : { ok: true, value: undefined },
    );
    await abandonedSetupStopped(h);
    assertEquals(started(h, next), false);
    // No GitHub traffic from the abandoned setup either: the host-fault label
    // sweep after the feature branch reads and writes labels through `gh`.
    assertEquals(h.ghCalls.count, ghAtDeadline);
  });
}

Deno.test("workOnIssue: setup abandoned during getRepoDefaultBranch does no default-branch sync, resume checkout or feature branch (Issue #5128)", async () => {
  const late = gate<{ ok: true; value: string }>();
  const calls = {
    sync: 0,
    list: 0,
    resume: 0,
    feature: 0,
    milestone: 0,
  };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      getRepoDefaultBranch: () => {
        h.entered.open();
        return late.promise;
      },
      ensureDefaultBranchCurrent: () => {
        calls.sync++;
        return Promise.resolve({ ok: true, value: "main" });
      },
      ensureMilestoneBranchExists: () => {
        calls.milestone++;
        return Promise.resolve({ ok: true, value: "ensured" });
      },
      listRemoteIssueBranches: () => {
        calls.list++;
        return Promise.resolve({ ok: true, value: [] });
      },
      resumeFeatureBranchFromRemote: () => {
        calls.resume++;
        return Promise.resolve({ ok: true, value: true });
      },
      createFeatureBranchFromBase: () => {
        calls.feature++;
        return Promise.resolve({ ok: true, value: "b" });
      },
    },
  });

  const result = await runUntilAbandoned(h, 5606, { milestoneTitle: "M1" });
  assertEquals(result.category, "timeout");
  assertEquals(started(h, "default branch sync"), true);

  late.open({ ok: true, value: "main" });
  await abandonedSetupStopped(h);
  assertEquals(calls, {
    sync: 0,
    list: 0,
    resume: 0,
    feature: 0,
    milestone: 0,
  });
  assertEquals(started(h, "feature branch"), false);
});

Deno.test("workOnIssue: setup abandoned during the default-branch sync does no milestone branch push or pre-sync (Issue #5128)", async () => {
  const late = gate<{ ok: true; value: string }>();
  const calls = { milestone: 0, presync: 0, list: 0 };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      ensureDefaultBranchCurrent: () => {
        h.entered.open();
        return late.promise;
      },
      ensureMilestoneBranchExists: () => {
        calls.milestone++;
        return Promise.resolve({ ok: true, value: "ensured" });
      },
      syncMilestoneBranchWithDefault: () => {
        calls.presync++;
        return Promise.resolve({ ok: true, value: { message: "synced" } });
      },
      listRemoteIssueBranches: () => {
        calls.list++;
        return Promise.resolve({ ok: true, value: [] });
      },
    },
  });

  const result = await runUntilAbandoned(h, 5608, { milestoneTitle: "M1" });
  assertEquals(result.category, "timeout");

  late.open({ ok: true, value: "main" });
  await abandonedSetupStopped(h);
  assertEquals(calls, { milestone: 0, presync: 0, list: 0 });
});

Deno.test("workOnIssue: setup abandoned during the milestone branch push does no pre-sync or resume lookup (Issue #5128)", async () => {
  const late = gate<{ ok: true; value: string }>();
  const calls = { presync: 0, list: 0 };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      ensureMilestoneBranchExists: () => {
        h.entered.open();
        return late.promise;
      },
      syncMilestoneBranchWithDefault: () => {
        calls.presync++;
        return Promise.resolve({ ok: true, value: { message: "synced" } });
      },
      listRemoteIssueBranches: () => {
        calls.list++;
        return Promise.resolve({ ok: true, value: [] });
      },
    },
  });

  const result = await runUntilAbandoned(h, 5609, { milestoneTitle: "M1" });
  assertEquals(result.category, "timeout");

  late.open({ ok: true, value: "ensured" });
  await abandonedSetupStopped(h);
  assertEquals(calls, { presync: 0, list: 0 });
});

Deno.test("workOnIssue: a resume lookup that returns after the deadline checks out nothing (Issue #5128)", async () => {
  const late = gate<{ ok: true; value: { branch: string; sha: string }[] }>();
  const calls = { resume: 0, feature: 0 };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      listRemoteIssueBranches: () => {
        h.entered.open();
        return late.promise;
      },
      resumeFeatureBranchFromRemote: () => {
        calls.resume++;
        return Promise.resolve({ ok: true, value: true });
      },
      createFeatureBranchFromBase: () => {
        calls.feature++;
        return Promise.resolve({ ok: true, value: "b" });
      },
    },
  });

  const result = await runUntilAbandoned(h, 5610);
  assertEquals(result.category, "timeout");

  // A checkpoint branch comes back after the run ended. Checking it out would
  // move HEAD in the lane worktree the slot's next run may be using.
  late.open({ ok: true, value: [{ branch: "issue-5610-wip", sha: "abc" }] });
  await abandonedSetupStopped(h);
  assertEquals(calls, { resume: 0, feature: 0 });
  assertEquals(started(h, "pre-setup command"), false);
});

Deno.test("workOnIssue: a resume lookup with two candidates that returns late fetches and checks out nothing (Issue #5128, PR #5130 review)", async () => {
  const late = gate<{ ok: true; value: { branch: string; sha: string }[] }>();
  const calls = { order: 0, resume: 0, feature: 0 };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      listRemoteIssueBranches: () => {
        h.entered.open();
        return late.promise;
      },
      orderBranchesByRecency: (branches) => {
        calls.order++;
        return Promise.resolve([...branches]);
      },
      resumeFeatureBranchFromRemote: () => {
        calls.resume++;
        return Promise.resolve({ ok: true, value: true });
      },
      createFeatureBranchFromBase: () => {
        calls.feature++;
        return Promise.resolve({ ok: true, value: "b" });
      },
    },
  });

  const result = await runUntilAbandoned(h, 5617);
  assertEquals(result.category, "timeout");

  // Ordering two candidates runs `git fetch origin <branch>` in the lane
  // worktree, which writes its FETCH_HEAD and objects to the shared store.
  late.open({
    ok: true,
    value: [
      { branch: "issue-5617-a", sha: "abc" },
      { branch: "issue-5617-b", sha: "def" },
    ],
  });
  await abandonedSetupStopped(h);
  assertEquals(calls, { order: 0, resume: 0, feature: 0 });
});

Deno.test("workOnIssue: a stored stream session is not adopted by a setup abandoned after the resume lookup (Issue #5128, PR #5130 review)", async () => {
  const { workDir } = await streamWorkDir();
  try {
    let compactions = 0;
    let fire: () => void = () => {};
    const h = harness({
      issues: { claimIssue: () => Promise.resolve(CLAIMED) },
      git: {
        listRemoteIssueBranches: () =>
          Promise.resolve({
            ok: true,
            value: [{ branch: "issue-5618-wip", sha: "abc" }],
          }),
        resumeFeatureBranchFromRemote: () =>
          Promise.resolve({ ok: true, value: true }),
      },
      claude: {
        primeStreamCompaction: () => {
          compactions++;
          return Promise.resolve(false);
        },
      },
    }, {
      // The resume lookup is done and the checkpoint branch is in use; the
      // deadline falls while setup reads its handover file.
      onLine: (message) => {
        if (message.startsWith("Resuming prior progress from")) fire();
      },
    });
    fire = () => void h.clock.advance(DEADLINE_MS);
    const config = {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume: true,
    };

    const result = await workOnIssue(issueContext(5618, { config }), h.deps);
    assertEquals(result.category, "timeout");
    await abandonedSetupStopped(h);
    // `primeStreamSession` logs the stream it adopts, and may delete a stored
    // session; neither happens once setup is abandoned.
    assertEquals(
      h.lines.some((l) => l.startsWith("stream ") && l.includes(" session ")),
      false,
    );
    assertEquals(compactions, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("workOnIssue: a branch repair is not started once setup is abandoned (Issue #5128)", async () => {
  const late = gate<{ ok: false; error: Error }>();
  const calls = { repair: 0, sweep: 0 };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      createFeatureBranchFromBase: () => {
        h.entered.open();
        return late.promise;
      },
      repairObjectStore: () => {
        calls.repair++;
        return Promise.resolve({
          ok: true,
          value: { removed: [], fsck: "ok" },
        } as never);
      },
      sweepBrokenRefs: () => {
        calls.sweep++;
        return Promise.resolve({ ok: true, value: { removed: [] } } as never);
      },
    },
  });

  const result = await runUntilAbandoned(h, 5611);
  assertEquals(result.category, "timeout");

  // The branch creation fails late with object-store corruption: the repair
  // ladder would re-clone the store every lane of the repository shares.
  late.open({
    ok: false,
    error: new Error("error: inflate: data stream error (incorrect header)"),
  });
  await abandonedSetupStopped(h);
  assertEquals(calls, { repair: 0, sweep: 0 });
});

/** A git failure naming a ruleset refusal, which the in-run repair answers. */
const RULESET_REFUSAL =
  "remote: error: GH013: Repository rule violations found";

Deno.test("workOnIssue: a milestone ruleset repair that returns late is not retried (Issue #5128)", async () => {
  const late = gate<
    Awaited<ReturnType<WorkerDeps["github"]["repairMilestoneCreateBlock"]>>
  >();
  const calls = { ensure: 0, presync: 0, list: 0 };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      ensureMilestoneBranchExists: () => {
        calls.ensure++;
        return Promise.resolve({
          ok: false,
          error: new Error(RULESET_REFUSAL),
        });
      },
      syncMilestoneBranchWithDefault: () => {
        calls.presync++;
        return Promise.resolve({ ok: true, value: { message: "synced" } });
      },
      listRemoteIssueBranches: () => {
        calls.list++;
        return Promise.resolve({ ok: true, value: [] });
      },
    },
    github: {
      repairMilestoneCreateBlock: () => {
        h.entered.open();
        return late.promise;
      },
    },
  });

  const result = await runUntilAbandoned(h, 5612, { milestoneTitle: "M1" });
  assertEquals(result.category, "timeout");
  assertEquals(calls.ensure, 1);

  // The ruleset is exempted late. Retrying the push now would create the
  // milestone branch on behalf of a run that no longer exists.
  late.open({ ok: true, repaired: true, ruleset: "milestone-rules" });
  await abandonedSetupStopped(h);
  assertEquals(calls, { ensure: 1, presync: 0, list: 0 });
});

Deno.test("workOnIssue: a milestone refusal-label sweep that returns late is followed by no pre-sync (Issue #5128)", async () => {
  const late = gate<string>();
  const calls = { presync: 0, list: 0 };
  let ensured = false;
  let swept = false;
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      ensureMilestoneBranchExists: () => {
        ensured = true;
        return Promise.resolve({ ok: true, value: "ensured" });
      },
      syncMilestoneBranchWithDefault: () => {
        calls.presync++;
        return Promise.resolve({ ok: true, value: { message: "synced" } });
      },
      listRemoteIssueBranches: () => {
        calls.list++;
        return Promise.resolve({ ok: true, value: [] });
      },
    },
    github: {
      // The first `gh` command after the milestone branch exists is the label
      // sweep, a GitHub read-then-write the abandoned setup must not follow.
      runGhCommand: () => {
        if (!ensured || swept) return Promise.resolve("");
        swept = true;
        h.entered.open();
        return late.promise;
      },
    },
  });

  const result = await runUntilAbandoned(h, 5613, { milestoneTitle: "M1" });
  assertEquals(result.category, "timeout");
  assertEquals(swept, true);

  late.open("");
  await abandonedSetupStopped(h);
  assertEquals(calls, { presync: 0, list: 0 });
});

Deno.test("workOnIssue: a milestone pre-sync that returns late is followed by no session restore or resume lookup (Issue #5128)", async () => {
  const late = gate<{ ok: true; value: { message: string } }>();
  let list = 0;
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      syncMilestoneBranchWithDefault: () => {
        h.entered.open();
        return late.promise;
      },
      listRemoteIssueBranches: () => {
        list++;
        return Promise.resolve({ ok: true, value: [] });
      },
    },
  });

  const result = await runUntilAbandoned(h, 5614, { milestoneTitle: "M2" });
  assertEquals(result.category, "timeout");

  late.open({ ok: true, value: { message: "synced" } });
  await abandonedSetupStopped(h);
  assertEquals(list, 0);
});

/** A temporary work dir holding the stream record a sibling issue left. */
async function streamWorkDir(): Promise<{ workDir: string; repo: string }> {
  const workDir = await Deno.makeTempDir({ prefix: "issue5128-stream-" });
  const repo = "org/repo";
  const saved = await saveStreamSession(
    workDir,
    resolveStreamId(repo, undefined),
    {
      providerId: anticipatedProviderId(),
      sessionId: "0199fd1e-2a4b-4c3d-8e5f-000000005128",
      holderHost: "test-host",
    },
  );
  assertEquals(saved, true);
  return { workDir, repo };
}

Deno.test("workOnIssue: a stream compaction is not started once setup is abandoned (Issue #5128)", async () => {
  const { workDir } = await streamWorkDir();
  try {
    let compactions = 0;
    let feature = 0;
    let fire: () => void = () => {};
    const h = harness({
      issues: { claimIssue: () => Promise.resolve(CLAIMED) },
      git: {
        createFeatureBranchFromBase: () => {
          feature++;
          return Promise.resolve({ ok: true, value: "b" });
        },
      },
      claude: {
        primeStreamCompaction: () => {
          compactions++;
          return Promise.resolve(false);
        },
      },
    }, {
      // `primeStreamSession` logs the adopted stream just before it returns,
      // so the deadline falls between joining the stream and compacting it.
      onLine: (message) => {
        if (message.startsWith("stream ") && message.includes(" session ")) {
          fire();
        }
      },
    });
    fire = () => void h.clock.advance(DEADLINE_MS);
    const config = {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume: true,
    };

    const result = await workOnIssue(issueContext(5615, { config }), h.deps);
    assertEquals(result.category, "timeout");
    await abandonedSetupStopped(h);
    assertEquals(compactions, 0);
    assertEquals(feature, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("workOnIssue: a resumed setup whose stream compaction returns late runs no label sweep or pre-setup command (Issue #5128)", async () => {
  const { workDir } = await streamWorkDir();
  try {
    const late = gate<boolean>();
    let feature = 0;
    const h = harness({
      issues: { claimIssue: () => Promise.resolve(CLAIMED) },
      git: {
        listRemoteIssueBranches: () =>
          Promise.resolve({
            ok: true,
            value: [{ branch: "issue-5616-wip", sha: "abc" }],
          }),
        resumeFeatureBranchFromRemote: () =>
          Promise.resolve({ ok: true, value: true }),
        createFeatureBranchFromBase: () => {
          feature++;
          return Promise.resolve({ ok: true, value: "b" });
        },
      },
      claude: {
        primeStreamCompaction: () => {
          h.entered.open();
          return late.promise;
        },
      },
    });
    const config = {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume: true,
    };

    const result = await runUntilAbandoned(h, 5616, { config });
    assertEquals(result.category, "timeout");
    // Positive control: the checkpoint was resumed, so the feature branch step
    // is skipped and only the check outside that condition can stop setup.
    assertEquals(
      h.lines.some((l) => l.startsWith("Resuming prior progress from")),
      true,
    );
    const ghAtDeadline = h.ghCalls.count;

    late.open(false);
    await abandonedSetupStopped(h);
    assertEquals(feature, 0);
    assertEquals(started(h, "pre-setup command"), false);
    assertEquals(h.ghCalls.count, ghAtDeadline);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

const REPAIRED = {
  ok: true,
  value: { removed: [], fsck: "ok" },
} as never;

Deno.test("workOnIssue: an object-store repair that returns late is not followed by a re-clone (Issue #5128)", async () => {
  const late = gate<unknown>();
  const calls = { setupRepo: 0, feature: 0 };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      setupRepo: () => {
        calls.setupRepo++;
        return Promise.resolve({ ok: true, value: "/tmp/repo" });
      },
      createFeatureBranchFromBase: () => {
        calls.feature++;
        return Promise.resolve({
          ok: false,
          error: new Error("error: inflate: data stream error"),
        });
      },
      repairObjectStore: () => {
        h.entered.open();
        return late.promise as never;
      },
    },
  });

  const result = await runUntilAbandoned(h, 5617, { repo: "org/store-repair" });
  assertEquals(result.category, "timeout");
  // Positive control: the ladder was entered (the repair is the stalled call).
  assertEquals(calls, { setupRepo: 1, feature: 1 });

  late.open(REPAIRED);
  await abandonedSetupStopped(h);
  assertEquals(calls, { setupRepo: 1, feature: 1 });
});

Deno.test("workOnIssue: a re-clone that returns late is not followed by a branch retry (Issue #5128)", async () => {
  const late = gate<unknown>();
  const calls = { setupRepo: 0, feature: 0 };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      setupRepo: () => {
        calls.setupRepo++;
        if (calls.setupRepo === 1) {
          return Promise.resolve({ ok: true, value: "/tmp/repo" });
        }
        h.entered.open();
        return late.promise as never;
      },
      createFeatureBranchFromBase: () => {
        calls.feature++;
        return Promise.resolve({
          ok: false,
          error: new Error("error: inflate: data stream error"),
        });
      },
      repairObjectStore: () => Promise.resolve(REPAIRED),
    },
  });

  const result = await runUntilAbandoned(h, 5618, { repo: "org/reclone" });
  assertEquals(result.category, "timeout");
  assertEquals(calls, { setupRepo: 2, feature: 1 });

  late.open({ ok: true, value: "/tmp/repo" });
  await abandonedSetupStopped(h);
  assertEquals(calls, { setupRepo: 2, feature: 1 });
});

Deno.test("workOnIssue: a broken-ref sweep that returns late is not followed by a branch retry or re-clone (Issue #5128)", async () => {
  const late = gate<unknown>();
  const calls = { feature: 0, repair: 0 };
  const h = harness({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    git: {
      createFeatureBranchFromBase: () => {
        calls.feature++;
        return Promise.resolve({
          ok: false,
          error: new Error("bad object refs/heads/issue-5619-old"),
        });
      },
      sweepBrokenRefs: () => {
        h.entered.open();
        return late.promise as never;
      },
      repairObjectStore: () => {
        calls.repair++;
        return Promise.resolve(REPAIRED);
      },
    },
  });

  const result = await runUntilAbandoned(h, 5619, { repo: "org/sweep" });
  assertEquals(result.category, "timeout");
  assertEquals(calls, { feature: 1, repair: 0 });

  late.open({ ok: true, value: { removed: ["refs/heads/issue-5619-old"] } });
  await abandonedSetupStopped(h);
  assertEquals(calls, { feature: 1, repair: 0 });
});

for (const posted of [true, false]) {
  Deno.test(
    `workOnIssue: a claim won while the run reads its claim comment (${
      posted ? "posted" : "not yet posted"
    }) is released once (Issue #5128)`,
    async () => {
      const late = gate<Awaited<ReturnType<IssueDeps["claimIssue"]>>>();
      const read = gate<string>();
      const reading = gate<void>();
      let workerId = "";
      const h = harness({
        issues: {
          claimIssue: (options) => {
            workerId = options.workerId;
            h.entered.open();
            return late.promise;
          },
        },
        github: {
          runGhCommand: () => {
            reading.open();
            return read.promise;
          },
        },
      });

      const ctx = issueContext(5620);
      const run = workOnIssue(ctx, h.deps);
      await h.entered.promise;
      await h.clock.advance(DEADLINE_MS);
      // The run is reading the issue's comments to decide whether it holds the
      // claim; the claim comes back before that read does.
      await reading.promise;
      late.open(CLAIMED);
      await abandonedSetupStopped(h);
      read.open(posted ? claimComments(workerId) : "[]");
      const result = await run;

      assertEquals(result.category, "timeout");
      // One release in all: the abandoned setup's unassign, or run_core's
      // failure path when the result does not carry `claimNotHeld`.
      const runReleases = result.claimNotHeld ? 0 : 1;
      assertEquals(h.unassigns.length + runReleases, 1);
    },
  );
}
