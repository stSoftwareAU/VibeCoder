/**
 * Tests for the merge-queue refusal in `directMergePr` (Issue #4424). A PR
 * whose default-branch base requires a merge queue is deferred with
 * `blocked: "merge_queue"` — no gate and no `gh pr merge`. An unqueued base,
 * or a lookup that cannot be read, merges exactly as before.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { directMergePr, type PreMergeGateFn } from "../lib/direct_merge.ts";
import { _resetMergeQueueMemo } from "../lib/merge_queue_runtime.ts";
import { blockedReason } from "../commands/merge_if_checks_passed.ts";

const REPO = "stSoftwareAU/NEAT-AI-Ockham";
const DEFAULT_BRANCH = "Develop";
const HEAD_SHA = "d00dfeed";
const FLEET = ["VibeCoderST", "stservice"];

/** Approving review from outside the fleet — the Ockham#116 shape. */
const outsideApproval = {
  fetchReviewsFn: () =>
    Promise.resolve([{ author: "nleck", state: "APPROVED" as const }]),
};

/** Counts gate calls; the PRs here are green, so the gate would allow them. */
function countingGate(counter: { calls: number }): PreMergeGateFn {
  return () => {
    counter.calls++;
    return Promise.resolve({
      ok: true,
      value: { allowed: true, headSha: HEAD_SHA },
    });
  };
}

/**
 * `gh` stub for an approved PR whose base IS the default branch. `rules` is
 * the rule-type list the branch-rules endpoint returns, or `"throws"`.
 * Every command is recorded, so a merge (or its absence) can be asserted.
 */
function ghDefaultBranchPr(
  calls: string[][],
  opts: {
    rules: string | "throws";
    /** Fail the second `pr view … baseRefName` (the queue check's read). */
    failSecondBaseRead?: boolean;
  },
): (args: string[]) => Promise<string> {
  let baseReads = 0;
  return (args: string[]) => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      baseReads++;
      if (opts.failSecondBaseRead && baseReads > 1) {
        return Promise.reject(new Error("HTTP 502"));
      }
      return Promise.resolve(DEFAULT_BRANCH);
    }
    if (joined.includes("/rules/branches/")) {
      return opts.rules === "throws"
        ? Promise.reject(new Error("HTTP 403"))
        : Promise.resolve(opts.rules);
    }
    if (joined.includes("/comments")) return Promise.resolve("[]");
    if (joined.startsWith("api repos/")) {
      return Promise.resolve(DEFAULT_BRANCH);
    }
    if (joined.includes("pr merge")) return Promise.resolve("merged");
    throw new Error(`Unexpected gh command: ${joined}`);
  };
}

function merged(calls: string[][]): boolean {
  return calls.some((c) => c.join(" ").includes("pr merge"));
}

// ---------------------------------------------------------------------------
// A queued default branch is never direct-merged
// ---------------------------------------------------------------------------

Deno.test("queued default branch - an approved, green PR is deferred as merge_queue with no gate and no merge", async () => {
  _resetMergeQueueMemo();
  const calls: string[][] = [];
  const gate = { calls: 0 };
  const result = await directMergePr(
    REPO,
    116,
    ghDefaultBranchPr(calls, { rules: "pull_request,merge_queue" }),
    countingGate(gate),
    { approvedDefaultBranch: { fleetAuthors: FLEET, ...outsideApproval } },
  );

  assertEquals(result, {
    ok: true,
    value: { merged: false, blocked: "merge_queue" },
  });
  assertEquals(gate.calls, 0, "the pre-merge gate must not run");
  assertEquals(merged(calls), false, "no `gh pr merge` may be issued");
});

Deno.test("queued default branch - the queue question is asked for the default branch's rules", async () => {
  _resetMergeQueueMemo();
  const calls: string[][] = [];
  await directMergePr(
    REPO,
    116,
    ghDefaultBranchPr(calls, { rules: "merge_queue" }),
    countingGate({ calls: 0 }),
    { approvedDefaultBranch: { fleetAuthors: FLEET, ...outsideApproval } },
  );
  const ruleRead = calls.map((c) => c.join(" ")).find((j) =>
    j.includes("/rules/branches/")
  );
  assert(ruleRead !== undefined, "expected a branch-rules read");
  assertStringIncludes(ruleRead, `repos/${REPO}/rules/branches/Develop`);
});

