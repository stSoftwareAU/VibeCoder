/**
 * Tests for the milestone sync against a dirty shared clone (Issue #568).
 *
 * `${WORK_DIR}/<repo>` is shared scratch: a timed-out claim or an abandoned
 * pass routinely leaves uncommitted files in it. `git checkout` then refuses
 * ("Your local changes to the following files would be overwritten"), the sync
 * recorded `sync_failed` and moved on, and the milestone branch drifted behind
 * the default line — which is the drift that produces the conflicting child
 * PRs the merge-conflict lane spends agent time on.
 *
 * Real git throughout: the behaviour under test is git's own refusal, which a
 * stub would only re-describe.
 *
 * The clone is left parked on a FEATURE branch, which is what makes the dirt
 * survive: `ensureDefaultBranchCurrent` resets the tree only when the clone is
 * already on the default branch, and otherwise just moves the ref. That is the
 * observed shape — a clone on `issue-540-…` with `docs/IDLE-TASK-FRAMEWORK.md`
 * modified.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

/** A clone carrying `main` and a milestone branch, both pushed. */
async function setupCloneWithMilestone(): Promise<{
  tmpDir: string;
  localPath: string;
  milestone: string;
}> {
  const tmpDir = await Deno.makeTempDir({ prefix: "milestone_dirty_" });
  const remotePath = `${tmpDir}/remote.git`;
  const localPath = `${tmpDir}/local`;
  const milestone = "milestone/1-collection";

  await Deno.mkdir(remotePath, { recursive: true });
  await runGitCommand(["init", "--bare"], { cwd: remotePath });
  await runGitCommand(["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: remotePath,
  });
  await runGitCommand(["clone", remotePath, localPath], { cwd: tmpDir });
  const git = (args: string[]) => runGitCommand(args, { cwd: localPath });
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);

  await Deno.writeTextFile(`${localPath}/shared.txt`, "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Initial commit"]);
  await git(["push", "origin", "main"]);

  // The milestone branch, then a commit on main it is behind by.
  await git(["checkout", "-b", milestone]);
  await git(["push", "origin", milestone]);
  await git(["checkout", "main"]);
  await Deno.writeTextFile(`${localPath}/shared.txt`, "base\nfrom main\n");
  await git(["commit", "-am", "Advance main"]);
  await git(["push", "origin", "main"]);

  return { tmpDir, localPath, milestone };
}

Deno.test("syncMilestoneBranchWithDefault - a dirty shared clone is reset rather than failing the sync", async () => {
  const { tmpDir, localPath, milestone } = await setupCloneWithMilestone();
  try {
    // What a timed-out claim leaves behind: parked on its own branch with an
    // uncommitted edit to a file the checkout needs to change.
    await runGitCommand(["checkout", "-b", "issue-42-abandoned"], {
      cwd: localPath,
    });
    await Deno.writeTextFile(
      `${localPath}/shared.txt`,
      "base\nfrom main\nabandoned edit\n",
    );

    const result = await syncMilestoneBranchWithDefault(milestone, "main", {
      cwd: localPath,
    });

    assert(
      result.ok,
      `sync should succeed, got: ${
        (result as { error?: Error }).error?.message
      }`,
    );
    // It says what it discarded — a surprise must stay diagnosable.
    assertStringIncludes(result.value, "SELF-HEALING");
    assertStringIncludes(result.value, "shared.txt");

    // The branch really is on the milestone line with main integrated.
    const branch = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: localPath,
    });
    assert(branch.ok);
    assertEquals(branch.value.stdout.trim(), milestone);
    const content = await Deno.readTextFile(`${localPath}/shared.txt`);
    assertStringIncludes(content, "from main");
    assertEquals(content.includes("abandoned edit"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranchWithDefault - an untracked file does not block the checkout either", async () => {
  const { tmpDir, localPath, milestone } = await setupCloneWithMilestone();
  try {
    await runGitCommand(["checkout", "-b", "issue-43-abandoned"], {
      cwd: localPath,
    });
    await Deno.writeTextFile(`${localPath}/scratch-output.log`, "leftover\n");

    const result = await syncMilestoneBranchWithDefault(milestone, "main", {
      cwd: localPath,
    });

    assert(result.ok);
    assertEquals(
      await Deno.stat(`${localPath}/scratch-output.log`).then(
        () => true,
        () => false,
      ),
      false,
      "an untracked leftover must be cleaned, not carried onto the branch",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranchWithDefault - a clean clone reports no self-healing", async () => {
  const { tmpDir, localPath, milestone } = await setupCloneWithMilestone();
  try {
    const result = await syncMilestoneBranchWithDefault(milestone, "main", {
      cwd: localPath,
    });

    assert(result.ok);
    assertEquals(
      result.value.includes("discarded"),
      false,
      `a clean clone must not claim a discard: ${result.value}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
