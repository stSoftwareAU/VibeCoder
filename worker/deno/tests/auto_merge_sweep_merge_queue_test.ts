/**
 * Tests for the merge-queue exception in the auto-merge sweep (Issue #4424).
 * An armed PR that is behind a queued base is not sent to `updateBranchFn`,
 * and the merge attempt is skipped too: the queue lands it. The same fixture
 * on an unqueued base still updates the branch, and a conflicting PR still
 * falls through to the existing behaviour.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { type SweepablePr, sweepAutoMerge } from "../lib/auto_merge_sweep.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { PrLiveStateReading } from "../lib/pr_live_state.ts";

const REPO = "org/repo";
const FLEET = ["VibeCoderST"];

const PR: SweepablePr = {
  number: 7,
  headRefName: "issue-7",
  baseRefName: "main",
};

interface SweepFixture {
  /** The PR's live state (armed, behind, mergeable). */
  reading?: Partial<PrLiveStateReading & { open: true }>;
  /** The merge-queue answer for the base. */
  queued: boolean | "throws";
  /** Set to model a listed PR that carries no base ref at all. */
  noBaseRef?: true;
}

interface SweepRun {
  updated: number[];
  attempted: number[];
  queueQuestions: string[];
  infos: string[];
  warns: string[];
}

/** Run the real sweep over one armed PR and record what it did. */
async function runSweep(f: SweepFixture): Promise<SweepRun> {
  const updated: number[] = [];
  const attempted: number[] = [];
  const queueQuestions: string[] = [];
  const infos: string[] = [];
  const warns: string[] = [];
  const listed: SweepablePr = f.noBaseRef === true
    ? { number: PR.number, headRefName: PR.headRefName }
    : PR;
  const reading: PrLiveStateReading = {
    open: true,
    mergeable: "MERGEABLE",
    armed: true,
    behind: true,
    ...f.reading,
  } as PrLiveStateReading;

  await sweepAutoMerge({
    repos: [REPO],
    isRepoAllowed: () => true,
    fleetAuthors: FLEET,
    listOpenPrs: () => Promise.resolve([listed]),
    prLiveState: () => Promise.resolve(reading),
    updateBranchFn: (_repo: string, prNumber: number) => {
      updated.push(prNumber);
      return Promise.resolve({ ok: true, value: undefined });
    },
    isMergeQueueBase: (repo: string, baseRefName: string) => {
      queueQuestions.push(`${repo}#${baseRefName}`);
      if (f.queued === "throws") {
        return Promise.reject(new Error("rules endpoint down"));
      }
      return Promise.resolve(f.queued);
    },
    checkBaseIntegrity: () =>
      Promise.resolve({ action: "proceed" as const, disarmed: false }),
    attemptMerge: (_repo: string, pr: SweepablePr) => {
      attempted.push(pr.number);
      return Promise.resolve({
        result: AutoMergeResult.MergedDirectly,
        message: `merged #${pr.number}`,
      });
    },
    recordOutcome: () => {},
    invalidateOpenPrCache: () => Promise.resolve(),
    logger: {
      info: (message: string) => {
        infos.push(message);
      },
      warn: (message: string) => {
        warns.push(message);
      },
    },
  });
  return { updated, attempted, queueQuestions, infos, warns };
}

Deno.test("sweep - armed, behind PR on a queued base is not updated and not merge-attempted", async () => {
  const run = await runSweep({ queued: true });
  assertEquals(run.updated, []);
  assertEquals(run.attempted, []);
  assertEquals(run.queueQuestions, [`${REPO}#main`]);
});

Deno.test("sweep - the same armed, behind PR on an unqueued base is updated, not merge-attempted", async () => {
  const run = await runSweep({ queued: false });
  assertEquals(run.updated, [7]);
  assertEquals(run.attempted, []);
});

Deno.test("sweep - the queued skip is logged at info and names the merge queue", async () => {
  const run = await runSweep({ queued: true });
  const line = run.infos.find((m) => m.includes("merge queue"));
  assertEquals(
    line !== undefined,
    true,
    `expected a merge-queue info line, got: ${JSON.stringify(run.infos)}`,
  );
});

Deno.test("sweep - a conflicting, armed, behind PR on a queued base falls through to the merge attempt", async () => {
  const run = await runSweep({
    queued: true,
    reading: { mergeable: "CONFLICTING" },
  });
  assertEquals(run.updated, []);
  assertEquals(run.attempted, [7]);
});

Deno.test("sweep - an armed PR that is not behind is merge-attempted without asking the queue", async () => {
  const run = await runSweep({ queued: true, reading: { behind: false } });
  assertEquals(run.updated, []);
  assertEquals(run.attempted, [7]);
  assertEquals(run.queueQuestions, []);
});

Deno.test("sweep - a PR with no base ref is not treated as queued", async () => {
  const run = await runSweep({ queued: true, noBaseRef: true });
  assertEquals(run.updated, [7]);
  assertEquals(run.attempted, []);
  assertEquals(run.queueQuestions, []);
});

Deno.test("sweep - a failing merge-queue read is logged at warning, naming the repo, base and cause (fail loud)", async () => {
  const run = await runSweep({ queued: "throws" });
  assertEquals(
    run.warns.length,
    1,
    `expected one warning, got: ${JSON.stringify(run.warns)}`,
  );
  const line = run.warns[0] ?? "";
  assertEquals(line.includes(REPO), true);
  assertEquals(line.includes("main"), true);
  assertEquals(line.includes("rules endpoint down"), true);
});

Deno.test("sweep - a failing merge-queue read is treated as not queued, so the branch is still updated", async () => {
  const run = await runSweep({ queued: "throws" });
  assertEquals(run.updated, [7]);
  assertEquals(run.attempted, []);
});
