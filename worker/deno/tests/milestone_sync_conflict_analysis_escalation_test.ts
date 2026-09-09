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
      assertStringIncludes(body, "Nothing has been pushed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - the same unresolvable conflict is reported once even as the default branch moves; a different conflict is reported again (Issues #1559, #1786)",
  async () => {
    // Issue #1786 changed this contract deliberately. The dedup key used to
    // be the default branch's tip, so "a conflict against a different
    // commit is reported again" meant a fresh comment every time anything
    // merged to main — four copies of one analysis on
    // stSoftwareAU/VibeCoder#1653 in 36 minutes. The key is now the
    // conflict itself, so a moved default tip is the SAME conflict and a
    // different conflicted file set is a new one.
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
        "the same conflict is reported once",
      );

      await syncMilestoneBranches(deps(calls, {
        ...options,
        error: escalation("c".repeat(40)),
      }));
      assertEquals(
        commentCalls(calls).length,
        1,
        "the default branch moving on is not a new conflict (Issue #1786)",
      );

      await syncMilestoneBranches(deps(calls, {
        ...options,
        error: escalation(DEFAULT_SHA, {
          path: "worker/deno/lib/other_file.ts",
        }),
      }));
      assertEquals(
        commentCalls(calls).length,
        2,
        "a conflict over a different file is reported again",
      );

      await syncMilestoneBranches(deps(calls, {
        ...options,
        error: escalation(DEFAULT_SHA, { milestoneSha: "d".repeat(40) }),
      }));
      assertEquals(
        commentCalls(calls).length,
        3,
        "a conflict from a moved milestone branch is reported again",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "milestone sync - without a streak file the analysis is logged, not repeated every cycle (Issue #1559)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1559-nostreak-" });
    try {
      const calls: string[][] = [];
      const built = deps(calls, {
        milestoneTitle: "#1559 Rival designs",
        error: escalation(),
        streakPath: milestoneSyncStreakPath(dir),
      });
      // No streak file: there is nowhere to record that a report went out.
      delete built.streakPath;

      await syncMilestoneBranches(built);
      await syncMilestoneBranches(built);

      assertEquals(
        commentCalls(calls).length,
        0,
        "a report that could not be remembered is not posted every cycle",
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
        error: escalation(),
        streakPath: milestoneSyncStreakPath(first),
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
