/**
 * A conflict only a human can settle escalates with the analysis, not the
 * compiler output (Issue #1559).
 *
 * #1542's body was a wall of `TS2304` — true, and nearly useless for deciding
 * anything. What the reader needs is what each side exports, what each side
 * tests, and which cases exist on one side only, and that is what the sync
 * posts on the milestone's tracking issue.
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
import { milestoneSyncStreakPath } from "../lib/milestone_sync_streak.ts";

const MILESTONE_BRANCH = "milestone/1559-rivals";
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
    log: () => undefined,
    cooldownSeconds: 0,
    lastSyncTimes: new Map(),
    streakPath: options.streakPath,
  };
}

const commentCalls = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === "issue" && c[1] === "comment");

Deno.test(
  "milestone sync - a case-3 conflict escalates on the first cycle with both sides' exports, cases and the difference (Issue #1559)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1559-escalation-" });
    try {
      const calls: string[][] = [];
      const result = await syncMilestoneBranches(deps(calls, {
        milestoneTitle: "#1559 Rival designs",
        error: escalation(),
        streakPath: milestoneSyncStreakPath(dir),
      }));

      assert(result.ok);
      assertEquals(result.value.failed, 1, "nothing was pushed");

      const comments = commentCalls(calls);
      assertEquals(comments.length, 1, "escalated on the very first cycle");
      assertEquals(comments[0]?.[2], "1559", "on the tracking issue");
      const body = comments[0]?.[comments[0]!.length - 1] ?? "";
      assertStringIncludes(body, "worker/deno/lib/scan_content.ts");
      assertStringIncludes(body, "IndirectSpawnRules");
      assertStringIncludes(body, "scanContentForVariableBinarySpawn");
      assertStringIncludes(body, "rules reject an indirect spawn");
      assertStringIncludes(body, "triaged false positive stays quiet");
      assertStringIncludes(body, "Cases only on");
      assertStringIncludes(body, "aborted");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - the same unresolvable conflict is reported once, a new one again (Issue #1559)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1559-dedup-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const options = {
        milestoneTitle: "#1559 Rival designs",
        error: escalation(),
        streakPath,
      };

      await syncMilestoneBranches(deps(calls, options));
      await syncMilestoneBranches(deps(calls, options));
      assertEquals(
        commentCalls(calls).length,
        1,
        "the same default-branch commit is reported once",
      );

      await syncMilestoneBranches(deps(calls, {
        ...options,
        error: escalation("c".repeat(40)),
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
