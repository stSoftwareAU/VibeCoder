/**
 * Tests for the orphaned-milestone-merge self-heal (Issue #175).
 *
 * GRQ#4173's PR merged into `milestone/4168-…` after that milestone's rollup
 * PR had already merged into Develop. The pre-check refused to close the
 * issue, but nothing raised a fresh rollup, so the state that caused the
 * refusal never changed and both pool slots re-claimed the issue every cycle.
 * These tests call the repair with injected gh doubles and assert on the
 * commands it issues and the outcome it reports.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildOrphanedRollupBody,
  ORPHANED_ROLLUP_MARKER,
  repairOrphanedMilestoneMerge,
} from "../lib/orphaned_rollup.ts";
import { clearDefaultBranchMemoryCache } from "../lib/shell_helpers.ts";

const REPO = "stSoftwareAU/GRQ";
const BRANCH = "milestone/4168-feed-completion-signal";

/** A gh double that answers the three calls the repair makes. */
function makeGh(overrides: {
  openPrs?: unknown[];
  aheadBy?: string;
  createUrl?: string;
  failOn?: (args: string[]) => Error | null;
}): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const failure = overrides.failOn?.(args);
    if (failure) return Promise.reject(failure);
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(overrides.openPrs ?? []));
    }
    if (args[0] === "api" && String(args[1]).includes("/compare/")) {
      return Promise.resolve(overrides.aheadBy ?? "3");
    }
    if (args[0] === "api" && String(args[1]) === `repos/${REPO}`) {
      return Promise.resolve("Develop\n");
    }
    if (args[0] === "pr" && args[1] === "create") {
      return Promise.resolve(
        overrides.createUrl ?? `https://github.com/${REPO}/pull/4400\n`,
      );
    }
    return Promise.resolve("");
  };
  return { gh, calls };
}

Deno.test("orphaned-rollup - raises a fresh rollup PR when the milestone branch is ahead", async () => {
  const { gh, calls } = makeGh({ aheadBy: "5" });

  const outcome = await repairOrphanedMilestoneMerge({
    repo: REPO,
    milestoneBranch: BRANCH,
    orphanedPrNumber: 4211,
    defaultBranch: "Develop",
    ghCommandFn: gh,
  });

  assertEquals(outcome, {
    action: "created",
    prUrl: `https://github.com/${REPO}/pull/4400`,
    milestoneBranch: BRANCH,
  });

  const create = calls.find((a) => a[0] === "pr" && a[1] === "create");
  assertEquals(create?.[create.indexOf("--head") + 1], BRANCH);
  assertEquals(create?.[create.indexOf("--base") + 1], "Develop");
  assertStringIncludes(
    create?.[create.indexOf("--body") + 1] ?? "",
    ORPHANED_ROLLUP_MARKER,
  );
  // The orphaned PR is named so a reviewer can trace the repair.
  assertStringIncludes(create?.[create.indexOf("--body") + 1] ?? "", "#4211");
});

Deno.test("orphaned-rollup - is idempotent when an open rollup PR already exists", async () => {
  const { gh, calls } = makeGh({
    openPrs: [{ number: 4400, headRefName: BRANCH, baseRefName: "Develop" }],
  });

  const outcome = await repairOrphanedMilestoneMerge({
    repo: REPO,
    milestoneBranch: BRANCH,
    orphanedPrNumber: 4211,
    defaultBranch: "Develop",
    ghCommandFn: gh,
  });

  assertEquals(outcome, {
    action: "exists",
    prNumber: 4400,
    milestoneBranch: BRANCH,
  });
  assertEquals(calls.some((a) => a[0] === "pr" && a[1] === "create"), false);
});

Deno.test("orphaned-rollup - an open PR from another head does not count as the rollup", async () => {
  const { gh, calls } = makeGh({
    openPrs: [
      { number: 4399, headRefName: "feature/other", baseRefName: "Develop" },
    ],
    aheadBy: "2",
  });

  const outcome = await repairOrphanedMilestoneMerge({
    repo: REPO,
    milestoneBranch: BRANCH,
    orphanedPrNumber: 4211,
    defaultBranch: "Develop",
    ghCommandFn: gh,
  });

  assertEquals(outcome.action, "created");
  assertEquals(calls.some((a) => a[0] === "pr" && a[1] === "create"), true);
});

