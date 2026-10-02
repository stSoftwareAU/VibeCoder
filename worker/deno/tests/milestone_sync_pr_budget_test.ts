/**
 * The milestone sync's side of the shared per-PR conflict-resolution budget
 * (Issue #2998): an open PR against the milestone branch charges its
 * conflict attempts to that PR's own marker tally rather than the local
 * ledger, which stays the fallback when there is no open PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
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
  milestoneSyncStreakPath,
  syncStreakKey,
} from "../lib/milestone_sync_streak.ts";
import {
  conflictAttemptMarker,
  conflictFailedMarker,
  type ConflictResolutionPass,
  readResolutionAttempts,
} from "../lib/merge_conflict_markers.ts";
import { isFleetAuthor } from "../lib/fleet_authors.ts";

const MILESTONE_TITLE = "v1.0";
const REPO = "owner/repo";
const FLEET = "vibe-coder-bot";
const MILESTONE_BRANCH = createMilestoneBranchName(MILESTONE_TITLE);
const DEFAULT_SHA = "b".repeat(40);
const MILESTONE_SHA = "a".repeat(40);
/** The PR's head sha and the sha every marker below is attributed to. */
const HEAD_SHA = "c".repeat(40);
/** The sha a confirmed conflicted landing resolves to. */
const TIP_SHA = "d".repeat(40);

/** Mutable thread/PR state shared between a test's `gh` calls. */
interface GhState {
  prListRaw: string;
  prComments: unknown[];
  /** When set, the milestone branch's commit tip `confirmSyncLanding` reads. */
  tipSha?: string;
}

/** A fake `gh` CLI covering every call `syncMilestoneBranches` makes here. */
function makeGhCommandFn(
  calls: string[][],
  state: GhState,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.join(" ");
    if (key.includes(`repos/${REPO}/milestones`)) {
      return Promise.resolve(
        JSON.stringify([{ title: MILESTONE_TITLE, number: 1 }]),
      );
    }
    if (key.includes("default_branch")) return Promise.resolve("main");
    if (key.includes(`branches/${MILESTONE_BRANCH}`)) {
      return Promise.resolve(MILESTONE_SHA);
    }
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(state.prListRaw);
    }
    if (/issues\/\d+\/comments\?/.test(key)) {
      const page = Number(/[?&]page=(\d+)/.exec(key)?.[1] ?? "1");
      return Promise.resolve(
        page === 1 ? JSON.stringify(state.prComments) : "[]",
      );
    }
    if (args[0] === "pr" && args[1] === "comment") {
      const body = args[args.indexOf("--body") + 1] ?? "";
      state.prComments.push({
        user: { login: FLEET },
        created_at: new Date().toISOString(),
        body,
      });
      return Promise.resolve("");
    }
    if (state.tipSha && key.includes(`commits/${MILESTONE_BRANCH}`)) {
      return Promise.resolve(`${state.tipSha} a commit subject`);
    }
    return Promise.resolve("");
  };
}

/** A conflict every rung left undecided — the ordinary judged failure. */
function conflictFailure(): MilestoneConflictEscalation {
  const analyses = [
    analyseConflictedFile(
      {
        path: "worker/deno/lib/scan_content.ts",
        ours: "export class A {}\n",
        theirs: "export function b() {}\n",
        oursFixes: [1],
        theirsFixes: [2],
      },
      "both sides changed the same code and neither contains the other",
    ),
  ];
  return new MilestoneConflictEscalation(
    "Refusing to resolve the merge",
    analyses,
    [],
    DEFAULT_SHA,
    undefined,
    MILESTONE_SHA,
  );
}

/** One prior concluded attempt comment, fleet-authored. */
function priorAttemptComment(
  n: number,
  pass: ConflictResolutionPass,
  outcome: "failed",
  headSha: string,
  login: string = FLEET,
): unknown {
  return {
    user: { login },
    created_at: new Date(2024, 0, n).toISOString(),
    body: [
      conflictAttemptMarker(n, pass, headSha),
      outcome === "failed" ? conflictFailedMarker(n, pass, headSha) : "",
    ].join("\n"),
  };
}

function baseDeps(
  calls: string[][],
  state: GhState,
  syncBranchFn: MilestoneBranchSyncDeps["syncBranchFn"],
  streakPath?: string,
): MilestoneBranchSyncDeps {
  return {
    repos: [REPO],
    ghCommandFn: makeGhCommandFn(calls, state),
    syncBranchFn,
    defaultTipShaFn: () =>
      Promise.resolve({ ok: true as const, value: DEFAULT_SHA }),
    log: () => undefined,
    dedupAuthors: { fleetAuthors: [FLEET] },
    ...(streakPath ? { streakPath } : {}),
  };
}

