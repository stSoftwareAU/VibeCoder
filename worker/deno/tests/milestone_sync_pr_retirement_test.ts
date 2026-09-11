/**
 * A milestone sync PR must not outlive the branch it targets (Issue #1967).
 *
 * The sweep raised `Sync main into milestone/<name>` from
 * `sync/milestone-<name>`; fourteen minutes later the milestone's final PR
 * merged, GitHub deleted the milestone branch and **retargeted the still-open
 * sync PR to `main`**, carrying its approval and its auto-merge arming with
 * it. Against `main` that PR's only diff reverted a file to a pre-milestone
 * state, and the one thing that stopped it landing was an unrelated red shard.
 *
 * Three closures answer it, and each is stated here in both directions: the
 * PR that must be retired, and the PR that must be left exactly as it is.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  closeLandedMilestoneSyncPrs,
  closeRetargetedSyncPr,
  isRetargetedSyncPr,
  retireMilestoneSyncPrs,
} from "../lib/milestone_sync_pr_retirement.ts";
import { checkAndHandleMilestoneCompletions } from "../lib/milestone_completion.ts";
import { syncMilestoneBranches } from "../lib/milestone_branch_sync.ts";

const REPO = "owner/repo";
const MILESTONE_BRANCH = "milestone/scan-issues-20260906";
const SYNC_BRANCH = "sync/milestone-scan-issues-20260906";

interface PrRow {
  number: number;
  headRefName: string;
  baseRefName: string;
  files?: { path: string }[];
}

/** A `gh` stub answering the head-branch listing, the file read and the close. */
function ghStub(rows: PrRow[], options: { closeFails?: boolean } = {}): {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args: string[]): Promise<string> => {
      calls.push([...args]);
      const key = args.join(" ");
      if (key.startsWith("pr list")) {
        const head = args[args.indexOf("--head") + 1] ?? "";
        return Promise.resolve(
          JSON.stringify(rows.filter((r) => r.headRefName === head)),
        );
      }
      if (key.startsWith("pr view")) {
        const number = Number(args[2]);
        const row = rows.find((r) => r.number === number);
        return Promise.resolve(JSON.stringify({ files: row?.files ?? [] }));
      }
      if (key.startsWith("pr close") && options.closeFails) {
        return Promise.reject(new Error("422 Unprocessable Entity"));
      }
      return Promise.resolve("");
    },
  };
}

const openSyncPr: PrRow = {
  number: 1957,
  headRefName: SYNC_BRANCH,
  baseRefName: MILESTONE_BRANCH,
  files: [{ path: "docs/audits/lib-sweep-coverage.json" }],
};

// ---------------------------------------------------------------------------
// isRetargetedSyncPr — the shape that must never merge.
// ---------------------------------------------------------------------------

Deno.test("isRetargetedSyncPr - a sync PR GitHub moved onto the default branch is refused (Issue #1967)", () => {
  assert(
    isRetargetedSyncPr(
      { number: 1957, headRefName: SYNC_BRANCH, baseRefName: "main" },
      "main",
    ),
  );
});

Deno.test("isRetargetedSyncPr - a sync PR still targeting its milestone branch is left alone (Issue #1967)", () => {
  assertEquals(
    isRetargetedSyncPr(
      { number: 1957, headRefName: SYNC_BRANCH, baseRefName: MILESTONE_BRANCH },
      "main",
    ),
    false,
  );
});

Deno.test("isRetargetedSyncPr - an ordinary PR into the default branch is not a sync PR (Issue #1967)", () => {
  assertEquals(
    isRetargetedSyncPr(
      { number: 1959, headRefName: "issue-1959-fix", baseRefName: "main" },
      "main",
    ),
    false,
  );
});

Deno.test("isRetargetedSyncPr - an unread base branch is not treated as the default branch (Issue #1967)", () => {
  assertEquals(
    isRetargetedSyncPr({ number: 1957, headRefName: SYNC_BRANCH }, "main"),
    false,
  );
});

// ---------------------------------------------------------------------------
// retireMilestoneSyncPrs — the close that runs before the final PR.
// ---------------------------------------------------------------------------

