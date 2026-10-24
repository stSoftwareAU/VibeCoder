/**
 * Tests for `default_branch_approval.ts` and the merge path it unlocks in
 * `direct_merge.ts` / `pr_auto_merge.ts` (Issue #1082).
 *
 * The live fixture is the pair the issue was filed from: `NEAT-AI-Ockham#116`
 * (green, approved by a human, unprotected default base) and `GRQ-GTC#305`
 * (green, no review, same shape). The first must land unattended; the second
 * must not, and the hold must be logged. The refusal direction is the one a
 * careless fix breaks, so it is asserted alongside.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { directMergePr, type PreMergeGateFn } from "../lib/direct_merge.ts";
import {
  defaultBranchMergeAllowed,
  hasNonFleetApproval,
  type PrReview,
} from "../lib/default_branch_approval.ts";
import {
  renderPreprReviewRequest,
  renderPreprReviewResolved,
} from "../lib/prepr_review_record.ts";
import {
  _resetBaseProtectionMemo,
  AutoMergeResult,
  enableAutoMerge,
} from "../lib/pr_auto_merge.ts";

const REPO = "stSoftwareAU/NEAT-AI-Ockham";
const DEFAULT_BRANCH = "Develop";
const HEAD_SHA = "d00dfeed";
const FLEET = ["VibeCoderST", "stservice"];

/** Gate that always allows — the PRs in these fixtures are green. */
const allowingGate: PreMergeGateFn = () =>
  Promise.resolve({ ok: true, value: { allowed: true, headSha: HEAD_SHA } });

/**
 * `gh` stub for a PR whose base IS the repository default branch. Records
 * every command so a merge can be asserted to have happened (or not).
 */
function ghForDefaultBranchPr(
  calls: string[][],
  opts: { baseRefName?: string } = {},
): (args: string[]) => Promise<string> {
  const base = opts.baseRefName ?? DEFAULT_BRANCH;
  return (args: string[]) => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      return Promise.resolve(base);
    }
    if (joined.includes("/comments")) return Promise.resolve("[]");
    if (joined.startsWith("api repos/")) return Promise.resolve(DEFAULT_BRANCH);
    if (joined.includes("pr merge")) return Promise.resolve("merged");
    throw new Error(`Unexpected gh command: ${joined}`);
  };
}

function merged(calls: string[][]): boolean {
  return calls.some((c) => c.join(" ").includes("pr merge"));
}

// ---------------------------------------------------------------------------
// hasNonFleetApproval — who counts as a reviewer
// ---------------------------------------------------------------------------

Deno.test("an approval from outside the fleet counts as review", () => {
  const reviews: PrReview[] = [{ author: "nleck", state: "APPROVED" }];
  assertEquals(hasNonFleetApproval(reviews, FLEET), true);
});

Deno.test("a sibling fleet account's approval is not review", () => {
  const reviews: PrReview[] = [{ author: "stservice", state: "APPROVED" }];
  assertEquals(hasNonFleetApproval(reviews, FLEET), false);
});

Deno.test("fleet logins are matched case-insensitively", () => {
  const reviews: PrReview[] = [{ author: "VIBECODERST", state: "APPROVED" }];
  assertEquals(hasNonFleetApproval(reviews, FLEET), false);
});

Deno.test("a withdrawn approval no longer counts", () => {
  const reviews: PrReview[] = [
    { author: "nleck", state: "APPROVED" },
    { author: "nleck", state: "CHANGES_REQUESTED" },
  ];
  assertEquals(hasNonFleetApproval(reviews, FLEET), false);
});

Deno.test("the latest verdict is decided by timestamp, not array order", () => {
  // GitHub documents no ordering for `reviews`. If the withdrawal arrives
  // first in the array it must still win — reading the stale approval as
  // current would merge work the reviewer had already blocked.
  const reviews: PrReview[] = [
    {
      author: "nleck",
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-09-05T02:00:00Z",
    },
    { author: "nleck", state: "APPROVED", submittedAt: "2026-09-05T00:37:00Z" },
  ];
  assertEquals(hasNonFleetApproval(reviews, FLEET), false);
});

