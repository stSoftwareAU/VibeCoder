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
  setupDeadlineMs,
} from "../lib/setup_steps.ts";
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

/**
 * Lets an abandoned setup run on after a gate opens. The steps are mocks, and
 * the heartbeat start does a little file I/O, so one macrotask is not enough;
 * the assertions after it fail if that setup does any further work.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

function issueContext(issueNumber: number): IssueContext {
  return {
    repo: "org/repo",
    issueNumber,
    issueTitle: "Wedged setup",
    issueBody: "A setup step never returns.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
}

/** Mock deps whose setup deadline is short and whose unassigns are recorded. */
function deadlineDeps(
  overrides: Parameters<typeof createMockDeps>[0],
  unassigns: unknown[][],
  ghComments = "",
): WorkerDeps {
  const base = createMockDeps();
  return createMockDeps({
    ...overrides,
    github: {
      createClient: (logger) => ({
        ...base.github.createClient(logger),
        unassignIssue: (...args: unknown[]) => {
          unassigns.push(args);
          return Promise.resolve();
        },
      }),
      runGhCommand: () => Promise.resolve(ghComments),
      ...overrides?.github,
    },
    infrastructure: { setupDeadlineMs: () => 30, ...overrides?.infrastructure },
  });
}

Deno.test("setupDeadlineMs covers two agent budgets plus the clone and pre-setup bounds (Issue #5128)", () => {
  const hour = setupDeadlineMs({ claudeTimeout: 3600 });
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
    setupDeadlineMs({ claudeTimeout: 7200 }) - hour,
    2 * 3600 * 1000,
  );
});

Deno.test("runSetupWithDeadline returns the setup result and never abandons when setup settles first (Issue #5128)", async () => {
  let abandoned = 0;
  const result = await runSetupWithDeadline(
    () => Promise.resolve({ status: "continue" as const }),
    { deadlineMs: 5_000, onAbandon: () => abandoned++ },
  );
  assertEquals(result, { status: "continue" });
  assertEquals(abandoned, 0);
});

Deno.test("runSetupWithDeadline abandons a wedged setup once and returns a timeout failure (Issue #5128)", async () => {
  let abandoned = 0;
  const result = await runSetupWithDeadline(
    () => never<{ status: "continue" }>(),
    { deadlineMs: 20, onAbandon: () => abandoned++ },
  );
  assertEquals(result.status, "failure");
  if (result.status !== "failure") return;
  assertEquals(result.category, "timeout");
  assertStringIncludes(result.reason, "abandoned it");
  assertEquals(abandoned, 1);
});

Deno.test("ownClaimCommentPresent answers true only for this run's claim comment (Issue #5128)", async () => {
  const seen: string[][] = [];
  const present = await ownClaimCommentPresent(
    (args) => {
      seen.push(args);
      return Promise.resolve("987\n");
    },
    "org/repo",
    5,
    "testbot-123",
  );
  assertEquals(present, true);
  assertStringIncludes(seen[0]!.join(" "), "CLAIM_LOCK:testbot-123 -->");
  assertEquals(
    await ownClaimCommentPresent(() => Promise.resolve(""), "o/r", 5, "w-1"),
    false,
  );
  // A read that fails is never taken as "held".
  assertEquals(
    await ownClaimCommentPresent(
      () => Promise.reject(new Error("rate limited")),
      "o/r",
      5,
      "w-1",
    ),
    false,
  );
  // A worker id that is not a plain id never reaches the query.
  assertEquals(
    await ownClaimCommentPresent(
      () => Promise.resolve("1"),
      "o/r",
      5,
      'x") | .id #',
    ),
    false,
  );
});

Deno.test("workOnIssue: a wedge inside claimIssue with no claim of its own does not unassign (Issue #5128)", async () => {
  const unassigns: unknown[][] = [];
  const late = gate<Awaited<ReturnType<IssueDeps["claimIssue"]>>>();
  let churnChecks = 0;
  const deps = deadlineDeps({
    issues: {
      claimIssue: () => late.promise,
      checkClaimChurn: () => {
        churnChecks++;
        return Promise.resolve({
          ok: true,
          value: { escalated: false },
        } as Awaited<ReturnType<IssueDeps["checkClaimChurn"]>>);
      },
    },
  }, unassigns);

  const result = await workOnIssue(issueContext(5601), deps);

  assertEquals(result.phase, "setup");
  assertEquals(result.category, "timeout");
  // A claim never taken is not released: the shared login may now be another
  // host's live claim.
  assertEquals(result.claimNotHeld, true);

  // The claim comes back after the run ended: it is released, once, and the
  // abandoned setup goes no further.
  late.open(CLAIMED);
  await settle();
  assertEquals(unassigns.length, 1);
  assertEquals(churnChecks, 0);
});

