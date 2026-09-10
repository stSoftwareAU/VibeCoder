/**
 * A conflict only a human could settle is charged to the branch ledger and
 * reported to nobody while an automatic attempt remains (Issue #1778).
 *
 * Issue #1559 posted that conflict's analysis on the milestone's tracking
 * issue the first time it happened — before any of the three automatic
 * attempts had been spent. That is exactly the "needs-human while a rung
 * remains" the conflict budget removes, so these tests now assert the
 * opposite of what they asserted then: the analysis escalation is gone, the
 * ledger records why the branch is still behind, and the roll-back is what
 * an exhausted budget reaches for.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  analyseConflictedFile,
  MilestoneConflictEscalation,
} from "../lib/milestone_conflict_triage.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import {
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  milestoneSyncStreakPath,
} from "../lib/milestone_sync_streak.ts";

const MILESTONE_TITLE = "#1559 Rival designs";
/** The branch the sync derives from {@link MILESTONE_TITLE}. */
const MILESTONE_BRANCH = createMilestoneBranchName(MILESTONE_TITLE);
const DEFAULT_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** The milestone branch tip the escalations below conflicted from. */
const MILESTONE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The `scanContentForVariableBinarySpawn` versus `IndirectSpawnRules` shape. */
function escalation(
  defaultSha = DEFAULT_SHA,
  options: { path?: string; milestoneSha?: string } = {},
): MilestoneConflictEscalation {
  const analyses = [
    analyseConflictedFile(
      {
        path: options.path ?? "worker/deno/lib/scan_content.ts",
        ours:
          'export class IndirectSpawnRules {}\nDeno.test("rules reject an indirect spawn", () => {});\n',
        theirs:
          'export function scanContentForVariableBinarySpawn() {}\nDeno.test("triaged false positive stays quiet", () => {});\n',
        oursFixes: [1378],
        theirsFixes: [1227],
      },
      "both sides changed the same code and neither contains the other",
    ),
  ];
  return new MilestoneConflictEscalation(
    "Refusing to resolve the merge",
    analyses,
    [],
    defaultSha,
    undefined,
    options.milestoneSha ?? MILESTONE_SHA,
  );
}

/**
 * A resolution the verification then refused. This is the one remaining
 * comment path after Issue #1778: a gate refusal is not a conflict the
 * budget can retry, so it still escalates — and Issue #1786's marker is
 * what stops a second host repeating that comment.
 */
function gateRefusal(
  defaultSha = DEFAULT_SHA,
  options: { path?: string; milestoneSha?: string } = {},
): MilestoneConflictEscalation {
  const base = escalation(defaultSha, options);
  return new MilestoneConflictEscalation(
    base.message,
    base.analyses,
    base.resolved,
    base.defaultSha,
    "quality gate refused the resolved tree",
    base.milestoneSha,
  );
}

function deps(
  calls: string[][],
  options: {
    milestoneTitle: string;
    error: Error;
    streakPath: string;
    /** The default branch's tip this cycle. */
    defaultSha: string;
  },
): MilestoneBranchSyncDeps {
  return {
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
      if (key.includes("branches/milestone")) {
        return Promise.resolve(MILESTONE_BRANCH);
      }
      if (key.includes("/commits/")) {
        return Promise.resolve(`${DEFAULT_SHA} a commit subject`);
      }
      return Promise.resolve("");
    },
    syncBranchFn: () => Promise.resolve({ ok: false, error: options.error }),
    // The tip the cadence gate and the ledger measure against: without it
    // the ledger has no tip to compare and paces on the cooldown alone.
    defaultTipShaFn: () =>
      Promise.resolve({ ok: true as const, value: options.defaultSha }),
    log: () => undefined,
    streakPath: options.streakPath,
  };
}

const commentCalls = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === "issue" && c[1] === "comment");