Deno.test("queued default branch - an unapproved PR is still held as default_branch_unapproved, not merge_queue", async () => {
  _resetMergeQueueMemo();
  const calls: string[][] = [];
  const gate = { calls: 0 };
  const result = await directMergePr(
    REPO,
    305,
    ghDefaultBranchPr(calls, { rules: "merge_queue" }),
    countingGate(gate),
    {
      approvedDefaultBranch: {
        fleetAuthors: FLEET,
        fetchReviewsFn: () => Promise.resolve([]),
      },
    },
  );
  assertEquals(result, {
    ok: true,
    value: { merged: false, blocked: "default_branch_unapproved" },
  });
  assertEquals(gate.calls, 0);
  assertEquals(merged(calls), false);
});

Deno.test("queued default branch - an injected queue check is honoured", async () => {
  _resetMergeQueueMemo();
  const calls: string[][] = [];
  const gate = { calls: 0 };
  const result = await directMergePr(
    REPO,
    116,
    ghDefaultBranchPr(calls, { rules: "" }),
    countingGate(gate),
    {
      approvedDefaultBranch: { fleetAuthors: FLEET, ...outsideApproval },
      isBaseMergeQueuedFn: () => Promise.resolve(true),
    },
  );
  assertEquals(result, {
    ok: true,
    value: { merged: false, blocked: "merge_queue" },
  });
  assertEquals(gate.calls, 0);
  assertEquals(merged(calls), false);
});

Deno.test("queued default branch - a base read that fails closed is refused, with no merge", async () => {
  _resetMergeQueueMemo();
  const calls: string[][] = [];
  const gate = { calls: 0 };
  const result = await directMergePr(
    REPO,
    116,
    ghDefaultBranchPr(calls, {
      rules: "merge_queue",
      failSecondBaseRead: true,
    }),
    countingGate(gate),
    { approvedDefaultBranch: { fleetAuthors: FLEET, ...outsideApproval } },
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "Issue #4424");
  }
  assertEquals(gate.calls, 0);
  assertEquals(merged(calls), false);
});

// ---------------------------------------------------------------------------
// Unqueued and unreadable lookups merge exactly as before
// ---------------------------------------------------------------------------

Deno.test("unqueued default branch - the same approved, green PR merges as before", async () => {
  _resetMergeQueueMemo();
  const calls: string[][] = [];
  const gate = { calls: 0 };
  const result = await directMergePr(
    REPO,
    116,
    ghDefaultBranchPr(calls, {
      rules: "pull_request,required_status_checks",
    }),
    countingGate(gate),
    { approvedDefaultBranch: { fleetAuthors: FLEET, ...outsideApproval } },
  );
  assert(result.ok, "expected the merge to be attempted");
  assertEquals(result.value.merged, true);
  assertEquals(gate.calls, 1);
  assert(merged(calls), "expected a `gh pr merge` call");
});

Deno.test("unreadable queue lookup - the approved, green PR still merges (null is not queued)", async () => {
  _resetMergeQueueMemo();
  const calls: string[][] = [];
  const gate = { calls: 0 };
  const result = await directMergePr(
    REPO,
    116,
    ghDefaultBranchPr(calls, { rules: "throws" }),
    countingGate(gate),
    { approvedDefaultBranch: { fleetAuthors: FLEET, ...outsideApproval } },
  );
  assert(result.ok, "expected the merge to be attempted");
  assertEquals(result.value.merged, true);
  assertEquals(gate.calls, 1);
  assert(merged(calls), "expected a `gh pr merge` call");
});

// ---------------------------------------------------------------------------
// The command maps the new reason to its stable string
// ---------------------------------------------------------------------------

Deno.test("blockedReason - maps merge_queue to its stable reason string", () => {
  assertEquals(blockedReason("merge_queue"), "merge_queue");
});