Deno.test("an approval submitted after a withdrawal counts again", () => {
  const reviews: PrReview[] = [
    { author: "nleck", state: "APPROVED", submittedAt: "2026-09-05T02:00:00Z" },
    {
      author: "nleck",
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-09-05T00:37:00Z",
    },
  ];
  assertEquals(hasNonFleetApproval(reviews, FLEET), true);
});

Deno.test("an undated review never displaces a dated verdict", () => {
  const reviews: PrReview[] = [
    { author: "nleck", state: "APPROVED" },
    {
      author: "nleck",
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-09-05T00:37:00Z",
    },
  ];
  assertEquals(hasNonFleetApproval(reviews, FLEET), false);
});

Deno.test("a later comment does not clear an approval", () => {
  const reviews: PrReview[] = [
    { author: "nleck", state: "APPROVED" },
    { author: "nleck", state: "COMMENTED" },
  ];
  assertEquals(hasNonFleetApproval(reviews, FLEET), true);
});

Deno.test("no reviews at all is not an approval", () => {
  assertEquals(hasNonFleetApproval([], FLEET), false);
});

// ---------------------------------------------------------------------------
// directMergePr — the two live shapes
// ---------------------------------------------------------------------------

Deno.test("approved default-branch PR merges (the Ockham#116 shape)", async () => {
  const calls: string[][] = [];
  const result = await directMergePr(
    REPO,
    116,
    ghForDefaultBranchPr(calls),
    allowingGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () =>
          Promise.resolve([{ author: "nleck", state: "APPROVED" }]),
      },
    },
  );

  assert(result.ok, "expected the merge to be attempted");
  assertEquals(result.value.merged, true);
  assert(merged(calls), "expected a `gh pr merge` call");
});

Deno.test("unreviewed default-branch PR is held, not merged (the GRQ-GTC#305 shape)", async () => {
  const calls: string[][] = [];
  const result = await directMergePr(
    REPO,
    305,
    ghForDefaultBranchPr(calls),
    allowingGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () => Promise.resolve([]),
      },
    },
  );

  assert(result.ok, "a hold is a typed deferral, not an error");
  assertEquals(result.value.merged, false);
  assertEquals(result.value.blocked, "default_branch_unapproved");
  assertEquals(merged(calls), false);
});

Deno.test("default-branch PR is still refused when no policy is supplied", async () => {
  const calls: string[][] = [];
  const result = await directMergePr(
    REPO,
    116,
    ghForDefaultBranchPr(calls),
    allowingGate,
  );

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error.message, "Issue #2416");
  assertEquals(merged(calls), false);
});

Deno.test("an unreadable review list fails closed", async () => {
  const calls: string[][] = [];
  const result = await directMergePr(
    REPO,
    116,
    ghForDefaultBranchPr(calls),
    allowingGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () => Promise.reject(new Error("HTTP 502")),
      },
    },
  );

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error.message, "HTTP 502");
  assertEquals(merged(calls), false);
});

Deno.test("an approved default-branch PR whose CI is red is still refused", async () => {
  const calls: string[][] = [];
  const redGate: PreMergeGateFn = () =>
    Promise.resolve({
      ok: true,
      value: { allowed: false, reason: "checks_failed" },
    });

  const result = await directMergePr(
    REPO,
    116,
    ghForDefaultBranchPr(calls),
    redGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () =>
          Promise.resolve([{ author: "nleck", state: "APPROVED" }]),
      },
    },
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.blocked, "checks_failed");
  assertEquals(merged(calls), false);
});

