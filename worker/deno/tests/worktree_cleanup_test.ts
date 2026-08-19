/**
 * Tests for worktree_cleanup.ts — orphaned git worktree cleanup (Issue #1492).
 *
 * Each test sets up a real git repository in a temp directory and exercises
 * the real `git worktree` subcommands. No source inspection or mocking of
 * git itself.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  branchExists,
  cleanupOrphanedWorktrees,
  DEFAULT_MAX_AGE_HOURS,
  parseWorktreeList,
} from "../lib/worktree_cleanup.ts";

async function makeTempWorkDir(): Promise<string> {
  // Resolve symlinks (macOS /var → /private/var) so paths match the
  // absolute paths git reports in `worktree list --porcelain`.
  const raw = await Deno.makeTempDir({ prefix: "vibe-worktree-cleanup-" });
  return await Deno.realPath(raw);
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Create a git repo with one commit on the default branch `main`. */
async function makeRepo(workDir: string, name: string): Promise<string> {
  const path = `${workDir}/${name}`;
  await Deno.mkdir(path, { recursive: true });
  const init = await runGit(path, ["init", "-q", "-b", "main"]);
  assertEquals(init.code, 0, `git init failed: ${init.stderr}`);
  const commit = await runGit(path, [
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "initial",
  ]);
  assertEquals(commit.code, 0, `git commit failed: ${commit.stderr}`);
  return path;
}

/** Add a linked worktree on a new branch. Returns the absolute worktree path. */
async function addWorktree(
  repoDir: string,
  wtPath: string,
  branch: string,
): Promise<void> {
  const r = await runGit(repoDir, [
    "worktree",
    "add",
    "-q",
    wtPath,
    "-b",
    branch,
  ]);
  assertEquals(r.code, 0, `git worktree add failed: ${r.stderr}`);
}

/** Force-delete a branch ref directly via update-ref (bypasses the worktree guard). */
async function deleteBranchRef(repoDir: string, branch: string): Promise<void> {
  const r = await runGit(repoDir, ["update-ref", "-d", `refs/heads/${branch}`]);
  assertEquals(r.code, 0, `update-ref -d failed: ${r.stderr}`);
}

/** Set mtime on a path relative to now (using seconds ago). */
async function setMtimeSecondsAgo(
  path: string,
  secondsAgo: number,
): Promise<void> {
  const now = new Date();
  const mtime = new Date(now.getTime() - secondsAgo * 1000);
  await Deno.utime(path, now, mtime);
}

// ============================================================================
// Constants
// ============================================================================

Deno.test("worktree_cleanup - default max age is 24 hours", () => {
  assertEquals(DEFAULT_MAX_AGE_HOURS, 24);
});

// ============================================================================
// parseWorktreeList
// ============================================================================

Deno.test("parseWorktreeList - parses main + linked worktrees", () => {
  const porcelain = "worktree /tmp/repo\n" +
    "HEAD abc123\n" +
    "branch refs/heads/main\n" +
    "\n" +
    "worktree /tmp/wt-a\n" +
    "HEAD abc123\n" +
    "branch refs/heads/feature-a\n";
  const entries = parseWorktreeList(porcelain);
  assertEquals(entries.length, 2);
  assertEquals(entries[0], {
    path: "/tmp/repo",
    branch: "refs/heads/main",
    isMain: true,
  });
  assertEquals(entries[1], {
    path: "/tmp/wt-a",
    branch: "refs/heads/feature-a",
    isMain: false,
  });
});

Deno.test("parseWorktreeList - detached worktree has null branch", () => {
  const porcelain = "worktree /tmp/repo\n" +
    "HEAD abc123\n" +
    "branch refs/heads/main\n" +
    "\n" +
    "worktree /tmp/wt-d\n" +
    "HEAD abc123\n" +
    "detached\n";
  const entries = parseWorktreeList(porcelain);
  assertEquals(entries.length, 2);
  assertEquals(entries[1]!.branch, null);
});

Deno.test("parseWorktreeList - empty input yields no entries", () => {
  assertEquals(parseWorktreeList(""), []);
});

// ============================================================================
// branchExists
// ============================================================================

Deno.test("branchExists - true for existing branch, false for missing", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repo = await makeRepo(workDir, "repo");
    assertEquals(await branchExists(repo, "refs/heads/main"), true);
    assertEquals(await branchExists(repo, "refs/heads/does-not-exist"), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// cleanupOrphanedWorktrees — happy paths
// ============================================================================

Deno.test("cleanupOrphanedWorktrees - removes orphan (branch gone, old mtime)", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repo = await makeRepo(workDir, "repo");
    const wtPath = `${workDir}/repo-wt`;
    await addWorktree(repo, wtPath, "feature-orphan");
    await deleteBranchRef(repo, "feature-orphan");
    // Worktree is 48h old
    await setMtimeSecondsAgo(wtPath, 48 * 3600);

    const result = await cleanupOrphanedWorktrees({
      workDir,
      maxAgeHours: 24,
    });

    assertEquals(result.reposScanned, 1);
    assertEquals(result.removedDirs, [wtPath]);
    // Directory is gone
    let existed = true;
    try {
      await Deno.stat(wtPath);
    } catch {
      existed = false;
    }
    assertEquals(existed, false);
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* ignore */ }
  }
});

