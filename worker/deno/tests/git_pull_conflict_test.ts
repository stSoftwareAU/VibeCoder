/**
 * Tests for updatePrBranch conflict resolution (Issue #1313).
 *
 * Verifies that PRs flagged as "conflicting" with behindBy=0 are handled
 * correctly instead of returning early with "already up to date".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  isPrBranchConflictError,
  syncMilestoneBranchWithDefault,
  updatePrBranch,
} from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

// ---------------------------------------------------------------------------
// Helpers — create real git repos for integration testing
// ---------------------------------------------------------------------------

/** Create a temporary directory for test repos. */
async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "git_pull_conflict_test_" });
}

/** Initialise a bare "remote" repo and a "local" clone. */
async function setupTestRepos(
  tmpDir: string,
): Promise<{ remotePath: string; localPath: string }> {
  const remotePath = `${tmpDir}/remote.git`;
  const localPath = `${tmpDir}/local`;

  // Create bare remote
  await Deno.mkdir(remotePath, { recursive: true });
  await runGitCommand(["init", "--bare"], { cwd: remotePath });

  // Ensure the bare repo uses 'main' as the default branch.
  // On CI runners without init.defaultBranch configured, git may default to
  // 'master'. Setting symbolic-ref explicitly ensures the clone's default
  // branch is 'main', matching the branch names used throughout this test.
  await runGitCommand(
    ["symbolic-ref", "HEAD", "refs/heads/main"],
    { cwd: remotePath },
  );

  // Clone locally
  await runGitCommand(["clone", remotePath, localPath], { cwd: tmpDir });

  // Configure git user in local repo
  await runGitCommand(
    ["config", "user.email", "test@example.com"],
    { cwd: localPath },
  );
  await runGitCommand(
    ["config", "user.name", "Test User"],
    { cwd: localPath },
  );

  // Create initial commit on main
  await Deno.writeTextFile(`${localPath}/README.md`, "# Test Repo\n");
  await runGitCommand(["add", "README.md"], { cwd: localPath });
  await runGitCommand(["commit", "-m", "Initial commit"], { cwd: localPath });
  await runGitCommand(["push", "origin", "main"], { cwd: localPath });

  return { remotePath, localPath };
}