Deno.test(
  "milestone sync - a case-3 conflict posts nothing and charges one attempt (Issue #1778)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1778-analysis-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const result = await syncMilestoneBranches(deps(calls, {
        milestoneTitle: MILESTONE_TITLE,
        error: escalation(),
        streakPath,
        defaultSha: DEFAULT_SHA,
      }));

      assert(result.ok);
      assertEquals(result.value.failed, 1, "nothing was pushed");
      // The Issue #1559 escalation fired here on the first cycle; it is gone.
      assertEquals(
        commentCalls(calls).length,
        0,
        `posted while attempts remained: ${
          JSON.stringify(commentCalls(calls))
        }`,
      );

      const entry =
        (await loadSyncStreaks(streakPath))[`owner/repo|${MILESTONE_BRANCH}`];
      assertEquals(entry?.conflictAttempts, 1, "the attempt is charged");
      assertEquals(entry?.lastAttempt?.outcome, "failed");
      assertEquals(entry?.lastAttempt?.defaultSha, DEFAULT_SHA);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - the budget, not a comment, is what a repeated conflict spends (Issue #1778)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1778-budget-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const rolledBack: number[] = [];
      const options = {
        milestoneTitle: MILESTONE_TITLE,
        error: escalation(),
        streakPath,
        defaultSha: DEFAULT_SHA,
      };

      // Each cycle sees a different default tip, so the cooldown never
      // stands between the attempts and the budget is what bounds them.
      for (let cycle = 0; cycle < MILESTONE_CONFLICT_ATTEMPT_BUDGET; cycle++) {
        const tip = `${cycle}`.repeat(40);
        const built = deps(calls, {
          ...options,
          error: escalation(tip),
          defaultSha: tip,
        });
        built.rollbackFn = (request) => {
          rolledBack.push(request.attempts);
          return Promise.resolve();
        };
        await syncMilestoneBranches(built);
      }

      assertEquals(
        commentCalls(calls).length,
        0,
        "no comment is posted on the way to an exhausted budget",
      );
      assertEquals(
        rolledBack,
        [MILESTONE_CONFLICT_ATTEMPT_BUDGET],
        "the roll-back is reached exactly once, on the last attempt",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - without a streak file there is no ledger and still no comment (Issue #1778)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1559-nostreak-" });
    try {
      const calls: string[][] = [];
      const built = deps(calls, {
        milestoneTitle: MILESTONE_TITLE,
        error: escalation(),
        streakPath: milestoneSyncStreakPath(dir),
        defaultSha: DEFAULT_SHA,
      });
      // No streak file: there is no ledger to charge, and a conflict still
      // reaches nobody — the loud WARNING line stands on its own.
      delete built.streakPath;

      await syncMilestoneBranches(built);
      await syncMilestoneBranches(built);

      assertEquals(
        commentCalls(calls).length,
        0,
        "a conflict is never reported while an automatic rung remains",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a second host does not repeat an escalation already on the issue (Issue #1786)",
  async () => {
    // Each host keeps its own streak file, so the local record cannot stop
    // the repeat — `VibeCoderST` and `stservice` both posted the same
    // analysis on stSoftwareAU/VibeCoder#1653 ten minutes apart. The marker
    // on the issue is the shared record both hosts read.
    const first = await Deno.makeTempDir({ prefix: "issue-1786-host-a-" });
    const second = await Deno.makeTempDir({ prefix: "issue-1786-host-b-" });
    try {
      const calls: string[][] = [];
      const options = {
        milestoneTitle: "#1559 Rival designs",
        error: gateRefusal(),
        streakPath: milestoneSyncStreakPath(first),
        defaultSha: DEFAULT_SHA,
      };

      await syncMilestoneBranches(deps(calls, options));
      const posted = commentCalls(calls);
      assertEquals(posted.length, 1, "the first host escalates");
      const body = posted[0]?.[posted[0]!.length - 1] ?? "";
      assertStringIncludes(body, "<!-- vibe-milestone-sync-conflict key=");

      // The second host has an empty streak file but reads the same issue.
      const hostB = deps(calls, {
        ...options,
        streakPath: milestoneSyncStreakPath(second),
      });
      const inner = hostB.ghCommandFn;
      hostB.ghCommandFn = (args: string[]): Promise<string> => {
        if (args[0] === "issue" && args[1] === "view") {
          calls.push(args);
          return Promise.resolve(JSON.stringify({ comments: [{ body }] }));
        }
        return inner(args);
      };

      await syncMilestoneBranches(hostB);
      assertEquals(
        commentCalls(calls).length,
        1,
        "the second host sees the marker and posts nothing",
      );
    } finally {
      await Deno.remove(first, { recursive: true });
      await Deno.remove(second, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - a second host does not reopen a closed issue only to post nothing (Issues #1786, #1826)",
  async () => {
    // The escalation destination is resolved before the comment goes out, and
    // resolving a CLOSED parent planning issue reopens it. Asking the marker
    // question first is what stops a human's close being undone with no
    // comment to explain why.
    const first = await Deno.makeTempDir({ prefix: "issue-1826-host-a-" });
    const second = await Deno.makeTempDir({ prefix: "issue-1826-host-b-" });
    try {
      const calls: string[][] = [];
      const options = {
        milestoneTitle: "#1559 Rival designs",
        error: gateRefusal(),
        streakPath: milestoneSyncStreakPath(first),
        defaultSha: DEFAULT_SHA,
      };

      await syncMilestoneBranches(deps(calls, options));
      const posted = commentCalls(calls);
      assertEquals(posted.length, 1, "the first host escalates");
      const body = posted[0]?.[posted[0]!.length - 1] ?? "";

      // A human read it and closed the issue. The second host has its own
      // (empty) streak file, so only the marker can stop it repeating.
      const hostB = deps(calls, {
        ...options,
        streakPath: milestoneSyncStreakPath(second),
      });
      const inner = hostB.ghCommandFn;
      hostB.ghCommandFn = (args: string[]): Promise<string> => {
        if (args[0] === "issue" && args[1] === "view") {
          calls.push(args);
          return Promise.resolve(
            args.includes("state")
              ? "CLOSED"
              : JSON.stringify({ comments: [{ body }] }),
          );
        }
        return inner(args);
      };

      await syncMilestoneBranches(hostB);

      assertEquals(
        commentCalls(calls).length,
        1,
        "the second host posts nothing",
      );
      assertEquals(
        calls.filter((c) => c[0] === "issue" && c[1] === "reopen"),
        [],
        "and it does not reopen the issue the human closed",
      );
      assertEquals(
        calls.filter((c) => c.includes("--add-label")),
        [],
        "nor label it needs-human again",
      );
    } finally {
      await Deno.remove(first, { recursive: true });
      await Deno.remove(second, { recursive: true });
    }
  },
);
