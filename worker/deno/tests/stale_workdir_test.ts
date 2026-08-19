/**
 * Tests for stale_workdir.ts — detect and remove stale repository work
 * directories without requiring a disk-full trigger (Issue #1493).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyWorkDir,
  DEFAULT_STALE_WORKDIR_DAYS,
  scanAndCleanupStaleWorkDirs,
} from "../lib/stale_workdir.ts";

async function makeTempWorkDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "vibe-stale-workdir-" });
}

async function makeRepoClone(workDir: string, name: string): Promise<string> {
  const path = `${workDir}/${name}`;
  await Deno.mkdir(`${path}/.git`, { recursive: true });
  return path;
}

async function makePartialClone(
  workDir: string,
  name: string,
): Promise<string> {
  const path = `${workDir}/${name}`;
  await Deno.mkdir(path, { recursive: true });
  return path;
}

async function writeHeartbeat(
  workDir: string,
  owner: string,
  repo: string,
  issue: number,
  epoch: number,
): Promise<void> {
  await Deno.writeTextFile(
    `${workDir}/.heartbeat_${owner}_${repo}_${issue}`,
    String(epoch),
  );
}

function setMtime(path: string, daysAgo: number, now: number): Promise<void> {
  const atime = new Date(now * 1000);
  const mtime = new Date((now - daysAgo * 86400) * 1000);
  return Deno.utime(path, atime, mtime);
}

// ============================================================================
// Constants
// ============================================================================

Deno.test("stale_workdir - default age threshold is 7 days", () => {
  assertEquals(DEFAULT_STALE_WORKDIR_DAYS, 7);
});

// ============================================================================
// classifyWorkDir
// ============================================================================

Deno.test("classifyWorkDir - fresh heartbeat marks directory active", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makeRepoClone(workDir, "my-repo");
    const now = Math.floor(Date.now() / 1000);
    // Mtime 30 days ago — would otherwise be stale
    await setMtime(repoPath, 30, now);
    await writeHeartbeat(workDir, "acme", "my-repo", 42, now - 60);

    const result = await classifyWorkDir(
      workDir,
      repoPath,
      7 * 86400,
      now,
    );
    assertEquals(result.kind, "active");
    assertStringIncludes(result.reason, "heartbeat");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("classifyWorkDir - stale heartbeat does not keep directory alive", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makeRepoClone(workDir, "my-repo");
    const now = Math.floor(Date.now() / 1000);
    await setMtime(repoPath, 30, now);
    // Heartbeat 30 days old — stale
    await writeHeartbeat(workDir, "acme", "my-repo", 42, now - 30 * 86400);

    const result = await classifyWorkDir(
      workDir,
      repoPath,
      7 * 86400,
      now,
    );
    assertEquals(result.kind, "stale");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("classifyWorkDir - recently modified dir is active", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makeRepoClone(workDir, "my-repo");
    const now = Math.floor(Date.now() / 1000);
    await setMtime(repoPath, 1, now);

    const result = await classifyWorkDir(
      workDir,
      repoPath,
      7 * 86400,
      now,
    );
    assertEquals(result.kind, "active");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("classifyWorkDir - no heartbeat and old mtime is stale", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makeRepoClone(workDir, "my-repo");
    const now = Math.floor(Date.now() / 1000);
    await setMtime(repoPath, 30, now);

    const result = await classifyWorkDir(
      workDir,
      repoPath,
      7 * 86400,
      now,
    );
    assertEquals(result.kind, "stale");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("classifyWorkDir - missing .git is partial", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makePartialClone(workDir, "my-repo");
    const now = Math.floor(Date.now() / 1000);
    // Even with a recent mtime, missing .git means broken/partial
    await setMtime(repoPath, 0, now);

    const result = await classifyWorkDir(
      workDir,
      repoPath,
      7 * 86400,
      now,
    );
    assertEquals(result.kind, "partial");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// scanAndCleanupStaleWorkDirs
// ============================================================================

Deno.test("scanAndCleanupStaleWorkDirs - removes stale repo", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makeRepoClone(workDir, "old-repo");
    const now = Math.floor(Date.now() / 1000);
    await setMtime(repoPath, 30, now);

    const result = await scanAndCleanupStaleWorkDirs({
      workDir,
      maxAgeDays: 7,
      nowFn: () => now,
    });

    assertEquals(result.scanned, 1);
    assertEquals(result.removedStale, ["old-repo"]);
    assertEquals(result.removedPartial, []);
    assertEquals(result.active, []);
    // Directory should be gone
    let existed = true;
    try {
      await Deno.stat(repoPath);
    } catch {
      existed = false;
    }
    assertEquals(existed, false);
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* already removed */ }
  }
});