Deno.test("an approved default-branch PR whose head just moved is still refused", async () => {
  const calls: string[][] = [];
  const recentGate: PreMergeGateFn = () =>
    Promise.resolve({
      ok: true,
      value: { allowed: false, reason: "head_too_recent" },
    });

  const result = await directMergePr(
    REPO,
    116,
    ghForDefaultBranchPr(calls),
    recentGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () =>
          Promise.resolve([{ author: "nleck", state: "APPROVED" }]),
      },
    },
  );

  assert(result.ok);
  assertEquals(result.value.blocked, "head_too_recent");
  assertEquals(merged(calls), false);
});

Deno.test("a non-default base never consults the review policy", async () => {
  const calls: string[][] = [];
  let reviewsRead = 0;
  const result = await directMergePr(
    REPO,
    120,
    ghForDefaultBranchPr(calls, { baseRefName: "milestone/thing" }),
    allowingGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () => {
          reviewsRead++;
          return Promise.resolve([]);
        },
      },
    },
  );

  assert(result.ok);
  assertEquals(result.value.merged, true);
  assertEquals(reviewsRead, 0);
});

// ---------------------------------------------------------------------------
// enableAutoMerge — the sweep's view of the same two shapes
// ---------------------------------------------------------------------------

/** `gh` stub for `enableAutoMerge` on an unprotected default base. */
function ghForSweep(): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const joined = args.join(" ");
    // The milestone gates read the head/base refs and the issue list.
    if (joined.includes("/comments")) return Promise.resolve("[]");
    if (joined.includes("pr view")) return Promise.resolve("{}");
    if (joined.startsWith("api repos/")) return Promise.resolve("");
    throw new Error(`Unexpected gh command: ${joined}`);
  };
}

Deno.test("enableAutoMerge lands an approved PR on an unprotected default base", async () => {
  _resetBaseProtectionMemo();
  let policyFleet: readonly string[] | undefined;

  const outcome = await enableAutoMerge({
    repo: REPO,
    prNumber: 116,
    baseRefName: DEFAULT_BRANCH,
    headRefName: "issue-104-progressive-screening",
    fleetAuthors: FLEET,
    ghCommandFn: ghForSweep(),
    isBaseProtectedFn: () => Promise.resolve(false),
    log: () => {},
    directMergeFn: (_repo, _pr, _gh, _gate, options) => {
      policyFleet = options?.approvedDefaultBranch?.fleetAuthors;
      return Promise.resolve({ ok: true, value: { merged: true } });
    },
  });

  assertEquals(outcome.result, AutoMergeResult.MergedDirectly);
  assertEquals(policyFleet, FLEET);
});

Deno.test("enableAutoMerge defers an unapproved default-branch PR and says why", async () => {
  _resetBaseProtectionMemo();

  const outcome = await enableAutoMerge({
    repo: "stSoftwareAU/GRQ-GTC",
    prNumber: 305,
    baseRefName: DEFAULT_BRANCH,
    fleetAuthors: FLEET,
    ghCommandFn: ghForSweep(),
    isBaseProtectedFn: () => Promise.resolve(false),
    log: () => {},
    directMergeFn: () =>
      Promise.resolve({
        ok: true,
        value: { merged: false, blocked: "default_branch_unapproved" },
      }),
  });

  assertEquals(outcome.result, AutoMergeResult.Deferred);
  assertStringIncludes(outcome.message, "no approving review");
  assertStringIncludes(outcome.message, "#305");
});

Deno.test("enableAutoMerge does not arm when no fleet authors are supplied (Issue #4236)", async () => {
  _resetBaseProtectionMemo();
  let directCalls = 0;

  const outcome = await enableAutoMerge({
    repo: REPO,
    prNumber: 116,
    baseRefName: DEFAULT_BRANCH,
    ghCommandFn: ghForSweep(),
    isBaseProtectedFn: () => Promise.resolve(false),
    log: () => {},
    directMergeFn: () => {
      directCalls++;
      return Promise.resolve({ ok: true, value: { merged: true } });
    },
  });

  assertEquals(outcome.result, AutoMergeResult.Deferred);
  assertStringIncludes(outcome.message, "fleet logins were not supplied");
  assertEquals(directCalls, 0, "a missing fleet set must not reach the merge");
});

