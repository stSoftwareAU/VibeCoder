/**
 * A stuck milestone sync escalates even with no `#NNN` in the title (#1465),
 * onto an issue that already exists (#1769).
 *
 * The escalation used to resolve its destination by parsing a tracking issue
 * number out of the milestone TITLE, and returned `false` when there was none:
 * the streak counted to the threshold and one line went to the worker log.
 * That is how `milestone/fix-scan-issues-20260906` sat 32 commits behind
 * `main` for over a day with 14 conflicting files and nothing was raised.
 *
 * Issue #1465 closed that silence by filing a `needs-human` issue instead —
 * and Issue #1769 reversed **that** half: filing one issue per branch and per
 * conflicting commit produced #1754, #1756, #1764, NEAT-AI-scorer#612/#613 and
 * GRQ-AutoTrader#120, none of which anything ever closed. The destination is
 * now an issue that already exists — the milestone's parent planning issue,
 * else its oldest open child — and where neither exists the log line is the
 * whole escalation.
 *
 * These tests pin what survived: an escalation that cannot find its preferred
 * destination still reaches a human where one exists, it does so once rather
 * than every cycle, and it never files a new issue.
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

/** Options for {@link gateFailingDeps}. */
interface DepsOptions {
  /** Open children the milestone answers with (issue-shaped rows). */
  children?: { number: number; title: string }[];
  /** Log sink, when the test reads the log lines. */
  log?: (message: string) => void;
}

/** Sync deps whose sync always fails the merge gate, recording gh calls. */
function gateFailingDeps(
  calls: string[][],
  streakPath: string,
  milestoneTitle: string,
  options: DepsOptions = {},
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
      // The milestone's open children — the fallback destination (#1769).
      if (key.includes("issues?milestone=")) {
        return Promise.resolve(JSON.stringify(options.children ?? []));
      }
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
    log: options.log ?? (() => undefined),
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
// The gap #1465 found: no `#NNN`, no escalation at all
// ---------------------------------------------------------------------------

Deno.test("milestone sync #1465 - a milestone with no #NNN title still escalates, onto its oldest open child (#1769)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1465-" });
  try {
    const calls: string[][] = [];
    const result = await syncMilestoneBranches(
      gateFailingDeps(calls, milestoneSyncStreakPath(dir), UNPREFIXED_TITLE, {
        children: [
          { number: 88, title: "A later sub-issue" },
          { number: 41, title: "The oldest sub-issue" },
        ],
      }),
    );
    assert(result.ok);
    assertEquals(result.value.failed, 1, "the sync is reported as failed");

    const comments = commentCalls(calls);
    assertEquals(
      comments.length,
      1,
      `a stuck sync must reach somewhere a human looks; gh calls: ${
        JSON.stringify(calls)
      }`,
    );
    assertEquals(comments[0]![2], "41", "the oldest open child carries it");
    assertStringIncludes(comments[0]!.join(" "), MILESTONE_BRANCH);
    assertEquals(createCalls(calls).length, 0, "no new issue is ever filed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("milestone sync #1465 - the escalation is posted once, not every cycle", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1465-" });
  try {
    const all: string[][] = [];
    const streakPath = milestoneSyncStreakPath(dir);
    for (let cycle = 0; cycle < 4; cycle++) {
      await syncMilestoneBranches(
        gateFailingDeps(all, streakPath, UNPREFIXED_TITLE, {
          children: [{ number: 41, title: "The oldest sub-issue" }],
        }),
      );
    }
    assertEquals(
      commentCalls(all).length,
      1,
      "exactly one escalation across four failing cycles",
    );
    assertEquals(createCalls(all).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("milestone sync #1769 - no parent and no open child is one log line, not an issue", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1769-" });
  try {
    const calls: string[][] = [];
    const logs: string[] = [];
    const streakPath = milestoneSyncStreakPath(dir);
    for (let cycle = 0; cycle < 2; cycle++) {
      await syncMilestoneBranches(
        gateFailingDeps(calls, streakPath, UNPREFIXED_TITLE, {
          children: [],
          log: (m) => logs.push(m),
        }),
      );
    }

    assertEquals(createCalls(calls).length, 0, "nothing is filed");
    assertEquals(commentCalls(calls).length, 0, "there is nowhere to comment");
    assertEquals(
      logs.filter((l) => l.includes("no open children")).length,
      1,
      `said once, not every cycle; logs: ${JSON.stringify(logs)}`,
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
