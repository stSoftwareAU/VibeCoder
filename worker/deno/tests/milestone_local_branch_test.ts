/**
 * Tests for the local milestone-branch inspection (Issue #1345).
 *
 * The creation path touches nothing local, so this module is what tells an
 * operator where the stale checkout that used to wedge the run actually is.
 * A git command that could not be run must report `unknown` — the reassuring
 * "no local branch" answer is exactly the silent failure this guards.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  describeLocalMilestoneBranch,
  findWorktreeHoldingBranch,
  inspectLocalMilestoneBranch,
} from "../lib/milestone_local_branch.ts";
import { gitOk, setupGitRepoFixture } from "./support/git_repo_fixture.ts";

Deno.test("findWorktreeHoldingBranch - matches the branch's own worktree", () => {
  const output = [
    "worktree /work/repo",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /work/repo-lane-2",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/milestone/69-example",
    "",
  ].join("\n");

  assertEquals(
    findWorktreeHoldingBranch(output, "milestone/69-example"),
    "/work/repo-lane-2",
  );
  assertEquals(findWorktreeHoldingBranch(output, "main"), "/work/repo");
  assertEquals(findWorktreeHoldingBranch(output, "milestone/other"), null);
  assertEquals(findWorktreeHoldingBranch("", "main"), null);
});

Deno.test("inspectLocalMilestoneBranch - a name with no local ref is absent", async () => {
  const fx = await setupGitRepoFixture("issue-1345-inspect-");
  try {
    assertEquals(
      await inspectLocalMilestoneBranch("milestone/nothing", {
        cwd: fx.clone,
      }),
      { kind: "absent" },
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("inspectLocalMilestoneBranch - an unchecked-out local branch reports its sha", async () => {
  const fx = await setupGitRepoFixture("issue-1345-inspect-");
  try {
    await gitOk(["branch", "milestone/idle", "main"], fx.clone);
    const sha = (await gitOk(["rev-parse", "milestone/idle"], fx.clone)).trim();

    const report = await inspectLocalMilestoneBranch("milestone/idle", {
      cwd: fx.clone,
    });

    assertEquals(report, {
      kind: "present",
      sha,
      location: "not checked out",
    });
  } finally {
    await fx.cleanup();
  }
});

Deno.test("inspectLocalMilestoneBranch - a branch held by a worktree names that worktree", async () => {
  const fx = await setupGitRepoFixture("issue-1345-inspect-");
  const worktree = `${fx.root}/lane-2`;
  try {
    await gitOk(["branch", "milestone/held", "main"], fx.clone);
    await gitOk(["worktree", "add", worktree, "milestone/held"], fx.clone);

    const report = await inspectLocalMilestoneBranch("milestone/held", {
      cwd: fx.clone,
    });

    assertEquals(report.kind, "present");
    if (report.kind !== "present") return;
    assertStringIncludes(report.location, "checked out at");
    assertStringIncludes(report.location, "lane-2");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("inspectLocalMilestoneBranch - a directory that is not a repository is unknown, not absent", async () => {
  const outside = await Deno.makeTempDir({ prefix: "issue-1345-outside-" });
  try {
    const report = await inspectLocalMilestoneBranch("milestone/x", {
      cwd: outside,
    });

    assertEquals(report.kind, "unknown");
    if (report.kind !== "unknown") return;
    assertStringIncludes(report.detail, "git rev-parse exited");
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("describeLocalMilestoneBranch - absent local state says nothing", () => {
  assertEquals(
    describeLocalMilestoneBranch("milestone/x", { kind: "absent" }, "main"),
    null,
  );
});

Deno.test("describeLocalMilestoneBranch - a present branch is named as left untouched", () => {
  const line = describeLocalMilestoneBranch(
    "milestone/x",
    {
      kind: "present",
      sha: "0123456789abcdef0123456789abcdef01234567",
      location: "checked out at /work/repo-lane-2",
    },
    "origin/main",
  );

  assertStringIncludes(line ?? "", "milestone/x");
  assertStringIncludes(line ?? "", "01234567");
  assertStringIncludes(line ?? "", "/work/repo-lane-2");
  assertStringIncludes(line ?? "", "left untouched");
});

Deno.test("describeLocalMilestoneBranch - an unknown inspection is reported, not swallowed", () => {
  const line = describeLocalMilestoneBranch(
    "milestone/x",
    { kind: "unknown", detail: "git rev-parse exited 128: not a repository" },
    "main",
  );

  assertStringIncludes(line ?? "", "Could not inspect");
  assertStringIncludes(line ?? "", "not a repository");
});
