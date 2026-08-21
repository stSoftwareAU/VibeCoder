/**
 * Remote-head alignment tests (Issue #211).
 *
 * The branch-update pass reuses one working copy, so a PR branch can still
 * carry commits an earlier pass failed to push. Evaluating *those* against the
 * base labelled PR #557 `merge-conflict` while the remote PR was mergeable.
 * These tests drive real git repositories end to end.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { alignBranchWithRemoteHead } from "../lib/git_remote_head_align.ts";
import { isPrBranchConflictError, updatePrBranch } from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const BRANCH = "issue-556-fix";
const BASE = "Develop";

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(
      `git ${
        args.join(" ")
      } failed (${result.value.code}): ${result.value.stderr}`,
    );
  }
  return result.value.stdout.trim();
}

async function revParse(ref: string, cwd: string): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", ref],
    {
      cwd,
    },
  );
  if (!result.ok || result.value.code !== 0) return null;
  return result.value.stdout.trim();
}

interface TestRepos {
  tmpDir: string;
  remotePath: string;
  workerPath: string;
}

/**
 * Bare remote with a `Develop` base branch and a PR branch off it, cloned once
 * into the worker's reused working copy.
 */
async function setupRepos(): Promise<TestRepos> {
  const tmpDir = await Deno.makeTempDir({ prefix: "remote_head_align_" });
  const remotePath = `${tmpDir}/remote.git`;
  const workerPath = `${tmpDir}/worker`;

  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(["symbolic-ref", "HEAD", `refs/heads/${BASE}`], remotePath);

  await git(["clone", remotePath, workerPath], tmpDir);
  await git(["config", "user.email", "worker@example.com"], workerPath);
  await git(["config", "user.name", "Worker"], workerPath);
  await git(["checkout", "-b", BASE], workerPath);
  await Deno.writeTextFile(`${workerPath}/app.ts`, "export const a = 1;\n");
  await git(["add", "-A"], workerPath);
  await git(["commit", "-m", "Initial commit"], workerPath);
  await git(["push", "-u", "origin", BASE], workerPath);

  await git(["checkout", "-b", BRANCH], workerPath);
  await Deno.writeTextFile(`${workerPath}/feature.ts`, "export const f = 1;\n");
  await git(["add", "-A"], workerPath);
  await git(["commit", "-m", "PR commit"], workerPath);
  await git(["push", "-u", "origin", BRANCH], workerPath);

  return { tmpDir, remotePath, workerPath };
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// alignBranchWithRemoteHead
// ---------------------------------------------------------------------------

Deno.test("alignBranchWithRemoteHead - resets a branch carrying unpushed commits to the remote head", async () => {
  const { tmpDir, workerPath } = await setupRepos();
  try {
    const remoteHead = await revParse("HEAD", workerPath);
    await Deno.writeTextFile(`${workerPath}/local.ts`, "local only\n");
    await git(["add", "-A"], workerPath);
    await git(["commit", "-m", "Unpushed local commit"], workerPath);

    const result = await alignBranchWithRemoteHead(BRANCH, { cwd: workerPath });

    assert(
      result.ok,
      `expected success, got ${!result.ok && result.error.message}`,
    );
    assertEquals(result.value.aligned, true);
    assertEquals(result.value.discardedCommits, 1);
    assertEquals(await revParse("HEAD", workerPath), remoteHead);
    assertStringIncludes(result.value.detail, "unpushed local commit");
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("alignBranchWithRemoteHead - is a no-op when the branch already matches the remote", async () => {
  const { tmpDir, workerPath } = await setupRepos();
  try {
    const head = await revParse("HEAD", workerPath);

    const result = await alignBranchWithRemoteHead(BRANCH, { cwd: workerPath });

    assert(
      result.ok,
      `expected success, got ${!result.ok && result.error.message}`,
    );
    assertEquals(result.value.aligned, false);
    assertEquals(result.value.discardedCommits, 0);
    assertEquals(await revParse("HEAD", workerPath), head);
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("alignBranchWithRemoteHead - reports a no-op for a branch that was never pushed", async () => {
  const { tmpDir, workerPath } = await setupRepos();
  try {
    await git(["checkout", "-b", "never-pushed"], workerPath);
    await Deno.writeTextFile(`${workerPath}/new.ts`, "new\n");
    await git(["add", "-A"], workerPath);
    await git(["commit", "-m", "New work"], workerPath);
    const head = await revParse("HEAD", workerPath);

    const result = await alignBranchWithRemoteHead("never-pushed", {
      cwd: workerPath,
    });

    assert(
      result.ok,
      `expected success, got ${!result.ok && result.error.message}`,
    );
    assertEquals(result.value.aligned, false);
    assertEquals(await revParse("HEAD", workerPath), head, "no commits lost");
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// The regression: no spurious conflict verdict from stale local commits
// ---------------------------------------------------------------------------

Deno.test("updatePrBranch - a mergeable PR is not reported as conflicting because of unpushed local commits", async () => {
  const { tmpDir, workerPath } = await setupRepos();
  try {
    // The base moves on, touching a file the PR branch does not.
    await git(["checkout", BASE], workerPath);
    await Deno.writeTextFile(`${workerPath}/base.ts`, "export const b = 1;\n");
    await git(["add", "-A"], workerPath);
    await git(["commit", "-m", "Base commit"], workerPath);
    await git(["push", "origin", BASE], workerPath);

    // An earlier pass left unpushed commits on the PR branch that collide with
    // the base — the remote PR itself is perfectly mergeable.
    await git(["checkout", BRANCH], workerPath);
    await Deno.writeTextFile(`${workerPath}/base.ts`, "export const b = 99;\n");
    await git(["add", "-A"], workerPath);
    await git(
      ["commit", "-m", "Unpushed local commit that collides"],
      workerPath,
    );

    const result = await updatePrBranch(
      BRANCH,
      BASE,
      { cwd: workerPath },
      "behind",
    );

    assert(
      !isPrBranchConflictError(!result.ok ? result.error : undefined),
      "the PR must not be judged conflicting on the strength of local commits",
    );
    assert(
      result.ok,
      `expected success, got ${!result.ok && result.error.message}`,
    );
    // The PR's own commit survived, rebased onto the new base.
    const log = await git(["log", "--format=%s", "-n", "3"], workerPath);
    assertStringIncludes(log, "PR commit");
    assertStringIncludes(log, "Base commit");
  } finally {
    await cleanup(tmpDir);
  }
});