/** `pr comment <42>` calls made against the open PR. */
function prCommentCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "pr" && c[1] === "comment");
}

Deno.test(
  'milestone sync - with an open PR on the milestone branch a failed conflict attempt posts a pass="sync" marker on that PR (Issue #2998)',
  async () => {
    const calls: string[][] = [];
    const state: GhState = {
      prListRaw: JSON.stringify([{ number: 42, headRefOid: HEAD_SHA }]),
      prComments: [],
    };
    const result = await syncMilestoneBranches(
      baseDeps(
        calls,
        state,
        () => Promise.resolve({ ok: false, error: conflictFailure() }),
      ),
    );
    assert(result.ok);

    const posted = prCommentCalls(calls);
    assertEquals(posted.length, 1, "exactly one pr comment call");
    assertEquals(posted[0]![2], "42");
    const body = posted[0]![posted[0]!.indexOf("--body") + 1] ?? "";
    assertStringIncludes(body, 'pass="sync"');
    assertStringIncludes(body, conflictAttemptMarker(1, "sync", HEAD_SHA));
    assertStringIncludes(body, conflictFailedMarker(1, "sync", HEAD_SHA));

    const attempts = readResolutionAttempts(
      [{ user: { login: FLEET }, created_at: new Date().toISOString(), body }],
      (login) => isFleetAuthor(login, [FLEET]),
    );
    assertEquals(attempts.length, 1);
    assertEquals(attempts[0]!.outcome, "failed");
    assertEquals(attempts[0]!.pass, "sync");
  },
);

Deno.test(
  "milestone sync - a second failure within 2 hours posts no new marker (Issue #2996)",
  async () => {
    const calls: string[][] = [];
    const state: GhState = {
      prListRaw: JSON.stringify([{ number: 42, headRefOid: HEAD_SHA }]),
      prComments: [],
    };
    let syncs = 0;
    const syncBranchFn = () => {
      syncs++;
      return Promise.resolve({ ok: false as const, error: conflictFailure() });
    };

    const first = await syncMilestoneBranches(
      baseDeps(calls, state, syncBranchFn),
    );
    assert(first.ok);
    assertEquals(prCommentCalls(calls).length, 1);
    assertEquals(syncs, 1);

    const second = await syncMilestoneBranches(
      baseDeps(calls, state, syncBranchFn),
    );
    assert(second.ok);
    assertEquals(
      prCommentCalls(calls).length,
      1,
      "the owner check holds the next attempt",
    );
    assertEquals(syncs, 1, "the conflicting branch is not synced again");
  },
);

Deno.test(
  "milestone sync - two prior failed markers on the PR allow exactly one more sync attempt (Issue #2998)",
  async () => {
    const calls: string[][] = [];
    const state: GhState = {
      prListRaw: JSON.stringify([{ number: 42, headRefOid: HEAD_SHA }]),
      prComments: [
        priorAttemptComment(1, "ladder", "failed", HEAD_SHA),
        priorAttemptComment(2, "ladder", "failed", HEAD_SHA),
      ],
    };
    let called = 0;
    const result1 = await syncMilestoneBranches(
      baseDeps(calls, state, () => {
        called++;
        return Promise.resolve({ ok: false, error: conflictFailure() });
      }),
    );
    assert(result1.ok);
    assertEquals(called, 1, "syncBranchFn is called once");

    const posted = prCommentCalls(calls);
    assertEquals(posted.length, 1);
    const body = posted[0]![posted[0]!.indexOf("--body") + 1] ?? "";
    assertStringIncludes(body, 'pass="sync"');
    assertStringIncludes(body, conflictAttemptMarker(3, "sync", HEAD_SHA));

    // The PR thread now carries three failed attempts in total — the budget
    // is spent, so a second run must not call syncBranchFn at all.
    const calls2: string[][] = [];
    const result2 = await syncMilestoneBranches(
      baseDeps(calls2, state, () => {
        called++;
        return Promise.resolve({ ok: false, error: conflictFailure() });
      }),
    );
    assert(result2.ok);
    assertEquals(called, 1, "syncBranchFn is not called a second time");
    assertEquals(result2.value.skipped, 1);
  },
);

