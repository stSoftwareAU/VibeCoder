/**
 * The auto-merge sweep clears a `milestone-behind` deferral in its own cycle
 * (Issue #2005).
 *
 * The Issue #1779 gate defers every child PR on a milestone branch that is
 * behind the default branch, and the sweep used to do nothing but log it —
 * so the PRs waited for the periodic sync at priority 1.72, which runs
 * *after* this sweep and therefore lands a cycle late for arming purposes.
 *
 * These tests drive `sweepAutoMerge` itself. Both passes (priority 1.65 and
 * the post-scan pass) are the same function, so covering it covers both.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { type SweepablePr, sweepAutoMerge } from "../lib/auto_merge_sweep.ts";
import {
  AutoMergeResult,
  type EnableAutoMergeResult,
} from "../lib/pr_auto_merge.ts";
import type { MilestonePresyncResult } from "../lib/milestone_presync.ts";
import type { PrLiveStateReading } from "../lib/pr_live_state.ts";
import type { Logger } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const MILESTONE_BRANCH = "milestone/1730-resolve-merge-conflicts";
const OTHER_BRANCH = "milestone/1999-sync-ladder";

const silentLogger: Pick<Logger, "info" | "warn"> = {
  info: () => {},
  warn: () => {},
};

/** Three children of one milestone plus one of another. */
const PRS: SweepablePr[] = [
  { number: 11, baseRefName: MILESTONE_BRANCH },
  { number: 12, baseRefName: MILESTONE_BRANCH },
  { number: 13, baseRefName: MILESTONE_BRANCH },
  { number: 14, baseRefName: OTHER_BRANCH },
];

/** What one drive of the sweep did. */
interface Observed {
  attempts: number[];
  resyncs: string[];
  recorded: AutoMergeResult[];
  rearmed: number;
}

/**
 * Drive the sweep with every PR deferring `milestone-behind` until its
 * milestone branch is reported level — what the real gate does.
 */
async function runSweep(options: {
  resync: (branch: string) => MilestonePresyncResult;
  /** Omit the resync seam entirely — the pre-#2005 behaviour. */
  withoutResync?: boolean;
  /** Report no milestone branch on the deferral or the PR. */
  anonymousDeferral?: boolean;
}): Promise<Observed> {
  const attempts: number[] = [];
  const resyncs: string[] = [];
  const recorded: AutoMergeResult[] = [];
  const levelBranches = new Set<string>();

  const prs = options.anonymousDeferral
    ? PRS.map((pr) => ({ number: pr.number }))
    : PRS;

  const result = await sweepAutoMerge({
    repos: [REPO],
    isRepoAllowed: () => true,
    fleetAuthors: ["VibeCoderST"],
    listOpenPrs: () => Promise.resolve(prs),
    prLiveState: () => Promise.resolve({ open: true } as PrLiveStateReading),
    attemptMerge: (_repo: string, pr: SweepablePr) => {
      attempts.push(pr.number);
      const branch = pr.baseRefName ?? MILESTONE_BRANCH;
      if (levelBranches.has(branch)) {
        return Promise.resolve({
          result: AutoMergeResult.Enabled,
          message: `armed #${pr.number}`,
        } as EnableAutoMergeResult);
      }
      return Promise.resolve({
        result: AutoMergeResult.Deferred,
        deferral: "milestone-behind",
        ...(options.anonymousDeferral ? {} : { milestoneBranch: branch }),
        message: `milestone behind default branch — PR #${pr.number}`,
      } as EnableAutoMergeResult);
    },
    ...(options.withoutResync ? {} : {
      resyncMilestoneBase: (_repo: string, milestoneBranch: string) => {
        resyncs.push(milestoneBranch);
        const outcome = options.resync(milestoneBranch);
        if (outcome.status !== "deferred") levelBranches.add(milestoneBranch);
        return Promise.resolve(outcome);
      },
    }),
    recordOutcome: (_repo, _prNumber, outcome) => {
      recorded.push(outcome.result as AutoMergeResult);
    },
    invalidateOpenPrCache: () => Promise.resolve(),
    logger: silentLogger,
  });

  assert(result.ok);
  return {
    attempts,
    resyncs,
    recorded,
    rearmed: result.value.prsRearmedAfterResync,
  };
}

/** A sync that landed. */
function synced(): MilestonePresyncResult {
  return { status: "synced", behindBy: 1, detail: "merged main down" };
}

/** A sync the branch's conflict budget could not settle. */
function deferred(): MilestonePresyncResult {
  return {
    status: "deferred",
    behindBy: 1,
    detail: "deferred: milestone behind default branch (1 commits) — " +
      "conflict attempt 1 of 3 failed at rung agent",
  };
}

Deno.test("#2005 - one inline sync per milestone clears every child PR on it", async () => {
  const observed = await runSweep({ resync: synced });

  // Three children of one milestone and one of another: two syncs, not four.
  assertEquals(observed.resyncs, [MILESTONE_BRANCH, OTHER_BRANCH]);
  // #11 defers, is synced, and arms on the retry; #12 and #13 then arm on
  // their first attempt because the branch the sync levelled is their base.
  assertEquals(observed.attempts, [11, 11, 12, 13, 14, 14]);
  assertEquals(
    observed.recorded,
    [
      AutoMergeResult.Enabled,
      AutoMergeResult.Enabled,
      AutoMergeResult.Enabled,
      AutoMergeResult.Enabled,
    ],
    "the recorded outcome is the armed one, not the deferral",
  );
  assertEquals(observed.rearmed, 2, "two PRs needed the inline sync");
});

Deno.test("#2005 - a milestone whose sync conflicts keeps its deferral", async () => {
  const observed = await runSweep({ resync: deferred });

  // The memo is what this asserts: three children of one milestone all
  // report the deferral, and the milestone is synced once, not three times.
  assertEquals(observed.resyncs, [MILESTONE_BRANCH, OTHER_BRANCH]);
  assertEquals(observed.attempts, [11, 12, 13, 14], "no arming is retried");
  assertEquals(
    observed.recorded,
    [
      AutoMergeResult.Deferred,
      AutoMergeResult.Deferred,
      AutoMergeResult.Deferred,
      AutoMergeResult.Deferred,
    ],
  );
  assertEquals(observed.rearmed, 0);
});

Deno.test("#2005 - without the resync seam the sweep behaves exactly as before", async () => {
  const observed = await runSweep({ resync: synced, withoutResync: true });

  assertEquals(observed.resyncs, []);
  assertEquals(observed.attempts, [11, 12, 13, 14]);
  assertEquals(observed.rearmed, 0);
});

Deno.test("#2005 - a deferral naming no branch is never synced against a guess", async () => {
  const observed = await runSweep({
    resync: synced,
    anonymousDeferral: true,
  });

  assertEquals(observed.resyncs, [], "no branch is guessed at");
  assertEquals(observed.attempts, [11, 12, 13, 14]);
  assertEquals(observed.rearmed, 0);
});
