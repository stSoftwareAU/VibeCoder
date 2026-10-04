/**
 * Replays the GRQ-AutoTrader#2028 timeline — the second instance of the #1957
 * conflict stall — against the merge-conflict pass, the stall watchdog and the
 * milestone's abandon-and-redo, cycle by cycle on a fake clock (Issue #3036,
 * part of #3013).
 *
 * Historically the milestone head was labelled `merge-conflict` at 13:38 UTC
 * on 1 Oct 2026, the pass stood down, and a human merged `Develop` into it by
 * hand at 20:11 and 20:25 (and twice more after midnight). Every one of those
 * human events is `historical` in the fixture and never applied: the replay's
 * own passes must clear the conflict.
 *
 * #3013's done criterion: a conflicted fleet PR reaches `MERGEABLE` within 2
 * hours of the `merge-conflict` label with no human-authored commit on its
 * head, and a redo gets its own 2 hours from its new PR.
 *
 * Each cycle runs what the scan hands the processor while the PR is labelled
 * and conflicting — `processMergeConflict` — and then the stall watchdog,
 * exactly as the 1957 replay drives them (see `fixtures/conflict_replay_driver.ts`).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { FakeGitHub } from "./fixtures/fake_github.ts";
import { processMergeConflict } from "../lib/pr_merge_conflict_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import {
  CONFLICT_RESOLUTION_BUDGET,
  MERGE_CONFLICT_LABEL,
  readResolutionAttempts,
  spentConflictAttempts,
} from "../lib/merge_conflict_markers.ts";
import {
  detectConflictQueueStall,
  repairConflictQueueStall,
} from "../lib/merge_conflict_stall_watchdog.ts";
import type {
  ConflictTakeoverPr,
  TakeoverResolution,
} from "../lib/conflict_takeover.ts";
import type {
  AbandonRestartOutcome,
  AbandonRestartRequest,
} from "../lib/conflict_abandon_restart.ts";
import { abandonAndRebuildMilestone } from "../lib/conflict_milestone_rebuild.ts";
import {
  type Fixture,
  type FixtureEvent,
  loadFixture,
  makeAbandonRecorder,
  ReplayGitHub,
  silentLogger,
  standDownComments,
} from "./fixtures/conflict_replay_driver.ts";

const TWO_HOURS_MS = 2 * 3_600_000;

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

interface CycleRecord {
  atMs: number;
  labels: string[];
  summary?: string;
}

interface ReplayResult {
  fixture: Fixture;
  repl: ReplayGitHub;
  fake: FakeGitHub;
  calls: string[][];
  cycles: CycleRecord[];
  labelledAtMs: number;
  firstMergeableAtMs: number | undefined;
  abandonFromWatchdog: Array<{ atMs: number; outcome: AbandonRestartOutcome }>;
}

async function runReplay(
  resolveOnFixBranch: (
    repl: ReplayGitHub,
  ) => (
    pr: ConflictTakeoverPr,
    fixBranch: string,
  ) => Promise<TakeoverResolution>,
): Promise<ReplayResult> {
  const fixture = await loadFixture("grq_autotrader_2028_timeline.json");
  const { repo, workerLogin } = fixture;
  const prNumber = fixture.pr.number;
  const endAtMs = Date.parse(fixture.replay.endAt);
  const tickMs = fixture.replay.tickMinutes * 60_000;

  const fake = new FakeGitHub({
    startIso: fixture.events[0]!.at,
    defaultBranch: fixture.pr.base,
  });
  fake.actor = workerLogin;
  fake.addIssue({
    repo,
    number: prNumber,
    title: `Milestone ${fixture.milestoneIssue} completion`,
    author: workerLogin,
  });
  fake.addIssue({
    repo,
    number: fixture.milestoneIssue,
    title: fixture.milestoneTitle,
    author: workerLogin,
  });

  const repl = new ReplayGitHub(fake, fixture);
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    return repl.gh(args);
  };
  const isTrustedAuthor = (login: string) => login === workerLogin;
  const resolvers = {
    resolveViaLadder: repl.resolveViaLadder,
    resolveOnFixBranch: resolveOnFixBranch(repl),
  };
  const abandonFromWatchdog: ReplayResult["abandonFromWatchdog"] = [];
  const cycles: CycleRecord[] = [];

  function applyEvent(event: FixtureEvent): Promise<string> | undefined {
    if (event.kind !== "conflict-labelled") {
      throw new Error(`replay: unhandled fixture event kind '${event.kind}'`);
    }
    repl.labelledAtMs = fake.nowMs;
    return gh([
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${prNumber}/labels`,
      "-f",
      `labels[]=${MERGE_CONFLICT_LABEL}`,
    ]);
  }

  /** What the scan hands the processor while the PR is labelled and conflicting. */
  async function mergeConflictPass(): Promise<string> {
    const result = await processMergeConflict(
      {
        repo,
        prNumber,
        branchName: fixture.pr.head,
        baseBranch: fixture.pr.base,
        attemptCount: 0,
      },
      {
        logger: silentLogger,
        deps: createMockDeps({ github: { runGhCommand: gh } }),
        workDir: "/nonexistent-clone",
        workRoot: "/nonexistent-root",
        trustedAuthors: [workerLogin],
        takeoverResolvers: resolvers,
        nowMsFn: () => fake.nowMs,
        milestoneRebuildFn: (request: AbandonRestartRequest) =>
          abandonAndRebuildMilestone(request, {
            gh,
            git: repl.git,
            logger: silentLogger,
            raiseSyncPr: repl.raiseSyncPr,
          }),
      },
    );
    if (!result.ok) throw result.error;
    return result.value.summary;
  }

  async function watchdogTick(): Promise<void> {
    const stall = detectConflictQueueStall(
      repl.observation(repo, prNumber),
      { nowMs: fake.nowMs, isTrustedAuthor },
    );
    if (stall === null) return;
    await repairConflictQueueStall(stall, {
      ghCommandFn: gh,
      logger: silentLogger,
      isTrustedAuthor,
      nowMs: fake.nowMs,
      trustedAuthors: [workerLogin],
      acquireLease: () => ({ release() {} }),
      takeoverResolvers: resolvers,
      abandon: makeAbandonRecorder(repl, abandonFromWatchdog),
    });
  }

  const applied = new Set<number>();
  let firstMergeableAtMs: number | undefined;

  while (fake.nowMs <= endAtMs) {
    repl.settle();

    for (let i = 0; i < fixture.events.length; i++) {
      const event = fixture.events[i]!;
      if (applied.has(i) || Date.parse(event.at) > fake.nowMs) continue;
      applied.add(i);
      if (!event.historical) await applyEvent(event);
    }

    if (
      repl.mergeableState() === "MERGEABLE" && firstMergeableAtMs === undefined
    ) {
      firstMergeableAtMs = fake.nowMs;
    }

    const labels = () => [...fake.issue(repo, prNumber).labels];
    const cycle: CycleRecord = { atMs: fake.nowMs, labels: labels() };
    if (
      repl.mergeableState() === "CONFLICTING" &&
      cycle.labels.includes(MERGE_CONFLICT_LABEL)
    ) {
      cycle.summary = await mergeConflictPass();
      await watchdogTick();
      cycle.labels = labels();
    }
    cycles.push(cycle);

    if (fake.nowMs >= endAtMs) break;
    fake.nowMs = Math.min(fake.nowMs + tickMs, endAtMs);
  }

  return {
    fixture,
    repl,
    fake,
    calls,
    cycles,
    labelledAtMs: repl.labelledAtMs!,
    firstMergeableAtMs,
    abandonFromWatchdog,
  };
}