Deno.test(
  'milestone sync - a confirmed conflicted merge records a resolved pass="sync" marker on the open PR (Issue #2998)',
  async () => {
    const calls: string[][] = [];
    const state: GhState = {
      prListRaw: JSON.stringify([{ number: 42, headRefOid: HEAD_SHA }]),
      prComments: [],
      tipSha: TIP_SHA,
    };
    const result = await syncMilestoneBranches(
      baseDeps(calls, state, () =>
        Promise.resolve({
          ok: true,
          value: {
            message: "merged with conflicts",
            conflict: {
              files: ["a.ts"],
              milestoneSha: MILESTONE_SHA,
              defaultSha: DEFAULT_SHA,
              resolution: "auto",
              mergeSha: TIP_SHA,
            },
          },
        })),
    );
    assert(result.ok);

    const posted = prCommentCalls(calls);
    assertEquals(posted.length, 1, "exactly one pr comment call");
    const body = posted[0]![posted[0]!.indexOf("--body") + 1] ?? "";
    assertStringIncludes(body, 'pass="sync"');
    assertStringIncludes(body, `head="${TIP_SHA}"`);
    assertStringIncludes(body, "merge-conflict-resolved");
  },
);

Deno.test(
  "milestone sync - with no open PR the local ledger stays the fallback (Issue #2998)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-2998-fallback-" });
    try {
      const streakPath = milestoneSyncStreakPath(dir);
      const calls: string[][] = [];
      const state: GhState = { prListRaw: "[]", prComments: [] };
      const result = await syncMilestoneBranches(
        baseDeps(
          calls,
          state,
          () => Promise.resolve({ ok: false, error: conflictFailure() }),
          streakPath,
        ),
      );
      assert(result.ok);
      assertEquals(prCommentCalls(calls).length, 0, "no PR to comment on");

      const entry = (await loadSyncStreaks(streakPath))[
        syncStreakKey(REPO, MILESTONE_BRANCH)
      ];
      assertEquals(entry?.conflictAttempts, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  'milestone sync - an unconfirmed landing with an open PR is charged to that PR as a failed pass="sync" attempt (Issue #2998)',
  async () => {
    const calls: string[][] = [];
    /** What `confirmSyncLanding` observes on the milestone tip — deliberately
     * neither the merge sha nor the PR's own head, so no comparison finds it
     * contained. */
    const OBSERVED_SHA = "e".repeat(40);
    const state: GhState = {
      prListRaw: JSON.stringify([{ number: 42, headRefOid: HEAD_SHA }]),
      prComments: [],
      tipSha: OBSERVED_SHA,
    };
    const result = await syncMilestoneBranches(
      baseDeps(calls, state, () =>
        Promise.resolve({
          ok: true,
          value: {
            message: "merged with conflicts",
            conflict: {
              files: ["a.ts"],
              milestoneSha: MILESTONE_SHA,
              defaultSha: DEFAULT_SHA,
              resolution: "auto",
              mergeSha: TIP_SHA,
            },
          },
        })),
    );
    assert(result.ok);
    assertEquals(result.value.failed, 1);

    const issueComments = calls.filter((c) =>
      c[0] === "issue" && c[1] === "comment"
    );
    assertEquals(issueComments.length, 0, "no issue comment calls");

    const posted = prCommentCalls(calls);
    assertEquals(posted.length, 1, "exactly one pr comment call");
    assertEquals(posted[0]![2], "42");
    const body = posted[0]![posted[0]!.indexOf("--body") + 1] ?? "";
    assertStringIncludes(body, conflictAttemptMarker(1, "sync", HEAD_SHA));
    assertStringIncludes(body, conflictFailedMarker(1, "sync", HEAD_SHA));
  },
);

Deno.test(
  "milestone sync - comments from untrusted authors do not spend the PR budget (Issue #2998)",
  async () => {
    const calls: string[][] = [];
    const state: GhState = {
      prListRaw: JSON.stringify([{ number: 42, headRefOid: HEAD_SHA }]),
      prComments: [
        priorAttemptComment(1, "ladder", "failed", HEAD_SHA, "random-user"),
        priorAttemptComment(2, "ladder", "failed", HEAD_SHA, "random-user"),
        priorAttemptComment(3, "ladder", "failed", HEAD_SHA, "random-user"),
      ],
    };
    let called = 0;
    const result = await syncMilestoneBranches(
      baseDeps(calls, state, () => {
        called++;
        return Promise.resolve({ ok: false, error: conflictFailure() });
      }),
    );
    assert(result.ok);
    assertEquals(called, 1, "an untrusted thread cannot spend the PR budget");
  },
);