Deno.test("scanAndCleanupStaleWorkDirs - preserves active repo", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makeRepoClone(workDir, "active-repo");
    const now = Math.floor(Date.now() / 1000);
    await setMtime(repoPath, 30, now);
    await writeHeartbeat(workDir, "acme", "active-repo", 7, now - 60);

    const result = await scanAndCleanupStaleWorkDirs({
      workDir,
      maxAgeDays: 7,
      nowFn: () => now,
    });

    assertEquals(result.scanned, 1);
    assertEquals(result.removedStale, []);
    assertEquals(result.active, ["active-repo"]);
    // Directory should still exist
    const stat = await Deno.stat(repoPath);
    assertEquals(stat.isDirectory, true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("scanAndCleanupStaleWorkDirs - removes partial clone", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makePartialClone(workDir, "partial-repo");
    const now = Math.floor(Date.now() / 1000);

    const result = await scanAndCleanupStaleWorkDirs({
      workDir,
      maxAgeDays: 7,
      nowFn: () => now,
    });

    assertEquals(result.scanned, 1);
    assertEquals(result.removedPartial, ["partial-repo"]);
    let existed = true;
    try {
      await Deno.stat(repoPath);
    } catch {
      existed = false;
    }
    assertEquals(existed, false);
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* already removed */ }
  }
});