// ---------------------------------------------------------------------------
// Checks every scenario shares
// ---------------------------------------------------------------------------

/** No cycle applied `needs-human` or asked a human for anything. */
function assertNoHumanHandOff(result: ReplayResult): void {
  for (const cycle of result.cycles) {
    assert(
      !cycle.labels.includes("needs-human"),
      `needs-human was on the PR at ${new Date(cycle.atMs).toISOString()}`,
    );
  }
  assert(
    !result.calls.some((call) =>
      call.some((arg) => arg.includes("needs-human"))
    ),
    "no gh call may name needs-human",
  );
  for (const issue of result.fake.issues.values()) {
    for (const comment of issue.comments) {
      const body = comment.body.toLowerCase();
      assert(
        !body.includes("needs-human") && !body.includes("needs a human"),
        `a hand-off comment was posted on #${issue.number}: ${comment.body}`,
      );
    }
  }
}

/** The head carries no commit authored outside the fleet, and no human sha. */
function assertFleetOnlyHead(result: ReplayResult): void {
  const { fixture, repl } = result;
  assertEquals([...repl.headOnlyAuthors()], [fixture.workerLogin]);
  const humanShas = new Set(
    fixture.events.flatMap((e) =>
      e.kind === "human-push" && e.sha ? [e.sha] : []
    ),
  );
  assert(humanShas.size > 0, "the fixture records the human pushes");
  for (const sha of repl.ancestors(repl.headTip())) {
    assert(!humanShas.has(sha), `a historical human push reached the head`);
  }
  for (const push of repl.pushes) {
    assertEquals(push.actor, fixture.workerLogin);
  }
}

function fixPrs(result: ReplayResult) {
  return [...result.fake.prs.values()].filter((pr) =>
    pr.base === result.fixture.pr.head && pr.head.startsWith("milestone-fix/")
  );
}

function prCloses(result: ReplayResult): string[][] {
  return result.calls.filter((c) =>
    c[0] === "pr" && c[1] === "close" &&
    c[2] === String(result.fixture.pr.number)
  );
}

// ---------------------------------------------------------------------------
// Scenario 1 — the takeover resolves it: MERGEABLE within 2 hours
// ---------------------------------------------------------------------------

