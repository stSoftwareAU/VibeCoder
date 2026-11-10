/**
 * Tests for the auto-merge sweep's orphaned-draft hook (Issue #4952).
 *
 * With the `readyOrphanedDraft` hook returning true, a draft PR falls through
 * to the normal path and reaches `attemptMerge` in the same pass. Otherwise a
 * draft is skipped exactly as before (Issue #1800), and a non-draft PR never
 * consults the hook.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  resetAnnouncedDraftsForTest,
  type SweepablePr,
  sweepAutoMerge,
  type SweepAutoMergeOptions,
} from "../lib/auto_merge_sweep.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { PrLiveStateReading } from "../lib/pr_live_state.ts";

const REPO = "stSoftwareAU/VibeCoder";
const FLEET = ["VibeCoderST", "stservice"];

interface Logged {
  message: string;
  context?: Record<string, unknown>;
}

/** Build a one-repo sweep; `hook` is wired only when supplied. */
function sweep(
  prs: SweepablePr[],
  hook?: (repo: string, pr: SweepablePr) => Promise<boolean>,
) {
  const attempted: number[] = [];
  const recorded: number[] = [];
  const liveReads: number[] = [];
  const hookCalls: number[] = [];
  const warnings: Logged[] = [];
  const infos: Logged[] = [];
  const options: SweepAutoMergeOptions = {
    repos: [REPO],
    isRepoAllowed: () => true,
    fleetAuthors: FLEET,
    listOpenPrs: () => Promise.resolve(prs),
    prLiveState: (_repo, pr) => {
      liveReads.push(pr.number);
      return Promise.resolve(
        { open: true, mergeable: "MERGEABLE" } as PrLiveStateReading,
      );
    },
    updateBranchFn: () => Promise.resolve({ ok: true, value: undefined }),
    isMergeQueueBase: () => Promise.resolve(false),
    checkBaseIntegrity: () =>
      Promise.resolve({ action: "proceed" as const, disarmed: false }),
    attemptMerge: (_repo, pr) => {
      attempted.push(pr.number);
      return Promise.resolve({
        result: AutoMergeResult.MergedDirectly,
        message: `merged #${pr.number}`,
      });
    },
    ...(hook
      ? {
        readyOrphanedDraft: (repo: string, pr: SweepablePr) => {
          hookCalls.push(pr.number);
          return hook(repo, pr);
        },
      }
      : {}),
    recordOutcome: (_repo, prNumber) => {
      recorded.push(prNumber);
    },
    invalidateOpenPrCache: () => Promise.resolve(),
    logger: {
      info: (message: string, context?: Record<string, unknown>) => {
        infos.push({ message, context });
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        warnings.push({ message, context });
      },
      error: () => {},
    },
  };
  return {
    options,
    attempted,
    recorded,
    liveReads,
    hookCalls,
    warnings,
    infos,
  };
}

const skipAnnouncements = (infos: Logged[]) =>
  infos.filter((i) => i.message.includes("skipping draft PR"));

Deno.test("#4952 - a draft the hook readies reaches attemptMerge in the same pass", async () => {
  resetAnnouncedDraftsForTest();
  const run = sweep(
    [{ number: 7, headRefName: "issue-7-fix", isDraft: true }],
    () => Promise.resolve(true),
  );
  const result = await sweepAutoMerge(run.options);
  assert(result.ok);
  assertEquals(run.hookCalls, [7]);
  assertEquals(run.liveReads, [7], "the normal path re-reads live state");
  assertEquals(run.attempted, [7]);
  assertEquals(run.recorded, [7]);
  assertEquals(result.value.prsAttempted, 1);
  assertEquals(skipAnnouncements(run.infos), []);
});

Deno.test("#4952 - a draft the hook declines is skipped, announced once, and never attempted", async () => {
  resetAnnouncedDraftsForTest();
  const run = sweep(
    [{ number: 7, headRefName: "issue-7-fix", isDraft: true }],
    () => Promise.resolve(false),
  );
  const first = await sweepAutoMerge(run.options);
  assert(first.ok);
  assertEquals(run.hookCalls, [7]);
  assertEquals(run.attempted, []);
  assertEquals(run.liveReads, [], "a skipped draft gets no live read");
  assertEquals(skipAnnouncements(run.infos).length, 1);
  assertEquals(skipAnnouncements(run.infos)[0]!.context?.prNumber, 7);

  const second = await sweepAutoMerge(run.options);
  assert(second.ok);
  assertEquals(run.attempted, []);
  assertEquals(skipAnnouncements(run.infos).length, 1, "announced once");
  resetAnnouncedDraftsForTest();
});

Deno.test("#4952 - a hook that throws leaves the draft skipped and warns naming the PR number", async () => {
  resetAnnouncedDraftsForTest();
  const run = sweep(
    [{ number: 7, headRefName: "issue-7-fix", isDraft: true }],
    () => Promise.reject(new Error("gh exploded")),
  );
  const result = await sweepAutoMerge(run.options);
  assert(result.ok, "the sweep itself does not fail");
  assertEquals(run.attempted, []);
  assertEquals(run.recorded, []);
  const warned = run.warnings.find((w) =>
    w.message.includes("self-heal threw")
  );
  assert(warned, "a warning names the self-heal failure");
  assertEquals(warned.context?.repo, REPO);
  assertEquals(warned.context?.prNumber, 7);
  assertEquals(warned.context?.error, "gh exploded");
  resetAnnouncedDraftsForTest();
});

Deno.test("#4952 - a skipped draft clears its recorded branch-refresh refusal", async () => {
  resetAnnouncedDraftsForTest();
  const run = sweep(
    [{ number: 7, headRefName: "issue-7-fix", isDraft: true }],
    () => Promise.resolve(false),
  );
  const notified: Array<{ repo: string; prNumber: number; active: boolean }> =
    [];
  const state = new Map([[`${REPO}#7`, {
    reason: "mergeability-unknown" as const,
    streak: 2,
    lastSeenAtMs: Date.now(),
    notified: true,
  }]]);
  const result = await sweepAutoMerge({
    ...run.options,
    branchRefreshRefusals: {
      load: () => Promise.resolve(state),
      save: () => Promise.resolve(),
      notify: ({ repo, prNumber, active }) => {
        notified.push({ repo, prNumber, active });
        return Promise.resolve();
      },
    },
  });
  assert(result.ok);
  assertEquals(notified, [{ repo: REPO, prNumber: 7, active: false }]);
  assertEquals(state.size, 0);
  resetAnnouncedDraftsForTest();
});

Deno.test("#4952 - with no hook supplied a draft is skipped exactly as before", async () => {
  resetAnnouncedDraftsForTest();
  const run = sweep([{ number: 7, headRefName: "issue-7-fix", isDraft: true }]);
  const result = await sweepAutoMerge(run.options);
  assert(result.ok);
  assertEquals(run.attempted, []);
  assertEquals(run.liveReads, []);
  assertEquals(skipAnnouncements(run.infos).length, 1);
  assertEquals(run.warnings, []);
  resetAnnouncedDraftsForTest();
});

Deno.test("#4952 - a non-draft PR, or one of unknown draft state, never consults the hook", async () => {
  resetAnnouncedDraftsForTest();
  const run = sweep(
    [
      { number: 5, headRefName: "issue-5-x", isDraft: false },
      { number: 6, headRefName: "issue-6-x" },
    ],
    () => Promise.resolve(false),
  );
  const result = await sweepAutoMerge(run.options);
  assert(result.ok);
  assertEquals(run.hookCalls, []);
  assertEquals(run.attempted, [5, 6]);
  resetAnnouncedDraftsForTest();
});