Deno.test("cleanupOrphanedWorktrees - preserves active worktree (branch exists)", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repo = await makeRepo(workDir, "repo");
    const wtPath = `${workDir}/repo-wt`;
    await addWorktree(repo, wtPath, "feature-alive");
    // Even if old, the branch still exists — must keep
    await setMtimeSecondsAgo(wtPath, 72 * 3600);

    const result = await cleanupOrphanedWorktrees({
      workDir,
      maxAgeHours: 24,
    });

    assertEquals(result.removedDirs, []);
    const stat = await Deno.stat(wtPath);
    assertEquals(stat.isDirectory, true);
    assertEquals(result.preserved.length, 1);
    assertStringIncludes(result.preserved[0]!, "feature-alive");
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* ignore */ }
  }
});

Deno.test("cleanupOrphanedWorktrees - preserves recent orphan (below age threshold)", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repo = await makeRepo(workDir, "repo");
    const wtPath = `${workDir}/repo-wt`;
    await addWorktree(repo, wtPath, "feature-recent");
    await deleteBranchRef(repo, "feature-recent");
    // Only 1h old — safely below the 24h threshold
    await setMtimeSecondsAgo(wtPath, 3600);

    const result = await cleanupOrphanedWorktrees({
      workDir,
      maxAgeHours: 24,
    });

    assertEquals(result.removedDirs, []);
    const stat = await Deno.stat(wtPath);
    assertEquals(stat.isDirectory, true);
    assert(result.preserved.some((p) => p.includes("below threshold")));
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* ignore */ }
  }
});

Deno.test("cleanupOrphanedWorktrees - prunes admin files for deleted worktree dir", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repo = await makeRepo(workDir, "repo");
    const wtPath = `${workDir}/repo-wt`;
    await addWorktree(repo, wtPath, "feature-manual");
    // Manually remove the directory without using `git worktree remove` —
    // this leaves behind admin files that `git worktree prune` cleans up.
    await Deno.remove(wtPath, { recursive: true });

    const result = await cleanupOrphanedWorktrees({
      workDir,
      maxAgeHours: 24,
    });

    assertEquals(result.reposScanned, 1);
    assert(
      result.pruned >= 1,
      `expected at least one prune, got ${result.pruned}`,
    );
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* ignore */ }
  }
});

// ============================================================================
// cleanupOrphanedWorktrees — no-ops and edge cases
// ============================================================================

Deno.test("cleanupOrphanedWorktrees - no-op when no repos present", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const result = await cleanupOrphanedWorktrees({
      workDir,
      maxAgeHours: 24,
    });
    assertEquals(result.reposScanned, 0);
    assertEquals(result.removedDirs, []);
    assertEquals(result.pruned, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cleanupOrphanedWorktrees - skips non-repo directories", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await Deno.mkdir(`${workDir}/just-a-dir`, { recursive: true });
    const result = await cleanupOrphanedWorktrees({
      workDir,
      maxAgeHours: 24,
    });
    // No .git folder — should not count as a scanned repo
    assertEquals(result.reposScanned, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cleanupOrphanedWorktrees - ignores dot-prefixed entries", async () => {
  const workDir = await makeTempWorkDir();
  try {
    // .claude-sessions etc. should be left alone
    await Deno.mkdir(`${workDir}/.claude-sessions/.git`, { recursive: true });
    const result = await cleanupOrphanedWorktrees({
      workDir,
      maxAgeHours: 24,
    });
    assertEquals(result.reposScanned, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cleanupOrphanedWorktrees - missing workDir collects error without throwing", async () => {
  const result = await cleanupOrphanedWorktrees({
    workDir: "/tmp/vibe-worktree-cleanup-nonexistent-1492",
    maxAgeHours: 24,
  });
  assertEquals(result.reposScanned, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0]!, "Cannot read");
});

Deno.test("cleanupOrphanedWorktrees - empty workDir returns error", async () => {
  const result = await cleanupOrphanedWorktrees({ workDir: "" });
  assertEquals(result.reposScanned, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0]!, "workDir is required");
});

Deno.test("cleanupOrphanedWorktrees - emits SELF-HEALING log on removal", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repo = await makeRepo(workDir, "repo");
    const wtPath = `${workDir}/repo-wt`;
    await addWorktree(repo, wtPath, "feature-orphan");
    await deleteBranchRef(repo, "feature-orphan");
    await setMtimeSecondsAgo(wtPath, 48 * 3600);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await cleanupOrphanedWorktrees({ workDir, maxAgeHours: 24 });
    } finally {
      console.log = origLog;
    }

    const matches = logs.filter((l) => l.includes("SELF-HEALING"));
    assert(matches.length > 0, "expected at least one SELF-HEALING log line");
    assert(
      matches.some((l) => l.includes(wtPath)),
      `expected log to mention ${wtPath}`,
    );
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* ignore */ }
  }
});

Deno.test("cleanupOrphanedWorktrees - processes multiple repositories", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoA = await makeRepo(workDir, "repo-a");
    const repoB = await makeRepo(workDir, "repo-b");
    const wtA = `${workDir}/repo-a-wt`;
    const wtB = `${workDir}/repo-b-wt`;
    await addWorktree(repoA, wtA, "orphan-a");
    await addWorktree(repoB, wtB, "orphan-b");
    await deleteBranchRef(repoA, "orphan-a");
    await deleteBranchRef(repoB, "orphan-b");
    await setMtimeSecondsAgo(wtA, 48 * 3600);
    await setMtimeSecondsAgo(wtB, 48 * 3600);

    const result = await cleanupOrphanedWorktrees({
      workDir,
      maxAgeHours: 24,
    });

    assertEquals(result.reposScanned, 2);
    assertEquals(result.removedDirs.length, 2);
    assert(result.removedDirs.includes(wtA));
    assert(result.removedDirs.includes(wtB));
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* ignore */ }
  }
});
