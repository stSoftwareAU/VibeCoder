/**
 * Tests for stranded-branch detection (Issue #174).
 *
 * A branch named `issue-<n>-…` that is ahead of the base and carries no PR
 * at all is *stranded work*: commits nobody can review or merge. VibeCoder#42
 * ended a 49-minute run that way because a sibling's merged PR was mistaken
 * for the run's own PR.
 *
 * Every test drives `findStrandedIssueBranch` with an injected gh command
 * function and asserts on the returned scan — never on source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  findStrandedIssueBranch,
  isIssueBranchName,
} from "../lib/stranded_branch.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GhStub {
  /** Refs returned by the matching-refs listing, as bare branch names. */
  branches?: string[];
  /** Branch → number of PRs (any state) that exist for it. */
  prCounts?: Record<string, number>;
  /** Branch → commits ahead of the base. */
  aheadBy?: Record<string, number>;
  /** Args substring that should throw instead of answering. */
  failOn?: string;
}

function makeGh(stub: GhStub): {
  fn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const key = args.join(" ");
    if (stub.failOn && key.includes(stub.failOn)) {
      return Promise.reject(new Error(`gh failed: ${stub.failOn}`));
    }
    if (key.includes("matching-refs")) {
      return Promise.resolve(
        (stub.branches ?? []).map((b) => `refs/heads/${b}`).join("\n"),
      );
    }
    if (key.includes(".default_branch")) {
      return Promise.resolve("Develop\n");
    }
    if (args[0] === "pr" && args[1] === "list") {
      const head = args[args.indexOf("--head") + 1]!;
      const count = stub.prCounts?.[head] ?? 0;
      const prs = Array.from({ length: count }, (_, i) => ({ number: i + 1 }));
      return Promise.resolve(JSON.stringify(prs));
    }
    if (key.includes("/compare/")) {
      const path = args[1]!;
      const head = path.slice(path.lastIndexOf("...") + 3);
      return Promise.resolve(String(stub.aheadBy?.[head] ?? 0));
    }
    return Promise.resolve("");
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// isIssueBranchName
// ---------------------------------------------------------------------------

Deno.test("isIssueBranchName - matches the worker's deterministic branch shape only", () => {
  assertEquals(isIssueBranchName("issue-42-quota-exhaustion", 42), true);
  assertEquals(isIssueBranchName("issue-42-", 42), true);
  // A digit-prefix neighbour must never match.
  assertEquals(isIssueBranchName("issue-421-something", 42), false);
  assertEquals(isIssueBranchName("issue-4-something", 42), false);
  // Bare, prefixed and unrelated names are not this issue's branch.
  assertEquals(isIssueBranchName("issue-42", 42), false);
  assertEquals(isIssueBranchName("feature/issue-42-x", 42), false);
  assertEquals(isIssueBranchName("main", 42), false);
});

// ---------------------------------------------------------------------------
// findStrandedIssueBranch
// ---------------------------------------------------------------------------

Deno.test("findStrandedIssueBranch - reports a branch ahead of base with no PR of its own", async () => {
  const gh = makeGh({
    branches: ["issue-42-primary-graphql-quota"],
    prCounts: {},
    aheadBy: { "issue-42-primary-graphql-quota": 3 },
  });

  const scan = await findStrandedIssueBranch("org/repo", 42, gh.fn, {
    baseBranch: "Develop",
  });

  assert(scan.ok, "scan should succeed");
  assertEquals(scan.stranded, {
    branch: "issue-42-primary-graphql-quota",
    baseBranch: "Develop",
    aheadBy: 3,
  });
});

Deno.test("findStrandedIssueBranch - a branch that already has a PR is not stranded (merged sibling included)", async () => {
  const gh = makeGh({
    branches: ["issue-42-with-a-pr"],
    prCounts: { "issue-42-with-a-pr": 1 },
    aheadBy: { "issue-42-with-a-pr": 5 },
  });

  const scan = await findStrandedIssueBranch("org/repo", 42, gh.fn, {
    baseBranch: "Develop",
  });

  assert(scan.ok);
  assertEquals(scan.stranded, null);
  // The compare call is skipped once a PR is found — no wasted API call.
  assertEquals(gh.calls.some((a) => a.join(" ").includes("/compare/")), false);
});

Deno.test("findStrandedIssueBranch - a branch level with base is not stranded", async () => {
  const gh = makeGh({
    branches: ["issue-42-already-merged"],
    aheadBy: { "issue-42-already-merged": 0 },
  });

  const scan = await findStrandedIssueBranch("org/repo", 42, gh.fn, {
    baseBranch: "Develop",
  });

  assert(scan.ok);
  assertEquals(scan.stranded, null);
});

Deno.test("findStrandedIssueBranch - no matching branches at all is a clean null", async () => {
  const gh = makeGh({ branches: [] });

  const scan = await findStrandedIssueBranch("org/repo", 42, gh.fn, {
    baseBranch: "Develop",
  });

  assert(scan.ok);
  assertEquals(scan.stranded, null);
  // Nothing to compare when the listing is empty.
  assertEquals(gh.calls.length, 1);
});

Deno.test("findStrandedIssueBranch - refs that are not this issue's branch are ignored", async () => {
  // matching-refs is a prefix search; a defensive re-check keeps a
  // mis-scoped or hand-crafted ref out of the scan.
  const gh = makeGh({
    branches: ["issue-421-neighbour", "renovate/deno"],
    aheadBy: { "issue-421-neighbour": 9, "renovate/deno": 9 },
  });

  const scan = await findStrandedIssueBranch("org/repo", 42, gh.fn, {
    baseBranch: "Develop",
  });

  assert(scan.ok);
  assertEquals(scan.stranded, null);
});

Deno.test("findStrandedIssueBranch - resolves the default branch when no base is supplied", async () => {
  const gh = makeGh({
    branches: ["issue-42-stranded"],
    aheadBy: { "issue-42-stranded": 1 },
  });

  const scan = await findStrandedIssueBranch("org/repo-default-lookup", 42, gh.fn);

  assert(scan.ok);
  assertEquals(scan.stranded?.baseBranch, "Develop");
  assertEquals(scan.stranded?.branch, "issue-42-stranded");
});

Deno.test("findStrandedIssueBranch - a failed ref listing is an error, never a silent 'nothing stranded'", async () => {
  const gh = makeGh({ branches: ["issue-42-x"], failOn: "matching-refs" });

  const scan = await findStrandedIssueBranch("org/repo", 42, gh.fn, {
    baseBranch: "Develop",
  });

  assertEquals(scan.ok, false);
  if (!scan.ok) {
    assert(
      scan.error.message.includes("matching-refs") ||
        scan.error.message.includes("issue-42"),
      `error should name what failed: ${scan.error.message}`,
    );
  }
});

Deno.test("findStrandedIssueBranch - a failed compare is an error, never a silent 'nothing stranded'", async () => {
  const gh = makeGh({
    branches: ["issue-42-x"],
    failOn: "/compare/",
  });

  const scan = await findStrandedIssueBranch("org/repo", 42, gh.fn, {
    baseBranch: "Develop",
  });

  assertEquals(scan.ok, false);
});

Deno.test("findStrandedIssueBranch - a failed PR listing is an error, never a silent 'nothing stranded'", async () => {
  const gh = makeGh({ branches: ["issue-42-x"], failOn: "pr list" });

  const scan = await findStrandedIssueBranch("org/repo", 42, gh.fn, {
    baseBranch: "Develop",
  });

  assertEquals(scan.ok, false);
});

Deno.test("findStrandedIssueBranch - scans at most maxBranches candidates", async () => {
  const branches = Array.from({ length: 5 }, (_, i) => `issue-42-branch-${i}`);
  const gh = makeGh({
    branches,
    // Only the last branch is stranded — a capped scan must not reach it.
    aheadBy: { "issue-42-branch-4": 4 },
  });

  const scan = await findStrandedIssueBranch("org/repo", 42, gh.fn, {
    baseBranch: "Develop",
    maxBranches: 2,
  });

  assert(scan.ok);
  assertEquals(scan.stranded, null);
  const compares = gh.calls.filter((a) => a.join(" ").includes("/compare/"));
  assertEquals(compares.length, 2);
});