Deno.test("retireMilestoneSyncPrs - closes the open sync PR and deletes its branch (Issue #1967)", async () => {
  const { gh, calls } = ghStub([openSyncPr]);
  const logs: string[] = [];

  const closed = await retireMilestoneSyncPrs({
    repo: REPO,
    milestoneBranch: MILESTONE_BRANCH,
    ghCommandFn: gh,
    log: (m) => logs.push(m),
    reason: "the final milestone PR for 'scan' is being raised",
  });

  assertEquals(closed, [1957]);
  const comment = calls.find((c) => c[0] === "pr" && c[1] === "comment");
  assert(comment, "the closure must say why on the PR");
  assertStringIncludes(comment.join(" "), "final milestone PR");
  const close = calls.find((c) => c[0] === "pr" && c[1] === "close");
  assert(close, "the sync PR must be closed");
  assertEquals(close[2], "1957");
  assert(
    close.includes("--delete-branch"),
    "the sync branch must go with it, or GitHub can retarget the PR later",
  );
  assert(logs.some((l) => l.includes("1957")));
});

Deno.test("retireMilestoneSyncPrs - no open sync PR means no calls beyond the listing (Issue #1967)", async () => {
  const { gh, calls } = ghStub([]);
  const closed = await retireMilestoneSyncPrs({
    repo: REPO,
    milestoneBranch: MILESTONE_BRANCH,
    ghCommandFn: gh,
    log: () => {},
    reason: "the final milestone PR is being raised",
  });
  assertEquals(closed, []);
  assertEquals(calls.filter((c) => c[1] === "close").length, 0);
});

