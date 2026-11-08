/**
 * Tests for the Issue #4794 held-branch repair in
 * `resumeFeatureBranchFromRemote`: a pushed checkpoint whose branch is checked
 * out in a sibling lane worktree is released, so the resume is not lost to
 * "is already used by worktree".
 *
 * Uses real git throughout. Uses Australian English throughout (behaviour,
 * colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { resumeFeatureBranchFromRemote } from "../lib/git_branch.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

/** Runs git in `cwd`, asserts it succeeded, and returns trimmed stdout. */
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  assert(result.ok && result.value.code === 0, JSON.stringify(result));
  return result.value.stdout.trim();
}

/** The symbolic HEAD of the worktree at `cwd`, trimmed. */
async function headOf(cwd: string): Promise<string> {
  return await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * A clone on `main` with one commit, a bare remote named `origin`, and a
 * detached lane worktree for the running lane s1 beside it.
 */
async function laneFixture(): Promise<
  { workDir: string; repoPath: string; runningLane: string }
> {
  const raw = await Deno.makeTempDir({ prefix: "git_branch_lane_held_" });
  const workDir = await Deno.realPath(raw);
  const repoPath = `${workDir}/VibeCoder`;
  const runningLane = `${workDir}/worktrees/s1/VibeCoder`;

  await git(workDir, ["init", "-b", "main", repoPath]);
  await git(repoPath, ["config", "user.email", "t@example.com"]);
  await git(repoPath, ["config", "user.name", "Test"]);
  await Deno.writeTextFile(`${repoPath}/base.txt`, "base\n");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "initial"]);
  await git(workDir, ["init", "--bare", `${workDir}/remote.git`]);
  await git(repoPath, ["remote", "add", "origin", `${workDir}/remote.git`]);

  // The running lane is detached, as a healthy lane is between runs.
  await Deno.mkdir(`${workDir}/worktrees/s1`, { recursive: true });
  await git(repoPath, ["worktree", "add", "--detach", runningLane, "main"]);

  return { workDir, repoPath, runningLane };
}

Deno.test("resumeFeatureBranchFromRemote - preserves a pushed checkpoint held by a sibling lane worktree (Issue #4794)", async () => {
  const { workDir, repoPath, runningLane } = await laneFixture();
  const branch = "issue-4794-held";
  const siblingLane = `${workDir}/worktrees/s3/VibeCoder`;
  try {
    await Deno.mkdir(`${workDir}/worktrees/s3`, { recursive: true });
    await git(repoPath, ["worktree", "add", "--detach", siblingLane, "main"]);

    // The sibling lane carries the pushed checkpoint and keeps the branch
    // checked out, so it is the holder the running lane is refused by.
    await git(siblingLane, ["checkout", "-b", branch]);
    await Deno.writeTextFile(`${siblingLane}/checkpoint.txt`, "checkpoint\n");
    await git(siblingLane, ["add", "checkpoint.txt"]);
    await git(siblingLane, ["commit", "-m", "checkpoint"]);
    const checkpoint = await git(siblingLane, ["rev-parse", "HEAD"]);
    await git(siblingLane, ["push", "origin", "main", branch]);

    const result = await resumeFeatureBranchFromRemote(branch, {
      cwd: runningLane,
    });

    assertEquals(result, { ok: true, value: true });
    assertEquals(await headOf(runningLane), branch);
    assertEquals(await git(runningLane, ["rev-parse", "HEAD"]), checkpoint);
    // The sibling was detached, not left holding the issue branch.
    assertEquals(await headOf(siblingLane), "HEAD");
    // The primary was never the holder and stays on main.
    assertEquals(await headOf(repoPath), "main");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("resumeFeatureBranchFromRemote - leaves a developer's worktree outside the lane root alone (Issue #4794)", async () => {
  const { workDir, repoPath, runningLane } = await laneFixture();
  const branch = "issue-4794-developer";
  const outsidePath = `${workDir}/somebody-elses-worktree`;
  try {
    // The developer's own worktree holds the branch, with a pushed checkpoint.
    await git(repoPath, ["worktree", "add", "-b", branch, outsidePath, "main"]);
    await Deno.writeTextFile(`${outsidePath}/checkpoint.txt`, "checkpoint\n");
    await git(outsidePath, ["add", "checkpoint.txt"]);
    await git(outsidePath, ["commit", "-m", "checkpoint"]);
    await git(outsidePath, ["push", "origin", branch]);

    const result = await resumeFeatureBranchFromRemote(branch, {
      cwd: runningLane,
    });

    assertEquals(result, { ok: true, value: false });
    // The developer's worktree was not detached.
    assertEquals(await headOf(outsidePath), branch);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
