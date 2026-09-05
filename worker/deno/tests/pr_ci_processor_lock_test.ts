/**
 * Tests for the cross-host PR lock on the CI-fix path (Issue #3754).
 *
 * Two hosts fixed PR #3644's CI failure at the same time because the CI-fix
 * path took no lock. These tests drive the real `pr_branch_lock` protocol
 * through `processCiFailure` against a shared in-memory comment store, so a
 * regression — a dropped acquire, a heartbeating loser, a missing release —
 * fails the repo's `deno test` gate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import {
  acquireBranchUpdateLock,
  BRANCH_UPDATE_LOCK_PREFIX,
  cleanStaleBranchUpdateLocks,
  parseLockComment,
  renewBranchUpdateLock,
} from "../lib/pr_branch_lock.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
  PrDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger, Result } from "../types.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A logger that records every message so lock outcomes can be asserted. */
function makeRecordingLogger(lines: string[]): Logger {
  const record = (message: string) => {
    lines.push(message);
  };
  const noop = () => {};
  return {
    info: record,
    warn: record,
    error: record,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

function makeInput(): CiFixInput {
  const annotations: CheckAnnotation[] = [
    { path: "tests/main_test.ts", start_line: 42, message: "Assertion failed" },
  ];
  return {
    repo: "org/repo",
    prNumber: 3644,
    branchName: "issue-42-fix-bug",
    checkRunId: "67890",
    checkName: "CI / test",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  };
}

/** One comment in the fake PR timeline. */
interface FakeComment {
  id: number;
  body: string;
  created_at: string;
  /**
   * The login GitHub reports for the comment (Issue #1124). Both hosts in
   * this race run as the same fleet service account and are told apart by
   * the worker-id inside the marker, which is how the fleet actually
   * authenticates; a lock from outside the set is not a lock at all.
   */
  author: string;
}

/** The fleet service account both racing hosts post as. */
const FLEET_AUTHOR = "vibe-coder-bot";

/** Author-verification inputs the fixtures pass instead of a config file. */
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] } as const;

/**
 * A shared, in-memory stand-in for one PR's comment timeline.
 *
 * Post/read/patch/delete are enough to exercise the whole lock protocol.
 */
class FakePrComments {
  readonly comments: FakeComment[] = [];
  private nextId = 100;
  /** Monotonic clock (seconds) shared with the lock's `nowFn`. */
  now = 1_700_000_000;

  /** Build a `ghCommandFn` that reads and writes this timeline. */
  gh(): (args: string[]) => Promise<string> {
    return (args: string[]): Promise<string> => {
      const joined = args.join(" ");

      if (args[0] === "issue" && args[1] === "comment") {
        const bodyIndex = args.indexOf("--body");
        const body = bodyIndex >= 0 ? args[bodyIndex + 1] ?? "" : "";
        this.comments.push({
          id: this.nextId++,
          body,
          created_at: new Date(this.now * 1000).toISOString(),
          author: FLEET_AUTHOR,
        });
        // Each post advances the clock so `created_at` ordering is stable.
        this.now += 1;
        return Promise.resolve("");
      }

      if (args.includes("DELETE")) {
        const id = Number(joined.match(/comments\/(\d+)/)?.[1] ?? 0);
        const index = this.comments.findIndex((c) => c.id === id);
        if (index >= 0) this.comments.splice(index, 1);
        return Promise.resolve("");
      }

      if (args.includes("PATCH")) {
        const id = Number(joined.match(/comments\/(\d+)/)?.[1] ?? 0);
        const target = this.comments.find((c) => c.id === id);
        const bodyArg = args.find((a) => a.startsWith("body="));
        if (target && bodyArg) target.body = bodyArg.slice("body=".length);
        return Promise.resolve("");
      }

      if (args[0] === "api" && joined.includes("/comments")) {
        return Promise.resolve(
          JSON.stringify(
            this.comments.filter((c) =>
              c.body.includes(BRANCH_UPDATE_LOCK_PREFIX)
            ),
          ),
        );
      }

      return Promise.resolve("");
    };
  }

  /** All lock comments currently on the timeline. */
  locks(): FakeComment[] {
    return this.comments.filter((c) =>
      c.body.includes(BRANCH_UPDATE_LOCK_PREFIX)
    );
  }
}

/** Side effects a losing worker must never produce. */
interface Effects {
  heartbeats: number;
  claudeRuns: number;
  pushes: number;
}

/** Build worker deps that record heartbeats, Claude runs and pushes. */
function makeDeps(effects: Effects, options: { claudeThrows?: boolean } = {}) {
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() => {
      effects.claudeRuns++;
      if (options.claudeThrows) {
        return Promise.reject(new Error("claude exploded"));
      }
      return Promise.resolve({
        ok: true,
        value: { output: "Fixed CI", exitCode: 0, timedOut: false },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: () => Promise.resolve(""),
  };
  return createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      commitAndPushPending: (() => {
        effects.pushes++;
        return Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: true,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        });
      }) as unknown as GitDeps["commitAndPushPending"],
      captureBranchHead: (() =>
        Promise.resolve({
          ok: true,
          value: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        })) as unknown as GitDeps["captureBranchHead"],
    },
    pr: {
      enableAutoMerge: (() =>
        Promise.resolve()) as unknown as PrDeps["enableAutoMerge"],
    },
    crashHandling: {
      recordHeartbeat: (): Promise<Result<void>> => {
        effects.heartbeats++;
        return Promise.resolve({ ok: true, value: undefined });
      },
    },
  });
}

