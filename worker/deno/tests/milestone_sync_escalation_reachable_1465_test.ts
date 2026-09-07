/**
 * A stuck milestone sync escalates even with no `#NNN` in the title (#1465).
 *
 * The escalation resolved its destination by parsing a tracking issue number
 * out of the milestone TITLE. A milestone whose title does not begin with
 * `#NNN` therefore had no destination at all: the failure streak still counted
 * to the threshold, the escalation returned `false`, and one line went to the
 * worker log. Every milestone open at the time was in that state, so the
 * escalation was off for effectively all of the fleet's work — and off
 * silently, because `false` is indistinguishable from "nothing to report".
 *
 * That is how `milestone/fix-scan-issues-20260906` sat 32 commits behind
 * `main` for over a day with 14 conflicting files while PRs kept merging into
 * it, and nothing was raised.
 *
 * These tests pin the property that matters: an escalation that cannot find
 * its preferred destination must still reach somewhere a human looks, and it
 * must do so once rather than every cycle.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import { mergeGateFailureError } from "../lib/milestone_merge_gate.ts";
import { milestoneSyncStreakPath } from "../lib/milestone_sync_streak.ts";

/** A real milestone title from the fleet — no `#NNN` prefix. */
const UNPREFIXED_TITLE = "Fix scan issues 20260906";
const PREFIXED_TITLE = "#974 CI gates";
const MILESTONE_BRANCH = "milestone/fix-scan-issues-20260906";

/** Sync deps whose sync always fails the merge gate, recording gh calls. */
function gateFailingDeps(
  calls: string[][],
  streakPath: string,
  milestoneTitle: string,
  existingIssues = "[]",
): MilestoneBranchSyncDeps {
  return {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      calls.push(args);
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(
          JSON.stringify([{ title: milestoneTitle, number: 1 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("issue list") && key.includes("--state closed")) {
        return Promise.resolve(
          JSON.stringify([{
            number: 10,
            title: "t",
            milestone: { title: milestoneTitle },
          }]),
        );
      }
      // The idempotency lookup for an already-filed diagnostic.
      if (key.includes("issue list")) return Promise.resolve(existingIssues);
      if (key.includes("branches/milestone")) {
        return Promise.resolve(MILESTONE_BRANCH);
      }
      return Promise.resolve("");
    },
    syncBranchFn: () =>
      Promise.resolve({
        ok: false as const,
        error: mergeGateFailureError(MILESTONE_BRANCH, "main", {
          status: "failed",
          detail: "merge conflict in 14 files",
          output: "CONFLICT (content): Merge conflict in setup.sh",
        }),
      }),
    log: () => undefined,
    cooldownSeconds: 0,
    lastSyncTimes: new Map(),
    streakPath,
  };
}

const commentCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === "issue" && c[1] === "comment");
const createCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === "issue" && c[1] === "create");

// ---------------------------------------------------------------------------
// The gap: no `#NNN`, no escalation at all
// ---------------------------------------------------------------------------

Deno.test("milestone sync #1465 - a milestone with no #NNN title still escalates", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1465-" });
  try {
    const calls: string[][] = [];
    const result = await syncMilestoneBranches(
      gateFailingDeps(calls, milestoneSyncStreakPath(dir), UNPREFIXED_TITLE),
    );
    assert(result.ok);
    assertEquals(result.value.failed, 1, "the sync is reported as failed");

    // The destination is a filed diagnostic rather than a tracking-issue
    // comment, because there is no tracking issue to comment on.
    const created = createCalls(calls);
    assertEquals(
      created.length,
      1,
      `a stuck sync must reach somewhere a human looks; gh calls: ${
        JSON.stringify(calls)
      }`,
    );
    const body = created[0]!.join(" ");
    assertStringIncludes(body, MILESTONE_BRANCH);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("milestone sync #1465 - the diagnostic is filed once, not every cycle", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1465-" });
  try {
    const all: string[][] = [];
    const streakPath = milestoneSyncStreakPath(dir);
    for (let cycle = 0; cycle < 4; cycle++) {
      await syncMilestoneBranches(
        gateFailingDeps(all, streakPath, UNPREFIXED_TITLE),
      );
    }
    assertEquals(
      createCalls(all).length,
      1,
      "exactly one diagnostic across four failing cycles",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("milestone sync #1465 - an issue nobody can vouch for does not suppress the escalation", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1465-" });
  try {
    const calls: string[][] = [];
    // An open issue with exactly the diagnostic's title, authored by someone
    // outside the fleet. A title-only dedup would read this as "already
    // handled" and stay silent for ever — which is the very failure this
    // escalation exists to prevent, so anyone able to open an issue could
    // switch the alarm off. The lookup is author-verified
    // (`marker_dedup_author_cap`), so an unvouched match is not evidence.
    const impostor = JSON.stringify([{
      number: 4242,
      title: `Milestone branch sync is stuck: ${MILESTONE_BRANCH}`,
      author: { login: "passer-by" },
      body: "",
    }]);
    await syncMilestoneBranches(
      gateFailingDeps(
        calls,
        milestoneSyncStreakPath(dir),
        UNPREFIXED_TITLE,
        impostor,
      ),
    );
    assertEquals(
      createCalls(calls).length,
      1,
      "an unverified title match must not silence the escalation",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The permit direction: the tracking-issue path is unchanged
// ---------------------------------------------------------------------------

Deno.test("milestone sync #1465 - a #NNN title still comments on its tracking issue", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1465-" });
  try {
    const calls: string[][] = [];
    await syncMilestoneBranches(
      gateFailingDeps(calls, milestoneSyncStreakPath(dir), PREFIXED_TITLE),
    );
    const comments = commentCalls(calls);
    assertEquals(comments.length, 1, "the existing path is untouched");
    assertEquals(comments[0]![2], "974", "posted on the tracking issue");
    // And it does NOT also file a diagnostic — one destination, not two.
    assertEquals(createCalls(calls).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
