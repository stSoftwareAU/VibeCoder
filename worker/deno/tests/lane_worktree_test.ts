/**
 * Tests for lane_worktree.ts — per-lane worktrees off the shared clone
 * (Issue #394).
 *
 * Real git repositories throughout: the point of the module is that another
 * lane can no longer move `HEAD`, the index or the working tree underneath
 * the lane that is working, and only real git can demonstrate that.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  detachLaneWorktreeHead,
  ensureLaneWorktree,
  LANE_WORKTREE_ROOT,
  laneWorktreePath,
  PR_BRANCH_UPDATE_LANE_ID,
} from "../lib/lane_worktree.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { isReservedWorkRootEntry } from "../lib/stale_workdir.ts";

/** A clone with one commit on `main`, plus a feature branch on origin. */
async function setupClone(): Promise<{ workDir: string; repoPath: string }> {
  const raw = await Deno.makeTempDir({ prefix: "lane_worktree_" });
  const workDir = await Deno.realPath(raw);
  const remotePath = `${workDir}/remote.git`;
  const repoPath = `${workDir}/demo`;

  await Deno.mkdir(remotePath, { recursive: true });
  await runGitCommand(["init", "--bare"], { cwd: remotePath });
  await runGitCommand(["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: remotePath,
  });
  await runGitCommand(["clone", remotePath, repoPath], { cwd: workDir });
  await runGitCommand(["config", "user.email", "test@example.com"], {
    cwd: repoPath,
  });
  await runGitCommand(["config", "user.name", "Test User"], { cwd: repoPath });
  await Deno.writeTextFile(`${repoPath}/base.txt`, "base\n");
  await runGitCommand(["add", "."], { cwd: repoPath });
  await runGitCommand(["commit", "-m", "initial"], { cwd: repoPath });
  await runGitCommand(["push", "origin", "main"], { cwd: repoPath });

  return { workDir, repoPath };
}

async function head(cwd: string): Promise<string> {
  const result = await runGitCommand(["rev-parse", "HEAD"], { cwd });
  return result.ok ? result.value.stdout.trim() : "";
}

Deno.test("laneWorktreePath - lands under the reserved work-root directory", () => {
  const path = laneWorktreePath("/work", "owner/demo", "pr-branch-update");
  assertEquals(path, `/work/${LANE_WORKTREE_ROOT}/pr-branch-update/demo`);
});

Deno.test("the lane worktree root is reserved, so housekeeping sweeps leave it alone", () => {
  assertEquals(isReservedWorkRootEntry(LANE_WORKTREE_ROOT), true);
});