Deno.test("workOnIssue: a wedge inside claimIssue after this run's claim comment landed releases it, once (Issue #5128)", async () => {
  const unassigns: unknown[][] = [];
  const late = gate<Awaited<ReturnType<IssueDeps["claimIssue"]>>>();
  const deps = deadlineDeps(
    { issues: { claimIssue: () => late.promise } },
    unassigns,
    "4242\n",
  );

  const result = await workOnIssue(issueContext(5602), deps);

  assertEquals(result.category, "timeout");
  // The run's own comment is there, so run_core's failure path releases it.
  assertEquals(result.claimNotHeld, undefined);
  // The late claim must not release a second time: that unassign would strip
  // whichever host claimed the issue in between.
  late.open(CLAIMED);
  await settle();
  assertEquals(unassigns.length, 0);
});

Deno.test("workOnIssue: a wedge after a won claim releases the claim and does no later setup work (Issue #5128)", async () => {
  const unassigns: unknown[][] = [];
  const late = gate<Awaited<ReturnType<IssueDeps["claimIssue"]>>>();
  const repoSetup = gate<Awaited<ReturnType<WorkerDeps["git"]["setupRepo"]>>>();
  let heartbeats = 0;
  const base = createMockDeps();
  const deps = deadlineDeps({
    issues: { claimIssue: () => late.promise },
    git: { setupRepo: () => repoSetup.promise },
    crashHandling: {
      recordHeartbeat: (...args) => {
        heartbeats++;
        return base.crashHandling.recordHeartbeat(...args);
      },
    },
  }, unassigns);
  late.open(CLAIMED);

  const result = await workOnIssue(issueContext(5603), deps);

  assertEquals(result.phase, "setup");
  assertEquals(result.category, "timeout");
  // The claim is held, so the run's failure path releases it as before.
  assertEquals(result.claimNotHeld, undefined);

  // The clone returns after the run ended: no heartbeat starts and nothing
  // releases the claim a second time.
  repoSetup.open({ ok: true, value: "/tmp/repo" });
  await settle();
  assertEquals(heartbeats, 0);
  assertEquals(unassigns.length, 0);
});

Deno.test("workOnIssue: a heartbeat that starts after the deadline is stopped (Issue #5128)", async () => {
  const unassigns: unknown[][] = [];
  const recorded = gate<{ ok: true; value: undefined }>();
  const deps = deadlineDeps({
    issues: { claimIssue: () => Promise.resolve(CLAIMED) },
    crashHandling: { recordHeartbeat: () => recorded.promise },
  }, unassigns);

  const result = await workOnIssue(issueContext(5604), deps);
  assertEquals(result.category, "timeout");

  recorded.open({ ok: true, value: undefined });
  await settle();
  assertEquals(isHeartbeatRunning("org/repo", 5604), false);
  assertEquals(unassigns.length, 0);
});

for (
  const wedge of [
    { step: "checkClaimChurn", next: "repository setup", issue: 5605 },
    { step: "getRepoDefaultBranch", next: "feature branch", issue: 5606 },
    {
      step: "createFeatureBranchFromBase",
      next: "pre-setup command",
      issue: 5607,
    },
  ] as const
) {
  Deno.test(`workOnIssue: setup abandoned during ${wedge.step} never starts the ${wedge.next} step (Issue #5128)`, async () => {
    const lines: string[] = [];
    const late = gate<unknown>();
    const stall = (): never => (() => late.promise) as never;
    const deps = deadlineDeps({
      issues: {
        claimIssue: () => Promise.resolve(CLAIMED),
        ...(wedge.step === "checkClaimChurn"
          ? { checkClaimChurn: stall() }
          : {}),
      },
      git: wedge.step === "checkClaimChurn" ? {} : {
        [wedge.step]: stall(),
      },
      logger: { info: (message: string) => void lines.push(message) },
    }, []);

    const result = await workOnIssue(issueContext(wedge.issue), deps);
    assertEquals(result.category, "timeout");
    // Positive control: the step before the wedge did start.
    assertEquals(lines.some((l) => l.startsWith("[setup-step]")), true);

    late.open(
      wedge.step === "checkClaimChurn"
        ? { ok: true, value: { escalated: false } }
        : wedge.step === "getRepoDefaultBranch"
        ? { ok: true, value: "main" }
        : { ok: true, value: undefined },
    );
    await settle();
    assertEquals(
      lines.some((l) => l.includes(`[setup-step] ${wedge.next}: started`)),
      false,
    );
  });
}