/** Processor deps wired to the shared fake timeline and a fast lock. */
function makeProcessorDeps(params: {
  workerId: string;
  timeline: FakePrComments;
  effects: Effects;
  logLines: string[];
  stateDir: string;
  workDir: string;
  claudeThrows?: boolean;
}): CiProcessorDeps {
  const { timeline } = params;
  return {
    promptsDir: PROMPTS_DIR,
    logger: makeRecordingLogger(params.logLines),
    deps: makeDeps(params.effects, {
      ...(params.claudeThrows !== undefined
        ? { claudeThrows: params.claudeThrows }
        : {}),
    }),
    stateDir: params.stateDir,
    workDir: params.workDir,
    workerId: params.workerId,
    // Delegate to the real protocol, but with no consistency sleep and a
    // deterministic clock so the race resolves instantly.
    acquireLockFn: (options) =>
      acquireBranchUpdateLock({
        ...options,
        ghCommandFn: timeline.gh(),
        sleepFn: () => Promise.resolve(),
        nowFn: () => timeline.now,
        authorOptions: FLEET_OPTIONS,
        log: () => {},
      }),
    ghCommandFn: timeline.gh(),
  };
}

// ---------------------------------------------------------------------------
// Race: exactly one worker proceeds
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - racing workers: earliest wins, loser returns early", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci-lock-race-" });
  try {
    const timeline = new FakePrComments();
    const firstEffects: Effects = { heartbeats: 0, claudeRuns: 0, pushes: 0 };
    const secondEffects: Effects = { heartbeats: 0, claudeRuns: 0, pushes: 0 };
    const firstLog: string[] = [];
    const secondLog: string[] = [];

    // First worker acquires and completes.
    const firstResult = await processCiFailure(
      makeInput(),
      makeProcessorDeps({
        workerId: "Mac-Ultra-M2.local-b6287ceb",
        timeline,
        effects: firstEffects,
        logLines: firstLog,
        stateDir: `${tmpDir}/.ci_check_state`,
        workDir: tmpDir,
      }),
    );
    assertEquals(firstResult.ok, true);
    if (firstResult.ok) assertEquals(firstResult.value.processed, true);
    // The winner does heartbeat, run Claude and push — the loser's zeroes
    // below are therefore a real difference, not an inert stub.
    assertEquals(firstEffects.heartbeats >= 1, true);
    assertEquals(firstEffects.claudeRuns >= 1, true);
    assertEquals(firstEffects.pushes >= 1, true);

    // Its lock was released, so re-lock the PR on behalf of the first worker
    // to simulate the two runs overlapping in time: a fresh (non-stale) lock
    // created one second before the second worker posts its own.
    const holderTimestamp = timeline.now;
    timeline.comments.push({
      id: 1,
      body:
        `<!-- BRANCH_UPDATE_LOCK:Mac-Ultra-M2.local-b6287ceb:${holderTimestamp} -->`,
      created_at: new Date((holderTimestamp - 1) * 1000).toISOString(),
      author: FLEET_AUTHOR,
    });

    const secondResult = await processCiFailure(
      makeInput(),
      makeProcessorDeps({
        workerId: "host-25-7c9330ff",
        timeline,
        effects: secondEffects,
        logLines: secondLog,
        stateDir: `${tmpDir}/.ci_check_state`,
        workDir: tmpDir,
      }),
    );

    // The loser reports the winner and does no work at all.
    assertEquals(secondResult.ok, true);
    if (secondResult.ok) {
      assertEquals(secondResult.value.processed, false);
      assertEquals(secondResult.value.changesPushed, false);
      assertStringIncludes(
        secondResult.value.summary,
        "Mac-Ultra-M2.local-b6287ceb",
      );
    }
    assertEquals(secondEffects.heartbeats, 0);
    assertEquals(secondEffects.claudeRuns, 0);
    assertEquals(secondEffects.pushes, 0);

    // Contention is logged with the winning worker id.
    assertEquals(
      secondLog.some((line) =>
        line.includes("pr_ci_lock=lost") &&
        line.includes("Mac-Ultra-M2.local-b6287ceb")
      ),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Release on every exit path
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - releases the lock on success", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci-lock-release-" });
  try {
    const timeline = new FakePrComments();
    const effects: Effects = { heartbeats: 0, claudeRuns: 0, pushes: 0 };

    const result = await processCiFailure(
      makeInput(),
      makeProcessorDeps({
        workerId: "worker-a",
        timeline,
        effects,
        logLines: [],
        stateDir: `${tmpDir}/.ci_check_state`,
        workDir: tmpDir,
      }),
    );

    assertEquals(result.ok, true);
    assertEquals(timeline.locks().length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - releases the lock when the CI-fix body throws", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci-lock-throw-" });
  try {
    const timeline = new FakePrComments();
    const effects: Effects = { heartbeats: 0, claudeRuns: 0, pushes: 0 };

    await assertRejects(
      () =>
        processCiFailure(
          makeInput(),
          makeProcessorDeps({
            workerId: "worker-a",
            timeline,
            effects,
            logLines: [],
            stateDir: `${tmpDir}/.ci_check_state`,
            workDir: tmpDir,
            claudeThrows: true,
          }),
        ),
      Error,
      "claude exploded",
    );

    // The `finally` released the lock despite the throw.
    assertEquals(timeline.locks().length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Stale locks never deadlock the PR
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - a stale lock past TTL is cleaned and acquisition succeeds", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci-lock-stale-" });
  try {
    const timeline = new FakePrComments();
    // A crashed holder's lock, 40 minutes old against the 300s TTL.
    timeline.comments.push({
      id: 1,
      body: "<!-- BRANCH_UPDATE_LOCK:crashed-host:1699997600 -->",
      created_at: "2026-08-03T01:00:00Z",
      author: FLEET_AUTHOR,
    });
    const effects: Effects = { heartbeats: 0, claudeRuns: 0, pushes: 0 };

    const result = await processCiFailure(
      makeInput(),
      makeProcessorDeps({
        workerId: "worker-a",
        timeline,
        effects,
        logLines: [],
        stateDir: `${tmpDir}/.ci_check_state`,
        workDir: tmpDir,
      }),
    );

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.processed, true);
    assertEquals(effects.claudeRuns >= 1, true);
    // The stale lock was removed, not left to deadlock the PR.
    assertEquals(
      timeline.comments.some((c) => c.body.includes("crashed-host")),
      false,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Renewal keeps a long run's lock alive past the base TTL
// ---------------------------------------------------------------------------

Deno.test("renewBranchUpdateLock - a renewed lock survives past the base TTL", async () => {
  const timeline = new FakePrComments();
  const gh = timeline.gh();

  // t=0: worker-a takes the lock.
  const acquired = await acquireBranchUpdateLock({
    repo: "org/repo",
    prNumber: 3644,
    workerId: "worker-a",
    ghCommandFn: gh,
    sleepFn: () => Promise.resolve(),
    nowFn: () => 1_700_000_000,
    note: "Locked for a CI fix.",
  });
  assertEquals(acquired.ok, true);
  if (!acquired.ok) return;
  assertEquals(acquired.value.acquired, true);
  const lockCommentId = acquired.value.lockCommentId!;

  // t=250s: still working — renew before the 300s TTL expires.
  const renewed = await renewBranchUpdateLock({
    repo: "org/repo",
    lockCommentId,
    workerId: "worker-a",
    ghCommandFn: gh,
    nowFn: () => 1_700_000_250,
    note: "Locked for a CI fix.",
  });
  assertEquals(renewed.ok, true);

  // t=400s — past the base TTL measured from acquisition, but only 150s
  // since the renewal, so a competing host must not clean it.
  await cleanStaleBranchUpdateLocks({
    repo: "org/repo",
    prNumber: 3644,
    ghCommandFn: gh,
    nowFn: () => 1_700_000_400,
    lockTtlSeconds: 300,
  });

  const remaining = timeline.locks();
  assertEquals(remaining.length, 1);
  assertEquals(parseLockComment(remaining[0]!.body)?.workerId, "worker-a");
  // The visible line survives renewal, so the comment never renders blank.
  assertStringIncludes(remaining[0]!.body, "Locked for a CI fix.");
});

Deno.test("renewBranchUpdateLock - reports a failed renewal instead of failing silently", async () => {
  const result = await renewBranchUpdateLock({
    repo: "org/repo",
    lockCommentId: 55,
    workerId: "worker-a",
    ghCommandFn: () => Promise.reject(new Error("API down")),
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error.message, "API down");
});

// ---------------------------------------------------------------------------
// Renewal is scheduled for the duration of a run
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - schedules and stops lock renewal around the run", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci-lock-renew-" });
  try {
    const timeline = new FakePrComments();
    const effects: Effects = { heartbeats: 0, claudeRuns: 0, pushes: 0 };
    let started = 0;
    let stopped = 0;
    let renewalNote = "";

    const base = makeProcessorDeps({
      workerId: "worker-a",
      timeline,
      effects,
      logLines: [],
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    });

    const result = await processCiFailure(makeInput(), {
      ...base,
      startLockRenewalFn: (options) => {
        started++;
        renewalNote = options.note ?? "";
        return {
          stop() {
            stopped++;
          },
        };
      },
    });

    assertEquals(result.ok, true);
    assertEquals(started, 1);
    assertEquals(stopped, 1);
    assertStringIncludes(renewalNote, "worker-a");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