Deno.test("scanAndCleanupStaleWorkDirs - ignores dot-prefixed entries", async () => {
  const workDir = await makeTempWorkDir();
  try {
    // Dot-prefixed directories like .claude-sessions should be left alone
    await Deno.mkdir(`${workDir}/.claude-sessions`, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    await setMtime(`${workDir}/.claude-sessions`, 30, now);

    const result = await scanAndCleanupStaleWorkDirs({
      workDir,
      maxAgeDays: 7,
      nowFn: () => now,
    });

    assertEquals(result.scanned, 0);
    // Still exists
    const stat = await Deno.stat(`${workDir}/.claude-sessions`);
    assertEquals(stat.isDirectory, true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("scanAndCleanupStaleWorkDirs - ignores reserved subdirs (logs)", async () => {
  // The self-heal events emitter creates ${workDir}/logs/self-heal.jsonl.
  // That directory has no .git and would otherwise be classified as
  // "partial" and removed every cycle, only to be recreated by the next
  // self-heal event. Reserved names must be skipped outright.
  const workDir = await makeTempWorkDir();
  try {
    await Deno.mkdir(`${workDir}/logs`, { recursive: true });
    await Deno.writeTextFile(`${workDir}/logs/self-heal.jsonl`, "{}\n");

    const result = await scanAndCleanupStaleWorkDirs({
      workDir,
      maxAgeDays: 7,
      nowFn: () => Math.floor(Date.now() / 1000),
    });

    assertEquals(result.scanned, 0);
    assertEquals(result.removedPartial, []);
    const stat = await Deno.stat(`${workDir}/logs`);
    assertEquals(stat.isDirectory, true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("scanAndCleanupStaleWorkDirs - ignores files in workDir root", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await Deno.writeTextFile(`${workDir}/not-a-repo.txt`, "hi");

    const result = await scanAndCleanupStaleWorkDirs({
      workDir,
      maxAgeDays: 7,
      nowFn: () => Math.floor(Date.now() / 1000),
    });

    assertEquals(result.scanned, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("scanAndCleanupStaleWorkDirs - handles missing workDir gracefully", async () => {
  const result = await scanAndCleanupStaleWorkDirs({
    workDir: "/tmp/nonexistent-vibe-stale-1493",
    maxAgeDays: 7,
  });
  assertEquals(result.scanned, 0);
  assertEquals(result.errors.length, 1);
});

Deno.test("scanAndCleanupStaleWorkDirs - configurable age threshold", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makeRepoClone(workDir, "ten-day-repo");
    const now = Math.floor(Date.now() / 1000);
    await setMtime(repoPath, 10, now);

    // 30-day threshold — 10-day-old dir should be active
    const kept = await scanAndCleanupStaleWorkDirs({
      workDir,
      maxAgeDays: 30,
      nowFn: () => now,
    });
    assertEquals(kept.active, ["ten-day-repo"]);

    // 5-day threshold — 10-day-old dir should be stale
    const removed = await scanAndCleanupStaleWorkDirs({
      workDir,
      maxAgeDays: 5,
      nowFn: () => now,
    });
    assertEquals(removed.removedStale, ["ten-day-repo"]);
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* ignore */ }
  }
});

Deno.test("scanAndCleanupStaleWorkDirs - emits SELF-HEALING log prefix on removal", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const repoPath = await makeRepoClone(workDir, "bye-repo");
    const now = Math.floor(Date.now() / 1000);
    await setMtime(repoPath, 30, now);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await scanAndCleanupStaleWorkDirs({
        workDir,
        maxAgeDays: 7,
        nowFn: () => now,
      });
    } finally {
      console.log = origLog;
    }

    const matches = logs.filter((l) => l.includes("SELF-HEALING"));
    assertEquals(matches.length > 0, true);
    assertStringIncludes(matches[0]!, "bye-repo");
  } finally {
    try {
      await Deno.remove(workDir, { recursive: true });
    } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// ext4 volume artefacts (Issue #4212)
// ---------------------------------------------------------------------------

Deno.test("scanStaleWorkDirs - leaves the ext4 lost+found directory alone (Issue #4212)", async () => {
  // The vibe-work named volume (#4203) is a real ext4 filesystem whose root
  // always carries a root-owned lost+found. Classifying it as a partial
  // clone produced a Permission-denied SELF-HEALING warning every cycle.
  const workDir = await Deno.makeTempDir({ prefix: "stale_workdir_lf_" });
  try {
    await Deno.mkdir(`${workDir}/lost+found`);
    const result = await scanAndCleanupStaleWorkDirs({ workDir });
    assertEquals(result.scanned, 0, "lost+found must not be scanned");
    assertEquals(result.removedPartial, []);
    assertEquals(result.errors, []);
    // Still present afterwards.
    assertEquals((await Deno.stat(`${workDir}/lost+found`)).isDirectory, true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Push-before-delete rescue (Issue #4170)
// ---------------------------------------------------------------------------

async function runRescueGit(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

/** Build an origin repo plus a clone with an unpushed issue-branch commit. */
async function buildUnpushedFixture(
  tmp: string,
): Promise<{ upstream: string; clone: string }> {
  const upstream = `${tmp}/upstream`;
  const clone = `${tmp}/clone`;
  await Deno.mkdir(upstream, { recursive: true });
  await runRescueGit(["init", "--bare", "-b", "main"], upstream);
  const seed = `${tmp}/seed`;
  await runRescueGit(["clone", upstream, seed], tmp);
  await Deno.writeTextFile(`${seed}/base.txt`, "base\n");
  await runRescueGit(["add", "base.txt"], seed);
  await runRescueGit(["commit", "-m", "base"], seed);
  await runRescueGit(["push", "origin", "main"], seed);
  await runRescueGit(["clone", upstream, clone], tmp);
  await runRescueGit(["checkout", "-b", "issue-11-wip"], clone);
  await Deno.writeTextFile(`${clone}/wip.txt`, "unpushed work\n");
  await runRescueGit(["add", "wip.txt"], clone);
  await runRescueGit(["commit", "-m", "WIP"], clone);
  return { upstream, clone };
}

Deno.test("stale_workdir - pushUnpushedBranches rescues an unpushed issue branch (Issue #4170)", async () => {
  const { pushUnpushedBranches } = await import("../lib/stale_workdir.ts");
  const tmp = await Deno.makeTempDir({ prefix: "stale_rescue_" });
  try {
    const { upstream, clone } = await buildUnpushedFixture(tmp);
    const rescue = await pushUnpushedBranches(clone);
    assertEquals(rescue.ok, true);
    assertEquals(rescue.pushedBranches, ["issue-11-wip"]);
    // The commit is now on the origin.
    const remote = await runRescueGit(
      ["log", "issue-11-wip", "--oneline", "-1"],
      upstream,
    );
    assertEquals(remote.code, 0);
    assert(remote.stdout.includes("WIP"));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stale_workdir - pushUnpushedBranches is a no-op on a fully pushed clone", async () => {
  const { pushUnpushedBranches } = await import("../lib/stale_workdir.ts");
  const tmp = await Deno.makeTempDir({ prefix: "stale_rescue_" });
  try {
    const { clone } = await buildUnpushedFixture(tmp);
    await runRescueGit(["push", "origin", "issue-11-wip"], clone);
    const rescue = await pushUnpushedBranches(clone);
    assertEquals(rescue.ok, true);
    assertEquals(rescue.pushedBranches, []);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stale_workdir - a failing push keeps the stale directory with a loud warning (Issue #4170)", async () => {
  const { scanAndCleanupStaleWorkDirs } = await import(
    "../lib/stale_workdir.ts"
  );
  const tmp = await Deno.makeTempDir({ prefix: "stale_rescue_" });
  try {
    const { upstream, clone } = await buildUnpushedFixture(tmp);
    // Sever the origin so the rescue push must fail.
    await Deno.remove(upstream, { recursive: true });
    // Move the clone into a scanned work dir and age it out.
    const workDir = `${tmp}/work`;
    await Deno.mkdir(workDir, { recursive: true });
    const repoDir = `${workDir}/repo`;
    await Deno.rename(clone, repoDir);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await Deno.utime(repoDir, old, old);

    const result = await scanAndCleanupStaleWorkDirs({ workDir });
    assertEquals(result.removedStale, []);
    assertEquals(result.errors.length, 1);
    assert(result.errors[0]!.includes("unpushed"), result.errors[0]!);
    // The directory (and the unpushed work) survives.
    await Deno.stat(`${repoDir}/wip.txt`);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stale_workdir - a stale clone with pushed-only work is still removed after rescue (Issue #4170)", async () => {
  const { scanAndCleanupStaleWorkDirs } = await import(
    "../lib/stale_workdir.ts"
  );
  const tmp = await Deno.makeTempDir({ prefix: "stale_rescue_" });
  try {
    const { upstream, clone } = await buildUnpushedFixture(tmp);
    const workDir = `${tmp}/work`;
    await Deno.mkdir(workDir, { recursive: true });
    const repoDir = `${workDir}/repo`;
    await Deno.rename(clone, repoDir);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await Deno.utime(repoDir, old, old);

    const result = await scanAndCleanupStaleWorkDirs({ workDir });
    // The rescue pushed the WIP branch, then the removal proceeded.
    assertEquals(result.removedStale, ["repo"]);
    const remote = await runRescueGit(
      ["log", "issue-11-wip", "--oneline", "-1"],
      upstream,
    );
    assertEquals(remote.code, 0);
    assert(remote.stdout.includes("WIP"));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
  }
});