Deno.test("a protected base still goes through native auto-merge, never the direct path", async () => {
  _resetBaseProtectionMemo();
  let directCalls = 0;
  const issued: string[][] = [];

  const outcome = await enableAutoMerge({
    repo: REPO,
    prNumber: 116,
    baseRefName: DEFAULT_BRANCH,
    fleetAuthors: FLEET,
    ghCommandFn: (args: string[]) => {
      issued.push(args);
      const joined = args.join(" ");
      if (joined.includes("/comments")) return Promise.resolve("[]");
      if (joined.includes("pr view")) return Promise.resolve("{}");
      if (joined.includes("pr merge")) return Promise.resolve("");
      if (joined.startsWith("api repos/")) return Promise.resolve("");
      throw new Error(`Unexpected gh command: ${joined}`);
    },
    isBaseProtectedFn: () => Promise.resolve(true),
    log: () => {},
    directMergeFn: () => {
      directCalls++;
      return Promise.resolve({ ok: true, value: { merged: true } });
    },
  });

  assertEquals(outcome.result, AutoMergeResult.Enabled);
  assertEquals(directCalls, 0);
  assert(
    issued.some((c) => c.includes("--auto")),
    "expected the native auto-merge call",
  );
});

const REVIEW_FINDING = {
  file: "src/balance.ts",
  line: 42,
  problem: "rounding drops the final cent",
};

Deno.test("an unresolved pre-PR review record holds an approved default-branch PR (Issue #4236)", async () => {
  const calls: string[][] = [];
  const result = await directMergePr(
    REPO,
    116,
    (args) => {
      const joined = args.join(" ");
      if (joined.includes("/comments")) {
        return Promise.resolve(JSON.stringify([{
          author: "VibeCoderST",
          body: renderPreprReviewRequest([REVIEW_FINDING]),
        }]));
      }
      return ghForDefaultBranchPr(calls)(args);
    },
    allowingGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () =>
          Promise.resolve([{ author: "nleck", state: "APPROVED" }]),
      },
    },
  );

  assert(result.ok, "a hold is a typed deferral, not an error");
  assertEquals(result.value.merged, false);
  assertEquals(merged(calls), false);
  assertEquals(
    defaultBranchMergeAllowed(
      [{ author: "nleck", state: "APPROVED" }],
      FLEET,
      [renderPreprReviewRequest([REVIEW_FINDING])],
    ),
    false,
  );
});

Deno.test("a resolved pre-PR review record lets an approved default-branch PR merge (Issue #4236)", async () => {
  const calls: string[][] = [];
  const result = await directMergePr(
    REPO,
    116,
    (args) => {
      const joined = args.join(" ");
      if (joined.includes("/comments")) {
        return Promise.resolve(JSON.stringify([
          {
            author: "VibeCoderST",
            body: renderPreprReviewRequest([REVIEW_FINDING]),
          },
          { author: "VibeCoderST", body: renderPreprReviewResolved() },
        ]));
      }
      return ghForDefaultBranchPr(calls)(args);
    },
    allowingGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () =>
          Promise.resolve([{ author: "nleck", state: "APPROVED" }]),
      },
    },
  );

  assert(result.ok, "expected the merge to be attempted");
  assertEquals(result.value.merged, true);
  assert(merged(calls), "expected a `gh pr merge` call");
  assertEquals(
    defaultBranchMergeAllowed(
      [{ author: "nleck", state: "APPROVED" }],
      FLEET,
      [
        renderPreprReviewRequest([REVIEW_FINDING]),
        renderPreprReviewResolved(),
      ],
    ),
    true,
  );
});

const REQUEST = renderPreprReviewRequest([REVIEW_FINDING]);
const RESOLVED = renderPreprReviewResolved();

