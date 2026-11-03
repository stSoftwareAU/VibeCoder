/**
 * Tests for the Issue #4789 held-branch repair: a feature branch checked out
 * in the shared clone's own primary worktree is released by
 * `createFeatureBranchFromBase`, run from a lane worktree.
 *
 * Uses real git throughout. Uses Australian English throughout (behaviour,
 * colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createFeatureBranchFromBase } from "../lib/git_branch.ts";
import { primaryCloneHoldingBranch } from "../lib/lane_worktree.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

/**
 * A clone on `main` with one commit, a detached lane worktree for slot s2
 * beside it, and the issue branch checked out in the primary worktree.
 */
async function primaryHeldFixture(): Promise<
  { workDir: string; repoPath: string; lanePath: string; branch: string }
> {
  const raw = await Deno.makeTempDir({ prefix: "git_branch_primary_held_" });
  const workDir = await Deno.realPath(raw);
  const repoPath = `${workDir}/VibeCoder`;
  const lanePath = `${workDir}/worktrees/s2/VibeCoder`;
  const branch = "issue-4789-primary-held";

  await runGitCommand(["init", "-b", "main", repoPath], { cwd: workDir });
  await runGitCommand(["config", "user.email", "t@example.com"], {
    cwd: repoPath,
  });
  await runGitCommand(["config", "user.name", "Test"], { cwd: repoPath });
  await Deno.writeTextFile(`${repoPath}/base.txt`, "base\n");
  await runGitCommand(["add", "."], { cwd: repoPath });
  await runGitCommand(["commit", "-m", "initial"], { cwd: repoPath });

  // The lane worktree is detached, as a healthy lane is between runs.
  await Deno.mkdir(`${workDir}/worktrees/s2`, { recursive: true });
  await runGitCommand(["worktree", "add", "--detach", lanePath, "main"], {
    cwd: repoPath,
  });

  // The issue branch is left checked out in the shared clone's primary.
  await runGitCommand(["checkout", "-b", branch], { cwd: repoPath });

  return { workDir, repoPath, lanePath, branch };
}

/** The symbolic HEAD of the worktree at `cwd`, trimmed. */
async function headOf(cwd: string): Promise<string> {
  const head = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
  });
  assert(head.ok, JSON.stringify(head));
  return head.value.stdout.trim();
}

Deno.test("createFeatureBranchFromBase - releases a branch held by the primary clone, run from a lane (Issue #4789)", async () => {
  const { workDir, repoPath, lanePath, branch } = await primaryHeldFixture();
  try {
    const result = await createFeatureBranchFromBase(branch, "main", {
      cwd: lanePath,
    });

    assertEquals(result.ok, true, JSON.stringify(result));
    assertEquals(await headOf(lanePath), branch);
    // The primary was detached, not left holding the issue branch.
    assertEquals(await headOf(repoPath), "HEAD");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("createFeatureBranchFromBase - will not detach a developer's worktree outside the lane root and primary (Issue #4789)", async () => {
  const { workDir, lanePath } = await primaryHeldFixture();
  const outsidePath = `${workDir}/somebody-elses-worktree`;
  const otherBranch = "other-branch";
  try {
    await runGitCommand(
      ["worktree", "add", "-b", otherBranch, outsidePath, "main"],
      { cwd: `${workDir}/VibeCoder` },
    );

    const result = await createFeatureBranchFromBase(otherBranch, "main", {
      cwd: lanePath,
    });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "already used by worktree");
    }
    assertEquals(await headOf(outsidePath), otherBranch);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("primaryCloneHoldingBranch - returns the primary worktree path it is given (Issue #4789)", async () => {
  const { workDir, repoPath, lanePath } = await primaryHeldFixture();
  try {
    const stderr = `fatal: 'x' is already used by worktree at '${repoPath}'`;
    assertEquals(await primaryCloneHoldingBranch(stderr, lanePath), repoPath);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("primaryCloneHoldingBranch - undefined for a lane worktree, which is not the primary (Issue #4789)", async () => {
  const { workDir, repoPath, lanePath } = await primaryHeldFixture();
  try {
    const stderr = `fatal: 'x' is already used by worktree at '${lanePath}'`;
    assertEquals(
      await primaryCloneHoldingBranch(stderr, repoPath),
      undefined,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("primaryCloneHoldingBranch - undefined for a linked worktree outside the clone (Issue #4789)", async () => {
  const { workDir, repoPath } = await primaryHeldFixture();
  const outsidePath = `${workDir}/somebody-elses-worktree`;
  try {
    await runGitCommand(
      ["worktree", "add", "-b", "other-branch", outsidePath, "main"],
      { cwd: repoPath },
    );
    const stderr =
      `fatal: 'other-branch' is already used by worktree at '${outsidePath}'`;
    assertEquals(await primaryCloneHoldingBranch(stderr, repoPath), undefined);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("primaryCloneHoldingBranch - undefined when stderr names no held path (Issue #4789)", async () => {
  const { workDir, repoPath } = await primaryHeldFixture();
  try {
    assertEquals(
      await primaryCloneHoldingBranch(
        "fatal: a different refusal entirely",
        repoPath,
      ),
      undefined,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("primaryCloneHoldingBranch - undefined when cwd is not a git repository (Issue #4789)", async () => {
  const { workDir, repoPath } = await primaryHeldFixture();
  const notRepo = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "git_branch_not_a_repo_" }),
  );
  try {
    const stderr = `fatal: 'x' is already used by worktree at '${repoPath}'`;
    assertEquals(await primaryCloneHoldingBranch(stderr, notRepo), undefined);
  } finally {
    await Deno.remove(notRepo, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});