/** Clean up temporary directory. */
async function cleanup(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("updatePrBranch - returns early when not behind and no conflicting reason", async () => {
  const tmpDir = await createTempDir();
  try {
    const { localPath } = await setupTestRepos(tmpDir);

    // Create a feature branch with a commit
    await runGitCommand(["checkout", "-b", "feature-branch"], {
      cwd: localPath,
    });
    await Deno.writeTextFile(
      `${localPath}/feature.ts`,
      "export const x = 1;\n",
    );
    await runGitCommand(["add", "feature.ts"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Add feature"], { cwd: localPath });
    await runGitCommand(["push", "origin", "feature-branch"], {
      cwd: localPath,
    });

    // No changes to main — feature is not behind
    const result = await updatePrBranch(
      "feature-branch",
      "main",
      { cwd: localPath },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value, "already up to date");
    }
  } finally {
    await cleanup(tmpDir);
  }
});

/** Local + remote head SHAs of a branch, for "left untouched" assertions. */
async function heads(
  localPath: string,
  branch: string,
): Promise<{ local: string; remote: string }> {
  const local = await runGitCommand(["rev-parse", branch], { cwd: localPath });
  const remote = await runGitCommand(["rev-parse", `origin/${branch}`], {
    cwd: localPath,
  });
  return {
    local: local.ok ? local.value.stdout.trim() : "",
    remote: remote.ok ? remote.value.stdout.trim() : "",
  };
}

Deno.test("updatePrBranch - a 'conflicting' PR whose changes collide with the base is LEFT UNTOUCHED: no side-picking, no force-push, PR content preserved (Issue #4373)", async () => {
  const tmpDir = await createTempDir();
  try {
    const { localPath } = await setupTestRepos(tmpDir);

    // Feature branch modifies a file …
    await runGitCommand(["checkout", "-b", "feature-branch"], {
      cwd: localPath,
    });
    await Deno.writeTextFile(
      `${localPath}/shared.ts`,
      "// Feature version\nexport const x = 1;\n",
    );
    await runGitCommand(["add", "shared.ts"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Feature change"], { cwd: localPath });
    await runGitCommand(["push", "origin", "feature-branch"], {
      cwd: localPath,
    });
    // … and main changes the same lines.
    await runGitCommand(["checkout", "main"], { cwd: localPath });
    await Deno.writeTextFile(
      `${localPath}/shared.ts`,
      "// Main version\nexport const x = 2;\n",
    );
    await runGitCommand(["add", "shared.ts"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Main change"], { cwd: localPath });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });
    await runGitCommand(["checkout", "feature-branch"], { cwd: localPath });
    const before = await heads(localPath, "feature-branch");

    const result = await updatePrBranch(
      "feature-branch",
      "main",
      { cwd: localPath },
      "conflicting",
    );

    // Before Issue #4373 this "succeeded" by taking main's version of the
    // whole file and force-pushing — the PR's change silently vanished.
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(
        isPrBranchConflictError(result.error),
        true,
        result.error.message,
      );
      assertStringIncludes(result.error.message, "left untouched");
    }
    const after = await heads(localPath, "feature-branch");
    assertEquals(after, before, "local and remote heads unchanged");
    assertEquals(
      await Deno.readTextFile(`${localPath}/shared.ts`),
      "// Feature version\nexport const x = 1;\n",
      "the PR's content is preserved",
    );
    // No merge left in progress.
    const status = await runGitCommand(["status", "--porcelain"], {
      cwd: localPath,
    });
    assertEquals(status.ok && status.value.stdout.trim(), "");
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("updatePrBranch - a 'behind' PR whose rebase conflicts is aborted and LEFT UNTOUCHED, never side-picked (Issue #4373)", async () => {
  const tmpDir = await createTempDir();
  try {
    const { localPath } = await setupTestRepos(tmpDir);
    await Deno.writeTextFile(`${localPath}/config.json`, '{"version": 1}\n');
    await runGitCommand(["add", "config.json"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Add config"], { cwd: localPath });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });

    await runGitCommand(["checkout", "-b", "issue-42-update"], {
      cwd: localPath,
    });
    await Deno.writeTextFile(
      `${localPath}/config.json`,
      '{"version": 2, "feature": true}\n',
    );
    await runGitCommand(["add", "config.json"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Update config for feature"], {
      cwd: localPath,
    });
    await runGitCommand(["push", "origin", "issue-42-update"], {
      cwd: localPath,
    });

    await runGitCommand(["checkout", "main"], { cwd: localPath });
    await Deno.writeTextFile(
      `${localPath}/config.json`,
      '{"version": 3, "hotfix": true}\n',
    );
    await runGitCommand(["add", "config.json"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Hotfix config"], { cwd: localPath });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });
    await runGitCommand(["checkout", "issue-42-update"], { cwd: localPath });
    const before = await heads(localPath, "issue-42-update");

    // reason "behind": the rebase path.
    const result = await updatePrBranch(
      "issue-42-update",
      "main",
      { cwd: localPath },
      "behind",
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(
        isPrBranchConflictError(result.error),
        true,
        result.error.message,
      );
    }
    assertEquals(await heads(localPath, "issue-42-update"), before);
    assertEquals(
      await Deno.readTextFile(`${localPath}/config.json`),
      '{"version": 2, "feature": true}\n',
    );
    const rebasing = await runGitCommand([
      "rev-parse",
      "--git-path",
      "rebase-merge",
    ], { cwd: localPath });
    const rebaseDir = rebasing.ok ? rebasing.value.stdout.trim() : "";
    let inProgress = false;
    try {
      await Deno.stat(`${localPath}/${rebaseDir}`);
      inProgress = true;
    } catch { /* aborted */ }
    assertEquals(inProgress, false, "rebase aborted");
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("updatePrBranch - a 'behind' PR with NO conflict is still rebased and pushed (Issue #4373 keeps the clean path)", async () => {
  const tmpDir = await createTempDir();
  try {
    const { localPath } = await setupTestRepos(tmpDir);
    await runGitCommand(["checkout", "-b", "issue-7-docs"], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/docs.md`, "feature docs\n");
    await runGitCommand(["add", "docs.md"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Feature docs"], { cwd: localPath });
    await runGitCommand(["push", "origin", "issue-7-docs"], { cwd: localPath });
    await runGitCommand(["checkout", "main"], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/other.md`, "main change\n");
    await runGitCommand(["add", "other.md"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Main change"], { cwd: localPath });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });
    await runGitCommand(["checkout", "issue-7-docs"], { cwd: localPath });

    const result = await updatePrBranch("issue-7-docs", "main", {
      cwd: localPath,
    }, "behind");
    assertEquals(result.ok, true, JSON.stringify(result));
    const after = await heads(localPath, "issue-7-docs");
    assertEquals(after.local, after.remote, "rebased head force-pushed");
    // Both files present after the rebase.
    await Deno.stat(`${localPath}/other.md`);
    await Deno.stat(`${localPath}/docs.md`);
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("updatePrBranch - without conflicting reason returns early when not behind", async () => {
  const tmpDir = await createTempDir();
  try {
    const { localPath } = await setupTestRepos(tmpDir);

    // Create feature branch
    await runGitCommand(["checkout", "-b", "my-feature"], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/file.ts`, "content\n");
    await runGitCommand(["add", "file.ts"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Add file"], { cwd: localPath });
    await runGitCommand(["push", "origin", "my-feature"], { cwd: localPath });

    // Default reason (undefined) — should return "already up to date"
    const result = await updatePrBranch(
      "my-feature",
      "main",
      { cwd: localPath },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value, "already up to date");
    }

    // Explicit "behind" reason — should also return "already up to date"
    const result2 = await updatePrBranch(
      "my-feature",
      "main",
      { cwd: localPath },
      "behind",
    );

    assertEquals(result2.ok, true);
    if (result2.ok) {
      assertStringIncludes(result2.value, "already up to date");
    }
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// syncMilestoneBranchWithDefault — Issue #1517
// ---------------------------------------------------------------------------

Deno.test("syncMilestoneBranchWithDefault - succeeds when milestone branch exists only on remote (shallow clone scenario)", async () => {
  const tmpDir = await createTempDir();
  try {
    // Use setupTestRepos to produce a bare remote populated with `main`
    // plus a seed working clone we'll reuse to push further commits.
    const { remotePath, localPath: seedPath } = await setupTestRepos(tmpDir);

    // Create a shallow clone FIRST — mirrors production `git clone --depth=1
    // --no-single-branch`. At this point the remote only has `main`.
    const shallowPath = `${tmpDir}/shallow`;
    await runGitCommand(
      ["clone", "--depth=1", "--no-single-branch", remotePath, shallowPath],
      { cwd: tmpDir },
    );
    await runGitCommand(["config", "user.email", "test@example.com"], {
      cwd: shallowPath,
    });
    await runGitCommand(["config", "user.name", "Test User"], {
      cwd: shallowPath,
    });

    // Now create the milestone branch on the remote AFTER the shallow clone
    // — exactly the Issue #1517 scenario. The shallow clone's
    // remote-tracking refs will not know about it.
    await runGitCommand(["checkout", "-b", "milestone/v1-0"], {
      cwd: seedPath,
    });
    await Deno.writeTextFile(
      `${seedPath}/milestone.ts`,
      "export const m = 1;\n",
    );
    await runGitCommand(["add", "milestone.ts"], { cwd: seedPath });
    await runGitCommand(["commit", "-m", "Milestone seed"], { cwd: seedPath });
    await runGitCommand(["push", "origin", "milestone/v1-0"], {
      cwd: seedPath,
    });

    // Precondition: milestone branch is absent from the shallow clone's
    // remote-tracking refs (the scenario that triggers the warning).
    const refsResult = await runGitCommand(
      ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"],
      { cwd: shallowPath },
    );
    assertEquals(refsResult.ok, true);
    if (refsResult.ok) {
      assertEquals(
        refsResult.value.stdout.includes("refs/remotes/origin/milestone/v1-0"),
        false,
        "precondition: milestone branch must be absent from local remote-tracking refs",
      );
    }

    // Advance main on the remote so the sync has something to merge
    await runGitCommand(["checkout", "main"], { cwd: seedPath });
    await Deno.writeTextFile(
      `${seedPath}/main-update.ts`,
      "export const u = 1;\n",
    );
    await runGitCommand(["add", "main-update.ts"], { cwd: seedPath });
    await runGitCommand(["commit", "-m", "Main update"], { cwd: seedPath });
    await runGitCommand(["push", "origin", "main"], { cwd: seedPath });

    const result = await syncMilestoneBranchWithDefault(
      "milestone/v1-0",
      "main",
      { cwd: shallowPath },
    );

    assertEquals(
      result.ok,
      true,
      `expected sync to succeed, got: ${
        result.ok ? "ok" : result.error.message
      }`,
    );

    // Verify we actually ended up on the milestone branch
    const branchResult = await runGitCommand(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: shallowPath },
    );
    assertEquals(branchResult.ok, true);
    if (branchResult.ok) {
      assertEquals(branchResult.value.stdout.trim(), "milestone/v1-0");
    }
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("syncMilestoneBranchWithDefault - a non-conflict merge failure is a failure, not a success (Issue #4260)", async () => {
  const tmpDir = await createTempDir();
  try {
    const { localPath } = await setupTestRepos(tmpDir);

    // An orphan milestone branch: merging main into it fails with
    // "refusing to merge unrelated histories" — a merge failure with ZERO
    // conflicted files, exactly the branch that was reported as
    // "Synced … Could not resolve merge conflicts — aborted" with ok:true.
    await runGitCommand(
      ["checkout", "--orphan", "milestone/test-4260"],
      { cwd: localPath },
    );
    await runGitCommand(["rm", "-rf", "--cached", "."], { cwd: localPath });
    await Deno.remove(`${localPath}/README.md`).catch(() => undefined);
    await Deno.writeTextFile(`${localPath}/NOTES.md`, "unrelated\n");
    await runGitCommand(["add", "NOTES.md"], { cwd: localPath });
    await runGitCommand(
      ["commit", "-m", "Unrelated history"],
      { cwd: localPath },
    );
    await runGitCommand(
      ["push", "origin", "milestone/test-4260"],
      { cwd: localPath },
    );

    const result = await syncMilestoneBranchWithDefault(
      "milestone/test-4260",
      "main",
      { cwd: localPath },
    );

    assertEquals(
      result.ok,
      false,
      "a merge that fails with no conflicted files must not report success",
    );
    if (!result.ok) {
      assertStringIncludes(result.error.message, "milestone/test-4260");
      assertStringIncludes(
        result.error.message.toLowerCase(),
        "unrelated histories",
        "the git stderr naming the real reason must survive into the error",
      );
    }
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("syncMilestoneBranchWithDefault - a blocked checkout surfaces git's stderr (Issue #49)", async () => {
  const tmpDir = await createTempDir();
  try {
    const { remotePath, localPath: seedPath } = await setupTestRepos(tmpDir);

    const shallowPath = `${tmpDir}/shallow`;
    await runGitCommand(
      ["clone", "--depth=1", "--no-single-branch", remotePath, shallowPath],
      { cwd: tmpDir },
    );
    await runGitCommand(["config", "user.email", "test@example.com"], {
      cwd: shallowPath,
    });
    await runGitCommand(["config", "user.name", "Test User"], {
      cwd: shallowPath,
    });

    // A milestone branch on the remote adds `milestone.ts`.
    await runGitCommand(["checkout", "-b", "milestone/v1-0"], {
      cwd: seedPath,
    });
    await Deno.writeTextFile(
      `${seedPath}/milestone.ts`,
      "export const m = 1;\n",
    );
    await runGitCommand(["add", "milestone.ts"], { cwd: seedPath });
    await runGitCommand(["commit", "-m", "Milestone seed"], { cwd: seedPath });
    await runGitCommand(["push", "origin", "milestone/v1-0"], {
      cwd: seedPath,
    });

    // The shallow clone has a DIRTY tree: an untracked `milestone.ts` (as a
    // timed-out prior claim might leave). `git checkout milestone/v1-0` refuses
    // to overwrite it — the exact production scenario.
    await Deno.writeTextFile(
      `${shallowPath}/milestone.ts`,
      "leftover uncommitted work\n",
    );

    const result = await syncMilestoneBranchWithDefault(
      "milestone/v1-0",
      "main",
      { cwd: shallowPath },
    );

    assertEquals(result.ok, false, "a blocked checkout must fail");
    if (!result.ok) {
      // The message names the branch AND carries git's own diagnosis.
      assertStringIncludes(result.error.message, "milestone/v1-0");
      assertStringIncludes(result.error.message, "overwritten");
      assertStringIncludes(result.error.message, "milestone.ts");
    }
  } finally {
    await cleanup(tmpDir);
  }
});