Deno.test("laneWorktreePath - refuses a path segment that escapes the work root", () => {
  let message = "";
  try {
    laneWorktreePath("/work", "owner/..", PR_BRANCH_UPDATE_LANE_ID);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(message, "unsafe repo segment");

  let laneMessage = "";
  try {
    laneWorktreePath("/work", "owner/demo", "../escape");
  } catch (err) {
    laneMessage = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(laneMessage, "unsafe lane id");
});

Deno.test("ensureLaneWorktree - creates a detached worktree sharing the clone's objects", async () => {
  const { workDir, repoPath } = await setupClone();
  try {
    const result = await ensureLaneWorktree({
      workDir,
      repo: "owner/demo",
      laneId: PR_BRANCH_UPDATE_LANE_ID,
      repoPath,
    });

    assert(result.ok, `expected a worktree: ${!result.ok && result.error}`);
    if (!result.ok) return;

    assertEquals(
      result.value,
      `${workDir}/${LANE_WORKTREE_ROOT}/${PR_BRANCH_UPDATE_LANE_ID}/demo`,
    );
    // Same commit, own HEAD, and no branch claimed.
    assertEquals(await head(result.value), await head(repoPath));
    const symbolic = await runGitCommand(
      ["symbolic-ref", "--quiet", "HEAD"],
      { cwd: result.value },
    );
    assert(
      symbolic.ok && symbolic.value.code !== 0,
      "the lane worktree must start detached",
    );
    // No second object store: the worktree links back to the clone.
    const commonDir = await runGitCommand(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: result.value },
    );
    assert(commonDir.ok && commonDir.value.code === 0);
    assertEquals(
      await Deno.realPath(commonDir.value.stdout.trim()),
      await Deno.realPath(`${repoPath}/.git`),
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("ensureLaneWorktree - reuses an existing worktree instead of recreating it", async () => {
  const { workDir, repoPath } = await setupClone();
  try {
    const first = await ensureLaneWorktree({
      workDir,
      repo: "owner/demo",
      laneId: PR_BRANCH_UPDATE_LANE_ID,
      repoPath,
    });
    assert(first.ok);
    if (!first.ok) return;

    // A marker file survives only if the directory was not recreated.
    await Deno.writeTextFile(`${first.value}/.lane-marker`, "kept\n");

    const second = await ensureLaneWorktree({
      workDir,
      repo: "owner/demo",
      laneId: PR_BRANCH_UPDATE_LANE_ID,
      repoPath,
    });
    assert(second.ok);
    if (!second.ok) return;
    assertEquals(second.value, first.value);
    assertEquals(
      await Deno.readTextFile(`${first.value}/.lane-marker`),
      "kept\n",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("ensureLaneWorktree - the lane's checkout does not move the shared clone's HEAD or tree (Issue #394)", async () => {
  const { workDir, repoPath } = await setupClone();
  try {
    // The shared clone stands in for an issue slot mid-run: on its own
    // branch, with uncommitted work in the tree.
    await runGitCommand(["checkout", "-b", "issue-1-slot-work"], {
      cwd: repoPath,
    });
    await Deno.writeTextFile(`${repoPath}/base.txt`, "slot edit in progress\n");

    const worktree = await ensureLaneWorktree({
      workDir,
      repo: "owner/demo",
      laneId: PR_BRANCH_UPDATE_LANE_ID,
      repoPath,
    });
    assert(worktree.ok);
    if (!worktree.ok) return;

    // The lane does what the branch-update pass does: create and check out a
    // PR branch, commit, and move on.
    await runGitCommand(["checkout", "-b", "issue-2-pr-branch"], {
      cwd: worktree.value,
    });
    await Deno.writeTextFile(`${worktree.value}/lane.txt`, "lane work\n");
    await runGitCommand(["add", "."], { cwd: worktree.value });
    await runGitCommand(
      [
        "-c",
        "user.email=lane@example.com",
        "-c",
        "user.name=Lane",
        "commit",
        "-m",
        "lane commit",
      ],
      { cwd: worktree.value },
    );

    // The slot's branch, HEAD and uncommitted edit are all untouched.
    const branch = await runGitCommand(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoPath },
    );
    assert(branch.ok);
    assertEquals(branch.value.stdout.trim(), "issue-1-slot-work");
    assertEquals(
      await Deno.readTextFile(`${repoPath}/base.txt`),
      "slot edit in progress\n",
    );
    // And the lane's file never appeared in the slot's working tree.
    let laneFileLeaked = true;
    try {
      await Deno.stat(`${repoPath}/lane.txt`);
    } catch {
      laneFileLeaked = false;
    }
    assertEquals(laneFileLeaked, false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("detachLaneWorktreeHead - frees the branch the lane had checked out", async () => {
  const { workDir, repoPath } = await setupClone();
  try {
    const worktree = await ensureLaneWorktree({
      workDir,
      repo: "owner/demo",
      laneId: PR_BRANCH_UPDATE_LANE_ID,
      repoPath,
    });
    assert(worktree.ok);
    if (!worktree.ok) return;

    await runGitCommand(["checkout", "-b", "issue-3-held"], {
      cwd: worktree.value,
    });
    // While the lane holds it, the shared clone cannot check the branch out.
    const blocked = await runGitCommand(["checkout", "issue-3-held"], {
      cwd: repoPath,
    });
    assert(blocked.ok && blocked.value.code !== 0);

    assertEquals(await detachLaneWorktreeHead(worktree.value), true);

    const allowed = await runGitCommand(["checkout", "issue-3-held"], {
      cwd: repoPath,
    });
    assert(
      allowed.ok && allowed.value.code === 0,
      `the branch should be free once the lane detaches: ${
        allowed.ok ? allowed.value.stderr : allowed.error.message
      }`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("ensureLaneWorktree - fails loud when the clone is not a repository", async () => {
  const raw = await Deno.makeTempDir({ prefix: "lane_worktree_bad_" });
  const workDir = await Deno.realPath(raw);
  try {
    await Deno.mkdir(`${workDir}/demo`, { recursive: true });
    const result = await ensureLaneWorktree({
      workDir,
      repo: "owner/demo",
      laneId: PR_BRANCH_UPDATE_LANE_ID,
      repoPath: `${workDir}/demo`,
    });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "owner/demo");
    }
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
