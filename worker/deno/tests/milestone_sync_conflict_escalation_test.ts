/**
 * A conflicting milestone sync escalates on the day it happens (Issue #1558).
 *
 * The merge still lands — the branch has to keep moving — but a resolution
 * that favoured the default branch is a decision nobody made deliberately, so
 * it is reported immediately, naming both sides' commits. A clean merge stays
 * silent: it is pushed without ceremony and without an issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import type { MilestoneSyncConflict } from "../lib/milestone_sync_conflict.ts";
import { milestoneSyncStreakPath } from "../lib/milestone_sync_streak.ts";

const MILESTONE_BRANCH = "milestone/1558-drift";
const MILESTONE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEFAULT_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const CONFLICT: MilestoneSyncConflict = {
  files: ["worker/deno/lib/scan_content.ts"],
  milestoneSha: MILESTONE_SHA,
  defaultSha: DEFAULT_SHA,
  resolution: "theirs",
};

/** Sync deps whose merge conflicted (or did not), recording gh calls. */
function deps(
  calls: string[][],
  options: {
    milestoneTitle: string;
    conflict?: MilestoneSyncConflict;
    streakPath?: string;
    /** The milestone's open children — the #1769 fallback destination. */
    children?: { number: number; title: string }[];
  },
): MilestoneBranchSyncDeps {
  const built: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      calls.push(args);
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(
          JSON.stringify([{ title: options.milestoneTitle, number: 1 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("issue list") && key.includes("--state closed")) {
        return Promise.resolve(
          JSON.stringify([{
            number: 10,
            title: "t",
            milestone: { title: options.milestoneTitle },
          }]),
        );
      }
      if (key.includes("issues?milestone=")) {
        return Promise.resolve(JSON.stringify(options.children ?? []));
      }
      if (key.includes("branches/milestone")) {
        return Promise.resolve(MILESTONE_BRANCH);
      }
      if (key.includes("/commits/")) {
        return Promise.resolve(
          `${
            key.includes(MILESTONE_SHA) ? MILESTONE_SHA : DEFAULT_SHA
          } Issue #1227: the other implementation`,
        );
      }
      return Promise.resolve("");
    },
    syncBranchFn: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          message: "Issue #605: Auto-resolved merge conflicts",
          ...(options.conflict ? { conflict: options.conflict } : {}),
        },
      }),
    log: () => undefined,
    cooldownSeconds: 0,
    lastSyncTimes: new Map(),
  };
  if (options.streakPath) built.streakPath = options.streakPath;
  return built;
}

const commentCalls = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === "issue" && c[1] === "comment");
const createCalls = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === "issue" && c[1] === "create");

Deno.test(
  "milestone sync - a conflicting merge escalates on the first cycle, naming both sides' commits (Issue #1558)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1558-escalation-" });
    try {
      const calls: string[][] = [];
      const result = await syncMilestoneBranches(deps(calls, {
        milestoneTitle: "#1558 Drift",
        conflict: CONFLICT,
        streakPath: milestoneSyncStreakPath(dir),
      }));

      assert(result.ok);
      assertEquals(result.value.synced, 1, "the merge still landed");

      const comments = commentCalls(calls);
      assertEquals(comments.length, 1, "escalated on the very first cycle");
      const args = comments[0]!;
      assertEquals(args[2], "1558", "posted on the milestone's tracking issue");
      const body = args[args.length - 1] ?? "";
      assertStringIncludes(body, "worker/deno/lib/scan_content.ts");
      assertStringIncludes(body, MILESTONE_SHA);
      assertStringIncludes(body, DEFAULT_SHA);
      assertStringIncludes(body, MILESTONE_BRANCH);
      assertStringIncludes(body, "main");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a clean merge raises nothing (Issue #1558)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1558-clean-" });
    try {
      const calls: string[][] = [];
      const result = await syncMilestoneBranches(deps(calls, {
        milestoneTitle: "#1558 Drift",
        streakPath: milestoneSyncStreakPath(dir),
      }));

      assert(result.ok);
      assertEquals(result.value.synced, 1);
      assertEquals(
        commentCalls(calls).length,
        0,
        "no ceremony for a clean merge",
      );
      assertEquals(createCalls(calls).length, 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - the same conflict is reported once, not every cycle (Issue #1558)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1558-dedup-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const options = {
        milestoneTitle: "#1558 Drift",
        conflict: CONFLICT,
        streakPath,
      };

      await syncMilestoneBranches(deps(calls, options));
      await syncMilestoneBranches(deps(calls, options));

      assertEquals(
        commentCalls(calls).length,
        1,
        "the same default-branch commit is reported once",
      );

      // A conflict against a NEW default-branch commit is a new conflict.
      await syncMilestoneBranches(deps(calls, {
        ...options,
        conflict: { ...CONFLICT, defaultSha: "c".repeat(40) },
      }));
      assertEquals(
        commentCalls(calls).length,
        2,
        "a conflict against a different commit is reported again",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a conflict on a milestone with no tracking issue lands on its oldest open child (Issues #1558, #1769)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1558-diagnostic-" });
    try {
      const calls: string[][] = [];
      const result = await syncMilestoneBranches(deps(calls, {
        milestoneTitle: "Drift with no tracking issue",
        conflict: CONFLICT,
        streakPath: milestoneSyncStreakPath(dir),
        children: [
          { number: 77, title: "A later sub-issue" },
          { number: 33, title: "The oldest sub-issue" },
        ],
      }));

      assert(result.ok);
      assertEquals(
        createCalls(calls).length,
        0,
        "no diagnostic issue is filed for a milestone sync any more",
      );
      const comments = commentCalls(calls);
      assertEquals(comments.length, 1, "the conflict is reported once");
      assertEquals(comments[0]![2], "33", "on the oldest open child");
      const body = comments[0]![comments[0]!.indexOf("--body") + 1] ?? "";
      assertStringIncludes(body, DEFAULT_SHA);
      assertStringIncludes(body, "worker/deno/lib/scan_content.ts");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a conflict whose commit could not be read is still reported once (Issue #1558)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1558-unreadable-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const options = {
        milestoneTitle: "#1558 Drift",
        // git could not resolve the default branch's tip.
        conflict: { ...CONFLICT, defaultSha: "" },
        streakPath,
      };

      await syncMilestoneBranches(deps(calls, options));
      await syncMilestoneBranches(deps(calls, options));

      assertEquals(
        commentCalls(calls).length,
        1,
        "an unnamed conflicting commit still dedups rather than reporting every cycle",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - an automatically resolved conflict files no needs-human issue (Issue #1559)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1559-auto-" });
    try {
      const calls: string[][] = [];
      const result = await syncMilestoneBranches(deps(calls, {
        // No tracking issue in the title: the old path filed a needs-human
        // diagnostic here, which is the escalation Issue #1559 removed for a
        // conflict the worker resolved and verified itself.
        milestoneTitle: "Drift with no tracking issue",
        conflict: {
          ...CONFLICT,
          resolution: "auto",
          decisions: [{
            path: "worker/deno/lib/scan_content.ts",
            case: "superset",
            action: "theirs",
            reason: "the default branch's side keeps every line of the other",
          }],
        },
        streakPath: milestoneSyncStreakPath(dir),
      }));

      assert(result.ok);
      assertEquals(result.value.synced, 1, "the resolution landed");
      assertEquals(
        createCalls(calls).length,
        0,
        "a verified automatic resolution does not reach a human",
      );
      assertEquals(commentCalls(calls).length, 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