Deno.test("orphaned-rollup - reports nothing-to-merge when the branch is not ahead", async () => {
  const { gh, calls } = makeGh({ aheadBy: "0" });

  const outcome = await repairOrphanedMilestoneMerge({
    repo: REPO,
    milestoneBranch: BRANCH,
    orphanedPrNumber: 4211,
    defaultBranch: "Develop",
    ghCommandFn: gh,
  });

  assertEquals(outcome, {
    action: "nothing-to-merge",
    milestoneBranch: BRANCH,
  });
  assertEquals(calls.some((a) => a[0] === "pr" && a[1] === "create"), false);
});

Deno.test("orphaned-rollup - a non-milestone base is not applicable", async () => {
  const { gh, calls } = makeGh({});

  const outcome = await repairOrphanedMilestoneMerge({
    repo: REPO,
    milestoneBranch: "Develop",
    orphanedPrNumber: 4211,
    defaultBranch: "Develop",
    ghCommandFn: gh,
  });

  assertEquals(outcome.action, "not-applicable");
  assertEquals(calls.length, 0);
});

Deno.test("orphaned-rollup - a failed create is reported loudly, never as success", async () => {
  const { gh } = makeGh({
    aheadBy: "4",
    failOn: (args) =>
      args[0] === "pr" && args[1] === "create"
        ? new Error("GraphQL: No commits between Develop and the branch")
        : null,
  });

  const outcome = await repairOrphanedMilestoneMerge({
    repo: REPO,
    milestoneBranch: BRANCH,
    orphanedPrNumber: 4211,
    defaultBranch: "Develop",
    ghCommandFn: gh,
  });

  assertEquals(outcome.action, "failed");
  if (outcome.action === "failed") {
    assertStringIncludes(outcome.reason, "No commits between");
  }
});

Deno.test("orphaned-rollup - a failed PR lookup is reported as failed, not as 'create anyway'", async () => {
  const { gh, calls } = makeGh({
    failOn: (args) =>
      args[0] === "pr" && args[1] === "list"
        ? new Error("gh: API rate limit exceeded")
        : null,
  });

  const outcome = await repairOrphanedMilestoneMerge({
    repo: REPO,
    milestoneBranch: BRANCH,
    orphanedPrNumber: 4211,
    defaultBranch: "Develop",
    ghCommandFn: gh,
  });

  assertEquals(outcome.action, "failed");
  assertEquals(calls.some((a) => a[0] === "pr" && a[1] === "create"), false);
});

Deno.test("orphaned-rollup - resolves the default branch when the caller does not supply one", async () => {
  clearDefaultBranchMemoryCache();
  const { gh, calls } = makeGh({ aheadBy: "1" });

  const outcome = await repairOrphanedMilestoneMerge({
    repo: REPO,
    milestoneBranch: BRANCH,
    orphanedPrNumber: 4211,
    ghCommandFn: gh,
  });

  assertEquals(outcome.action, "created");
  // The resolved branch is the one actually used: the compare and the PR
  // base agree, and neither is empty. (`getRepoDefaultBranch` may answer
  // from its cache, so the resolution CALL is not asserted here.)
  const compare = calls.find((a) =>
    a[0] === "api" && String(a[1]).includes("/compare/")
  );
  const comparedBase = String(compare?.[1]).split("/compare/")[1]?.split(
    "...",
  )[0];
  const create = calls.find((a) => a[0] === "pr" && a[1] === "create");
  const prBase = create?.[create.indexOf("--base") + 1];
  assertEquals(typeof prBase === "string" && prBase.length > 0, true);
  assertEquals(comparedBase, prBase);
  clearDefaultBranchMemoryCache();
});

Deno.test("orphaned-rollup - a branch name outside the argument allowlist is refused", async () => {
  const { gh, calls } = makeGh({});

  const outcome = await repairOrphanedMilestoneMerge({
    repo: REPO,
    milestoneBranch: "milestone/4168; rm -rf /",
    orphanedPrNumber: 4211,
    defaultBranch: "Develop",
    ghCommandFn: gh,
  });

  assertEquals(outcome.action, "failed");
  assertEquals(calls.length, 0);
});

Deno.test("orphaned-rollup - body states the branch, default branch and commit count", () => {
  const body = buildOrphanedRollupBody({
    milestoneBranch: BRANCH,
    defaultBranch: "Develop",
    orphanedPrNumber: 4211,
    aheadBy: 7,
  });

  assertStringIncludes(body, ORPHANED_ROLLUP_MARKER);
  assertStringIncludes(body, BRANCH);
  assertStringIncludes(body, "Develop");
  assertStringIncludes(body, "7 commit(s)");
  assertStringIncludes(body, "#4211");
});
