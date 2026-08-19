/**
 * Tests for the merge-landing check (Issue #4396): before an issue is
 * auto-closed as completed because "its PR merged", verify the merge commit
 * is reachable from the default branch — or that it merged into a milestone
 * branch whose route to the default branch is still open. Seven fixes were
 * lost when they merged into `milestone/clean-up` after its rollup, and
 * their issues closed COMPLETED on the strength of a merge that went nowhere.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { verifyMergeLanded } from "../lib/merge_landing.ts";

function gh(answers: {
  pr?: {
    state?: string;
    mergeCommit?: { oid: string } | null;
    baseRefName?: string;
  };
  compare?: string | Error;
  rollups?: Array<{ number: number; state: string; baseRefName: string }>;
  milestones?: Array<{ number: number; title: string; state: string }>;
}) {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr view") && key.includes("mergeCommit")) {
      return JSON.stringify(
        answers.pr ??
          {
            state: "MERGED",
            mergeCommit: { oid: "abc" },
            baseRefName: "Develop",
          },
      );
    }
    if (key.includes("/compare/")) {
      if (answers.compare instanceof Error) throw answers.compare;
      return JSON.stringify({ status: answers.compare ?? "behind" });
    }
    if (key.includes("pr list") && key.includes("--head")) {
      return JSON.stringify(answers.rollups ?? []);
    }
    if (key.includes("/milestones?state=all")) {
      return JSON.stringify(answers.milestones ?? []);
    }
    throw new Error(`unexpected ${key}`);
  };
}

Deno.test("verifyMergeLanded - a merge commit reachable from the default branch has landed (Issue #4396)", async () => {
  const r = await verifyMergeLanded("org/repo", 10, gh({ compare: "behind" }), {
    defaultBranch: "Develop",
  });
  assertEquals(r, {
    landed: true,
    via: "default-branch",
    mergeCommit: "abc",
    baseRefName: "Develop",
  });
  const same = await verifyMergeLanded(
    "org/repo",
    10,
    gh({ compare: "identical" }),
    { defaultBranch: "Develop" },
  );
  assertEquals(same.landed, true);
});

Deno.test("verifyMergeLanded - a merge into a milestone branch whose route is open counts as landed-in-transit (Issue #4396)", async () => {
  const r = await verifyMergeLanded(
    "org/repo",
    10,
    gh({
      pr: {
        state: "MERGED",
        mergeCommit: { oid: "abc" },
        baseRefName: "milestone/still-open",
      },
      compare: "diverged",
      rollups: [{ number: 5, state: "OPEN", baseRefName: "Develop" }],
      milestones: [{ number: 3, title: "Still open", state: "open" }],
    }),
    { defaultBranch: "Develop" },
  );
  assertEquals(r.landed, true);
  if (r.landed) assertEquals(r.via, "milestone-route-open");
});

Deno.test("verifyMergeLanded - a merge into a rolled-up milestone branch is ORPHANED, never landed (Issue #4396)", async () => {
  const r = await verifyMergeLanded(
    "org/repo",
    3371,
    gh({
      pr: {
        state: "MERGED",
        mergeCommit: { oid: "dea1fdcc" },
        baseRefName: "milestone/clean-up",
      },
      compare: "diverged",
      rollups: [{ number: 3125, state: "MERGED", baseRefName: "Develop" }],
      milestones: [{ number: 7, title: "Clean up", state: "closed" }],
    }),
    { defaultBranch: "Develop" },
  );
  assertEquals(r.landed, false);
  if (!r.landed) {
    assertEquals(r.reason, "orphaned");
    assert(r.detail.includes("#3125"), r.detail);
  }
});

Deno.test("verifyMergeLanded - not merged, or an unreadable compare, is 'unknown' — never a false landing (Issue #4396)", async () => {
  const open = await verifyMergeLanded(
    "org/repo",
    10,
    gh({ pr: { state: "OPEN" } }),
    { defaultBranch: "Develop" },
  );
  assertEquals(open.landed, false);
  if (!open.landed) assertEquals(open.reason, "not-merged");
  const unreadable = await verifyMergeLanded(
    "org/repo",
    10,
    gh({ compare: new Error("HTTP 500") }),
    { defaultBranch: "Develop" },
  );
  assertEquals(unreadable.landed, false);
  if (!unreadable.landed) assertEquals(unreadable.reason, "unknown");
});

Deno.test("verifyMergeLanded - a child merged BEFORE its milestone's squash rollup has landed via the rollup; AFTER is orphaned (Issue #4396)", async () => {
  const stub =
    (childMergedAt: string) => async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (
        key.includes("pr view 4092") ||
        (key.includes("pr view") && key.includes("mergeCommit"))
      ) {
        return JSON.stringify({
          state: "MERGED",
          mergeCommit: { oid: "c0ffee" },
          baseRefName: "milestone/4074-x",
          mergedAt: childMergedAt,
        });
      }
      if (key.includes("pr view 4095")) {
        return JSON.stringify({ mergedAt: "2026-08-13T21:45:08Z" });
      }
      if (key.includes("/compare/")) {
        return JSON.stringify({ status: "diverged" });
      }
      if (key.includes("pr list") && key.includes("--head")) {
        return JSON.stringify([{
          number: 4095,
          state: "MERGED",
          baseRefName: "Develop",
          mergedAt: "2026-08-13T21:45:08Z",
        }]);
      }
      if (key.includes("/milestones?state=all")) return JSON.stringify([]);
      throw new Error(`unexpected ${key}`);
    };
  const before = await verifyMergeLanded(
    "org/repo",
    4092,
    stub("2026-08-13T18:04:35Z"),
    { defaultBranch: "Develop" },
  );
  assertEquals(before.landed, true);
  if (before.landed) assertEquals(before.via, "milestone-rollup");
  const after = await verifyMergeLanded(
    "org/repo",
    4092,
    stub("2026-08-14T09:00:00Z"),
    { defaultBranch: "Develop" },
  );
  assertEquals(after.landed, false);
  if (!after.landed) {
    assertEquals(after.reason, "orphaned");
    assert(after.detail.includes("after the rollup"), after.detail);
  }
});