Deno.test(
  "replays GRQ-AutoTrader#2028 to MERGEABLE within 2 hours of the label, with no stand-down and no human push",
  async () => {
    const result = await runReplay((repl) => repl.resolveOnFixBranchSucceeds);
    const { fixture, fake } = result;

    // The first cycle opened exactly one milestone-fix/** PR, at the label.
    const firstCycle = result.cycles.find((c) => c.summary !== undefined)!;
    assertEquals(firstCycle.atMs, result.labelledAtMs);
    assert(firstCycle.summary!.includes("fix PR"), firstCycle.summary);
    assertEquals(fixPrs(result).length, 1);
    assertEquals(
      Date.parse(fixPrs(result)[0]!.createdAt),
      result.labelledAtMs,
    );

    // No stand-down, no needs-human, no hand-off comment, in any cycle.
    const thread = fake.issue(fixture.repo, fixture.pr.number).comments;
    assertEquals(standDownComments(thread, fixture.pr.head), []);
    assertNoHumanHandOff(result);

    // MERGEABLE within 2 hours of the label, and before any human push.
    assert(result.firstMergeableAtMs !== undefined, "never reached MERGEABLE");
    assert(
      result.firstMergeableAtMs! - result.labelledAtMs <= TWO_HOURS_MS,
      `MERGEABLE ${
        (result.firstMergeableAtMs! - result.labelledAtMs) / 60_000
      } minutes after the label`,
    );
    const firstHumanPushMs = Math.min(
      ...fixture.events.filter((e) => e.kind === "human-push").map((e) =>
        Date.parse(e.at)
      ),
    );
    assert(result.firstMergeableAtMs! < firstHumanPushMs);
    assertEquals(result.repl.mergeableState(), "MERGEABLE");

    // Every commit the head gained is the fleet's.
    assertFleetOnlyHead(result);

    // Nothing was abandoned or closed, and the ladder never pushed the head.
    assertEquals(result.abandonFromWatchdog, []);
    assertEquals(prCloses(result), []);
    assertEquals(result.repl.resolveViaLadderCalls, []);
    assertEquals(result.repl.syncPrs, []);

    assertEquals(fake.unknownCommands, []);
  },
);

// ---------------------------------------------------------------------------
// Scenario 2 — three takeovers fail: the milestone is redone from its base
// ---------------------------------------------------------------------------

Deno.test(
  "replays GRQ-AutoTrader#2028 through 3 failed attempts to a redo from the base tip, MERGEABLE within 2 hours of the redo's PR",
  async () => {
    const result = await runReplay((repl) => repl.resolveOnFixBranchFails);
    const { fixture, fake, repl } = result;
    const thread = fake.issue(fixture.repo, fixture.pr.number).comments;
    const trusted = (login: string) => login === fixture.workerLogin;

    // No stand-down, no needs-human, no hand-off comment, in any cycle.
    assertEquals(standDownComments(thread, fixture.pr.head), []);
    assertNoHumanHandOff(result);

    // Exactly the budget's worth of attempts failed before the redo.
    const attempts = readResolutionAttempts(
      thread.map((c) => ({
        body: c.body,
        user: { login: c.author },
        created_at: c.at,
      })),
      trusted,
    );
    const failed = attempts.filter((a) => a.outcome === "failed");
    assertEquals(failed.length, CONFLICT_RESOLUTION_BUDGET);

    // The redo ran once, after the third failure, and started at the base tip.
    assertEquals(repl.syncPrs.length, 1, "the milestone was redone once");
    const redo = repl.syncPrs[0]!;
    const thirdFailureMs = Math.max(...failed.map((a) => a.atMs!));
    assert(redo.openedAtMs >= thirdFailureMs);
    assertEquals(repl.detachedOnto, [fixture.commits.baseTip]);
    assert(repl.ancestryContains(redo.sha, fixture.commits.baseTip));

    // The redo restarted the shared budget rather than inheriting it.
    assertEquals(spentConflictAttempts(attempts), 0);

    // The milestone PR itself was never closed, and never abandoned through
    // the single-issue rung — every sub-PR's work is replayed instead.
    assertEquals(prCloses(result), []);
    assertEquals(result.abandonFromWatchdog, []);
    for (const sub of fixture.subPrs!) {
      assert(
        [...repl.ancestors(redo.sha)].some((sha) =>
          repl.commits.get(sha)!.subject === `replay merge #${sub.number}`
        ),
        `sub-PR #${sub.number} was not replayed onto the redo`,
      );
    }

    // The 2-hour window restarts at the redo's own PR, and it is met there.
    assert(result.firstMergeableAtMs !== undefined, "never reached MERGEABLE");
    assert(result.firstMergeableAtMs! >= redo.openedAtMs);
    assert(
      result.firstMergeableAtMs! - redo.openedAtMs <= TWO_HOURS_MS,
      `MERGEABLE ${
        (result.firstMergeableAtMs! - redo.openedAtMs) / 60_000
      } minutes after the redo's PR opened`,
    );
    assertEquals(repl.mergeableState(), "MERGEABLE");
    assertFleetOnlyHead(result);

    assertEquals(fake.unknownCommands, []);
  },
);
