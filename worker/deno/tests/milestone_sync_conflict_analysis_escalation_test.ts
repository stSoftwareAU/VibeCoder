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

import { assert, assertEquals } from "@std/assert";
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

/** The `scanContentForVariableBinarySpawn` versus `IndirectSpawnRules` shape. */
function escalation(defaultSha = DEFAULT_SHA): MilestoneConflictEscalation {
  const analyses = [
    analyseConflictedFile(
      {
        path: "worker/deno/lib/scan_content.ts",
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