function commentsThen(
  calls: string[][],
  pages: string[],
): (args: string[]) => Promise<string> {
  return (args) => {
    if (args.join(" ").includes("/comments")) {
      // Without --paginate only the first page is visible, which is the
      // bug: a resolved marker past page one would never clear the hold.
      if (!args.includes("--paginate")) {
        return Promise.resolve(pages[0] ?? "[]");
      }
      return Promise.resolve(pages.join("\n"));
    }
    return ghForDefaultBranchPr(calls)(args);
  };
}

Deno.test("a resolved marker past the first comment page clears the hold (Issue #4236)", async () => {
  const calls: string[][] = [];
  const page1 = JSON.stringify([{ author: "VibeCoderST", body: REQUEST }]);
  const page2 = JSON.stringify([{ author: "stservice", body: RESOLVED }]);
  const result = await directMergePr(
    REPO,
    116,
    commentsThen(calls, [page1, page2]),
    allowingGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () =>
          Promise.resolve([{ author: "nleck", state: "APPROVED" }]),
      },
    },
  );

  assert(result.ok, "expected the merge to be attempted");
  assertEquals(result.value.merged, true);
  assert(merged(calls), "the resolved marker on page two must clear the hold");
});

Deno.test("a resolved marker from outside the fleet does not clear the hold (Issue #4236)", async () => {
  const calls: string[][] = [];
  const page = JSON.stringify([
    { author: "VibeCoderST", body: REQUEST },
    { author: "mallory", body: RESOLVED },
  ]);
  const result = await directMergePr(
    REPO,
    116,
    commentsThen(calls, [page]),
    allowingGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () =>
          Promise.resolve([{ author: "nleck", state: "APPROVED" }]),
      },
    },
  );

  assert(result.ok, "a hold is a typed deferral, not an error");
  assertEquals(result.value.merged, false);
  assertEquals(merged(calls), false);
});

Deno.test("a changes-requested marker from outside the fleet does not block (Issue #4236)", async () => {
  const calls: string[][] = [];
  const page = JSON.stringify([{ author: "mallory", body: REQUEST }]);
  const result = await directMergePr(
    REPO,
    116,
    commentsThen(calls, [page]),
    allowingGate,
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () =>
          Promise.resolve([{ author: "nleck", state: "APPROVED" }]),
      },
    },
  );

  assert(result.ok, "expected the merge to be attempted");
  assertEquals(result.value.merged, true);
  assert(merged(calls));
});

Deno.test("enableAutoMerge does not arm while a fleet pre-PR review record is unresolved (Issue #4236)", async () => {
  _resetBaseProtectionMemo();
  const issued: string[][] = [];
  const outcome = await enableAutoMerge({
    repo: REPO,
    prNumber: 116,
    baseRefName: DEFAULT_BRANCH,
    headRefName: "issue-104-progressive-screening",
    fleetAuthors: FLEET,
    ghCommandFn: (args: string[]) => {
      issued.push(args);
      const joined = args.join(" ");
      if (joined.includes("/comments")) {
        return Promise.resolve(JSON.stringify([{
          author: "VibeCoderST",
          body: REQUEST,
        }]));
      }
      if (joined.includes("pr view")) return Promise.resolve("{}");
      if (joined.includes("pr merge")) return Promise.resolve("");
      if (joined.startsWith("api repos/")) return Promise.resolve("");
      throw new Error(`Unexpected gh command: ${joined}`);
    },
    isBaseProtectedFn: () => Promise.resolve(true),
    log: () => {},
  });

  assertEquals(outcome.result, AutoMergeResult.Deferred);
  assertEquals(issued.some((call) => call.includes("--auto")), false);
  assertStringIncludes(outcome.message, "unresolved");
  assertEquals(outcome.message.includes("WARNING:"), false);
  assertEquals(outcome.message.includes("ERROR:"), false);
});
