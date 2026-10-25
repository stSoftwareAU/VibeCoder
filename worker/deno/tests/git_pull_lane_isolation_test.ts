/**
 * The branch-update pass survives a clone it does not own (Issue #394).
 *
 * Two failures from one 40-second window drove this:
 *
 *  1. PR #392's branch existed on origin and the PR was OPEN, yet the pass
 *     reported `pathspec … did not match any file(s) known to git` — the
 *     clone had no local copy of that branch when the bare
 *     `git checkout <branch>` ran.
 *  2. PR #390 could not be updated at all because an issue slot had left two
 *     unpushed commits on its branch in the shared clone.
 *
 * These tests drive the real `updatePrBranch` against real git repositories,
 * including a linked worktree standing in for the lane's own checkout while
 * the shared clone is busy on another branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { cloneGitFixture, seedGitRemote } from "./support/git_fixture.ts";

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { updatePrBranch } from "../lib/git_pull.ts";
import { classifyCloneContention } from "../lib/clone_contention.ts";
import { ensureLaneWorktree } from "../lib/lane_worktree.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

interface Fixture {
  tmpDir: string;
  /** The shared clone every lane used to work in. */
  clonePath: string;
  /** A second clone standing in for "somebody else pushed the PR". */
  authorPath: string;
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  return result.ok ? result.value.stdout.trim() : "";
}

/**
 * A remote with `main` and a PR branch `issue-373-fix` that is one commit
 * behind `main`, plus a shared clone that has fetched only `main`.
 */
async function setupFixture(
  options: { singleBranch?: boolean } = {},
): Promise<Fixture> {
  const raw = await Deno.makeTempDir({ prefix: "git_pull_lane_" });
  const tmpDir = await Deno.realPath(raw);
  const authorPath = `${tmpDir}/author`;
  const clonePath = `${tmpDir}/VibeCoder`;
  const remotePath = await seedGitRemote(tmpDir, "main", [
    { branch: "main", subject: "initial", files: { "base.txt": "base\n" } },
    {
      branch: "issue-373-fix",
      parent: 1,
      subject: "PR work",
      files: { "feature.txt": "feature\n" },
    },
    {
      branch: "main",
      parent: 1,
      subject: "base moves on",
      files: { "base.txt": "base\nmore\n" },
    },
  ]);
  await cloneGitFixture(remotePath, authorPath, {
    name: "Author",
    email: "author@example.com",
  });
  // Only the default branch is local; a legacy single-branch clone also
  // lacks the PR's remote-tracking ref until production repairs its refspec.
  await cloneGitFixture(remotePath, clonePath, {
    name: "Worker",
    email: "worker@example.com",
    ...(options.singleBranch ? { singleBranch: "main" } : {}),
  });

  return { tmpDir, clonePath, authorPath };
}

Deno.test("updatePrBranch - a PR branch that exists only on origin is updated, not reported as a missing pathspec (Issue #394)", async () => {
  const { tmpDir, clonePath, authorPath } = await setupFixture();
  try {
    // Precondition: the clone genuinely has no local copy of the branch.
    const localRef = await runGitCommand(
      ["rev-parse", "--verify", "--quiet", "refs/heads/issue-373-fix"],
      { cwd: clonePath },
    );
    assert(localRef.ok && localRef.value.code !== 0);

    const result = await updatePrBranch("issue-373-fix", "main", {
      cwd: clonePath,
    }, "behind");

    assert(
      result.ok,
      `expected the update to succeed, got: ${
        !result.ok && result.error.message
      }`,
    );

    // The rebase really was published: the author's clone sees the PR branch
    // sitting on top of the new base.
    await runGitCommand(["fetch", "origin"], { cwd: authorPath });
    const behind = await git(
      ["rev-list", "--count", "origin/issue-373-fix..origin/main"],
      authorPath,
    );
    assertEquals(behind, "0");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("updatePrBranch - runs in a lane worktree while the shared clone holds the base branch (Issue #394)", async () => {
  const { tmpDir, clonePath, authorPath } = await setupFixture({
    singleBranch: true,
  });
  try {
    // The shared clone stands in for an issue slot: on `main`, with an
    // uncommitted edit in its working tree.
    await Deno.writeTextFile(`${clonePath}/base.txt`, "slot edit\n");

    const worktree = await ensureLaneWorktree({
      workDir: tmpDir,
      repo: "stSoftwareAU/VibeCoder",
      laneId: "pr-branch-update",
      repoPath: clonePath,
    });
    assert(worktree.ok, `worktree: ${!worktree.ok && worktree.error.message}`);
    if (!worktree.ok) return;

    const result = await updatePrBranch("issue-373-fix", "main", {
      cwd: worktree.value,
    }, "behind");

    assert(
      result.ok,
      `expected the update to succeed in the lane worktree, got: ${
        !result.ok && result.error.message
      }`,
    );

    // The slot's uncommitted edit survived untouched.
    assertEquals(
      await Deno.readTextFile(`${clonePath}/base.txt`),
      "slot edit\n",
    );

    // And the PR really was rebased onto the published base.
    await runGitCommand(["fetch", "origin"], { cwd: authorPath });
    assertEquals(
      await git(
        ["rev-list", "--count", "origin/issue-373-fix..origin/main"],
        authorPath,
      ),
      "0",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("updatePrBranch - unpushed commits another lane left are refused as contention, and the PR is left alone (Issue #394)", async () => {
  const { tmpDir, clonePath, authorPath } = await setupFixture();
  try {
    // An issue slot's leftovers: the branch checked out locally with a commit
    // origin has never seen.
    await runGitCommand([
      "fetch",
      "origin",
      "issue-373-fix:refs/heads/issue-373-fix",
    ], { cwd: clonePath });
    await runGitCommand(["checkout", "issue-373-fix"], { cwd: clonePath });
    await Deno.writeTextFile(`${clonePath}/wip.txt`, "unpushed work\n");
    await runGitCommand(["add", "."], { cwd: clonePath });
    await runGitCommand(["commit", "-m", "slot work in progress"], {
      cwd: clonePath,
    });
    const beforeRemote = await git(
      ["rev-parse", "origin/issue-373-fix"],
      authorPath,
    );

    const result = await updatePrBranch("issue-373-fix", "main", {
      cwd: clonePath,
    }, "behind");

    assertEquals(result.ok, false);
    if (result.ok) return;
    // Classified as contention, so the pass defers instead of failing the PR.
    assertEquals(
      classifyCloneContention(result.error)?.kind,
      "unpushed-local-work",
    );
    assertStringIncludes(result.error.message, "issue-373-fix");

    // Nothing was pushed and the unpushed commit is still there.
    await runGitCommand(["fetch", "origin"], { cwd: authorPath });
    assertEquals(
      await git(["rev-parse", "origin/issue-373-fix"], authorPath),
      beforeRemote,
    );
    assertEquals(
      await Deno.readTextFile(`${clonePath}/wip.txt`),
      "unpushed work\n",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