Deno.test("retireMilestoneSyncPrs - a refused close is reported loudly, never counted (Issue #1967)", async () => {
  const { gh } = ghStub([openSyncPr], { closeFails: true });
  const logs: string[] = [];
  const closed = await retireMilestoneSyncPrs({
    repo: REPO,
    milestoneBranch: MILESTONE_BRANCH,
    ghCommandFn: gh,
    log: (m) => logs.push(m),
    reason: "the final milestone PR is being raised",
  });
  assertEquals(closed, []);
  assert(
    logs.some((l) => l.startsWith("WARNING") && l.includes("1957")),
    `expected a loud failure, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("retireMilestoneSyncPrs - a PR GitHub already retargeted is still retired (Issue #1967)", async () => {
  const { gh, calls } = ghStub([{ ...openSyncPr, baseRefName: "main" }]);
  const closed = await retireMilestoneSyncPrs({
    repo: REPO,
    milestoneBranch: MILESTONE_BRANCH,
    ghCommandFn: gh,
    log: () => {},
    reason: "the milestone is complete",
  });
  assertEquals(closed, [1957]);
  assert(calls.some((c) => c[1] === "close"));
});

// ---------------------------------------------------------------------------
// closeLandedMilestoneSyncPrs — the sync that landed by direct push.
// ---------------------------------------------------------------------------

Deno.test("closeLandedMilestoneSyncPrs - an empty-diff sync PR is closed rather than left armed (Issue #1967)", async () => {
  const { gh, calls } = ghStub([{ ...openSyncPr, files: [] }]);
  const closed = await closeLandedMilestoneSyncPrs({
    repo: REPO,
    milestoneBranch: MILESTONE_BRANCH,
    ghCommandFn: gh,
    log: () => {},
  });
  assertEquals(closed, [1957]);
  const comment = calls.find((c) => c[1] === "comment");
  assert(comment);
  assertStringIncludes(comment.join(" "), "nothing left to merge");
});

Deno.test("closeLandedMilestoneSyncPrs - a sync PR that still carries a diff is left open (Issue #1967)", async () => {
  const { gh, calls } = ghStub([openSyncPr]);
  const closed = await closeLandedMilestoneSyncPrs({
    repo: REPO,
    milestoneBranch: MILESTONE_BRANCH,
    ghCommandFn: gh,
    log: () => {},
  });
  assertEquals(closed, []);
  assertEquals(calls.filter((c) => c[1] === "close").length, 0);
});

Deno.test("closeLandedMilestoneSyncPrs - an unreadable file list closes nothing and says so (Issue #1967)", async () => {
  const logs: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args.join(" ").startsWith("pr list")) {
      return Promise.resolve(JSON.stringify([openSyncPr]));
    }
    if (args.join(" ").startsWith("pr view")) {
      return Promise.reject(new Error("502 Bad Gateway"));
    }
    return Promise.resolve("");
  };
  const closed = await closeLandedMilestoneSyncPrs({
    repo: REPO,
    milestoneBranch: MILESTONE_BRANCH,
    ghCommandFn: gh,
    log: (m) => logs.push(m),
  });
  assertEquals(closed, []);
  assert(
    logs.some((l) => l.startsWith("WARNING") && l.includes("502")),
    `expected the unreadable diff to be loud, got ${JSON.stringify(logs)}`,
  );
});

// ---------------------------------------------------------------------------
// closeRetargetedSyncPr — the maintenance scan's defence in depth.
// ---------------------------------------------------------------------------

Deno.test("closeRetargetedSyncPr - closes the PR and names the default branch it would have landed on (Issue #1967)", async () => {
  const { gh, calls } = ghStub([{ ...openSyncPr, baseRefName: "main" }]);
  const logs: string[] = [];
  const closed = await closeRetargetedSyncPr({
    repo: REPO,
    prNumber: 1957,
    headRefName: SYNC_BRANCH,
    defaultBranch: "main",
    ghCommandFn: gh,
    log: (m) => logs.push(m),
  });
  assert(closed);
  const comment = calls.find((c) => c[1] === "comment");
  assert(comment);
  assertStringIncludes(comment.join(" "), "main");
  assertStringIncludes(comment.join(" "), "never merged");
  assert(calls.some((c) => c[1] === "close"));
});

Deno.test("closeRetargetedSyncPr - a refused close is loud and reports failure (Issue #1967)", async () => {
  const { gh } = ghStub([{ ...openSyncPr, baseRefName: "main" }], {
    closeFails: true,
  });
  const logs: string[] = [];
  const closed = await closeRetargetedSyncPr({
    repo: REPO,
    prNumber: 1957,
    headRefName: SYNC_BRANCH,
    defaultBranch: "main",
    ghCommandFn: gh,
    log: (m) => logs.push(m),
  });
  assertEquals(closed, false);
  assert(logs.some((l) => l.startsWith("WARNING")));
});

// ---------------------------------------------------------------------------
// End to end: milestone completion retires the sync PR before the final PR.
// ---------------------------------------------------------------------------

/**
 * A `gh` stub for one complete milestone ('scan') whose sync PR is still
 * open, recording the order of the calls that matter.
 */
function completionGh(sink: {
  order: string[];
  closedPrs: number[];
  deleteBranch: boolean;
}): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) return Promise.resolve("[]");
    if (/api repos\/[^ ]+\/milestones\/\d+$/.test(key)) {
      return Promise.resolve(JSON.stringify({ open_issues: 0 }));
    }
    if (key.endsWith("/milestones")) {
      return Promise.resolve(JSON.stringify([{ title: "scan", number: 5 }]));
    }
    if (key.includes(".default_branch")) return Promise.resolve("main");
    if (key.includes("/branches/")) return Promise.resolve("milestone/scan");
    if (key.includes("/compare/")) return Promise.resolve("6");
    if (key.includes("issue list") && key.includes("--state closed")) {
      return Promise.resolve(
        JSON.stringify([
          { number: 1959, title: "did work", milestone: { title: "scan" } },
        ]),
      );
    }
    if (key.includes("issue list")) return Promise.resolve("[]");
    if (key.startsWith("pr list") && key.includes("sync/milestone-scan")) {
      return Promise.resolve(
        JSON.stringify([
          {
            number: 1957,
            headRefName: "sync/milestone-scan",
            baseRefName: "milestone/scan",
          },
        ]),
      );
    }
    if (key.startsWith("pr list")) return Promise.resolve("[]");
    if (key.startsWith("pr comment")) return Promise.resolve("");
    if (key.startsWith("pr close")) {
      sink.order.push("sync-pr-closed");
      sink.closedPrs.push(Number(args[2]));
      sink.deleteBranch = args.includes("--delete-branch");
      return Promise.resolve("");
    }
    if (key.startsWith("issue create")) {
      return Promise.resolve("https://github.com/owner/repo/issues/2000");
    }
    if (key.startsWith("pr create")) {
      sink.order.push("final-pr-created");
      return Promise.resolve("https://github.com/owner/repo/pull/1959");
    }
    return Promise.resolve("[]");
  };
}

Deno.test("checkAndHandleMilestoneCompletions - an unmerged final PR from an earlier cycle leaves the sync PR alone (Issue #1967)", async () => {
  const sink = {
    order: [] as string[],
    closedPrs: [] as number[],
    deleteBranch: false,
  };
  const base = completionGh(sink);
  const result = await checkAndHandleMilestoneCompletions({
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      const key = args.join(" ");
      // The summary PR was raised on an earlier cycle and has not merged.
      if (key.startsWith("pr list") && key.includes("milestone/scan")) {
        return Promise.resolve(
          JSON.stringify([{
            number: 1959,
            title: "Milestone: scan",
            headRefName: "milestone/scan",
          }]),
        );
      }
      if (key.startsWith("pr view") && key.includes("state")) {
        return Promise.resolve(JSON.stringify({ state: "OPEN" }));
      }
      return base(args);
    },
    log: () => {},
    authorOptions: { fleetAuthors: ["stservice"] },
  });

  assertEquals(result.ok, true);
  // Closing and re-raising the sync every cycle while the final PR waits on
  // a red check would starve the milestone branch of the default branch.
  assertEquals(sink.closedPrs, []);
});

Deno.test("checkAndHandleMilestoneCompletions - the open sync PR is closed before the final milestone PR is raised (Issue #1967)", async () => {
  const sink = {
    order: [] as string[],
    closedPrs: [] as number[],
    deleteBranch: false,
  };
  const result = await checkAndHandleMilestoneCompletions({
    repos: ["owner/repo"],
    ghCommandFn: completionGh(sink),
    log: () => {},
    authorOptions: { fleetAuthors: ["stservice"] },
  });

  assertEquals(result.ok, true);
  // The sync PR is gone, and it is gone *first*: the window this closes is
  // between the final merge and GitHub deleting the milestone branch.
  assertEquals(sink.closedPrs, [1957]);
  assertEquals(sink.order, ["sync-pr-closed", "final-pr-created"]);
  assert(sink.deleteBranch, "the sync branch must be deleted with the PR");
});

// ---------------------------------------------------------------------------
// End to end: a sync that landed by direct push retires its own PR.
// ---------------------------------------------------------------------------

Deno.test("syncMilestoneBranches - a sync PR left empty by a direct push is closed the same cycle (Issue #1967)", async () => {
  const closed: number[] = [];
  const result = await syncMilestoneBranches({
    repos: [REPO],
    ghCommandFn: (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("/milestones")) {
        return Promise.resolve(
          JSON.stringify([{ title: "scan", number: 7, closed_issues: 3 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("branches/milestone")) {
        return Promise.resolve("milestone/scan");
      }
      if (key.startsWith("pr list")) {
        return Promise.resolve(
          JSON.stringify([
            {
              number: 1957,
              headRefName: "sync/milestone-scan",
              baseRefName: "milestone/scan",
            },
          ]),
        );
      }
      // The direct push already landed the merge, so the PR merges nothing.
      if (key.startsWith("pr view")) {
        return Promise.resolve(JSON.stringify({ files: [] }));
      }
      if (key.startsWith("pr close")) {
        closed.push(Number(args[2]));
        return Promise.resolve("");
      }
      return Promise.resolve("[]");
    },
    syncBranchFn: () =>
      Promise.resolve({ ok: true as const, value: { message: "merged" } }),
    log: () => {},
  });

  assert(result.ok);
  assertEquals(closed, [1957]);
});
