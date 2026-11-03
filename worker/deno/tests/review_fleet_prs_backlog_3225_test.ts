/**
 * The review-fleet-prs gate on a backlog (Issue #3225).
 *
 * Several hosts review the same PRs (a laptop as the gh user, GRQ-25 as the
 * reviewer App), every fleet PR is armed with auto-merge on three conditions
 * (CI green, approved, branch up to date), and a round is capped at five.
 * The gate therefore has to (1) skip a PR anyone has already approved at its
 * head and count another host's marker-carrying review as its own,
 * (2) apply the cap itself after every other skip, so a non-green PR never
 * takes a slot, and (3) bring an approved fleet PR's branch up to date once
 * per head, review first, update second.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  approvedAtHead,
  pass,
  type Review,
  REVIEW_MARKER,
  type SearchPr,
  skipReason,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";
import {
  needsBranchUpdate,
  updateBranch,
  updateBranchOnce,
} from "../../../.claude/skills/review-fleet-prs/scripts/branch_update.ts";

const REVIEWER = "nleck";
const APP = "stsoftware-pr-reviewer";
const FLEET = new Set(["VibeCoderST", REVIEWER]);
const REPOS = new Set(["acme/app"]);

const review = (
  login: string,
  state: string,
  oid: string,
  body = "",
): Review => ({ author: { login }, state, body, commit: { oid } });

const green = {
  nodes: [{
    commit: {
      statusCheckRollup: { state: "SUCCESS" },
      checkSuites: { nodes: [] },
    },
  }],
};
const red = {
  nodes: [{
    commit: {
      statusCheckRollup: { state: "FAILURE" },
      checkSuites: { nodes: [] },
    },
  }],
};

function fleetPr(
  number: number,
  overrides: Partial<SearchPr> = {},
): SearchPr {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: { enabledAt: "2026-10-05T00:00:00Z" },
    headRefOid: `head-${number}`,
    baseRefName: "main",
    repository: {
      nameWithOwner: "acme/app",
      defaultBranchRef: { name: "main" },
      autoMergeAllowed: true,
      squashMergeAllowed: true,
      mergeCommitAllowed: true,
    },
    author: { login: "VibeCoderST" },
    commits: green,
    reviews: { nodes: [] },
    ...overrides,
  };
}

// --- (1) approved or reviewed elsewhere -----------------------------------

Deno.test("approvedAtHead: any login's approval at the head commit counts, not an older one or a change request (Issue #3225)", () => {
  assertEquals(
    approvedAtHead([review("owner", "APPROVED", "head")], "head"),
    true,
  );
  assertEquals(approvedAtHead([review(APP, "APPROVED", "head")], "head"), true);
  assertEquals(
    approvedAtHead([review("owner", "APPROVED", "old")], "head"),
    false,
  );
  assertEquals(
    approvedAtHead([review("owner", "CHANGES_REQUESTED", "head")], "head"),
    false,
  );
  assertEquals(approvedAtHead([], "head"), false);
});

Deno.test("skipReason: a PR the owner approved at its head is `approved`; the App's marker review counts as already-reviewed on every host (Issue #3225)", async () => {
  // The owner approved by hand: nothing left for the skill to do.
  assertEquals(
    await skipReason(
      fleetPr(1, {
        reviews: { nodes: [review("owner", "APPROVED", "head-1")] },
      }),
      REVIEWER,
    ),
    "approved",
  );
  // GRQ-25's App approved at the head (its body carries the marker).
  assertEquals(
    await skipReason(
      fleetPr(2, {
        reviews: {
          nodes: [review(APP, "APPROVED", "head-2", `ok\n\n${REVIEW_MARKER}`)],
        },
      }),
      REVIEWER,
    ),
    "already-reviewed",
  );
  // GRQ-AutoTrader#2546 on 2026-10-05: the App sent it back at the head.
  assertEquals(
    await skipReason(
      fleetPr(3, {
        reviews: {
          nodes: [
            review(
              APP,
              "CHANGES_REQUESTED",
              "head-3",
              `no\n\n${REVIEW_MARKER}`,
            ),
          ],
        },
      }),
      REVIEWER,
    ),
    "already-reviewed",
  );
  // GRQ-AutoTrader#2539: sent back by the App at an earlier head, and only
  // base merges since.
  assertEquals(
    await skipReason(
      fleetPr(4, {
        reviews: {
          nodes: [
            review(APP, "CHANGES_REQUESTED", "old", `no\n\n${REVIEW_MARKER}`),
          ],
        },
      }),
      REVIEWER,
      (since) => Promise.resolve(since === "old"),
    ),
    "awaiting-fix",
  );
  // An approval at an older head is stale: the new head still needs a review.
  assertEquals(
    await skipReason(
      fleetPr(5, { reviews: { nodes: [review("owner", "APPROVED", "old")] } }),
      REVIEWER,
    ),
    null,
  );
  // A stranger's change request without the marker is not this skill's
  // review; the fleet only acts on `pr_reviewers`, so the PR is still ready.
  assertEquals(
    await skipReason(
      fleetPr(6, {
        reviews: { nodes: [review("passerby", "CHANGES_REQUESTED", "head-6")] },
      }),
      REVIEWER,
    ),
    null,
  );
});

// --- (2) the cap belongs to the gate ---------------------------------------

function makeGh(prs: SearchPr[]) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: prs,
          },
        },
      }));
    }
    if (args[0] === "api" && args[1]?.endsWith("/files")) {
      return Promise.resolve("[]");
    }
    if (args[0] === "api" && args[1]?.endsWith("/update-branch")) {
      return Promise.resolve("{}");
    }
    // No PR comments: gh prints an empty JSON list (Issue #4398).
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return Promise.resolve("[]");
    }
    return Promise.resolve("");
  };
  return { gh, calls };
}

const fileCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === "api" && c[1]?.endsWith("/files")).length;

Deno.test("pass: at most `limit` PRs are ready, counted after every other skip, so a red or approved PR never takes a slot (Issue #3225)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const prs = [
      fleetPr(10, { commits: red }), // the fleet's to fix
      fleetPr(11, {
        reviews: { nodes: [review("owner", "APPROVED", "head-11")] },
      }),
      ...[12, 13, 14, 15, 16, 17, 18].map((n) => fleetPr(n)),
    ];
    const { gh, calls } = makeGh(prs);
    const result = await pass(REPOS, FLEET, REVIEWER, { gh, dir });
    assertEquals(result.ready.map((p) => p.number), [12, 13, 14, 15, 16]);
    assertEquals(result.skipped, {
      "ci-failed": 1,
      approved: 1,
      "over-limit": 2,
    });
    // Over-limit PRs cost nothing: no file list is read for them.
    assertEquals(fileCalls(calls), 5);
    // Oldest-updated first, so a PR whose head keeps moving cannot starve
    // the quiet ones behind it.
    const search = calls.find((c) => c[1] === "graphql")!;
    assertStringIncludes(search.join(" "), "sort:updated-asc");

    const { gh: gh2 } = makeGh(prs);
    const wide = await pass(REPOS, FLEET, REVIEWER, {
      gh: gh2,
      dir,
      limit: 10,
    });
    assertEquals(wide.ready.length, 7);
    assertEquals(wide.skipped["over-limit"], undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pass: a PR already in a round on this host is skipped as in-flight and never takes a slot (Issue #4395)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const prs = [12, 13, 14].map((n) => fleetPr(n));
    const { gh, calls } = makeGh(prs);
    const result = await pass(REPOS, FLEET, REVIEWER, {
      gh,
      dir,
      limit: 1,
      inFlight: new Set(["acme/app#12"]),
    });
    assertEquals(result.ready.map((p) => p.number), [13]);
    assertEquals(result.skipped, { "in-flight": 1, "over-limit": 1 });
    // No file list is read for the PR already being reviewed.
    assertEquals(fileCalls(calls), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- (3) approved first, then up to date -----------------------------------

Deno.test("needsBranchUpdate: only an approved, behind, non-draft fleet PR not already asked at this head (Issue #3225)", () => {
  const behind = fleetPr(20, {
    mergeStateStatus: "BEHIND",
    reviews: { nodes: [review("owner", "APPROVED", "head-20")] },
  });
  assertEquals(needsBranchUpdate(behind, "fleet", undefined), true);
  assertEquals(needsBranchUpdate(behind, "fleet", "head-20"), false);
  assertEquals(needsBranchUpdate(behind, "fleet", "head-19"), true);
  assertEquals(needsBranchUpdate(behind, "dependabot", undefined), false);
  assertEquals(
    needsBranchUpdate(
      { ...behind, mergeStateStatus: "CLEAN" },
      "fleet",
      undefined,
    ),
    false,
  );
  assertEquals(
    needsBranchUpdate(
      { ...behind, mergeStateStatus: "BLOCKED" },
      "fleet",
      undefined,
    ),
    false,
  );
  assertEquals(
    needsBranchUpdate({ ...behind, isDraft: true }, "fleet", undefined),
    false,
  );
  assertEquals(
    needsBranchUpdate(
      { ...behind, mergeable: "CONFLICTING" },
      "fleet",
      undefined,
    ),
    false,
  );
  assertEquals(
    needsBranchUpdate(
      { ...behind, reviews: { nodes: [review("owner", "APPROVED", "old")] } },
      "fleet",
      undefined,
    ),
    false,
  );
});

Deno.test("updateBranch refuses an unreadable ready state before requesting an update (Issue #4613)", async () => {
  const calls: string[][] = [];
  const result = await updateBranch(
    {
      repo: "acme/app",
      number: 20,
      headSha: "a".repeat(40),
      baseRefName: "main",
    },
    (args) => {
      calls.push(args);
      return Promise.resolve("{}");
    },
  );
  assertEquals(result.updated, false);
  assertEquals(
    calls.some((args) => args.some((arg) => arg.endsWith("/update-branch"))),
    false,
  );
});

Deno.test("updateBranchOnce refuses an unreadable ready state before the update request", async () => {
  const dir = await Deno.makeTempDir({ prefix: "review-4613-" });
  const calls: string[][] = [];
  try {
    const result = await updateBranchOnce(
      {
        repo: "acme/app",
        number: 20,
        headSha: "a".repeat(40),
        baseRefName: "main",
      },
      dir,
      async (args) => {
        calls.push(args);
        if (args[0] === "pr" && args[1] === "view") {
          return JSON.stringify({ state: "OPEN" });
        }
        return "{}";
      },
    );
    assertEquals(result, undefined);
    assertEquals(
      calls.some((args) => args.some((arg) => arg.endsWith("/update-branch"))),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pass: approved behind PRs reach the shared readiness policy, while an unreviewed PR is not refreshed (Issue #4613)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const approvedBehind = fleetPr(30, {
      mergeStateStatus: "BEHIND",
      reviews: {
        nodes: [review(APP, "APPROVED", "head-30", `ok\n\n${REVIEW_MARKER}`)],
      },
    });
    const ownApprovedBehind = fleetPr(31, {
      mergeStateStatus: "BEHIND",
      reviews: { nodes: [review(REVIEWER, "APPROVED", "head-31")] },
    });
    const approvedClean = fleetPr(32, {
      reviews: { nodes: [review("owner", "APPROVED", "head-32")] },
    });
    const unreviewedBehind = fleetPr(33, { mergeStateStatus: "BEHIND" });
    const dependabot = fleetPr(34, {
      mergeStateStatus: "BEHIND",
      author: { login: "dependabot" },
      reviews: { nodes: [review(REVIEWER, "APPROVED", "head-34")] },
    });
    const prs = [
      approvedBehind,
      ownApprovedBehind,
      approvedClean,
      unreviewedBehind,
      dependabot,
    ];
    const f = strictRefreshFixture("acme/app");
    const heads = new Map(
      prs.map((pr) => [pr.number, pr.number.toString(16).padStart(40, "0")]),
    );
    for (const pr of prs) {
      pr.headRefOid = heads.get(pr.number)!;
      for (const review of pr.reviews.nodes) review.commit!.oid = pr.headRefOid;
    }
    const search = makeGh(prs);
    let currentHead = f.head;
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      if (
        args[1] === "graphql" || args[1] === "--header" ||
        args[1]?.endsWith("/files") || args[1]?.endsWith("/comments") ||
        args[1]?.includes("/contents/")
      ) return await search.gh(args);
      const number = args[0] === "pr" && args[1] === "view"
        ? Number(args[2])
        : Number(args[1]?.match(/\/pulls\/(\d+)$/)?.[1]);
      if (heads.has(number)) currentHead = heads.get(number)!;
      const translated = args.map((arg) => arg.replaceAll(currentHead, f.head));
      return (await f.gh(translated)).replaceAll(f.head, currentHead);
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    let result;
    try {
      result = await pass(REPOS, FLEET, REVIEWER, { gh, dir });
    } finally {
      console.warn = originalWarn;
    }
    for (const number of [31, 34]) {
      assertEquals(
        warnings.some((line) =>
          line.includes(`acme/app#${number}`) &&
          line.includes("base refresh owned by acme/app#30")
        ),
        true,
      );
    }
    const updates = calls.filter((c) => c[3]?.endsWith("/update-branch"));
    assertEquals(updates.length, 1);
    assertEquals(updates[0]?.[3], "repos/acme/app/pulls/30/update-branch");
    assertEquals(result.upkeep, ["acme/app#30 branch update requested"]);
    for (const number of [31, 34]) {
      assertEquals(
        calls.some((c) =>
          c[0] === "pr" && c[1] === "view" && c[2] === String(number)
        ),
        true,
      );
    }
    assertEquals(
      calls.some((c) => c[0] === "pr" && c[1] === "view" && c[2] === "33"),
      false,
    );
    assertEquals(result.ready.map((p) => p.number), [33]);
    assertEquals(
      calls.some((c) => c[0] === "pr" && c[1] === "comment" && c[2] === "34"),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pass: unreadable refresh policy is logged as a retryable skip (Issue #4613)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const pr = fleetPr(40, {
      mergeStateStatus: "BEHIND",
      reviews: { nodes: [review(REVIEWER, "APPROVED", "head-40")] },
    });
    const unreadable = () => {
      const calls: string[][] = [];
      const inner = makeGh([pr]).gh;
      const gh = (args: string[]) => {
        calls.push(args);
        return inner(args);
      };
      return { gh, calls };
    };
    const first = unreadable();
    const result = await pass(REPOS, FLEET, REVIEWER, { gh: first.gh, dir });
    assertEquals(result.upkeep, []);
    assertEquals(result.ready, []);
    assertEquals(
      first.calls.some((c) => c[3]?.endsWith("/update-branch")),
      false,
    );
    const second = unreadable();
    const again = await pass(REPOS, FLEET, REVIEWER, { gh: second.gh, dir });
    assertEquals(
      second.calls.some((c) => c[3]?.endsWith("/update-branch")),
      false,
    );
    assertEquals(again.upkeep, []);
    assertEquals(
      second.calls.some((c) => c[0] === "pr" && c[1] === "view"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- post.ts: the approval comes first, the update follows it --------------

Deno.test("shouldUpdateBranch: only an approval of a PR that is behind its base (Issue #3225)", async () => {
  const { shouldUpdateBranch, postedResult } = await import(
    "../../../.claude/skills/review-fleet-prs/scripts/post.ts"
  );
  assertEquals(shouldUpdateBranch("approved", "BEHIND"), true);
  assertEquals(shouldUpdateBranch("approved", "BEHIND", true), false);
  assertEquals(shouldUpdateBranch("approved", "CLEAN"), false);
  assertEquals(shouldUpdateBranch("approved", undefined), false);
  assertEquals(
    shouldUpdateBranch("approved", "BEHIND", false, "CONFLICTING"),
    false,
  );
  assertEquals(
    shouldUpdateBranch("changes_requested", "BEHIND"),
    false,
  );
  assertEquals(shouldUpdateBranch("held", "BEHIND"), false);
  assertEquals(
    postedResult("approved", [], undefined, { updated: true }),
    { posted: true, outcome: "approved", filedIssues: [], branchUpdated: true },
  );
  assertEquals(
    postedResult("approved", [], undefined, {
      updated: false,
      error: "HTTP 422",
    }),
    {
      posted: true,
      outcome: "approved",
      filedIssues: [],
      branchUpdateError: "HTTP 422",
    },
  );
  assertEquals(postedResult("approved", []), {
    posted: true,
    outcome: "approved",
    filedIssues: [],
  });
});

import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";
import {
  FAILED_FILE,
  readMemory,
} from "../../../.claude/skills/review-fleet-prs/scripts/upkeep_memory.ts";

for (const refusal of ["", "gh api: HTTP 422: expected head sha\nmore"]) {
  Deno.test(`updateBranch reaches GitHub with strict readiness: ${refusal || "success"}`, async () => {
    const f = strictRefreshFixture("acme/app");
    f.state.refusal = refusal;
    const result = await updateBranch(
      { repo: "acme/app", number: 20, headSha: f.head, baseRefName: "main" },
      f.gh,
      { fleetAuthors: [...FLEET] },
    );
    assertEquals(
      result,
      refusal
        ? {
          updated: false,
          error: `Failed to update branch for PR #20 in acme/app: ${
            refusal.split("\n")[0]
          }`,
        }
        : { updated: true },
    );
    assertEquals(f.calls.filter((args) => args.includes("PUT")), [[
      "api",
      "--method",
      "PUT",
      "repos/acme/app/pulls/20/update-branch",
      "-f",
      `expected_head_sha=${f.head}`,
    ]]);
  });
}

for (const refusal of ["", "gh api: HTTP 403: locked\nstack"]) {
  Deno.test(`pass retains successful refresh and actual API refusal bookkeeping: ${refusal || "success"}`, async () => {
    const dir = await Deno.makeTempDir();
    try {
      const f = strictRefreshFixture("acme/app");
      f.state.refusal = refusal;
      const pr = fleetPr(40, {
        headRefOid: f.head,
        mergeStateStatus: "BEHIND",
        reviews: { nodes: [review(REVIEWER, "APPROVED", f.head)] },
      });
      const search = makeGh([pr]);
      const gh = (args: string[]) =>
        args[1] === "graphql" || args[1]?.endsWith("/files") ||
          args[1]?.endsWith("/comments")
          ? search.gh(args)
          : f.gh(args);
      const first = await pass(REPOS, FLEET, REVIEWER, { gh, dir });
      assertEquals(first.upkeep, [
        refusal
          ? "acme/app#40 branch update failed: Failed to update branch for PR #40 in acme/app: gh api: HTTP 403: locked"
          : "acme/app#40 branch update requested",
      ]);
      assertEquals(first.ready, []);
      const before = f.calls.length;
      const second = await pass(REPOS, FLEET, REVIEWER, { gh, dir });
      assertEquals(second.upkeep, []);
      assertEquals(
        f.calls.slice(before).some((args) => args.includes("PUT")),
        false,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("moving test merge leaves the reviewed head retryable", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const f = strictRefreshFixture("acme/app");
    f.state.changeAtMerge = 2;
    const pr = {
      repo: "acme/app",
      number: 20,
      headSha: f.head,
      baseRefName: "main",
    };
    const result = await updateBranchOnce(pr, dir, f.gh, {
      fleetAuthors: [...FLEET],
    });
    assertEquals(result, undefined);
    assertEquals(await readMemory(dir, FAILED_FILE), {});
    assertEquals(f.calls.some((args) => args.includes("PUT")), false);
    f.state.changeAtMerge = 0;
    assertEquals(
      await updateBranchOnce(pr, dir, f.gh, { fleetAuthors: [...FLEET] }),
      { updated: true },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
